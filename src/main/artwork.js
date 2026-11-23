'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// `require('electron')` returns the Electron API only in the main process.
// Guard it so the module can also be exercised from a plain Node script.
let net = null;
try {
  ({ net } = require('electron'));
} catch {
  /* not running inside Electron */
}

const REQUEST_TIMEOUT_MS = 8000;
const MIN_IMAGE_BYTES = 1024;

// Existing caches written by older versions use .jpg; Genius can also return png.
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const GENIUS_JSON_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  Referer: 'https://genius.com/',
};

const GENIUS_PAGE_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

const GENIUS_IMAGE_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  Referer: 'https://genius.com/',
};

const ITUNES_HEADERS = { 'User-Agent': 'Aurora/1.0' };

const JSON_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

/** Query variants: full title, then the title without "(prod. …)" style suffixes. */
function searchQueries(meta) {
  const title = String(meta.title || '').trim();
  const artist = String(meta.artist || '').trim();
  const cleaned = title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const list = [];
  if (artist && title) list.push(`${artist} ${title}`);
  if (cleaned && cleaned !== title) {
    if (artist) list.push(`${artist} ${cleaned}`);
    list.push(cleaned);
  } else if (title) {
    list.push(title);
  }
  return [...new Set(list.filter(Boolean))];
}
/** Shared title/artist scoring for catalogue providers. */
function pickMatch(items, meta, getTitle, getArtist) {
  const wantTitle = norm(meta.title);
  const wantArtist = norm(meta.artist);
  let best = null;
  let bestScore = -1;
  for (const item of items) {
    const title = norm(getTitle(item));
    if (!title) continue;
    const titleScore = titleSimilarity(title, wantTitle);
    if (titleScore < 0.6) continue;
    const artist = norm(getArtist(item));
    const artistScore = wantArtist && artist ? artistSimilarity(artist, wantArtist) : null;
    if (wantArtist && artistScore !== null && artistScore < 0.5) continue;
    const score = titleScore * 70 + (artistScore === null ? 40 : artistScore * 30);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 55 ? best : null;
}

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  const text = String(value || '').trim();
  return text ? text.split(' ') : [];
}

function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const setA = new Set(tokenize(a));
  const tokensB = tokenize(b);
  if (!tokensB.length) return 0;
  let common = 0;
  for (const token of tokensB) if (setA.has(token)) common += 1;
  return common / tokensB.length;
}

function artistSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const setA = new Set(tokenize(a).filter((t) => t.length > 1));
  const tokensB = tokenize(b).filter((t) => t.length > 1);
  if (!tokensB.length) return 0;
  let common = 0;
  for (const token of tokensB) if (setA.has(token)) common += 1;
  return common / tokensB.length;
}

function detectImageExt(buffer) {
  if (!buffer || buffer.length < MIN_IMAGE_BYTES) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return '.webp';
  }
  // Never trust Content-Type alone: an HTML challenge page can be served with
  // a 200 status, so only real image signatures are accepted.
  return null;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

function collectFetch() {
  if (net && typeof net.fetch === 'function') return net.fetch.bind(net);
  if (typeof fetch === 'function') return fetch.bind(globalThis);
  return null;
}

/**
 * GET a URL and return its body as a Buffer, with an 8 second hard timeout.
 * `AbortController` cancels the underlying request; the race guarantees the
 * caller is unblocked even if a particular transport ignores the signal.
 */
async function request(url, headers) {
  const fetchFn = collectFetch();
  if (!fetchFn) throw new Error('No fetch implementation available');

  const controller = new AbortController();
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  const task = (async () => {
    const res = await fetchFn(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    const buffer = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType: String(res.headers.get('content-type') || ''),
      buffer,
    };
  })();
  // If the guard wins the race, the pending fetch rejection is still handled.
  task.catch(() => {});

  try {
    return await Promise.race([task, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function htmlToLines(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|span)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim());
}

/** Pulls every `data-lyrics-container` block out of a Genius song page. */
function lyricsBlocks(html) {
  const blocks = [];
  const openRe = /<div[^>]*data-lyrics-container="true"[^>]*>/gi;
  let match;
  while ((match = openRe.exec(html))) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf('<div', i);
      const nextClose = html.indexOf('</div>', i);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        i = nextOpen + 4;
      } else {
        depth -= 1;
        i = nextClose + 6;
      }
    }
    blocks.push(html.slice(start, Math.max(start, i - 6)));
    openRe.lastIndex = Math.max(i, start);
  }
  return blocks;
}

const LYRICS_NOISE = new Set([
  'you might also like',
  'embed',
  'read more',
  '… read more',
  'contributors',
  'translations',
]);

const SECTION_RE = /^\[(intro|verse|chorus|pre-chorus|post-chorus|bridge|hook|outro|refrain|skit|interlude|breakdown|instrumental|verse \d|chorus \d)/i;

function parseGeniusLyrics(html) {
  // Scripts embed a JSON copy of the page: parsing them would capture the
  // header and the whole document instead of the rendered lyrics blocks.
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const raw = [];
  for (const block of lyricsBlocks(clean)) raw.push(...htmlToLines(block));

  // Genius puts the "N Contributors / Translations / …" header inside the
  // first lyrics container, so start at the first real section marker.
  let startIndex = raw.findIndex((line) => SECTION_RE.test(line));
  if (startIndex < 0) startIndex = 0;

  const lines = [];
  for (let i = startIndex; i < raw.length; i += 1) {
    const line = raw[i];
    if (/^\[.*\]$/.test(line)) continue; // [Chorus], [Verse 1] …
    if (LYRICS_NOISE.has(line.toLowerCase())) continue;
    if (!line && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Cover art resolver. Genius is the primary catalogue; iTunes remains as a
 * fallback when Genius has no usable result, is rate limited or blocked.
 */
class ArtworkService {
  constructor(dir) {
    this.dir = dir;
    this.memo = new Map();
    this.inflight = new Map();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* ignore */ }
  }

  keyFor(meta) {
    return crypto
      .createHash('sha1')
      .update(`${norm(meta.artist)}|${norm(meta.title)}`)
      .digest('hex')
      .slice(0, 16);
  }

  cached(meta) {
    if (!meta || !meta.title) return null;
    const key = this.keyFor(meta);
    if (this.memo.has(key)) return this.memo.get(key);
    return this._lookup(key);
  }

  /** Find cover art and return only the local file path (legacy contract). */
  async find(meta) {
    const result = await this.findWithSource(meta);
    return result ? result.file : null;
  }

  /**
   * Same lookup as find(), but reports where the artwork came from:
   * { file, source: 'genius' | 'itunes' | 'cache' } or null.
   */
  async findWithSource(meta) {
    if (!meta || !meta.title) return null;
    const cached = this.cached(meta);
    if (cached) return { file: cached, source: 'cache' };

    const key = this.keyFor(meta);
    if (this.inflight.has(key)) return this.inflight.get(key);

    // Remember recent misses so unknown tracks are not re-queried every time.
    if (!this.misses) this.misses = new Map();
    const missAt = this.misses.get(key);
    if (missAt && Date.now() - missAt < 10 * 60 * 1000) return null;

    const task = this._fetch(meta, key)
      .catch(() => null)
      .then((result) => {
        if (!result) this.misses.set(key, Date.now());
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  async lyrics(meta) {
    if (!meta || !meta.title) return null;
    const key = this.keyFor(meta);
    const cacheFile = path.join(this.dir, `${key}.lyrics.json`);
    try {
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached && Array.isArray(cached.lines) && cached.lines.length) return cached;
      }
    } catch { /* ignore broken cache */ }

    try {
      const song = await this._geniusFindSong(meta);
      if (!song || !song.url) return null;
      const page = await request(song.url, { ...GENIUS_JSON_HEADERS, Accept: 'text/html,application/xhtml+xml' });
      if (!page.ok || !page.buffer) return null;
      const lines = parseGeniusLyrics(page.buffer.toString('utf8'));
      if (!lines.length) return null;
      const payload = {
        title: meta.title,
        artist: meta.artist || (song.primary_artist && song.primary_artist.name) || '',
        url: song.url,
        lines,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(payload), 'utf8');
      return payload;
    } catch {
      return null;
    }
  }

  _lookup(key) {
    for (const ext of IMAGE_EXTS) {
      const file = path.join(this.dir, `${key}${ext}`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size >= MIN_IMAGE_BYTES) {
          this.memo.set(key, file);
          return file;
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  async _fetch(meta, key) {
    const base = path.join(this.dir, key);

    // Every catalogue is queried at once and the first usable cover wins.
    const providers = [
      ['genius', this._fromGenius(meta, key, base)],
      ['itunes', this._fromItunes(meta, key, base)],
      ['deezer', this._fromDeezer(meta, key, base)],
      ['yandex', this._fromYandex(meta, key, base)],
    ].map(([source, pending]) =>
      Promise.resolve(pending)
        .then((file) => (file ? { file, source } : null))
        .catch(() => null)
    );

    return new Promise((resolve) => {
      let settled = false;
      let remaining = providers.length;
      for (const provider of providers) {
        provider.then((result) => {
          if (settled) return;
          if (result) {
            settled = true;
            resolve(result);
          } else if (--remaining === 0) {
            settled = true;
            resolve(null);
          }
        });
      }
    });
  }

  // ---------------------------------------------------------------- Genius ---

  async _fromGenius(meta, key, base) {
    const song = await this._geniusFindSong(meta);
    if (!song) return null;

    const direct = String(song.song_art_image_url || '').trim();
    if (direct) {
      const saved = await this._tryDownload(direct, key, base);
      if (saved) return saved;
    }

    if (song.url) {
      try {
        const ogImage = await this._ogImage(String(song.url));
        if (ogImage) {
          const saved = await this._tryDownload(ogImage, key, base);
          if (saved) return saved;
        }
      } catch { /* page may be blocked — try the thumbnail */ }
    }

    const thumb = String(song.song_art_image_thumbnail_url || '').trim();
    if (thumb) {
      const saved = await this._tryDownload(thumb, key, base);
      if (saved) return saved;
    }

    return null;
  }

  async _geniusFindSong(meta) {
    const title = String(meta.title || '').trim();
    const artist = String(meta.artist || '').trim();
    const queries = [];
    if (artist) queries.push(`${artist} ${title}`);
    queries.push(title);

    const seenQueries = new Set();
    for (const query of queries) {
      const normalizedQuery = query.toLowerCase();
      if (!query || seenQueries.has(normalizedQuery)) continue;
      seenQueries.add(normalizedQuery);

      let json = null;
      try {
        const res = await request(
          `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`,
          GENIUS_JSON_HEADERS
        );
        if (!res.ok || !res.buffer) continue;
        json = JSON.parse(res.buffer.toString('utf8'));
      } catch {
        continue;
      }

      const match = this._bestSong(this._songHits(json), meta);
      if (match) return match;
    }
    return null;
  }

  _songHits(json) {
    const sections =
      json && json.response && Array.isArray(json.response.sections)
        ? json.response.sections
        : [];
    const hits = [];
    const seen = new Set();
    for (const section of sections) {
      if (!section || !Array.isArray(section.hits)) continue;
      for (const hit of section.hits) {
        const result = hit && hit.result;
        if (!result || result._type !== 'song') continue;
        const id = result.id || result.url;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        hits.push(result);
      }
    }
    return hits;
  }

  _bestSong(hits, meta) {
    const wantTitle = norm(meta.title);
    const wantArtist = norm(meta.artist);
    let best = null;
    let bestScore = -1;

    for (const item of hits) {
      const title = norm(item.title);
      if (!title) continue;

      const titleScore = titleSimilarity(title, wantTitle);
      // A differently named song is never the right cover.
      if (titleScore < 0.6) continue;

      let artistScore = null;
      if (wantArtist) {
        const names = [
          item.primary_artist && item.primary_artist.name,
          item.artist_names,
          item.primary_artist_names,
        ]
          .filter(Boolean)
          .map((name) => norm(name));
        artistScore = names.reduce((max, name) => Math.max(max, artistSimilarity(name, wantArtist)), 0);
        // Hard reject: the same title by another artist must not be used.
        if (artistScore < 0.5) continue;
      }

      const score = titleScore * 60 + (artistScore === null ? 0 : artistScore * 40);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return bestScore >= 55 ? best : null;
  }

  async _ogImage(pageUrl) {
    const res = await request(pageUrl, GENIUS_PAGE_HEADERS);
    if (!res.ok || !res.buffer) return null;
    const html = res.buffer.toString('utf8');
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const url = decodeHtmlEntities(match[1]).trim();
        if (/^https?:\/\//i.test(url)) return url;
      }
    }
    return null;
  }

  async _downloadImage(url) {
    const res = await request(url, GENIUS_IMAGE_HEADERS);
    if (!res.ok || !res.buffer) return null;
    const ext = detectImageExt(res.buffer);
    if (!ext) return null;
    return { buffer: res.buffer, ext };
  }

  async _tryDownload(url, key, base) {
    try {
      const image = await this._downloadImage(url);
      if (!image) return null;
      return this._saveArtwork(key, base, image.buffer, image.ext);
    } catch {
      return null;
    }
  }

  _saveArtwork(key, base, buffer, ext) {
    const file = `${base}${ext}`;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch { /* ignore */ }
      try {
        fs.writeFileSync(file, buffer);
      } catch {
        return null;
      }
    }
    this.memo.set(key, file);
    return file;
  }

  // ---------------------------------------------------------------- iTunes ---

  async _fromItunes(meta, key, base) {    const queries = [];
    if (meta.artist) queries.push(`${meta.artist} ${meta.title}`);
    queries.push(meta.title);

    for (const query of queries) {
      let items = [];
      try {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=6&media=music`;
        const res = await request(url, ITUNES_HEADERS);
        if (!res.ok || !res.buffer) continue;
        const json = JSON.parse(res.buffer.toString('utf8'));
        items = Array.isArray(json.results) ? json.results : [];
      } catch {
        continue;
      }
      const match = this._best(items, meta);
      if (!match) continue;
      const art = String(match.artworkUrl100 || match.artworkUrl60 || '').replace(
        /\/\d+x\d+bb\./,
        '/600x600bb.'
      );
      if (!art) continue;
      try {
        const res = await request(art, ITUNES_HEADERS);
        if (!res.ok || !res.buffer) continue;
        const ext = detectImageExt(res.buffer);
        if (!ext) continue;
        return this._saveArtwork(key, base, res.buffer, ext);
      } catch {
        continue;
      }
    }
    return null;
  }

  async _fromDeezer(meta, key, base) {
    for (const query of searchQueries(meta)) {
      try {
        const res = await request(
          `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=6`,
          JSON_HEADERS
        );
        if (!res.ok || !res.buffer) continue;
        const json = JSON.parse(res.buffer.toString('utf8'));
        const items = Array.isArray(json.data) ? json.data : [];
        const match = pickMatch(items, meta, (item) => item.title, (item) => (item.artist && item.artist.name) || '');
        if (!match) continue;
        const album = match.album || {};
        const art = album.cover_xl || album.cover_big || album.cover_medium || '';
        if (!art) continue;
        const saved = await this._tryDownload(art, key, base);
        if (saved) return saved;
      } catch {
        continue;
      }
    }
    return null;
  }

  async _fromYandex(meta, key, base) {
    for (const query of searchQueries(meta)) {
      try {
        const res = await request(
          `https://api.music.yandex.net/search?text=${encodeURIComponent(query)}&type=track&page=0`,
          JSON_HEADERS
        );
        if (!res.ok || !res.buffer) continue;
        const json = JSON.parse(res.buffer.toString('utf8'));
        const tracks = (json.result && json.result.tracks && json.result.tracks.results) || [];
        const match = pickMatch(
          tracks,
          meta,
          (track) => track.title,
          (track) => (track.artists || []).map((artist) => artist.name).join(' ')
        );
        if (!match) continue;
        const album = (match.albums && match.albums[0]) || {};
        const uri = match.coverUri || album.coverUri || '';
        if (!uri) continue;
        const art = `https://${uri.replace('%%', '1000x1000')}`;
        const saved = await this._tryDownload(art, key, base);
        if (saved) return saved;
      } catch {
        continue;
      }
    }
    return null;
  }

  _best(items, meta) {
    const wantTitle = norm(meta.title);
    const wantArtist = norm(meta.artist);
    const artistTokens = wantArtist ? wantArtist.split(' ').filter((t) => t.length > 1) : [];
    let best = null;
    let bestScore = -1;

    for (const item of items) {
      const title = norm(item.trackName);
      if (!title) continue;

      let titleScore;
      if (title === wantTitle) titleScore = 1;
      else if (title.includes(wantTitle) || wantTitle.includes(title)) titleScore = 0.8;
      else {
        const a = new Set(title.split(' '));
        const b = new Set(wantTitle.split(' '));
        let common = 0;
        for (const word of b) if (a.has(word)) common += 1;
        titleScore = common / Math.max(1, b.size);
      }
      // The song title itself must match — a different song is never a hit.
      if (titleScore < 0.6) continue;

      let artistScore = null;
      if (wantArtist) {
        const artist = norm(item.artistName);
        if (artist === wantArtist) artistScore = 1;
        else if (artist.includes(wantArtist) || wantArtist.includes(artist)) artistScore = 0.9;
        else {
          const at = new Set(artist.split(' '));
          let common = 0;
          for (const token of artistTokens) if (at.has(token)) common += 1;
          artistScore = artistTokens.length ? common / artistTokens.length : 0;
        }
        // Hard reject: same title by a different artist must not get this cover.
        if (artistScore < 0.5) continue;
      }

      const score = titleScore * 60 + (artistScore === null ? 0 : artistScore * 40);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return bestScore >= 55 ? best : null;
  }
}

module.exports = { ArtworkService };

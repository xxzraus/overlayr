'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'Overlayr/1.3 (Windows; lyrics sync)';
const CACHE_VERSION = 2;

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split('\n')) {
    const match = raw.match(/^\[(\d{1,3}):(\d{1,2}(?:\.\d+)?)\]\s*(.*)$/);
    if (!match) continue;
    const value = match[3].trim();
    if (!value) continue;
    lines.push({ time: Number(match[1]) * 60 + Number(match[2]), text: value });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/**
 * Lyrics with real timestamps (LRCLIB), falling back to Genius plain text.
 * Synced lines make the wallpaper scroll exactly with the music.
 */
class LyricsService {
  constructor(dir, artwork) {
    this.dir = dir;
    this.artwork = artwork;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* ignore */ }
  }

  keyFor(meta) {
    const base = `${norm(meta.artist)}|${norm(meta.title)}`;
    return crypto.createHash('sha1').update(base).digest('hex').slice(0, 20);
  }

  async get(meta) {
    if (!meta || !meta.title) return null;
    const key = this.keyFor(meta);
    const cacheFile = path.join(this.dir, `${key}.json`);

    try {
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached && cached.version === CACHE_VERSION && Array.isArray(cached.lines) && cached.lines.length) {
          return cached;
        }
      }
    } catch { /* ignore broken cache */ }

    let result = null;
    try {
      result = await this.fromLrclib(meta);
    } catch { /* fall back to Genius */ }

    if (!result) {
      try {
        const plain = await this.artwork.lyrics({ title: meta.title, artist: meta.artist });
        if (plain && plain.lines && plain.lines.length) {
          result = {
            version: CACHE_VERSION,
            synced: false,
            source: 'genius',
            lines: plain.lines.map((text) => ({ time: null, text })),
          };
        }
      } catch { /* ignore */ }
    }

    if (!result) return null;
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(result), 'utf8');
    } catch { /* ignore */ }
    return result;
  }

  async fromLrclib(meta) {
    const { net } = require('electron');
    const params = new URLSearchParams({
      track_name: String(meta.title || ''),
      artist_name: String(meta.artist || ''),
    });
    const res = await net.fetch(`https://lrclib.net/api/search?${params.toString()}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const items = await res.json();
    if (!Array.isArray(items) || !items.length) return null;

    const wantTitle = norm(meta.title);
    const wantArtist = norm(meta.artist);
    const wantDuration = Number(meta.duration) || 0;

    const scored = items
      .map((item) => {
        const title = norm(item.trackName);
        const artist = norm(item.artistName);
        let score = 0;
        if (title && wantTitle && (title === wantTitle || title.includes(wantTitle) || wantTitle.includes(title))) score += 40;
        if (artist && wantArtist && (artist === wantArtist || artist.includes(wantArtist) || wantArtist.includes(artist))) score += 40;
        if (wantDuration && item.duration) {
          const diff = Math.abs(Number(item.duration) - wantDuration);
          if (diff <= 3) score += 20;
          else if (diff <= 10) score += 8;
        }
        if (item.syncedLyrics) score += 15;
        return { item, score };
      })
      .filter((entry) => entry.item.syncedLyrics && entry.score >= 60)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best) return null;
    const lines = parseLrc(best.item.syncedLyrics);
    if (!lines.length) return null;

    return {
      version: CACHE_VERSION,
      synced: true,
      source: 'lrclib',
      lines,
      duration: Number(best.item.duration) || wantDuration || null,
    };
  }
}

module.exports = { LyricsService, parseLrc };

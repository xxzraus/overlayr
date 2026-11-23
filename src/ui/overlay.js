'use strict';


/* Aurora — music overlay renderer */

const api = window.aurora;
const $ = (s) => document.querySelector(s);
const tr = (text) => (window.OverlayrI18n ? window.OverlayrI18n.trText(text) : text);

const PAD = 20;
const PEEK_SIZE = 64;

const state = {
  settings: null,
  theme: null,
  media: null,
  audio: null,
  spectrum: null,
  seekOverride: null,
  layout: 'standard',
  peek: false,
  expandedHeight: 141,
  lastW: 0,
  lastH: 0,
  hoverTimer: null,
  collapseTimer: null,
};

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function luminance(hex) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastOn(hex) {
  return luminance(hex) > 0.42 ? '#0A0B10' : '#FFFFFF';
}

/* ---------------- theme + layout ---------------- */

function applyTheme(theme) {
  state.theme = theme;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars || {})) root.style.setProperty(k, v);
  const accent = state.settings?.accentOverride || theme.accent;
  if (state.settings?.accentOverride) root.style.setProperty('--accent', state.settings.accentOverride);
  root.style.setProperty('--on-accent', contrastOn(accent));
}

const ov = $('#ov');

function canPeek() {
  const cfg = state.settings?.overlay || {};
  return cfg.peekMode !== false && !cfg.clickThrough && !cfg.forceExpanded;
}

function applyUi() {
  const o = state.settings.overlay;
  state.layout = o.layout || 'standard';
  ov.dataset.layout = state.layout;
  const alpha = Number(o.opacity ?? 0.96);
  document.querySelector('.ov-body').style.setProperty('--ov-a', String(alpha));
  ov.style.setProperty('--ov-radius', `${Number(o.radius ?? 24)}px`);
  ov.classList.toggle('no-vis', !o.showVisualizer);
  ov.classList.toggle('no-progress', !o.showProgress);
  ov.classList.toggle('no-volume', !o.showVolume);
  ov.classList.toggle('no-stats', !o.showStats);
  ov.classList.toggle('no-clock', !o.showClock);
  ov.classList.toggle('passthrough', !!o.clickThrough);
  if (!canPeek()) state.peek = false;
  ov.classList.toggle('peek', state.peek);
  buildVisualizer();
  render();
  requestAnimationFrame(syncSize);
}

/* ---------------- size management ---------------- */

function syncSize() {
  const cfg = state.settings?.overlay || {};
  let width;
  let height;
  if (state.peek) {
    width = PEEK_SIZE + PAD * 2;
    height = PEEK_SIZE + PAD * 2;
  } else {
    const rect = ov.getBoundingClientRect();
    if (rect.height > 20) state.expandedHeight = Math.ceil(rect.height);
    width = Math.max(280, Number(cfg.width) || 420) + PAD * 2;
    height = (state.expandedHeight || 141) + PAD * 2;
  }
  if (width === state.lastW && height === state.lastH) return;
  state.lastW = width;
  state.lastH = height;
  api.overlay.resize({ width, height });
}

function setPeek(value) {
  if (state.peek === value) return;
  if (value) {
    // Collapse: shrink the card first, then snap the window to its size.
    ov.classList.add('collapsing');
    setTimeout(() => {
      ov.classList.remove('collapsing');
      state.peek = true;
      ov.classList.add('peek');
      syncSize();
      requestAnimationFrame(() => setTimeout(syncSize, 40));
    }, 280);
    return;
  }
  state.peek = false;
  ov.classList.remove('peek');
  ov.classList.add('growing');
  syncSize();
  setTimeout(() => ov.classList.remove('growing'), 460);
}

function scheduleCollapse() {
  clearTimeout(state.collapseTimer);
  if (!canPeek()) return;
  state.collapseTimer = setTimeout(async () => {
    if (ov.matches(':hover')) return;
    // The window may have just appeared under a motionless cursor: in that
    // case Chromium never fires mouseenter, so ask Windows where the pointer is.
    const inside = await api.overlay.cursorInside();
    if (!inside) setPeek(true);
  }, 1900);
}

function scheduleExpand() {
  clearTimeout(state.hoverTimer);
  if (!canPeek()) return;
  state.hoverTimer = setTimeout(() => setPeek(false), 240);
}

/* ---------------- visualizer ---------------- */

const BAR_COUNT = 26;
let visualizerStyle = 'bars';

function buildVisualizer(force = false) {
  const vis = $('#ov-visualizer');
  if (!vis) return;
  const style = state.settings?.overlay?.spectrumStyle || 'bars';
  const count = style === 'circle' ? 32 : BAR_COUNT;
  if (!force && vis.childElementCount === count && visualizerStyle === style) return;
  visualizerStyle = style;
  vis.dataset.style = style;
  let html = '';
  for (let i = 0; i < count; i++) {
    if (style === 'circle') {
      const angle = (360 / count) * i;
      html += `<i style="--angle:${angle}deg;--dur:${(0.62 + Math.random() * 0.9).toFixed(2)}s;--delay:-${(Math.random() * 0.7).toFixed(2)}s"></i>`;
    } else {
      const dur = (0.62 + Math.random() * 0.9).toFixed(2);
      const delay = (Math.random() * 0.7).toFixed(2);
      html += `<i style="--dur:${dur}s;--delay:-${delay}s"></i>`;
    }
  }
  vis.innerHTML = html;
}

function paintSpectrum(bands) {
  const vis = $('#ov-visualizer');
  if (!vis || !bands || !bands.length) return;
  ov.classList.add('real');
  const bars = vis.children;
  if (!bars.length) return;
  const sensitivity = Math.max(0.4, Math.min(2.2, Number(state.settings?.overlay?.spectrumSensitivity ?? 100) / 100));
  const step = bands.length / bars.length;
  for (let i = 0; i < bars.length; i++) {
    const value = (bands[Math.floor(i * step)] || 0) * sensitivity;
    const height = Math.max(6, Math.min(100, value));
    bars[i].style.height = `${height}%`;
    if (visualizerStyle === 'circle') bars[i].style.setProperty('--h', String(height));
  }
}

/* ---------------- render ---------------- */

function currentPosition() {
  const m = state.media;
  if (!m || !m.hasSession) return 0;
  if (state.seekOverride && Date.now() < state.seekOverride.until) return state.seekOverride.value;
  let pos = Number(m.position) || 0;
  if (m.playing) pos += Date.now() - (m.receivedAt || Date.now());
  const dur = Number(m.duration) || 0;
  return dur > 0 ? Math.max(0, Math.min(pos, dur)) : Math.max(0, pos);
}

function render() {
  const m = state.media;
  const has = !!(m && m.hasSession);

  ov.classList.toggle('idle', !has);
  ov.classList.toggle('playing', !!(has && m.playing));
  ov.classList.toggle('sticky', !!(has && m.sticky));

  $('#ov-title').textContent = has && m.title ? m.title : tr('Тишина в эфире');
  $('#ov-artist').textContent = has ? m.artist || tr('без исполнителя') : tr('включи музыку — я подхвачу');
  $('#ov-app').textContent = has ? m.app || '' : '';

  const art = has ? m.artUrl : null;
  const artEl = $('#ov-art');
  if (art) {
    artEl.style.backgroundImage = `url("${art}")`;
    $('.ov-note').style.display = 'none';
  } else {
    artEl.style.backgroundImage = '';
    $('.ov-note').style.display = '';
  }

  $('#ov-play-icon').outerHTML = has && m.playing
    ? '<svg id="ov-play-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>'
    : '<svg id="ov-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  $('#ov-shuffle').classList.toggle('on', !!(has && m.shuffle));
  $('#ov-repeat').classList.toggle('on', !!(has && m.repeat));

  updateProgress();
  if (!state.progressTimer) state.progressTimer = setInterval(updateProgress, 250);
}

function updateProgress() {
  const m = state.media;
  const dur = m && m.hasSession ? Number(m.duration) || 0 : 0;
  const pos = currentPosition();
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  const fill = $('#ov-fill');
  if (fill) fill.style.width = pct + '%';
  const artBar = $('#ov-art-progress');
  if (artBar) artBar.style.width = pct + '%';
  const cur = $('#ov-pos');
  if (cur) cur.textContent = fmtTime(pos);
  const d = $('#ov-dur');
  if (d) d.textContent = fmtTime(dur);
}

/* ---------------- volume ---------------- */

function currentTarget() {
  const m = state.media;
  return m && m.hasSession ? m.displayAppId || m.appId || null : null;
}

function updateAudio(payload) {
  if (!payload) return;
  state.audio = payload;
  if (payload.volume === null || payload.volume === undefined) return;
  $('#ov-vol').value = payload.volume;
  const muted = !!payload.muted;
  $('#ov-mute-icon').outerHTML = muted
    ? '<svg id="ov-mute-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M17 9l4 4M21 9l-4 4"/></svg>'
    : '<svg id="ov-mute-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>';
  $('#ov-mute').classList.toggle('on', muted);
  $('#ov-mute').title = payload.app ? `${tr('Без звука')}: ${payload.app}` : tr('Без звука');
}

/* ---------------- clock ---------------- */

function tickClock() {
  const now = new Date();
  $('#ov-clock').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- wiring ---------------- */

async function init() {
  const payload = await api.boot();
  state.settings = payload.settings;
  state.lang = state.settings.language === 'ru' ? 'ru' : 'en';
  if (window.OverlayrI18n) {
    window.OverlayrI18n.setLang(state.lang);
    window.OverlayrI18n.apply(document);
  }
  state.theme = payload.theme;
  state.media = payload.media;
  state.expandedHeight = { compact: 74, standard: 141, wide: 161 }[state.settings.overlay.layout || 'standard'] || 141;

  applyTheme(payload.theme);
  api.on('theme', (theme) => {
    applyTheme(theme);
    applyUi();
  });

  const cmd = (action, value = null) => {
    const target = currentTarget();
    api.media.command({ action, value, target });
  };

  $('#ov-play').addEventListener('click', (e) => {
    e.stopPropagation();
    cmd('toggle');
  });
  $('#ov-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    cmd('prev');
  });
  $('#ov-next').addEventListener('click', (e) => {
    e.stopPropagation();
    cmd('next');
  });
  $('#ov-shuffle').addEventListener('click', () => cmd('shuffle', true));
  $('#ov-repeat').addEventListener('click', () => cmd('repeat', ((state.media?.repeat ?? 0) + 1) % 3));
  $('#ov-close').addEventListener('click', () => api.overlay.hide());

  $('#ov-mute').addEventListener('click', async () => {
    const res = state.settings.overlay.volumeMode === 'app'
      ? await api.audio.toggleAppMute(currentTarget())
      : await api.audio.toggleMute();
    updateAudio(res);
  });

  $('#ov-track').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const dur = state.media?.duration || 0;
    state.seekOverride = { value: fraction * dur, until: Date.now() + 1200 };
    cmd('seek', fraction);
    updateProgress();
  });

  let volTimer = null;
  $('#ov-vol').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      const p = state.settings.overlay.volumeMode === 'app' ? api.audio.setApp(currentTarget(), v) : api.audio.set(v);
      p.then(updateAudio).catch(() => {});
    }, 90);
  });

  // Hover behaviour: peek (icon only) <-> full card
  ov.addEventListener('mouseenter', () => {
    scheduleExpand();
  });
  ov.addEventListener('mouseleave', () => {
    scheduleCollapse();
  });

  /* ---- manual dragging (native drag regions swallow mouse events) ---- */

  let drag = null;
  let suppressClick = false;

  ov.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, .ov-track, .ov-close')) return;
    const pos = await api.overlay.getPos();
    drag = { startX: e.screenX, startY: e.screenY, winX: pos.x, winY: pos.y, moved: false };
    ov.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.startX;
    const dy = e.screenY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) api.overlay.moveTo({ x: drag.winX + dx, y: drag.winY + dy });
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    suppressClick = drag.moved;
    drag = null;
    ov.classList.remove('dragging');
    if (suppressClick) setTimeout(() => { suppressClick = false; }, 300);
  });

  ov.addEventListener('click', (e) => {
    if (!state.peek) return;
    if (suppressClick) return;
    e.stopPropagation();
    clearTimeout(state.hoverTimer);
    cmd('toggle');
  });

  $('#ov-art').addEventListener('dblclick', async (e) => {
    e.stopPropagation();
    if (state.peek) return;
    const next = state.layout === 'compact' ? 'standard' : 'compact';
    state.settings.overlay.layout = next;
    api.overlay.set({ layout: next });
    applyUi();
  });

  api.on('media', (next) => {
    state.media = next;
    render();
  });

  api.on('audio', (next) => updateAudio(next));

  api.on('spectrum', (next) => {
    state.spectrum = next;
    if (state.settings.overlay.spectrum && next && next.bands) paintSpectrum(next.bands);
  });

  api.on('stats', (s) => {
    $('#ov-cpu').textContent = 'CPU ' + s.cpu + '%';
    $('#ov-ram').textContent = 'RAM ' + s.memPercent + '%';
  });

  api.on('settings', (next) => {
    const layoutChanged = next.overlay.layout !== state.settings.overlay.layout;
    state.settings = next;
    state.lang = next.language === 'ru' ? 'ru' : 'en';
    if (window.OverlayrI18n) {
      window.OverlayrI18n.setLang(state.lang);
      window.OverlayrI18n.apply(document);
    }
    applyUi();
    if (layoutChanged) setTimeout(syncSize, 60);
  });

  api.on('overlay:settings', (cfg) => {
    const layoutChanged = cfg.layout !== state.settings.overlay.layout;
    state.settings.overlay = { ...state.settings.overlay, ...cfg };
    applyUi();
    if (layoutChanged) setTimeout(syncSize, 60);
  });

  applyUi();
  tickClock();
  setInterval(tickClock, 15000);

  // Open expanded for a moment so the user sees what is playing, then shrink
  // into the peek icon if the pointer is elsewhere.
  setPeek(false);
  setTimeout(async () => {
    if (ov.matches(':hover')) return;
    const inside = await api.overlay.cursorInside();
    if (!inside) setPeek(true);
  }, 2600);
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = '<pre style="color:#fff;font-size:11px">' + esc(err.stack || err.message) + '</pre>';
});

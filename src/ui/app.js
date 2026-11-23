'use strict';

/* ------------------------------------------------------------------ */
/* Aurora — main window renderer                                       */
/* ------------------------------------------------------------------ */

const api = window.aurora;
const i18n = window.OverlayrI18n || null;
const tr = (text) => (i18n ? i18n.trText(text) : text);
function i18nRefresh(root = document) {
  if (i18n) i18n.apply(root);
}
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  settings: null,
  themes: [],
  theme: null,
  media: null,
  apps: [],
  pinned: [],
  usage: {},
  stats: null,
  audio: null,
  seekOverride: null,
  progressRaf: null,
  progressTimer: null,
  lang: 'en',
  mediaSig: '',
  playerLyrics: null,
  playerLyricsKey: '',
  playerWallKey: '',
  playerArtKey: '',
  playerArtWaitKey: '',
  playerWallTimer: null,
  playerLoop: null,
  playerBusy: false,
};

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-1 6 4 3v2h-5v6l-1 1-1-1v-6H6v-2l4-3z"/></svg>',
  x: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>',
};

const PROFILES = [
  {
    id: 'game',
    name: 'Игра',
    emo: '🎮',
    theme: 'neo-tokyo',
    overlay: {
      layout: 'compact',
      width: 340,
      peekMode: true,
      alwaysOnTop: true,
      showProgress: false,
      showVisualizer: true,
      showClock: false,
      showStats: false,
      opacity: 0.92,
    },
  },
  {
    id: 'work',
    name: 'Работа',
    emo: '💼',
    theme: 'aurora',
    overlay: {
      layout: 'standard',
      width: 420,
      peekMode: true,
      alwaysOnTop: true,
      showProgress: true,
      showVisualizer: true,
      showClock: true,
      showStats: true,
      opacity: 0.96,
    },
  },
  {
    id: 'movie',
    name: 'Кино',
    emo: '🎬',
    theme: 'midnight',
    overlay: {
      layout: 'compact',
      width: 320,
      peekMode: true,
      alwaysOnTop: true,
      showProgress: false,
      showVisualizer: false,
      showClock: false,
      showStats: false,
      opacity: 0.85,
    },
  },
];

/* ---------------------------- helpers ---------------------------- */

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastOn(hex) {
  return luminance(hex) > 0.42 ? '#0A0B10' : '#FFFFFF';
}

function toast(message, ms = 2600) {
  message = tr(message);
  const wrap = $('#toast-wrap');
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  wrap.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, ms);
}

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function showWelcomeCard() {
  const card = $('#welcome-card');
  if (!card) return;
  const hide = () => card.classList.remove('show');
  const close = $('#welcome-close');
  const x = $('#welcome-x');
  const themes = $('#welcome-themes');
  if (close) close.addEventListener('click', hide);
  if (x) x.addEventListener('click', hide);
  if (themes) {
    themes.addEventListener('click', () => {
      hide();
      showView('themes');
    });
  }
  setTimeout(() => card.classList.add('show'), 450);
  setTimeout(hide, 15000);
}

/* ---------------------------- theme ---------------------------- */

function applyThemeVars(theme) {
  const root = document.documentElement;
  const vars = theme.vars || {};
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  const override = state.settings?.accentOverride;
  const accent = override || theme.accent;
  if (override) {
    root.style.setProperty('--accent', override);
  }
  root.style.setProperty('--on-accent', contrastOn(accent));
  document.body.dataset.mode = theme.dark ? 'dark' : 'light';
  document.body.dataset.bgstyle = theme.bgStyle || 'aurora';
}

function allThemes() {
  return [...state.themes, ...(state.customThemes || [])];
}

function renderThemes() {
  const grid = $('#theme-grid');
  const currentId = state.theme?.id;
  grid.innerHTML = allThemes()
    .map((t) => {
      const active = t.id === currentId;
      return `
      <button class="theme-card ${active ? 'active' : ''}" data-theme="${t.id}" title="${esc(t.desc || '')}">
        ${t.custom ? `<span class="theme-del" data-del="${esc(t.id)}" title="Удалить тему">${ICONS.x}</span>` : ''}
        <div class="theme-preview" style="--p1:${t.wall[0]};--p2:${t.wall[1]};--p3:${t.wall[2]};--pa:${t.accent}">
          <div class="pv-window">
            <div class="pv-dots"><i></i><i></i><i></i>
              <span class="pv-swatches">
                <b style="background:${t.accent}"></b>
                <b style="background:${t.accent2}"></b>
                <b style="background:${t.aura}"></b>
              </span>
            </div>
            <div class="pv-line accent"></div>
            <div class="pv-line"></div>
            <div class="pv-line short"></div>
          </div>
        </div>
        <div class="theme-meta">
          <span class="theme-name">${esc(t.name)}</span>
          <span class="theme-tag">${esc(t.tag || '')}</span>
        </div>
        <div class="theme-desc">${esc(t.desc || '')}</div>
        <span class="theme-check">${ICONS.check}</span>
      </button>`;
    })
    .join('');

  grid.querySelectorAll('.theme-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) return;
      selectTheme(card.dataset.theme);
    });
  });
  grid.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteCustomTheme(btn.dataset.del);
    });
  });
}

const pushSystemTheme = debounce(async () => {
  const s = state.settings;
  if (!s.applyDarkMode && !s.applyAccent) return;
  const theme = state.theme;
  await api.system.apply({
    dark: s.applyDarkMode ? theme.dark : undefined,
    accent: s.accentOverride || theme.accent,
    wallpaper: null,
  });
}, 700);

function renderProfiles() {
  const row = $('#profile-row');
  if (!row) return;
  row.querySelectorAll('.profile-chip').forEach((n) => n.remove());
  for (const profile of PROFILES) {
    const btn = document.createElement('button');
    const hotkey = ['F1', 'F2', 'F3'][PROFILES.indexOf(profile)];
    btn.className = 'profile-chip' + (state.profile === profile.id ? ' active' : '');
    btn.innerHTML = `<span class="emo">${profile.emo}</span>${profile.name}`;
    btn.title = `Ctrl+Alt+${hotkey} · тема «${profile.theme}», оверлей «${profile.overlay.layout}»`;
    btn.addEventListener('click', () => applyProfile(profile));
    row.appendChild(btn);
  }
}

async function applyProfile(profile) {
  state.profile = profile.id;
  renderProfiles();
  await api.overlay.set(profile.overlay);
  state.settings.overlay = { ...state.settings.overlay, ...profile.overlay };
  syncOverlayUi();
  const theme = await api.theme.apply({ id: profile.theme, system: true });
  state.theme = theme;
  applyThemeVars(theme);
  renderThemes();
  fillEditorFrom(theme);
  await systemStatus();
  toast(`Профиль «${profile.name}» включён`);
}

async function selectTheme(id) {
  const theme = await api.theme.apply({ id, system: false });
  state.theme = theme;
  applyThemeVars(theme);
  renderThemes();
  fillEditorFrom(theme);
  if (state.settings.applyWallpaper) {
    await regenerateWallpaperForMode(true);
  }
  pushSystemTheme();
}

/* ------------------------- theme editor ------------------------- */

const WALLPAPER_MODE_LABEL = { auto: 'авто', dark: 'тёмная', light: 'светлая' };

const editor = {
  bg: '#081420',
  accent: '#35e0a1',
  accent2: '#4aa8ff',
  aura: '#22d3ee',
  dark: true,
  contrast: 100,
  gamma: 100,
  gradient: 100,
  saturation: 100,
  brightness: 100,
  glow: 100,
  radius: 16,
  angle: 180,
  bgStyle: 'aurora',
};

function clamp(value, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function rgbToHex(rgb) {
  return (
    '#' +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}

function mixHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}

function adjustGammaHex(hex, gamma) {
  return rgbToHex(hexToRgb(hex).map((v) => 255 * Math.pow(v / 255, 1 / gamma)));
}

function saturationOf([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function editorTheme() {
  const contrast = clamp(editor.contrast / 100, 0.6, 1.9);
  const gamma = clamp(editor.gamma / 100, 0.6, 1.5);
  const grad = clamp(editor.gradient / 100, 0, 1);
  const sat = clamp(editor.saturation / 100, 0, 2);
  const bright = clamp(editor.brightness / 100, 0.55, 1.5);
  const glow = clamp(editor.glow / 100, 0, 2);
  const radius = clamp(editor.radius, 0, 28);
  const angle = clamp(editor.angle, 0, 360);
  const dark = editor.dark;

  let bg = editor.bg;
  if (bright > 1) bg = mixHex(bg, '#ffffff', Math.min(0.8, (bright - 1) * 0.75));
  else if (bright < 1) bg = mixHex(bg, '#000000', Math.min(0.85, (1 - bright) * 1.15));

  const text = dark ? '#EAF3FF' : '#15181F';
  const bg2 = mixHex(bg, dark ? '#ffffff' : '#000000', dark ? 0.07 : 0.05);

  let accent = adjustGammaHex(editor.accent, gamma);
  let accent2 = mixHex(accent, editor.accent2, grad);
  let aura = editor.aura || mixHex(accent, accent2, 0.5);
  if (sat !== 1) {
    accent = saturateHex(accent, sat);
    accent2 = saturateHex(accent2, sat);
    aura = saturateHex(aura, sat);
  }

  const wall = [bg, bg2, mixHex(bg, accent, 0.26)];
  return {
    id: 'custom-editor',
    name: 'Своя тема',
    tag: 'своя',
    desc: `${bg.toUpperCase()} · ${accent.toUpperCase()}`,
    custom: true,
    dark,
    bg,
    bg2,
    text,
    accent,
    accent2,
    aura,
    wall,
    contrast,
    glow,
    radius,
    angle,
    bgStyle: editor.bgStyle,
  };
}

function themeVarsLocal(theme) {
  const radius = Number(theme.radius ?? 16);
  return {
    '--bg': theme.bg,
    '--bg2': theme.bg2,
    '--text': theme.text,
    '--accent': theme.accent,
    '--accent2': theme.accent2,
    '--aura': theme.aura,
    '--contrast': String(theme.contrast ?? 1),
    '--aura-strength': String(theme.glow ?? 1),
    '--grad-angle': `${Number(theme.angle ?? 180)}deg`,
    '--radius': `${radius}px`,
    '--radius-lg': `${radius + 6}px`,
    '--radius-sm': `${Math.max(6, radius - 6)}px`,
  };
}

function previewEditor() {
  const t = editorTheme();
  for (const [k, v] of Object.entries(themeVarsLocal(t))) document.documentElement.style.setProperty(k, v);
  document.documentElement.style.setProperty('--on-accent', contrastOn(t.accent));
  document.body.dataset.bgstyle = t.bgStyle || 'aurora';
  const p = $('#edp');
  if (p) {
    p.style.setProperty('--ed-bg', t.bg);
    p.style.setProperty('--ed-bg2', t.bg2);
    p.style.setProperty('--ed-text', t.text);
    p.style.setProperty('--ed-accent', t.accent);
    p.style.setProperty('--ed-accent2', t.accent2);
    p.style.setProperty('--ed-angle', `${t.angle}deg`);
    p.style.setProperty('--ed-line', `color-mix(in srgb, ${t.text} 18%, transparent)`);
  }
}

function syncEditorInputs() {
  $('#ed-bg').value = editor.bg;
  $('#ed-accent').value = editor.accent;
  $('#ed-accent2').value = editor.accent2;
  $('#ed-aura').value = editor.aura;
  const pairs = [
    ['contrast', '#ed-contrast', '#ed-contrast-v', '%'],
    ['gamma', '#ed-gamma', '#ed-gamma-v', '%'],
    ['gradient', '#ed-gradient', '#ed-gradient-v', '%'],
    ['saturation', '#ed-saturation', '#ed-saturation-v', '%'],
    ['brightness', '#ed-brightness', '#ed-brightness-v', '%'],
    ['glow', '#ed-glow', '#ed-glow-v', '%'],
  ];
  for (const [key, rangeSel, labelSel, suffix] of pairs) {
    $(rangeSel).value = editor[key];
    $(labelSel).textContent = editor[key] + suffix;
  }
  $('#ed-radius').value = editor.radius;
  $('#ed-radius-v').textContent = String(editor.radius);
  $('#ed-angle').value = editor.angle;
  $('#ed-angle-v').textContent = editor.angle + '°';
  $$('#seg-bgstyle button').forEach((b) => b.classList.toggle('on', b.dataset.style === (editor.bgStyle || 'aurora')));
  $$('#seg-wallmode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (state.wallpaperMode || 'auto')));
}

function fillEditorFrom(theme) {
  if (!theme) return;
  editor.bg = theme.bg;
  editor.accent = theme.accent;
  editor.accent2 = theme.accent2;
  editor.aura = theme.aura || mixHex(theme.accent, theme.accent2, 0.5);
  editor.dark = !!theme.dark;
  editor.contrast = Math.round((theme.contrast ?? 1) * 100);
  editor.gamma = 100;
  editor.gradient = 100;
  editor.saturation = 100;
  editor.brightness = 100;
  editor.glow = Math.round((theme.glow ?? 1) * 100);
  editor.radius = theme.radius ?? 16;
  editor.angle = theme.angle ?? 180;
  editor.bgStyle = theme.bgStyle || 'aurora';
  syncEditorInputs();
  previewEditor();
}

async function saveCustomTheme() {
  const t = editorTheme();
  const customThemes = [...(state.customThemes || [])];
  const theme = {
    ...t,
    id: `custom-${Date.now().toString(36)}`,
    name: `Своя ${customThemes.filter((x) => x.custom).length + 1}`,
    tag: 'моя',
    desc: `фон ${t.bg.toUpperCase()} · акцент ${t.accent.toUpperCase()}`,
  };
  customThemes.push(theme);
  state.customThemes = customThemes;
  await api.settings.patch({ customThemes });
  state.settings.customThemes = customThemes;
  await selectTheme(theme.id);
  renderThemes();
  const card = document.querySelector(`.theme-card[data-theme="${theme.id}"]`);
  if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast('Тема сохранена — она в списке');
}

async function deleteCustomTheme(id) {
  const customThemes = (state.customThemes || []).filter((t) => t.id !== id);
  state.customThemes = customThemes;
  await api.settings.patch({ customThemes });
  state.settings.customThemes = customThemes;
  if (state.theme?.id === id) await selectTheme('aurora');
  renderThemes();
  toast('Тема удалена');
}

async function exportTheme() {
  const t = editorTheme();
  const res = await api.theme.export({ ...t, id: `theme-${Date.now().toString(36)}`, name: 'Overlayr theme' });
  if (res && res.ok) toast('Тема выгружена в файл');
  else if (res && res.error) toast('Не удалось сохранить: ' + res.error);
}

async function importTheme() {
  const res = await api.theme.import();
  if (!res || !res.ok) {
    if (res && res.error) toast('Не удалось загрузить: ' + res.error);
    return;
  }
  const theme = { ...res.theme, id: `custom-${Date.now().toString(36)}`, custom: true };
  state.customThemes = [...(state.customThemes || []), theme];
  await api.settings.patch({ customThemes: state.customThemes });
  await selectTheme(theme.id);
  renderThemes();
  toast('Тема импортирована');
}

/* --------------------- palette from wallpaper --------------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image-load-failed'));
    img.src = src;
  });
}

function kmeans(points, k, iterations) {
  if (!points.length) return [];
  const centroids = [];
  for (let i = 0; i < k; i++) {
    centroids.push(points[Math.floor(((i + 0.5) * points.length) / k)].slice());
  }
  const assignment = new Array(points.length).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = points[i][0] - centroids[c][0];
        const dy = points[i][1] - centroids[c][1];
        const dz = points[i][2] - centroids[c][2];
        const dist = dx * dx + dy * dy + dz * dz;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed = true;
      }
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const c = assignment[i];
      sums[c][0] += points[i][0];
      sums[c][1] += points[i][1];
      sums[c][2] += points[i][2];
      sums[c][3] += 1;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c][3]) centroids[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
    if (!changed) break;
  }
  const counts = new Array(k).fill(0);
  for (const a of assignment) counts[a] += 1;
  return centroids.map((c, i) => ({ rgb: c, count: counts[i] })).filter((c) => c.count > 0);
}

function saturateHex(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const gray = (r + g + b) / 3;
  return rgbToHex([r, g, b].map((v) => gray + (v - gray) * amount));
}

function hexDistance(a, b) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return Math.abs(A[0] - B[0]) + Math.abs(A[1] - B[1]) + Math.abs(A[2] - B[2]);
}

function pickPalette(clusters, forcedMode) {
  const stats = clusters.map((c) => ({
    hex: rgbToHex(c.rgb),
    count: c.count,
    lum: luminance(rgbToHex(c.rgb)),
    sat: saturationOf(c.rgb),
  }));
  const total = stats.reduce((a, c) => a + c.count, 0) || 1;
  const avgLum = stats.reduce((a, c) => a + c.lum * c.count, 0) / total;
  const isDark = forcedMode === 'dark' ? true : forcedMode === 'light' ? false : avgLum < 0.55;

  // Ignore crushed blacks / blown highlights when picking colours.
  const usable = stats.filter((c) => c.lum > 0.05 && c.lum < 0.92);
  const pool = usable.length >= 2 ? usable : stats;

  const dominant = [...pool].sort((a, b) => b.count - a.count)[0] || stats[0];
  let bg;
  if (isDark) bg = mixHex(dominant.hex, '#04060a', forcedMode === 'dark' ? 0.72 : 0.62);
  else bg = mixHex(dominant.hex, '#ffffff', forcedMode === 'light' ? 0.78 : 0.55);

  const vivid = pool
    .map((c) => ({ ...c, score: Math.pow(c.sat, 1.6) * Math.log(1 + c.count) }))
    .sort((a, b) => b.score - a.score);

  let accent = vivid[0] || dominant;
  let accent2 = vivid.find((c) => c !== accent && Math.abs(c.lum - accent.lum) > 0.04) || vivid[1] || accent;
  let accentHex = saturateHex(accent.hex, 1.35);
  let accent2Hex = saturateHex(accent2.hex, 1.25);

  if (isDark) {
    if (luminance(accentHex) < 0.3) accentHex = mixHex(accentHex, '#ffffff', 0.35);
    if (luminance(accent2Hex) < 0.3) accent2Hex = mixHex(accent2Hex, '#ffffff', 0.25);
  } else {
    if (luminance(accentHex) > 0.7) accentHex = mixHex(accentHex, '#000000', 0.3);
    if (luminance(accent2Hex) > 0.7) accent2Hex = mixHex(accent2Hex, '#000000', 0.2);
  }

  if (hexDistance(accentHex, accent2Hex) < 45) {
    accent2Hex = mixHex(accentHex, isDark ? '#4aa8ff' : '#7a5cff', 0.55);
  }

  const auraHex = saturateHex(mixHex(accentHex, accent2Hex, 0.5), 1.2);
  return { bg, accent: accentHex, accent2: accent2Hex, aura: auraHex, dark: isDark };
}

async function paletteFromWallpaper() {
  const status = await api.system.status();
  if (!status || !status.wallpaper) {
    toast('Не удалось найти файл обоев');
    return;
  }
  const url = `aurora-icon://local/?p=${encodeURIComponent(status.wallpaper)}&v=${Date.now()}`;
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 68;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (!pixels.length) {
    toast('Не удалось прочитать обои');
    return;
  }
  const palette = pickPalette(kmeans(pixels, 6, 10), state.wallpaperMode || 'auto');
  editor.bg = palette.bg;
  editor.accent = palette.accent;
  editor.accent2 = palette.accent2;
  editor.aura = palette.aura;
  editor.dark = palette.dark;
  editor.contrast = 100;
  editor.gamma = 100;
  editor.gradient = 100;
  editor.saturation = 100;
  editor.brightness = 100;
  editor.glow = 100;
  syncEditorInputs();
  previewEditor();
  toast(`Палитра взята с обоев (${WALLPAPER_MODE_LABEL[state.wallpaperMode || 'auto']}) — нажми «Сохранить тему»`);
}

/* ---------------------- player wallpaper ---------------------- */

function coverFit(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.slice(0, maxLines);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

const PLAYER_W = 1920;
const PLAYER_H = 1080;

function playbackPosition(media) {
  if (!media) return 0;
  const base = Number(media.position) || 0;
  const elapsed = media.playing ? Date.now() - (media.receivedAt || Date.now()) : 0;
  const duration = Number(media.duration) || 0;
  return Math.max(0, Math.min(base + elapsed, duration || Infinity));
}

function lyricsCursor(media, lyrics) {
  const lines = (lyrics && lyrics.lines) || [];
  if (!lines.length) return { index: 0, fraction: 0, lines };
  const pos = playbackPosition(media);
  if (lyrics.synced) {
    let index = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const at = Number(lines[i].time);
      if (!Number.isFinite(at)) continue;
      if (at <= pos + 0.05) index = i;
      else break;
    }
    const t0 = Number(lines[index].time) || 0;
    const t1 = Number((lines[index + 1] || {}).time) || t0 + 4;
    const fraction = Math.min(1, Math.max(0, (pos - t0) / Math.max(0.3, t1 - t0)));
    return { index, fraction, lines };
  }
  const duration = Number(media && media.duration) || 0;
  const progress = duration > 0 ? Math.min(1, Math.max(0, pos / duration)) : 0;
  const raw = progress * lines.length;
  return { index: Math.min(lines.length - 1, Math.floor(raw)), fraction: raw % 1, lines };
}

function layoutLyrics(ctx, lines, box) {
  const candidates = [];
  for (const columns of [1, 2, 3, 4]) {
    for (const size of [32, 30, 28, 26, 24, 22, 20, 18, 16]) {
      const lineH = Math.round(size * 1.52);
      const gap = 46;
      const colWidth = (box.width - gap * (columns - 1)) / columns;
      const perColumn = Math.floor(box.height / lineH);
      if (perColumn < 3) continue;
      ctx.font = '400 ' + size + 'px "Segoe UI", sans-serif';
      let totalRows = 0;
      for (const line of lines) {
        const pieces = wrapText(ctx, line, colWidth, 2);
        totalRows += Math.max(1, pieces.length);
      }
      if (totalRows > perColumn * columns) continue;
      candidates.push({ columns, size, lineH, colWidth, gap, perColumn });
    }
  }
  if (!candidates.length) {
    const size = 15;
    const lineH = Math.round(size * 1.45);
    const gap = 28;
    const columns = 4;
    const colWidth = (box.width - gap * (columns - 1)) / columns;
    return { columns, size, lineH, colWidth, gap, perColumn: Math.floor(box.height / lineH), truncated: true };
  }
  candidates.sort((a, b) => b.size - a.size || b.columns - a.columns);
  return candidates[0];
}

async function drawPlayerWallpaper(theme, media, lyrics, lyricsEnabled = true) {
  const canvas = document.createElement('canvas');
  canvas.width = PLAYER_W;
  canvas.height = PLAYER_H;
  const ctx = canvas.getContext('2d');
  const scale = PLAYER_W / 2560;
  ctx.scale(scale, scale);
  const W = 2560;
  const H = 1440;

  let img = null;
  if (media && media.artUrl) {
    try {
      img = await loadImage(media.artUrl);
    } catch { /* no cover */ }
  }

  if (img) {
    ctx.save();
    ctx.filter = 'blur(64px) brightness(0.42) saturate(1.15)';
    coverFit(ctx, img, -100, -100, W + 200, H + 200);
    ctx.restore();
  } else {
    const base = ctx.createLinearGradient(0, 0, W * 0.5, H);
    base.addColorStop(0, theme.wall[0]);
    base.addColorStop(0.6, theme.wall[1]);
    base.addColorStop(1, theme.wall[2]);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
  }

  const tint = ctx.createLinearGradient(0, 0, W, H);
  tint.addColorStop(0, hexA(theme.bg, 0.82));
  tint.addColorStop(0.5, hexA(theme.bg2, 0.62));
  tint.addColorStop(1, hexA(theme.bg, 0.88));
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.24, H * 0.44, 80, W * 0.24, H * 0.44, W * 0.52);
  glow.addColorStop(0, hexA(theme.accent, 0.22));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // --- cover card -------------------------------------------------------
  const size = 740;
  const cx = 130;
  const cy = 210;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 70;
  ctx.shadowOffsetY = 26;
  ctx.fillStyle = theme.bg2;
  roundRectPath(ctx, cx, cy, size, size, 34);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, cx, cy, size, size, 34);
  ctx.clip();
  if (img) {
    coverFit(ctx, img, cx, cy, size, size);
  } else {
    const g = ctx.createLinearGradient(cx, cy, cx + size, cy + size);
    g.addColorStop(0, theme.accent);
    g.addColorStop(1, theme.accent2);
    ctx.fillStyle = g;
    ctx.fillRect(cx, cy, size, size);
    ctx.fillStyle = hexA(theme.onAccent || '#ffffff', 0.85);
    ctx.font = '400 220px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♪', cx + size / 2, cy + size / 2 - 10);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = hexA(theme.accent, 0.5);
  ctx.lineWidth = 3;
  roundRectPath(ctx, cx - 1.5, cy - 1.5, size + 3, size + 3, 36);
  ctx.stroke();
  ctx.restore();

  // --- text column ------------------------------------------------------
  const colX = 1010;
  const colW = 1400;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const title = (media && media.title) || 'Nothing playing';
  const artist = (media && media.artist) || '';

  ctx.fillStyle = hexA(theme.accent, 0.9);
  ctx.font = '600 26px "Segoe UI", sans-serif';
  ctx.fillText('NOW PLAYING', colX, cy + 26);

  ctx.fillStyle = theme.text;
  ctx.font = '700 76px "Segoe UI", "Segoe UI Semibold", sans-serif';
  const titleLines = wrapText(ctx, title, colW, 2);
  let textY = cy + 120;
  for (const line of titleLines) {
    ctx.fillText(line, colX, textY);
    textY += 88;
  }

  if (artist) {
    ctx.fillStyle = hexA(theme.text, 0.62);
    ctx.font = '400 40px "Segoe UI", sans-serif';
    ctx.fillText(artist, colX, textY + 8);
    textY += 74;
  }

  // --- lyrics: the full text, static, fitted into columns --------------
  const titleBlockBottom = Math.max(textY + 40, 500);

  const lyricsLines = ((lyrics && lyrics.lines) || [])
    .map((row) => (row && row.text) || '')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lyricsLines.length) {
    const layout = layoutLyrics(ctx, lyricsLines, {
      width: W - colX - 110,
      height: H - titleBlockBottom - 250,
    });

    ctx.font = `400 ${layout.size}px "Segoe UI", sans-serif`;
    ctx.fillStyle = hexA(theme.text, 0.74);

    let column = 0;
    let rowIndex = 0;
    for (let i = 0; i < lyricsLines.length; i += 1) {
      const pieces = wrapText(ctx, lyricsLines[i], layout.colWidth, 2);
      if (!pieces.length) continue;
      if (rowIndex + pieces.length > layout.perColumn) {
        column += 1;
        rowIndex = 0;
      }
      if (column >= layout.columns) break;
      let y = titleBlockBottom + layout.size + rowIndex * layout.lineH;
      for (const piece of pieces) {
        ctx.fillText(piece, colX + column * (layout.colWidth + layout.gap), y);
        y += layout.lineH;
      }
      rowIndex += pieces.length;
    }
  } else if (lyricsEnabled) {
    ctx.fillStyle = hexA(theme.text, 0.34);
    ctx.font = '400 32px "Segoe UI", sans-serif';
    ctx.fillText('Lyrics not found for this track', colX, titleBlockBottom + 46);
  }
  // --- progress ---------------------------------------------------------
  const barX = cx;
  const barY = H - 120;
  const barW = W - cx * 2;
  const barH = 8;
  ctx.fillStyle = hexA(theme.text, 0.16);
  roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fill();

  const duration = Number(media && media.duration) || 0;
  const pos = playbackPosition(media);
  const fraction = duration > 0 ? Math.min(1, pos / duration) : 0;
  if (fraction > 0) {
    const g = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    g.addColorStop(0, theme.accent);
    g.addColorStop(1, theme.accent2);
    ctx.fillStyle = g;
    roundRectPath(ctx, barX, barY, Math.max(barH, barW * fraction), barH, barH / 2);
    ctx.fill();
  }

  ctx.fillStyle = hexA(theme.text, 0.55);
  ctx.font = '400 24px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(fmtTime(pos), barX, barY - 18);
  ctx.textAlign = 'right';
  ctx.fillText(fmtTime(duration), barX + barW, barY - 18);

  const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.98);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  return canvas.toDataURL('image/jpeg', 0.9);
}

async function ensureArtUrl(maxWaitMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    if (state.media && state.media.artUrl) return state.media.artUrl;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  return null;
}

async function renderPlayerWallpaper(silent = false) {
  const current = state.media;
  if (!current || !current.hasSession) return { ok: false, error: 'no-track' };
  const trackKey = `${current.title || ''}|${current.artist || ''}`;

  // The catalogue cover may arrive a moment after the track starts — wait for
  // it once per track instead of painting the placeholder note.
  if (!current.artUrl && state.playerArtWaitKey !== trackKey) {
    state.playerArtWaitKey = trackKey;
    await ensureArtUrl(6000);
  }

  const media = state.media || current;
  const lyricsEnabled = state.settings.wallpaperLyrics !== false;
  try {
    if (lyricsEnabled && (!state.playerLyrics || state.playerLyricsKey !== trackKey)) {
      state.playerLyrics = await api.lyrics.get({
        title: media.title,
        artist: media.artist,
        duration: media.duration,
      });
      state.playerLyricsKey = trackKey;
    }
    const dataUrl = await drawPlayerWallpaper(
      state.theme,
      media,
      lyricsEnabled ? state.playerLyrics : null,
      lyricsEnabled
    );
    const res = await api.system.wallpaperFromDataUrl({ dataUrl, themeId: state.theme.id, slot: 'player' });
    if (res && res.ok) {
      if (!silent) toast('Обои с плеером обновлены');
    } else if (!silent) {
      toast('Не удалось поставить обои');
    }
    return res;
  } catch (err) {
    if (!silent) toast('Ошибка обоев: ' + err.message);
    return { ok: false, error: err.message };
  }
}

async function generatePlayerWallpaper(silent = false) {
  return renderPlayerWallpaper(silent);
}

function ensurePlayerLoop() {
  const active = state.settings.wallpaperSource === 'player' && state.settings.applyWallpaper;
  if (!active) {
    if (state.playerLoop) {
      clearInterval(state.playerLoop);
      state.playerLoop = null;
    }
    return;
  }
  if (state.playerLoop) return;
  state.playerLoop = setInterval(async () => {
    const media = state.media;
    if (!media || !media.hasSession || !media.playing || state.playerBusy) return;
    state.playerBusy = true;
    try {
      await renderPlayerWallpaper(true);
    } catch { /* keep the loop alive */ } finally {
      state.playerBusy = false;
    }
  }, 800);
}

async function regenerateWallpaperForMode(silent = false) {
  if (state.settings.wallpaperSource === 'player') {
    ensurePlayerLoop();
    return generatePlayerWallpaper(silent);
  }
  return generateWallpaper(state.theme, silent, { pattern: state.settings.wallpaperPattern });
}

/* ---------------------- wallpaper patterns, slideshow, preview ---------------------- */

function syncWallpaperUi() {
  const source = state.settings.wallpaperSource || 'pattern';
  $$('#seg-wallsrc button').forEach((b) => b.classList.toggle('on', b.dataset.src === source));
  const isPlayer = source === 'player';
  const patternSeg = $('#seg-pattern');
  const slideshow = $('#slideshow-wrap');
  const lyricsWrap = $('#lyrics-wrap');
  if (patternSeg) patternSeg.style.display = isPlayer ? 'none' : '';
  if (slideshow) slideshow.style.display = isPlayer ? 'none' : '';
  if (lyricsWrap) lyricsWrap.style.display = isPlayer ? '' : 'none';
  setSwitch($('#sw-lyrics'), state.settings.wallpaperLyrics !== false);
  $$('#seg-pattern button').forEach((b) => b.classList.toggle('on', b.dataset.pattern === (state.settings.wallpaperPattern || 'aurora')));
  setSwitch($('#sw-slideshow'), state.settings.slideshowEnabled);
  $('#slideshow-minutes').value = String(state.settings.slideshowMinutes || 30);
}

async function pickPattern(pattern) {
  state.settings.wallpaperPattern = pattern;
  await api.settings.patch({ wallpaperPattern: pattern });
  syncWallpaperUi();
  if (pattern === 'custom' && !(state.settings.wallpaperDrawing || []).length) {
    openDrawModal();
    return;
  }
  await generateWallpaper(state.theme, false, { pattern });
  if (state.settings.applyWallpaper) toast('Обои обновлены');
}

let slideIndex = 0;
async function slideshowTick() {
  const patterns = WALLPAPER_PATTERNS.filter((p) => p !== 'custom' || (state.settings.wallpaperDrawing || []).length);
  if (!patterns.length) return;
  slideIndex = (slideIndex + 1) % patterns.length;
  await generateWallpaper(state.theme, true, { pattern: patterns[slideIndex], slot: 'slide' });
}

function renderPreview() {
  const m = state.media;
  const has = m && m.hasSession;
  const title = $('#ovp-title');
  if (!title) return;
  title.textContent = has && m.title ? m.title : 'Тишина в эфире';
  $('#ovp-sub').textContent = has
    ? `${m.artist || 'без исполнителя'}${m.app ? ' · ' + m.app : ''}`
    : 'включи музыку — я подхвачу';
  const art = has ? m.artUrl : null;
  const artEl = $('#ovp-art');
  if (art) {
    artEl.style.backgroundImage = `url("${art}")`;
    artEl.textContent = '';
  } else {
    artEl.style.backgroundImage = '';
    artEl.textContent = '♪';
  }
  const dur = has ? Number(m.duration) || 0 : 0;
  const base = has ? Number(m.position) || 0 : 0;
  const elapsed = has && m.playing ? Date.now() - (m.receivedAt || Date.now()) : 0;
  const pos = Math.min(base + elapsed, dur || Infinity);
  $('#ovp-fill').style.width = dur > 0 ? Math.min(100, (pos / dur) * 100) + '%' : '0%';
  $('#ovp-pos').textContent = fmtTime(pos);
  $('#ovp-dur').textContent = fmtTime(dur);
  $('#ovp-play').innerHTML = has && m.playing ? ICONS.pause : ICONS.play;
  $('#ovp').style.setProperty('--ovp-radius', Math.max(6, Number(state.settings.overlay.radius ?? 24)) + 'px');
}

function renderHistory(items) {
  const el = $('#history-list');
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="muted" style="font-size:12.5px;padding:6px 2px">Пока пусто — включи музыку.</div>';
    return;
  }
  el.innerHTML = items
    .slice(0, 8)
    .map(
      (item) => `
    <div class="history-row">
      <div class="h-art"></div>
      <div class="h-title">${esc(item.title || 'Без названия')}</div>
      <div class="h-app">${esc(item.artist || item.app || '')}</div>
    </div>`
    )
    .join('');
}

/* ---------------------------- display ---------------------------- */

async function refreshDisplayInfo() {
  const res = await api.display.get();
  const brightness = $('#brightness-val');
  const contrast = $('#contrast-val');
  if (!res || !res.ok || !res.supported) {
    brightness.textContent = 'монитор не поддерживает DDC/CI';
    contrast.textContent = '—';
    $('#range-brightness').disabled = true;
    $('#range-contrast').disabled = true;
    return;
  }
  $('#range-brightness').disabled = false;
  $('#range-contrast').disabled = false;
  if (res.brightness !== null && res.brightness !== undefined) {
    $('#range-brightness').value = res.brightness;
    brightness.textContent = res.brightness + '%';
  } else {
    brightness.textContent = 'недоступно';
  }
  if (res.contrast !== null && res.contrast !== undefined) {
    $('#range-contrast').value = res.contrast;
    contrast.textContent = res.contrast + '%';
  } else {
    contrast.textContent = 'недоступно';
  }
}

function syncWarmUi() {
  const cfg = state.settings.display || {};
  setSwitch($('#sw-warm'), !!cfg.warm);
  $('#range-warm').value = Number(cfg.warmStrength) || 45;
  $('#warm-val').textContent = Number(cfg.warmStrength) || 45;
}

/* ------------------------ app hotkeys list ------------------------ */

function renderAppHotkeys() {
  const list = $('#apphotkeys-list');
  if (!list) return;
  const pinned = state.pinned || [];
  const map = state.settings.appHotkeys || {};
  if (!pinned.length) {
    list.innerHTML = '<div class="muted" style="font-size:12.5px">Сначала закрепи приложения в доке.</div>';
    return;
  }
  list.innerHTML = pinned
    .map(
      (app) => `
    <div class="apphotkey-row">
      <div class="ico">${appIconHtml(app, 12)}</div>
      <div class="nm">${esc(app.name)}</div>
      <input class="hotkey-input" data-apphk="${esc(app.id)}" readonly value="${esc(map[app.id] || '')}" placeholder="не задано" />
    </div>`
    )
    .join('');

  list.querySelectorAll('[data-apphk]').forEach((input) => {
    const appId = input.dataset.apphk;
    input.addEventListener('keydown', async (e) => {
      e.preventDefault();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const next = { ...(state.settings.appHotkeys || {}) };
        delete next[appId];
        state.settings.appHotkeys = next;
        input.value = '';
        await api.appHotkeys.set(next);
        toast('Хоткей снят');
        return;
      }
      const accel = hotkeyFromEvent(e);
      if (!accel) return;
      const next = { ...(state.settings.appHotkeys || {}), [appId]: accel };
      state.settings.appHotkeys = next;
      input.value = accel;
      await api.appHotkeys.set(next);
      toast('Хоткей сохранён: ' + accel);
    });
    input.addEventListener('focus', () => {
      input.value = '';
    });
    input.addEventListener('blur', () => {
      input.value = (state.settings.appHotkeys || {})[appId] || '';
    });
  });
}

/* --------------------------- draw modal --------------------------- */

const drawState = { strokes: [], current: null, size: 10, painting: false };

function drawOnCanvas() {
  const canvas = $('#draw-canvas');
  const ctx = canvas.getContext('2d');
  const theme = state.theme;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const g = ctx.createLinearGradient(0, 0, canvas.width * 0.5, canvas.height);
  g.addColorStop(0, theme.wall[0]);
  g.addColorStop(0.6, theme.wall[1]);
  g.addColorStop(1, theme.wall[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const all = drawState.current ? [...drawState.strokes, drawState.current] : drawState.strokes;
  for (const stroke of all) {
    if (!stroke.points || stroke.points.length < 2) continue;
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const x = p[0] * canvas.width;
      const y = p[1] * canvas.height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = Math.max(2, stroke.size * (canvas.width / 1200));
    ctx.stroke();
  }
}

function openDrawModal() {
  const backdrop = $('#draw-backdrop');
  if (!backdrop) return;
  drawState.strokes = (state.settings.wallpaperDrawing || []).map((s) => ({
    size: Number(s.size) || 10,
    points: (s.points || []).map((p) => [p[0], p[1]]),
  }));
  drawState.current = null;
  drawOnCanvas();
  backdrop.classList.add('open');
}

function closeDrawModal() {
  const backdrop = $('#draw-backdrop');
  if (backdrop) backdrop.classList.remove('open');
}

function canvasPoint(event) {
  const canvas = $('#draw-canvas');
  const rect = canvas.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  ];
}

async function applyDrawing() {
  const strokes = drawState.strokes
    .filter((s) => s.points.length > 1)
    .map((s) => ({ size: s.size, points: s.points }));
  state.settings.wallpaperDrawing = strokes;
  state.settings.wallpaperPattern = 'custom';
  await api.settings.patch({ wallpaperDrawing: strokes, wallpaperPattern: 'custom' });
  closeDrawModal();
  syncWallpaperUi();
  await generateWallpaper(state.theme, false, { pattern: 'custom' });
  toast('Свой узор сохранён');
}

/* ------------------------- wallpaper art ------------------------- */

const WALLPAPER_PATTERNS = ['aurora', 'waves', 'grid', 'dots', 'rings', 'custom'];

function drawPattern(ctx, W, H, theme, pattern, drawing) {
  const blob = (x, y, r, color, alpha) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(color, alpha));
    g.addColorStop(0.45, hexA(color, alpha * 0.45));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  if (pattern === 'waves') {
    for (let i = 0; i < 8; i++) {
      const amp = H * (0.04 + i * 0.012);
      const yBase = H * (0.12 + i * 0.105);
      ctx.beginPath();
      for (let x = 0; x <= W; x += 10) {
        const y = yBase + Math.sin((x / W) * Math.PI * 2.4 + i * 0.9) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = hexA(i % 2 ? theme.accent2 : theme.accent, 0.2);
      ctx.lineWidth = 2 + (i % 3);
      ctx.stroke();
    }
    blob(W * 0.28, H * 0.3, W * 0.55, theme.accent, 0.28);
    blob(W * 0.78, H * 0.72, W * 0.5, theme.accent2, 0.24);
    return;
  }

  if (pattern === 'grid') {
    blob(W * 0.5, H * 0.45, W * 0.6, theme.accent, 0.34);
    blob(W * 0.15, H * 0.85, W * 0.45, theme.aura, 0.3);
    const step = W / 28;
    ctx.strokeStyle = hexA('#ffffff', 0.055);
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    return;
  }

  if (pattern === 'dots') {
    const step = 36;
    const cx = W * 0.34;
    const cy = H * 0.46;
    for (let y = step / 2; y < H; y += step) {
      for (let x = step / 2; x < W; x += step) {
        const d = Math.min(1, Math.hypot(x - cx, y - cy) / (W * 0.72));
        const r = 7 * (1 - d);
        if (r < 1.1) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = hexA(theme.accent, 0.1 + 0.28 * (1 - d));
        ctx.fill();
      }
    }
    blob(cx, cy, W * 0.42, theme.accent, 0.35);
    blob(W * 0.74, H * 0.22, W * 0.45, theme.accent2, 0.3);
    return;
  }

  if (pattern === 'rings') {
    const cx = W * 0.66;
    const cy = H * 0.4;
    for (let i = 0; i < 17; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, 120 + i * 76, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(i % 2 ? theme.accent2 : theme.accent, Math.max(0.03, 0.16 - i * 0.006));
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    blob(cx, cy, W * 0.42, theme.accent, 0.38);
    blob(W * 0.2, H * 0.8, W * 0.42, theme.aura, 0.28);
    return;
  }

  if (pattern === 'custom' && Array.isArray(drawing) && drawing.length) {
    blob(W * 0.5, H * 0.5, W * 0.62, theme.accent, 0.26);
    blob(W * 0.2, H * 0.2, W * 0.4, theme.accent2, 0.2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of drawing) {
      if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) continue;
      ctx.beginPath();
      stroke.points.forEach((point, index) => {
        const x = point[0] * W;
        const y = point[1] * H;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = hexA(theme.accent, 0.8);
      ctx.lineWidth = Math.max(2, (Number(stroke.size) || 8) * (W / 1200));
      ctx.stroke();
    }
    return;
  }

  blob(W * 0.16, H * 0.22, W * 0.62, theme.accent, 0.5);
  blob(W * 0.86, H * 0.14, W * 0.5, theme.accent2, 0.42);
  blob(W * 0.72, H * 0.92, W * 0.58, theme.aura, 0.34);
  blob(W * 0.34, H * 0.78, W * 0.42, theme.accent2, 0.22);
}

function drawWallpaper(theme, pattern) {
  const W = 2560;
  const H = 1440;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const base = ctx.createLinearGradient(0, 0, W * 0.4, H);
  base.addColorStop(0, theme.wall[0]);
  base.addColorStop(0.55, theme.wall[1]);
  base.addColorStop(1, theme.wall[2]);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  drawPattern(ctx, W, H, theme, pattern || 'aurora', state.settings?.wallpaperDrawing || []);

  // diagonal light sheen
  ctx.save();
  ctx.translate(W * 0.5, H * 0.5);
  ctx.rotate(-0.35);
  const sheen = ctx.createLinearGradient(-W, 0, W, 0);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.48, hexA('#ffffff', 0.06));
  sheen.addColorStop(0.52, hexA('#ffffff', 0.045));
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(-W, -H, W * 2, H * 2);
  ctx.restore();

  // vignette
  const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.95);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, hexA(theme.dark ? '#000000' : '#2a2a2a', theme.dark ? 0.55 : 0.16));
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  return canvas.toDataURL('image/png');
}

function hexA(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

async function generateWallpaper(theme, silent = false, options = {}) {
  const t = theme || state.theme;
  const pattern = options.pattern || state.settings.wallpaperPattern || 'aurora';
  try {
    if (!silent) toast('Рисую обои…', 1200);
    const dataUrl = drawWallpaper(t, pattern);
    const res = await api.system.wallpaperFromDataUrl({ dataUrl, themeId: t.id, slot: options.slot });
    if (res.ok) toast(silent ? 'Обои обновлены под тему' : 'Обои рабочего стола обновлены');
    else toast('Не удалось поставить обои: ' + (res.error || 'ошибка'));
    return res;
  } catch (err) {
    toast('Ошибка обоев: ' + err.message);
    return { ok: false, error: err.message };
  }
}

/* ---------------------------- media ---------------------------- */

function renderMedia() {
  const m = state.media;
  const has = m && m.hasSession;
  const title = has && m.title ? m.title : 'Тишина в эфире';
  const artist = has && m.artist ? m.artist : has ? 'без исполнителя' : 'Включи что-нибудь — оверлей подхватит';

  $('#mini-title').textContent = title;
  $('#mini-sub').textContent = has ? `${m.artist || '—'} · ${m.app || ''}`.trim() : 'ничего не играет';
  $('#now-title').textContent = title;
  $('#now-artist').textContent = artist;
  $('#now-app').textContent = has ? m.app || 'аудио' : 'нет сессии';
  $('#now-status').textContent = has ? statusLabel(m.status) : '—';

  const artUrl = has ? m.artUrl : null;
  for (const id of ['#mini-art', '#big-art']) {
    const node = $(id);
    if (artUrl) {
      node.style.backgroundImage = `url("${artUrl}")`;
      node.textContent = '';
    } else {
      node.style.backgroundImage = '';
      node.textContent = has ? '♪' : '♪';
    }
  }
  $('#mini-play').innerHTML = has && m.playing ? ICONS.pause : ICONS.play;
  $('#play-icon').outerHTML = has && m.playing ? ICONS.pause.replace('<svg', '<svg id="play-icon"') : ICONS.play.replace('<svg', '<svg id="play-icon"');
  $('#big-art').classList.toggle('playing', !!has && m.playing);

  $('#btn-shuffle').classList.toggle('on', !!(has && m.shuffle));
  $('#btn-repeat').classList.toggle('on', !!(has && m.repeat));
  $('#nav-badge-music').textContent = has ? (m.playing ? 'on' : tr('пауза')) : 'off';
  $('#nav-badge-music').style.color = has && m.playing ? 'var(--accent)' : '';

  updateProgress();
  renderPreview();
  if (!state.progressTimer) state.progressTimer = setInterval(progressLoop, 250);
}

function statusLabel(status) {
  switch (status) {
    case 'Playing':
      return tr('играет');
    case 'Paused':
      return tr('пауза');
    case 'Stopped':
      return tr('остановлено');
    default:
      return String(status || '—').toLowerCase();
  }
}

function currentPosition() {
  const m = state.media;
  if (!m || !m.hasSession) return 0;
  if (state.seekOverride && Date.now() < state.seekOverride.until) return state.seekOverride.value;
  let pos = Number(m.position) || 0;
  if (m.playing) pos += Date.now() - (m.receivedAt || Date.now());
  return Math.max(0, Math.min(pos, Number(m.duration) || pos));
}

function updateProgress() {
  const m = state.media;
  const dur = m && m.hasSession ? Number(m.duration) || 0 : 0;
  const pos = currentPosition();
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  const fill = $('#progress-fill');
  if (fill) fill.style.width = pct + '%';
  const cur = $('#pos-cur');
  const durEl = $('#pos-dur');
  if (cur) cur.textContent = fmtTime(pos);
  if (durEl) durEl.textContent = fmtTime(dur);
}

function progressLoop() {
  updateProgress();
  if (state.view === 'music') renderPreview();
}

function mediaCommand(action, value = null) {
  api.media.command({ action, value, target: state.media?.displayAppId || state.media?.appId || null });
}

/* ---------------------------- dock ---------------------------- */

function appInitial(name) {
  return esc((name || '?').trim().charAt(0).toUpperCase());
}

function appIconHtml(app, size) {
  if (app.iconUrl) return `<img src="${esc(app.iconUrl)}" alt="" />`;
  return `<span style="font-size:${size || 16}px">${appInitial(app.name)}</span>`;
}

function renderPinned() {
  const grid = $('#pinned-grid');
  const pinned = state.pinned;
  $('#nav-badge-dock').textContent = String(pinned.length);

  if (!pinned.length) {
    grid.innerHTML = `<div class="dock-empty"><div style="font-weight:600;color:var(--text)">Пока пусто</div><div>Выбери приложение ниже и нажми на булавку</div></div>`;
    return;
  }

  grid.innerHTML = pinned
    .map(
      (app) => `
    <div class="dock-tile" draggable="true" data-id="${esc(app.id)}" title="${esc(app.name)}">
      <button class="dock-remove" data-remove="${esc(app.id)}" title="Убрать">${ICONS.x}</button>
      <div class="dock-icon">${appIconHtml(app, 17)}</div>
      <div class="dock-name">${esc(app.name)}</div>
    </div>`
    )
    .join('');

  let dragId = null;
  grid.querySelectorAll('.dock-tile').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) return;
      launchApp(tile.dataset.id, tile.dataset.id);
    });
    tile.querySelector('[data-remove]').addEventListener('click', async (e) => {
      e.stopPropagation();
      state.pinned = await api.apps.unpin(tile.dataset.id);
      renderPinned();
    });
    tile.addEventListener('dragstart', () => {
      dragId = tile.dataset.id;
      tile.classList.add('dragging');
    });
    tile.addEventListener('dragend', () => {
      dragId = null;
      tile.classList.remove('dragging');
      grid.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
    });
    tile.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragId && dragId !== tile.dataset.id) tile.classList.add('drag-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
    tile.addEventListener('drop', async (e) => {
      e.preventDefault();
      tile.classList.remove('drag-over');
      if (!dragId || dragId === tile.dataset.id) return;
      const ids = state.pinned.map((p) => p.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(tile.dataset.id);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      state.pinned = await api.apps.reorder(ids);
      renderPinned();
    });
  });
}

function renderFrequent() {
  const row = $('#freq-row');
  const usage = state.usage || {};
  const entries = Object.entries(usage)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (!entries.length) {
    row.innerHTML = `<span class="muted" style="font-size:12.5px">Пока ничего не запускали через Overlayr.</span>`;
    return;
  }
  const byId = new Map(state.apps.map((a) => [a.id, a]));
  row.innerHTML = '';
  for (const [id, count] of entries) {
    const app = byId.get(id);
    if (!app) continue;
    const chip = document.createElement('button');
    chip.className = 'btn small';
    chip.innerHTML = `<span style="width:16px;height:16px;display:inline-grid;place-items:center;overflow:hidden;border-radius:4px">${appIconHtml(app, 10)}</span> ${esc(app.name)} <span class="muted" style="font-size:10.5px">${count}</span>`;
    chip.addEventListener('click', () => launchApp(id, app.name));
    row.appendChild(chip);
  }
}

function renderCatalog() {
  const query = ($('#app-search').value || '').toLowerCase().trim();
  const catalog = $('#catalog');
  const pinnedIds = new Set(state.pinned.map((p) => p.id));
  const list = state.apps.filter((a) => !query || a.name.toLowerCase().includes(query));

  $('#apps-count').textContent = `· ${state.apps.length}`;

  if (!state.apps.length) {
    catalog.innerHTML = `<div class="empty-note">Сканирую меню «Пуск»… <span class="spinner" style="display:inline-block;vertical-align:middle;margin-left:6px"></span></div>`;
    return;
  }
  if (!list.length) {
    catalog.innerHTML = `<div class="empty-note">Ничего не найдено по «${esc(query)}»</div>`;
    return;
  }

  catalog.innerHTML = list
    .slice(0, 400)
    .map(
      (a) => `
    <div class="app-line" data-id="${esc(a.id)}">
      <div class="ico">${appIconHtml(a, 12)}</div>
      <div class="nm">${esc(a.name)}</div>
      <button class="pin-btn ${pinnedIds.has(a.id) ? 'pinned' : ''}" data-pin="${esc(a.id)}" title="${pinnedIds.has(a.id) ? 'Открепить' : 'Закрепить'}">${ICONS.pin}</button>
    </div>`
    )
    .join('');

  catalog.querySelectorAll('.app-line').forEach((line) => {
    line.addEventListener('click', (e) => {
      if (e.target.closest('[data-pin]')) return;
      launchApp(line.dataset.id, line.querySelector('.nm').textContent);
    });
    line.querySelector('[data-pin]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = e.currentTarget.dataset.pin;
      await togglePin(id);
    });
  });
}

async function togglePin(id) {
  const pinnedIds = new Set(state.pinned.map((p) => p.id));
  const app = state.apps.find((a) => a.id === id);
  if (!app) return;
  if (pinnedIds.has(id)) {
    state.pinned = await api.apps.unpin(id);
    toast(`«${app.name}» убрано из дока`, 1600);
  } else {
    state.pinned = await api.apps.pin({ ...app, iconPath: app.iconUrl ? null : null });
    toast(`«${app.name}» закреплено`, 1600);
  }
  renderPinned();
  renderCatalog();
}

async function launchApp(id, name) {
  const res = await api.apps.launch(id);
  if (!res.ok) toast(`Не удалось запустить ${name || ''}`.trim());
}

async function refreshApps(manual = false) {
  if (manual) toast('Обновляю список приложений…', 1600);
  state.apps = await api.apps.refresh();
  renderCatalog();
  if (manual) toast(`Найдено ${state.apps.length} приложений`);
}

/* --------------------------- settings --------------------------- */

function setSwitch(el, on) {
  if (!el) return;
  el.classList.toggle('on', !!on);
}

function bindSwitch(sel, initial, onChange) {
  const el = $(sel);
  if (!el) return;
  setSwitch(el, initial);
  let value = !!initial;
  el.addEventListener('click', async () => {
    value = !value;
    setSwitch(el, value);
    await onChange(value);
  });
}

function patchSettings(partial) {
  api.settings.patch(partial).then((next) => {
    state.settings = next;
  });
}

function patchOverlay(partial) {
  const merged = { ...state.settings.overlay, ...partial };
  state.settings.overlay = merged;
  api.overlay.set(partial);
}

function syncOverlayUi() {
  const o = state.settings.overlay;
  $$('#seg-layout button').forEach((b) => b.classList.toggle('on', b.dataset.layout === o.layout));
  $$('#seg-volume button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (o.volumeMode || 'app')));
  $('#range-width').value = o.width;
  $('#width-val').textContent = o.width;
  $('#range-opacity').value = Math.round(o.opacity * 100);
  $('#opacity-val').textContent = Math.round(o.opacity * 100);
  $('#range-radius').value = Number(o.radius ?? 24);
  $('#radius-val').textContent = Number(o.radius ?? 24);
  setSwitch($('#sw-visualizer'), o.showVisualizer);
  setSwitch($('#sw-progress'), o.showProgress);
  setSwitch($('#sw-volume'), o.showVolume);
  setSwitch($('#sw-clock'), o.showClock);
  setSwitch($('#sw-stats'), o.showStats);
  setSwitch($('#sw-onTop'), o.alwaysOnTop);
  setSwitch($('#sw-clickThrough'), o.clickThrough);
  setSwitch($('#sw-peek'), o.peekMode !== false);
  setSwitch($('#sw-spectrum'), o.spectrum !== false);
  $$('#seg-spectrum button').forEach((b) => b.classList.toggle('on', b.dataset.style === (o.spectrumStyle || 'bars')));
  $('#range-sens').value = Number(o.spectrumSensitivity ?? 100);
  $('#sens-val').textContent = Number(o.spectrumSensitivity ?? 100);
  setSwitch($('#sw-fullscreen'), o.hideInFullscreen !== false);
  renderPreview();
  syncWallpaperUi();
  $('#btn-toggle-overlay').textContent = o.visible ? 'Скрыть оверлей' : 'Показать оверлей';
}

function bindOverlayControls() {
  $$('#seg-layout button').forEach((btn) => {
    btn.addEventListener('click', () => {
      patchOverlay({ layout: btn.dataset.layout });
      syncOverlayUi();
    });
  });

  const widthRange = $('#range-width');
  widthRange.addEventListener('input', () => {
    $('#width-val').textContent = widthRange.value;
    patchOverlay({ width: Number(widthRange.value) });
  });

  const opacityRange = $('#range-opacity');
  opacityRange.addEventListener('input', () => {
    $('#opacity-val').textContent = opacityRange.value;
    patchOverlay({ opacity: Number(opacityRange.value) / 100 });
  });

  const radiusRange = $('#range-radius');
  radiusRange.addEventListener('input', () => {
    $('#radius-val').textContent = radiusRange.value;
    patchOverlay({ radius: Number(radiusRange.value) });
  });

  $$('#seg-volume button').forEach((btn) => {
    btn.addEventListener('click', () => {
      patchOverlay({ volumeMode: btn.dataset.mode });
      syncOverlayUi();
      toast(btn.dataset.mode === 'app' ? 'Громкость только выбранного приложения' : 'Громкость всей системы', 1800);
    });
  });

  $$('#seg-spectrum button').forEach((btn) => {
    btn.addEventListener('click', () => {
      patchOverlay({ spectrumStyle: btn.dataset.style });
      syncOverlayUi();
    });
  });

  $('#range-sens').addEventListener('input', (e) => {
    $('#sens-val').textContent = e.target.value;
    patchOverlay({ spectrumSensitivity: Number(e.target.value) });
  });

  const map = [
    ['#sw-visualizer', 'showVisualizer'],
    ['#sw-progress', 'showProgress'],
    ['#sw-volume', 'showVolume'],
    ['#sw-clock', 'showClock'],
    ['#sw-stats', 'showStats'],
    ['#sw-onTop', 'alwaysOnTop'],
    ['#sw-clickThrough', 'clickThrough'],
    ['#sw-peek', 'peekMode'],
    ['#sw-spectrum', 'spectrum'],
    ['#sw-fullscreen', 'hideInFullscreen'],
  ];
  for (const [sel, key] of map) {
    const el = $(sel);
    const initial = state.settings.overlay[key];
    let value = !!initial;
    setSwitch(el, initial);
    el.addEventListener('click', () => {
      value = !value;
      setSwitch(el, value);
      patchOverlay({ [key]: value });
      syncOverlayUi();
      if (key === 'clickThrough' && value) toast('Клики насквозь включены. Выключить: Ctrl+Alt+M', 3200);
    });
  }

  $('#btn-overlay-show').addEventListener('click', async () => {
    await api.overlay.show();
    state.settings.overlay.visible = true;
    syncOverlayUi();
  });
  $('#btn-toggle-overlay').addEventListener('click', async () => {
    const visible = !state.settings.overlay.visible;
    if (visible) await api.overlay.show();
    else await api.overlay.hide();
    state.settings.overlay.visible = visible;
    syncOverlayUi();
  });
  $('#btn-overlay-reset').addEventListener('click', async () => {
    await api.overlay.set({ x: null, y: null });
    state.settings.overlay.x = null;
    state.settings.overlay.y = null;
    toast('Оверлей вернулся в угол экрана');
  });
}

/* --------------------------- nav --------------------------- */

function showView(name) {
  state.view = name;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $('.content').scrollTop = 0;
}

/* --------------------------- modal picker --------------------------- */

function openModal() {
  const modal = $('#modal-backdrop');
  modal.classList.add('open');
  $('#modal-search').value = '';
  renderModalList('');
  setTimeout(() => $('#modal-search').focus(), 60);
}

function closeModal() {
  $('#modal-backdrop').classList.remove('open');
}

function renderModalList(query) {
  const q = (query || '').toLowerCase().trim();
  const pinnedIds = new Set(state.pinned.map((p) => p.id));
  const list = state.apps.filter((a) => !q || a.name.toLowerCase().includes(q)).slice(0, 300);
  const wrap = $('#modal-list');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-note">Ничего не найдено</div>`;
    return;
  }
  wrap.innerHTML = list
    .map(
      (a) => `
    <div class="app-line" data-id="${esc(a.id)}">
      <div class="ico">${appIconHtml(a, 12)}</div>
      <div class="nm">${esc(a.name)}</div>
      <button class="pin-btn ${pinnedIds.has(a.id) ? 'pinned' : ''}" data-pin="${esc(a.id)}">${ICONS.pin}</button>
    </div>`
    )
    .join('');
  wrap.querySelectorAll('.app-line').forEach((line) => {
    line.addEventListener('click', async (e) => {
      if (e.target.closest('[data-pin]')) return;
      const app = state.apps.find((a) => a.id === line.dataset.id);
      closeModal();
      if (app) {
        state.pinned = await api.apps.pin(app);
        renderPinned();
        renderCatalog();
        toast(`«${app.name}» закреплено в доке`);
      }
    });
  });
}

/* --------------------------- settings wiring --------------------------- */

function renderSettings() {
  const s = state.settings;
  setSwitch($('#sw-autostart'), s.launchAtLogin);
  $$('#seg-lang button').forEach((b) => b.classList.toggle('on', b.dataset.lang === (s.language || 'en')));
  setSwitch($('#sw-overlayStart'), s.overlay.visible);
  setSwitch($('#sw-sysDark'), s.applyDarkMode);
  setSwitch($('#sw-sysAccent'), s.applyAccent);
  setSwitch($('#sw-sysWall'), s.applyWallpaper);
  setSwitch($('#sw-dark'), s.applyDarkMode);
  setSwitch($('#sw-accent'), s.applyAccent);
  setSwitch($('#sw-wallpaper'), s.applyWallpaper);
  api.system.desktopIcons().then((res) => {
    if (res && res.ok && typeof res.visible === 'boolean') setSwitch($('#sw-desktopicons'), !res.visible);
  }).catch(() => {});
  $('#app-version').textContent = 'v' + (state.system?.version || '1.0.0');
  api.app.dataDir().then((dir) => {
    $('#data-dir').textContent = dir;
  });
  const hk = s.hotkeys || {};
  $$('.hotkey-input').forEach((input) => {
    input.value = hk[input.dataset.hk] || '';
  });
}

function hotkeyFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
  if (!mods.length) return null;
  let k = key.length === 1 ? key.toUpperCase() : key;
  if (k === ' ') k = 'Space';
  return mods.join('+') + '+' + k;
}

async function systemStatus(manual = false) {
  const st = await api.system.status();
  if (!st || st.ok === false) {
    $('#sys-status').textContent = 'нет данных';
    return;
  }
  const parts = [st.dark ? 'тёмный' : 'светлый', 'акцент ' + st.accent];
  $('#sys-status').textContent = parts.join(' · ');
  if (manual) toast('Windows: ' + parts.join(', '));
}

/* --------------------------- boot --------------------------- */

async function init() {
  const payload = await api.boot();
  state.settings = payload.settings;
  state.lang = state.settings.language === 'ru' ? 'ru' : 'en';
  if (i18n) {
    i18n.setLang(state.lang);
    i18n.apply(document);
  }
  state.themes = payload.themes;
  state.customThemes = payload.customThemes || payload.settings.customThemes || [];
  state.wallpaperMode = payload.settings.wallpaperMode || 'auto';
  state.theme = payload.theme;
  state.apps = payload.apps || [];
  state.pinned = payload.pinned || [];
  state.usage = payload.settings.usage || {};
  state.media = payload.media;

  applyThemeVars(state.theme);
  renderThemes();
  renderProfiles();
  renderMedia();
  renderPinned();
  renderFrequent();
  renderCatalog();
  renderSettings();
  syncOverlayUi();
  systemStatus();
  fillEditorFrom(state.theme);
  api.media.history().then(renderHistory).catch(() => {});

  // nav
  $$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));

  // themes panel
  bindSwitch('#sw-dark', state.settings.applyDarkMode, (v) => patchSettings({ applyDarkMode: v }));
  bindSwitch('#sw-accent', state.settings.applyAccent, (v) => patchSettings({ applyAccent: v }));
  bindSwitch('#sw-wallpaper', state.settings.applyWallpaper, (v) => patchSettings({ applyWallpaper: v }));
  bindSwitch('#sw-sysDark', state.settings.applyDarkMode, (v) => patchSettings({ applyDarkMode: v }));
  bindSwitch('#sw-sysAccent', state.settings.applyAccent, (v) => patchSettings({ applyAccent: v }));
  bindSwitch('#sw-sysWall', state.settings.applyWallpaper, (v) => patchSettings({ applyWallpaper: v }));
  bindSwitch('#sw-desktopicons', !!state.settings.hideDesktopIcons, async (v) => {
    const res = await api.system.desktopIcons(v);
    state.settings.hideDesktopIcons = !!v;
    if (res && res.ok) toast(v ? 'Иконки рабочего стола скрыты' : 'Иконки рабочего стола возвращены');
    else toast('Не удалось переключить иконки');
  });

  bindSwitch('#sw-lyrics', state.settings.wallpaperLyrics !== false, async (v) => {
    state.settings.wallpaperLyrics = v;
    await api.settings.patch({ wallpaperLyrics: v });
    if (v) state.playerLyrics = null;
    if (state.settings.wallpaperSource === 'player' && state.settings.applyWallpaper) {
      renderPlayerWallpaper(true);
    }
  });

  $('#btn-apply-system').addEventListener('click', async () => {
    const s = state.settings;
    toast('Применяю тему к Windows…', 1800);
    await api.system.apply({
      dark: s.applyDarkMode ? state.theme.dark : undefined,
      accent: s.accentOverride || state.theme.accent,
    });
    if (s.applyWallpaper) await generateWallpaper(state.theme, true);
    await systemStatus();
    toast('Готово: оформление Windows обновлено');
  });

  $('#btn-gen-wallpaper').addEventListener('click', () => regenerateWallpaperForMode());

  /* ------------------- theme editor ------------------- */

  const bindColor = (sel, key) => {
    const el = $(sel);
    el.addEventListener('input', () => {
      editor[key] = el.value;
      if (key === 'bg') editor.dark = luminance(el.value) < 0.5;
      previewEditor();
    });
  };
  bindColor('#ed-bg', 'bg');
  bindColor('#ed-accent', 'accent');
  bindColor('#ed-accent2', 'accent2');
  bindColor('#ed-aura', 'aura');

  const bindEditorRange = (sel, key, labelSel, suffix = '%') => {
    const el = $(sel);
    el.addEventListener('input', () => {
      editor[key] = Number(el.value);
      $(labelSel).textContent = el.value + suffix;
      previewEditor();
    });
  };
  bindEditorRange('#ed-contrast', 'contrast', '#ed-contrast-v');
  bindEditorRange('#ed-gamma', 'gamma', '#ed-gamma-v');
  bindEditorRange('#ed-gradient', 'gradient', '#ed-gradient-v');
  bindEditorRange('#ed-saturation', 'saturation', '#ed-saturation-v');
  bindEditorRange('#ed-brightness', 'brightness', '#ed-brightness-v');
  bindEditorRange('#ed-glow', 'glow', '#ed-glow-v');
  bindEditorRange('#ed-radius', 'radius', '#ed-radius-v', '');
  bindEditorRange('#ed-angle', 'angle', '#ed-angle-v', '°');

  $$('#seg-bgstyle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      editor.bgStyle = btn.dataset.style;
      syncEditorInputs();
      previewEditor();
    });
  });

  $$('#seg-wallmode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.wallpaperMode = btn.dataset.mode;
      api.settings.patch({ wallpaperMode: btn.dataset.mode });
      syncEditorInputs();
      toast(`Палитра из обоев: режим «${WALLPAPER_MODE_LABEL[btn.dataset.mode]}»`, 1800);
    });
  });

  $('#btn-theme-from-wallpaper').addEventListener('click', () => {
    paletteFromWallpaper().catch((err) => toast('Не получилось взять обои: ' + err.message));
  });
  $('#btn-theme-save').addEventListener('click', () => saveCustomTheme());
  $('#btn-theme-export').addEventListener('click', () => exportTheme());
  $('#btn-theme-import').addEventListener('click', () => importTheme());
  $('#btn-theme-reset').addEventListener('click', () => fillEditorFrom(state.theme));

  /* ------------------- wallpaper patterns & slideshow ------------------- */

  $$('#seg-pattern button').forEach((btn) => {
    btn.addEventListener('click', () => {
      pickPattern(btn.dataset.pattern).catch((err) => toast('Ошибка: ' + err.message));
    });
  });
  $$('#seg-wallsrc button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const source = btn.dataset.src;
      state.settings.wallpaperSource = source;
      await api.settings.patch({ wallpaperSource: source });
      syncWallpaperUi();
      if (source === 'player') {
        state.playerWallKey = '';
        await generatePlayerWallpaper();
      } else {
        ensurePlayerLoop();
        await generateWallpaper(state.theme, false, { pattern: state.settings.wallpaperPattern });
      }
    });
  });
  $('#btn-draw-wallpaper').addEventListener('click', openDrawModal);
  $('#btn-restore-wallpaper').addEventListener('click', async () => {
    const res = await api.system.restoreWallpaper();
    if (res && res.ok) toast('Вернул обои, которые были до Overlayr');
    else toast('Пока нечего возвращать — обои ещё не менялись');
  });
  bindSwitch('#sw-slideshow', state.settings.slideshowEnabled, async (v) => {
    await api.slideshow.set({ slideshowEnabled: v });
    state.settings.slideshowEnabled = v;
    toast(v ? 'Слайдшоу включено' : 'Слайдшоу выключено');
  });
  $('#slideshow-minutes').addEventListener('change', async (e) => {
    const minutes = Number(e.target.value) || 30;
    await api.slideshow.set({ slideshowMinutes: minutes });
    state.settings.slideshowMinutes = minutes;
  });
  syncWallpaperUi();

  /* --------------------------- draw modal --------------------------- */

  const canvas = $('#draw-canvas');
  canvas.addEventListener('pointerdown', (e) => {
    if (!canvas.setPointerCapture) return;
    canvas.setPointerCapture(e.pointerId);
    drawState.painting = true;
    drawState.current = { size: Number($('#draw-size').value) || 10, points: [canvasPoint(e)] };
    drawOnCanvas();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawState.painting || !drawState.current) return;
    drawState.current.points.push(canvasPoint(e));
    drawOnCanvas();
  });
  const finishStroke = () => {
    if (drawState.current && drawState.current.points.length > 1) drawState.strokes.push(drawState.current);
    drawState.current = null;
    drawState.painting = false;
    drawOnCanvas();
  };
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);
  $('#draw-size').addEventListener('input', (e) => {
    drawState.size = Number(e.target.value);
  });
  $('#draw-clear').addEventListener('click', () => {
    drawState.strokes = [];
    drawState.current = null;
    drawOnCanvas();
  });
  $('#draw-close').addEventListener('click', closeDrawModal);
  $('#draw-cancel').addEventListener('click', closeDrawModal);
  $('#draw-apply').addEventListener('click', () => applyDrawing());
  $('#draw-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'draw-backdrop') closeDrawModal();
  });

  /* ------------------------- preview player ------------------------- */

  $('#ovp-play').addEventListener('click', () => mediaCommand('toggle'));

  /* ---------------------------- display ---------------------------- */

  refreshDisplayInfo();
  syncWarmUi();
  const pushBrightness = debounce((v) => {
    api.display
      .brightness(v)
      .then((res) => {
        if (res && res.ok && res.brightness !== null) $('#brightness-val').textContent = res.brightness + '%';
      })
      .catch(() => {});
  }, 120);
  $('#range-brightness').addEventListener('input', (e) => {
    $('#brightness-val').textContent = e.target.value + '%';
    pushBrightness(Number(e.target.value));
  });
  const pushContrast = debounce((v) => {
    api.display
      .contrast(v)
      .then((res) => {
        if (res && res.ok && res.contrast !== null) $('#contrast-val').textContent = res.contrast + '%';
      })
      .catch(() => {});
  }, 120);
  $('#range-contrast').addEventListener('input', (e) => {
    $('#contrast-val').textContent = e.target.value + '%';
    pushContrast(Number(e.target.value));
  });
  bindSwitch('#sw-warm', !!(state.settings.display || {}).warm, async (v) => {
    state.settings.display = { ...(state.settings.display || {}), warm: v };
    await api.display.warm({ warm: v });
  });
  $('#range-warm').addEventListener('input', (e) => {
    const strength = Number(e.target.value);
    $('#warm-val').textContent = strength;
    state.settings.display = { ...(state.settings.display || {}), warmStrength: strength };
    api.display.warm({ warmStrength: strength });
  });

  /* ------------------------- app hotkeys ------------------------- */

  renderAppHotkeys();

  // music
  $('#btn-play').addEventListener('click', () => mediaCommand('toggle'));
  $('#mini-play').addEventListener('click', (e) => {
    e.stopPropagation();
    mediaCommand('toggle');
  });
  $('#mini-player').addEventListener('click', () => {
    api.overlay.show();
    state.settings.overlay.visible = true;
    syncOverlayUi();
  });
  $('#btn-prev').addEventListener('click', () => mediaCommand('prev'));
  $('#btn-next').addEventListener('click', () => mediaCommand('next'));
  $('#btn-shuffle').addEventListener('click', () => mediaCommand('shuffle', true));
  $('#btn-repeat').addEventListener('click', () => {
    const cur = state.media?.repeat ?? 0;
    mediaCommand('repeat', (cur + 1) % 3);
  });

  $('#progress-track').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const dur = state.media?.duration || 0;
    state.seekOverride = { value: fraction * dur, until: Date.now() + 1200 };
    mediaCommand('seek', fraction);
    updateProgress();
  });

  const volRange = $('#volume-range');
  const pushVolume = debounce((v) => {
    const mode = state.settings.overlay.volumeMode;
    const p = mode === 'app'
      ? api.audio.setApp(state.media?.displayAppId || state.media?.appId || null, v)
      : api.audio.set(v);
    p.then((res) => {
      if (res && res.ok === false && mode === 'app') {
        toast('У этого плеера нет отдельной аудио-сессии — переключи «Чей звук» на «Система»', 3200);
        return;
      }
      updateVolumeUi(res);
    }).catch(() => {});
  }, 90);
  volRange.addEventListener('input', () => {
    $('#volume-pct').textContent = volRange.value + '%';
    pushVolume(Number(volRange.value));
  });
  $('#btn-mute').addEventListener('click', async () => {
    const mode = state.settings.overlay.volumeMode;
    const res = mode === 'app'
      ? await api.audio.toggleAppMute(state.media?.displayAppId || state.media?.appId || null)
      : await api.audio.toggleMute();
    if (res && res.ok === false && mode === 'app') {
      toast('У этого плеера нет отдельной аудио-сессии', 2600);
      return;
    }
    updateVolumeUi(res);
  });

  bindOverlayControls();

  // dock
  $('#app-search').addEventListener('input', debounce(renderCatalog, 120));
  $('#btn-refresh-apps').addEventListener('click', () => refreshApps(true));
  $('#btn-add-app').addEventListener('click', openModal);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  $('#modal-search').addEventListener('input', debounce((e) => renderModalList(e.target.value), 100));
  $('#btn-quick-launch').addEventListener('click', () => api.launcher.show());
  $('#win-min').addEventListener('click', () => api.window.minimize());
  $('#win-max').addEventListener('click', () => api.window.maximize());
  $('#win-close').addEventListener('click', () => api.window.hide());

  // settings
  bindSwitch('#sw-autostart', state.settings.launchAtLogin, async (v) => {
    await api.app.setLoginItem(v);
    toast(v ? 'Overlayr будет запускаться с Windows' : 'Автозапуск выключен');
  });

  $$('#seg-lang button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const lang = btn.dataset.lang;
      if (lang === (state.settings.language || 'en')) return;
      await api.settings.patch({ language: lang });
      state.settings.language = lang;
      setTimeout(() => location.reload(), 80);
    });
  });
  $('#sw-overlayStart').addEventListener('click', () => {
    const v = !state.settings.overlay.visible;
    state.settings.overlay.visible = v;
    if (v) api.overlay.show();
    else api.overlay.hide();
    setSwitch($('#sw-overlayStart'), v);
    syncOverlayUi();
  });

  $$('.hotkey-input').forEach((input) => {
    input.addEventListener('keydown', async (e) => {
      e.preventDefault();
      const accel = hotkeyFromEvent(e);
      if (!accel) return;
      input.value = accel;
      const hotkeys = { ...state.settings.hotkeys, [input.dataset.hk]: accel };
      state.settings.hotkeys = hotkeys;
      patchSettings({ hotkeys });
      const ok = await api.hotkeys.apply();
      toast(ok ? 'Горячая клавиша сохранена' : 'Не удалось зарегистрировать клавишу');
    });
    input.addEventListener('focus', () => (input.value = ''));
    input.addEventListener('blur', () => (input.value = state.settings.hotkeys[input.dataset.hk] || ''));
  });

  $('#btn-sys-status').addEventListener('click', () => systemStatus(true));
  $('#btn-open-data').addEventListener('click', async () => {
    const dir = await api.app.dataDir();
    await api.app.openPath(dir);
  });
  $('#btn-reset-settings').addEventListener('click', async () => {
    if (!confirm('Сбросить все настройки Overlayr? Темы, док и положение оверлея вернутся к исходным.')) return;
    await api.settings.patch({
      themeId: 'aurora',
      applyDarkMode: true,
      applyAccent: true,
      applyWallpaper: false,
      pinned: [],
      usage: {},
      accentOverride: null,
      overlay: {
        visible: true,
        x: null,
        y: null,
        width: 400,
        layout: 'standard',
        opacity: 0.92,
        alwaysOnTop: true,
        clickThrough: false,
        showVisualizer: true,
        showProgress: true,
        showVolume: true,
        showClock: false,
        showStats: false,
      },
    });
    location.reload();
  });
  $('#btn-quit').addEventListener('click', () => api.app.quit());

  /* ------------------- live subscriptions ------------------- */

  api.on('media', (payload) => {
    state.media = payload;
    renderMedia();
    const trackKey = `${payload.title || ''}|${payload.artist || ''}`;
    const artSig = payload.artUrl || '';
    const changed = trackKey !== state.playerWallKey || artSig !== state.playerArtKey;
    if (state.settings.wallpaperSource === 'player' && state.settings.applyWallpaper && payload.hasSession && changed) {
      state.playerWallKey = trackKey;
      state.playerArtKey = artSig;
      clearTimeout(state.playerWallTimer);
      state.playerWallTimer = setTimeout(() => renderPlayerWallpaper(true), 900);
    }
    ensurePlayerLoop();
  });

  api.on('audio', (payload) => {
    state.audio = payload;
    updateVolumeUi(payload);
  });

  api.on('stats', (payload) => {
    state.stats = payload;
    $('#stat-cpu').textContent = payload.cpu;
    $('#stat-ram').textContent = payload.memPercent;
    $('#bar-cpu').style.width = payload.cpu + '%';
    $('#bar-ram').style.width = payload.memPercent + '%';
  });

  api.on('theme', (theme) => {
    state.theme = theme;
    applyThemeVars(theme);
    renderThemes();
  });

  api.on('settings', (next) => {
    state.settings = next;
    syncOverlayUi();
    setSwitch($('#sw-sysDark'), next.applyDarkMode);
    setSwitch($('#sw-sysAccent'), next.applyAccent);
    setSwitch($('#sw-sysWall'), next.applyWallpaper);
    setSwitch($('#sw-dark'), next.applyDarkMode);
    setSwitch($('#sw-accent'), next.applyAccent);
    setSwitch($('#sw-wallpaper'), next.applyWallpaper);
    setSwitch($('#sw-autostart'), next.launchAtLogin);
    ensurePlayerLoop();
    $('#btn-toggle-overlay').textContent = next.overlay.visible ? 'Скрыть оверлей' : 'Показать оверлей';
  });

  api.on('apps', (apps) => {
    state.apps = apps;
    renderCatalog();
    renderFrequent();
  });

  api.on('pinned', (pinned) => {
    state.pinned = pinned;
    renderPinned();
    renderCatalog();
    renderAppHotkeys();
  });

  api.on('usage', ({ usage, recent }) => {
    state.usage = usage;
    renderFrequent();
  });

  api.on('overlay:settings', (cfg) => {
    state.settings.overlay = { ...state.settings.overlay, ...cfg };
    syncOverlayUi();
  });

  api.on('media:history', renderHistory);
  api.on('wallpaper:request', () => slideshowTick());

  api.on('profile:hotkey', (id) => {
    const profile = PROFILES.find((p) => p.id === id);
    if (profile) applyProfile(profile);
  });

  api.on('system:applied', () => {
    systemStatus();
  });

  api.on('hotkeys', (hotkeys) => {
    state.settings.hotkeys = { ...state.settings.hotkeys, ...hotkeys };
    $$('.hotkey-input').forEach((input) => {
      input.value = state.settings.hotkeys[input.dataset.hk] || '';
    });
  });

  if (!payload.settings.welcomedOverlayr) {
    showWelcomeCard();
    api.settings.patch({ welcomedOverlayr: true });
  }

  i18nRefresh();
  if (i18n && state.lang === 'en') {
    let i18nTimer = null;
    const observer = new MutationObserver(() => {
      if (i18nTimer) return;
      i18nTimer = setTimeout(() => {
        i18nTimer = null;
        i18nRefresh();
      }, 90);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Safety net for content that is re-rendered right after a translation pass.
    setInterval(() => i18nRefresh(), 1500);
  }
}

function updateVolumeUi(payload) {
  if (!payload || payload.volume === null || payload.volume === undefined) return;
  const vol = Number(payload.volume);
  $('#volume-range').value = vol;
  $('#volume-pct').textContent = vol + '%';
  const btn = $('#btn-mute');
  btn.classList.toggle('active', !!payload.muted);
  btn.innerHTML = payload.muted
    ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M17 9l4 4M21 9l-4 4"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>';
  const pct = payload.muted ? 0 : vol;
  $('#progress-track')?.classList.remove('muted');
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:40px;font-family:Segoe UI;color:#fff">Ошибка запуска: ${esc(err.message)}</div>`;
});

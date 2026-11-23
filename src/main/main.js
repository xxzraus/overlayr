'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, nativeTheme, screen, shell, protocol, net, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const { Store } = require('./store');
const { MediaBridge } = require('./media');
const { AudioBridge } = require('./audio');
const { AppIndex } = require('./apps');
const { ThemeSystem } = require('./theme-system');
const { SpectrumBridge } = require('./spectrum');
const { ArtworkService } = require('./artwork');
const { DisplayBridge } = require('./display');
const { LyricsService } = require('./lyrics');
const { THEMES, getTheme, themeVars } = require('../shared/themes');

const ROOT = path.join(__dirname, '..', '..');
const isDev = !app.isPackaged;
const APP_VERSION = (() => {
  try {
    return require(path.join(ROOT, 'package.json')).version || '1.3.0';
  } catch {
    return '1.3.0';
  }
})();

// Transparent margin around the overlay card. It exists so the CSS shadow and
// the rounded corners have room to breathe inside the window — without it the
// shadow gets clipped by the window bounds and shows up as a dark rectangle.
const OVERLAY_PAD = 20;
const OVERLAY_PEEK = 64;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aurora-icon',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true },
  },
]);

const userDataDir = () => app.getPath('userData');
const iconsDir = () => path.join(userDataDir(), 'icons');
const wallpaperDir = () => path.join(userDataDir(), 'wallpapers');

/** The app used to be called Aurora: carry the old settings over on first run. */
function migrateLegacyUserData() {
  try {
    const legacy = path.join(app.getPath('appData'), 'Aurora');
    const current = app.getPath('userData');
    if (path.resolve(legacy).toLowerCase() === path.resolve(current).toLowerCase()) return;
    if (!fs.existsSync(legacy)) return;
    if (fs.existsSync(path.join(current, 'settings.json'))) return;
    fs.mkdirSync(current, { recursive: true });
    for (const entry of ['settings.json', 'apps-cache.json', 'artwork', 'wallpapers', 'icons']) {
      const from = path.join(legacy, entry);
      const to = path.join(current, entry);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.cpSync(from, to, { recursive: true });
    }
    console.log('[migrate] legacy settings imported from', legacy);
  } catch (err) {
    console.warn('[migrate] failed', err.message);
  }
}

let store;
let media;
let audio;
let appIndex;
let themeSystem;
let spectrum;
let artwork;
let lyrics;
let display;
let warmWin = null;
let fullscreenTimer = null;
let slideshowTimer = null;
let overlayHiddenByFullscreen = false;
const mediaHistory = [];
let tray = null;
let mainWin = null;
let overlayWin = null;
let launcherWin = null;
let quitting = false;
let statsTimer = null;
let audioTimer = null;
let lastCpu = null;
let lastArtKey = '';
let lastHistorySig = '';

function iconUrl(filePath) {
  if (!filePath) return null;
  let stamp = '';
  try {
    stamp = String(Math.round(fs.statSync(filePath).mtimeMs));
  } catch { /* file may have vanished */ }
  return `aurora-icon://local/?p=${encodeURIComponent(filePath)}&v=${stamp}`;
}

/** Reads the current desktop wallpaper path from the registry. */
function readWallpaperPath() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    const match = out.match(/WallPaper\s+REG_SZ\s+(.+)/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** Remembers the user's own wallpaper before Overlayr replaces it. */
function rememberWallpaper() {
  try {
    const current = readWallpaperPath();
    if (!current || !fs.existsSync(current)) return;
    if (current.toLowerCase().startsWith(wallpaperDir().toLowerCase())) return;
    if (store.all.previousWallpaper === current) return;
    store.patch({ previousWallpaper: current }, { silent: true });
  } catch { /* ignore */ }
}

function broadcast(channel, payload) {
  for (const win of [mainWin, overlayWin, launcherWin]) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Settings helpers                                                    */
/* ------------------------------------------------------------------ */

function appsForRenderer() {
  const usage = store.all.usage || {};
  return appIndex.apps
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      target: a.target,
      args: a.args,
      source: a.source,
      system: !!a.system,
      iconUrl: iconUrl(a.icon),
    }))
    .sort((a, b) => {
      const ua = usage[a.id] || 0;
      const ub = usage[b.id] || 0;
      if (ua !== ub) return ub - ua;
      if (a.system !== b.system) return a.system ? 1 : -1;
      return a.name.localeCompare(b.name, 'ru');
    });
}

function pinnedForRenderer() {
  const pinned = store.all.pinned || [];
  const byId = new Map(appIndex.apps.map((a) => [a.id, a]));
  return pinned
    .map((entry) => {
      const live = byId.get(entry.id);
      const merged = live ? { ...live, ...entry, icon: live.icon || entry.icon } : entry;
      return {
        id: merged.id,
        name: merged.name,
        kind: merged.kind,
        target: merged.target,
        args: merged.args,
        iconUrl: iconUrl(merged.icon),
      };
    })
    .filter(Boolean);
}

function resolveTheme(id) {
  const custom = (store.all.customThemes || []).find((t) => t && t.id === id);
  return custom || getTheme(id);
}

function currentTheme() {
  return resolveTheme(store.all.themeId);
}

function bootPayload() {
  const theme = currentTheme();
  return {
    settings: store.all,
    themes: THEMES,
    customThemes: store.all.customThemes || [],
    theme: { ...theme, vars: themeVars(theme) },
    media: media ? media.last : null,
    apps: appsForRenderer(),
    pinned: pinnedForRenderer(),
    system: { platform: process.platform, version: APP_VERSION, electron: process.versions.electron },
  };
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

function createMainWindow() {
  const theme = currentTheme();
  mainWin = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: theme.bg,
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (process.env.AURORA_DEBUG) {
    mainWin.webContents.on('console-message', (_e, level, message) => {
      console.log(`[window:${level}] ${message}`);
    });
    mainWin.webContents.on('render-process-gone', (_e, details) => {
      console.error('[window] renderer gone', JSON.stringify(details));
    });
  }
  mainWin.loadFile(path.join(ROOT, 'src', 'ui', 'index.html'));
  mainWin.once('ready-to-show', () => revealMainWindow());

  mainWin.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWin.hide();
    }
  });

  mainWin.on('closed', () => {
    mainWin = null;
  });

  // The overlay is always-on-top; drop it below Aurora's own window so it
  // never covers the settings/preview you are looking at.
  mainWin.on('focus', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setAlwaysOnTop(false);
      // Raise our own window above the now-normal overlay so the widget never
      // covers the settings you are looking at.
      mainWin.moveTop();
    }
  });
  mainWin.on('blur', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setAlwaysOnTop(store.all.overlay.alwaysOnTop !== false, 'screen-saver');
    }
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function defaultOverlayPosition(width, height) {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  return {
    x: Math.round(area.x + area.width - width - 36),
    y: Math.round(area.y + area.height - height - 36),
  };
}

/** Fits the overlay fully inside the nearest display's work area. */
function fitToDisplay(x, y, width, height) {
  const displays = screen.getAllDisplays();
  let best = null;
  let bestDist = Infinity;
  const cx = x + width / 2;
  const cy = y + height / 2;
  for (const d of displays) {
    const a = d.workArea;
    const dx = Math.max(a.x - cx, 0, cx - (a.x + a.width));
    const dy = Math.max(a.y - cy, 0, cy - (a.y + a.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  const area = best || screen.getPrimaryDisplay().workArea;
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), Math.max(area.x, maxX))),
    y: Math.round(Math.min(Math.max(y, area.y), Math.max(area.y, maxY))),
  };
}

function overlayWindowSize(cfg) {
  return {
    width: Math.max(280, Number(cfg.width) || 420) + OVERLAY_PAD * 2,
    height: 200,
  };
}

function createOverlayWindow() {
  const cfg = store.all.overlay;
  const { width, height } = overlayWindowSize(cfg);
  const fallback = defaultOverlayPosition(width, height);
  const saved = fitToDisplay(
    Number.isFinite(cfg.x) ? cfg.x : fallback.x,
    Number.isFinite(cfg.y) ? cfg.y : fallback.y,
    width,
    height
  );
  const x = saved.x;
  const y = saved.y;

  overlayWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      offscreen: false,
    },
  });

  overlayWin.setAlwaysOnTop(cfg.alwaysOnTop !== false, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(ROOT, 'src', 'ui', 'overlay.html'));
  if (process.env.AURORA_DEBUG) {
    overlayWin.webContents.on('console-message', (_e, level, message) => {
      console.log(`[overlay:${level}] ${message}`);
    });
    overlayWin.webContents.on('render-process-gone', (_e, details) => {
      console.error('[overlay] renderer gone', JSON.stringify(details));
    });
  }
  overlayWin.once('ready-to-show', () => {
    if (store.all.overlay.visible) overlayWin.showInactive();
  });
  overlayWin.on('moved', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const [px, py] = overlayWin.getPosition();
    store.patch({ overlay: { x: px, y: py } }, { silent: true });
  });
  overlayWin.on('closed', () => {
    overlayWin = null;
  });
  applyOverlayBehaviour();
}

function applyOverlayBehaviour() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const cfg = store.all.overlay;
  overlayWin.setAlwaysOnTop(cfg.alwaysOnTop !== false, 'screen-saver');
  if (cfg.clickThrough) {
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
  } else {
    overlayWin.setIgnoreMouseEvents(false);
  }
  if (cfg.visible) {
    if (!overlayWin.isVisible()) overlayWin.showInactive();
  } else if (overlayWin.isVisible()) {
    overlayWin.hide();
  }
  if (spectrum) {
    const playing = !!(media && media.last && media.last.playing);
    if (cfg.visible && cfg.spectrum !== false && playing) spectrum.start();
    else spectrum.stop();
  }
}

function createLauncherWindow() {
  launcherWin = new BrowserWindow({
    width: 760,
    height: 520,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  launcherWin.loadFile(path.join(ROOT, 'src', 'ui', 'launcher.html'));
  launcherWin.on('blur', () => {
    if (launcherWin && !launcherWin.isDestroyed()) launcherWin.hide();
  });
  launcherWin.on('closed', () => {
    launcherWin = null;
  });
}

function showLauncher() {
  if (!launcherWin || launcherWin.isDestroyed()) createLauncherWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const [w, h] = launcherWin.getSize();
  const x = Math.round(area.x + (area.width - w) / 2);
  const y = Math.round(area.y + area.height * 0.22);
  launcherWin.setPosition(x, y);
  launcherWin.show();
  launcherWin.focus();
  launcherWin.webContents.send('launcher:shown');
}

/* ------------------------------------------------------------------ */
/* Tray                                                                */
/* ------------------------------------------------------------------ */

const MAIN_EN = {
  'Открыть Overlayr': 'Open Overlayr',
  'Быстрый запуск': 'Quick launch',
  'Музыкальный оверлей': 'Music overlay',
  'Клики насквозь': 'Click-through',
  'Следующая тема': 'Next theme',
  'Сменить тему': 'Change theme',
  'Выход': 'Quit',
  'Сохранить тему Overlayr': 'Save Overlayr theme',
  'Открыть тему Overlayr': 'Open Overlayr theme',
  'Северное сияние': 'Northern lights',
  'Полночь': 'Midnight',
  'Сакура': 'Sakura',
  'Закат': 'Sunset',
  'Неон': 'Neon',
  'Лес': 'Forest',
  'Лаванда': 'Lavender',
  'Графит': 'Graphite',
  'Бумага': 'Paper',
  'Дневной свет': 'Daylight',
  'Угли': 'Embers',
  'Лёд': 'Ice',
  'Вейпорвейв': 'Vaporwave',
  'Матрица': 'Matrix',
};

function t(text) {
  const lang = store && store.all ? store.all.language : 'en';
  if (lang !== 'en') return text;
  return Object.prototype.hasOwnProperty.call(MAIN_EN, text) ? MAIN_EN[text] : text;
}

function buildTrayMenu() {
  const cfg = store.all.overlay;
  return Menu.buildFromTemplate([
    { label: 'Overlayr', enabled: false },
    { type: 'separator' },
    { label: t('Открыть Overlayr'), click: () => showMain() },
    { label: t('Быстрый запуск'), accelerator: undefined, click: () => showLauncher() },
    { type: 'separator' },
    {
      label: t('Музыкальный оверлей'),
      type: 'checkbox',
      checked: cfg.visible !== false,
      click: (item) => setOverlay({ visible: item.checked }),
    },
    {
      label: t('Клики насквозь'),
      type: 'checkbox',
      checked: !!cfg.clickThrough,
      click: (item) => setOverlay({ clickThrough: item.checked }),
    },
    { type: 'separator' },
    { label: t('Следующая тема'), click: () => cycleTheme() },
    {
      label: t('Сменить тему'),
      submenu: THEMES.map((theme) => ({
        label: t(theme.name),
        type: 'checkbox',
        checked: store.all.themeId === theme.id,
        click: () => applyTheme(theme.id, true),
      })),
    },
    { type: 'separator' },
    { label: t('Выход'), click: () => quitApp() },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip('Overlayr');
  refreshTray();
  tray.on('click', () => showMain());
}

let trayPlaying = null;

/** Draws a small accent dot on the tray icon while music is playing. */
function trayIconWithDot(base) {
  const size = base.getSize();
  if (!size.width) return base;
  const buffer = Buffer.from(base.toBitmap());
  const cx = size.width - Math.round(size.width * 0.28);
  const cy = size.height - Math.round(size.height * 0.28);
  const radius = Math.max(3, Math.round(size.width * 0.2));
  const yStart = Math.max(0, cy - radius - 1);
  const yEnd = Math.min(size.height - 1, cy + radius + 1);
  const xStart = Math.max(0, cx - radius - 1);
  const xEnd = Math.min(size.width - 1, cx + radius + 1);
  for (let y = yStart; y <= yEnd; y++) {
    for (let x = xStart; x <= xEnd; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius) continue;
      const alpha = dist > radius - 1.2 ? 0.6 : 1;
      const i = (y * size.width + x) * 4;
      buffer[i] = Math.round(buffer[i] * (1 - alpha) + 161 * alpha);
      buffer[i + 1] = Math.round(buffer[i + 1] * (1 - alpha) + 224 * alpha);
      buffer[i + 2] = Math.round(buffer[i + 2] * (1 - alpha) + 53 * alpha);
      buffer[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size.width, height: size.height });
}

function updateTrayStatus(playing) {
  if (!tray || trayPlaying === playing) return;
  trayPlaying = playing;
  try {
    const base = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
    if (base.isEmpty()) return;
    tray.setImage(playing ? trayIconWithDot(base) : base);
  } catch (err) {
    console.warn('[tray] status icon failed', err.message);
  }
}

function revealMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  // Windows' foreground lock can keep a freshly launched window behind the
  // current one; a brief topmost toggle + moveTop reliably raises it.
  try {
    mainWin.setAlwaysOnTop(true);
    mainWin.show();
    mainWin.moveTop();
    mainWin.focus();
    setTimeout(() => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.setAlwaysOnTop(false);
    }, 1400);
  } catch {
    mainWin.show();
  }
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  revealMainWindow();
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

async function applyTheme(id, withSystem = false) {
  const theme = resolveTheme(id);
  store.patch({ themeId: theme.id });
  nativeTheme.themeSource = theme.dark ? 'dark' : 'light';
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setBackgroundColor(theme.bg);
  }
  broadcast('theme', { ...theme, vars: themeVars(theme) });
  refreshTray();

  const cfg = store.all;
  if (withSystem) {
    let wallpaper = null;
    if (cfg.applyWallpaper) {
      wallpaper = path.join(wallpaperDir(), `${theme.id}.png`);
      if (!fs.existsSync(wallpaper)) wallpaper = null;
      if (wallpaper) rememberWallpaper();
    }
    await themeSystem.applyAll({
      dark: cfg.applyDarkMode ? theme.dark : undefined,
      accent: theme.accent,
      wallpaper,
    });
    broadcast('system:applied', { themeId: theme.id });
  }
  return theme;
}

function cycleTheme() {
  const idx = THEMES.findIndex((t) => t.id === store.all.themeId);
  const next = THEMES[(idx + 1) % THEMES.length];
  return applyTheme(next.id, true);
}

/**
 * Resizes the overlay window while keeping the card visually anchored to the
 * nearest screen corner, so peek/expand never makes the widget jump around.
 */
function resizeOverlayWindow(width, height) {
  if (!overlayWin || overlayWin.isDestroyed()) return false;
  const bounds = overlayWin.getBounds();
  const w = Math.max(80, Math.round(Number(width) || bounds.width));
  const h = Math.max(80, Math.round(Number(height) || bounds.height));
  if (w === bounds.width && h === bounds.height) return true;

  const area = screen.getDisplayMatching(bounds).workArea;
  const anchorRight = bounds.x + bounds.width / 2 > area.x + area.width / 2;
  const anchorBottom = bounds.y + bounds.height / 2 > area.y + area.height / 2;
  const proposedX = anchorRight ? bounds.x + (bounds.width - w) : bounds.x;
  const proposedY = anchorBottom ? bounds.y + (bounds.height - h) : bounds.y;
  const { x, y } = fitToDisplay(proposedX, proposedY, w, h);

  overlayWin.setBounds({ x, y, width: w, height: h });
  store.patch({ overlay: { x, y } }, { silent: true });
  return true;
}

function setOverlay(partial) {
  const before = { ...store.all.overlay };
  const merged = { ...before, ...partial };
  if (partial && partial.layout && partial.width === undefined && partial.layout !== before.layout) {
    const preset = { compact: 340, standard: 420, wide: 540 }[partial.layout];
    if (preset) {
      partial = { ...partial, width: preset };
      merged.width = preset;
    }
  }
  store.patch({ overlay: partial });
  if (overlayWin && !overlayWin.isDestroyed()) {
    if (merged.width !== before.width) {
      const size = overlayWin.getSize();
      resizeOverlayWindow(Math.max(280, Number(merged.width) || 420) + OVERLAY_PAD * 2, size[1]);
    }
    if (partial && (partial.x === null || partial.y === null)) {
      const [w, h] = overlayWin.getSize();
      const pos = defaultOverlayPosition(w, h);
      overlayWin.setPosition(pos.x, pos.y);
      store.patch({ overlay: { x: pos.x, y: pos.y } }, { silent: true });
      merged.x = pos.x;
      merged.y = pos.y;
    }
  }
  applyOverlayBehaviour();
  broadcast('overlay:settings', merged);
  refreshTray();
  return merged;
}

/* ------------------------------------------------------------------ */
/* Display, warm mode, slideshow                                       */
/* ------------------------------------------------------------------ */

function applyWarmOverlay() {
  const cfg = store.all.display || {};
  const strength = Math.max(0, Math.min(80, Number(cfg.warmStrength) || 45));
  if (!cfg.warm) {
    if (warmWin && !warmWin.isDestroyed()) warmWin.close();
    warmWin = null;
    return;
  }
  const area = screen.getPrimaryDisplay().bounds;
  if (!warmWin || warmWin.isDestroyed()) {
    warmWin = new BrowserWindow({
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    warmWin.setIgnoreMouseEvents(true, { forward: true });
    warmWin.setAlwaysOnTop(true, 'screen-saver');
    warmWin.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<style>html,body{margin:0;height:100%;background:rgba(255,138,45,${(strength / 100).toFixed(2)})}</style>`
        )
    );
    warmWin.once('ready-to-show', () => {
      if (warmWin && !warmWin.isDestroyed()) warmWin.showInactive();
    });
    return;
  }
  warmWin.setBounds(area);
  warmWin.webContents
    .executeJavaScript(`document.body.style.background='rgba(255,138,45,${(strength / 100).toFixed(2)})'`)
    .catch(() => {});
  if (!warmWin.isVisible()) warmWin.showInactive();
}

function startFullscreenWatcher() {
  if (fullscreenTimer) clearInterval(fullscreenTimer);
  fullscreenTimer = setInterval(async () => {
    if (!display || !overlayWin || overlayWin.isDestroyed()) return;
    const res = await display.fullscreen();
    const isFull = !!(res && res.ok && res.fullscreen);
    const appName = String((res && res.app) || '').toLowerCase();
    const isOurs = appName.includes('overlayr') || appName.includes('electron');
    const shouldHide = isFull && !isOurs && store.all.overlay.hideInFullscreen !== false;
    if (shouldHide && !overlayHiddenByFullscreen) {
      overlayHiddenByFullscreen = true;
      if (overlayWin.isVisible()) overlayWin.hide();
    } else if (!shouldHide && overlayHiddenByFullscreen) {
      overlayHiddenByFullscreen = false;
      applyOverlayBehaviour();
    }
  }, 3000);
}

function restartSlideshow() {
  if (slideshowTimer) clearInterval(slideshowTimer);
  slideshowTimer = null;
  const cfg = store.all;
  if (!cfg.slideshowEnabled) return;
  const minutes = Math.max(1, Math.min(240, Number(cfg.slideshowMinutes) || 30));
  slideshowTimer = setInterval(() => broadcast('wallpaper:request'), minutes * 60 * 1000);
  broadcast('wallpaper:request');
}

/* ------------------------------------------------------------------ */
/* Stats / audio loop                                                  */
/* ------------------------------------------------------------------ */

function cpuSnapshot() {
  const cpus = os.cpus();
  const totals = cpus.reduce(
    (acc, cpu) => {
      const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      acc.idle += cpu.times.idle;
      acc.total += t;
      return acc;
    },
    { idle: 0, total: 0 }
  );
  return totals;
}

function startStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(() => {
    const snap = cpuSnapshot();
    let cpuPercent = 0;
    if (lastCpu) {
      const idleDelta = snap.idle - lastCpu.idle;
      const totalDelta = snap.total - lastCpu.total;
      if (totalDelta > 0) cpuPercent = Math.round((1 - idleDelta / totalDelta) * 100);
    }
    lastCpu = snap;
    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    broadcast('stats', {
      cpu: Math.max(0, Math.min(100, cpuPercent)),
      memPercent: Math.round((usedMem / totalMem) * 100),
      memUsedGb: +(usedMem / 1073741824).toFixed(1),
      memTotalGb: +(totalMem / 1073741824).toFixed(1),
      uptime: Math.round(os.uptime()),
    });
  }, 2000);
}

function startAudioWatch() {
  if (audioTimer) clearInterval(audioTimer);
  audioTimer = setInterval(async () => {
    const overlayVisible = overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible();
    if (!overlayVisible && !(mainWin && !mainWin.isDestroyed() && mainWin.isVisible())) return;
    const cfg = store.all.overlay;
    const last = media && media.last;
    let res;
    if (cfg.volumeMode === 'app' && last && last.hasSession) {
      res = await audio.getApp(last.displayAppId || last.appId);
      res.appId = last.displayAppId || last.appId;
    } else {
      res = await audio.get();
    }
    broadcast('audio', res);
  }, 5000);
}

/* ------------------------------------------------------------------ */
/* Hotkeys                                                             */
/* ------------------------------------------------------------------ */

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = store.all.hotkeys || {};
  const fallbacks = {
    launcher: ['Control+Alt+Space', 'Control+Shift+Space'],
    overlay: ['Control+Alt+M', 'Control+Alt+O', 'Control+Shift+O', 'F9'],
    nextTheme: ['Control+Alt+T', 'Control+Shift+T'],
    mute: ['Control+Alt+V', 'Control+Shift+V'],
  };
  const handlers = {
    launcher: () => showLauncher(),
    overlay: () => setOverlay({ visible: !store.all.overlay.visible }),
    nextTheme: () => cycleTheme(),
    mute: async () => {
      const res = await audio.toggleMute();
      broadcast('audio', res);
    },
  };
  const resolved = {};
  for (const action of Object.keys(handlers)) {
    const candidates = [hk[action], ...(fallbacks[action] || [])].filter(Boolean);
    let registered = null;
    for (const accel of candidates) {
      try {
        if (globalShortcut.register(accel, handlers[action])) {
          registered = accel;
          break;
        }
      } catch { /* try next */ }
    }
    if (!registered) {
      console.warn('[hotkey] could not register', action);
      continue;
    }
    resolved[action] = registered;
    if (registered !== hk[action]) console.warn(`[hotkey] ${action}: ${hk[action]} busy, using ${registered}`);
  }
  const changed = Object.keys(resolved).some((k) => resolved[k] !== hk[k]);
  if (changed) {
    store.patch({ hotkeys: { ...hk, ...resolved } }, { silent: true });
    broadcast('hotkeys', resolved);
  }

  // Ctrl+Alt+1..9 launch the first nine pinned apps.
  (store.all.pinned || []).slice(0, 9).forEach((entry, index) => {
    if (!entry || !entry.id) return;
    try {
      globalShortcut.register(`Control+Alt+${index + 1}`, () => {
        const live = appIndex.find(entry.id) || entry;
        appIndex.launch(live).catch(() => {});
      });
    } catch { /* ignore */ }
  });

  // Ctrl+Alt+F1..F3 — переключение профилей оформления.
  [['game', 'F1'], ['work', 'F2'], ['movie', 'F3']].forEach(([id, key]) => {
    try {
      globalShortcut.register(`Control+Alt+${key}`, () => broadcast('profile:hotkey', id));
    } catch { /* ignore */ }
  });

  // Пользовательские хоткеи на конкретные приложения.
  Object.entries(store.all.appHotkeys || {}).forEach(([appId, accel]) => {
    if (!accel) return;
    try {
      globalShortcut.register(accel, () => {
        const live = appIndex.find(appId) || (store.all.pinned || []).find((p) => p.id === appId);
        if (live) appIndex.launch(live).catch(() => {});
      });
    } catch { /* ignore */ }
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('boot', () => bootPayload());

  ipcMain.handle('settings:patch', (_e, partial) => {
    const before = store.all.language;
    const next = store.patch(partial || {});
    broadcast('settings', next);
    if (next.language !== before) refreshTray();
    return next;
  });

  ipcMain.handle('theme:apply', async (_e, { id, system } = {}) => {
    const theme = await applyTheme(id, !!system);
    return { ...theme, vars: themeVars(theme) };
  });

  ipcMain.handle('theme:export', async (_e, theme = {}) => {
    try {
      const res = await dialog.showSaveDialog(mainWin, {
        title: t('Сохранить тему Overlayr'),
        defaultPath: path.join(app.getPath('documents'), 'overlayr-theme.json'),
        filters: [{ name: 'Overlayr theme', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(res.filePath, JSON.stringify(theme, null, 2), 'utf8');
      return { ok: true, file: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('theme:import', async () => {
    try {
      const res = await dialog.showOpenDialog(mainWin, {
        title: t('Открыть тему Overlayr'),
        properties: ['openFile'],
        filters: [{ name: 'Overlayr theme', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      for (const key of ['bg', 'bg2', 'text', 'accent', 'accent2']) {
        if (typeof raw[key] !== 'string') return { ok: false, error: 'bad-theme-file' };
      }
      const theme = {
        id: raw.id || 'imported',
        name: raw.name || 'Импортированная тема',
        tag: raw.tag || 'импорт',
        desc: raw.desc || '',
        custom: true,
        dark: raw.dark !== false,
        bg: raw.bg,
        bg2: raw.bg2,
        text: raw.text,
        accent: raw.accent,
        accent2: raw.accent2,
        aura: raw.aura || raw.accent,
        wall: Array.isArray(raw.wall) && raw.wall.length >= 3 ? raw.wall.slice(0, 3) : [raw.bg, raw.bg2, raw.accent],
        contrast: Number(raw.contrast) || 1,
        glow: Number(raw.glow) || 1,
        radius: Number(raw.radius) || 16,
        angle: Number(raw.angle) || 180,
        bgStyle: ['aurora', 'gradient', 'solid'].includes(raw.bgStyle) ? raw.bgStyle : 'aurora',
      };
      return { ok: true, theme };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('theme:cycle', async () => {
    const theme = await cycleTheme();
    return { ...theme, vars: themeVars(theme) };
  });

  ipcMain.handle('system:apply', async (_e, opts = {}) => {
    if (process.env.AURORA_SHOT_DIR) return { ok: true, skipped: 'dev-shots' };
    const theme = currentTheme();
    const res = await themeSystem.applyAll({
      dark: opts.dark === undefined ? (store.all.applyDarkMode ? theme.dark : undefined) : !!opts.dark,
      accent: opts.accent || theme.accent,
      wallpaper: opts.wallpaper || null,
    });
    return res;
  });

  ipcMain.handle('system:status', () => themeSystem.status());

  ipcMain.handle('system:wallpaperFromDataUrl', async (_e, { dataUrl, themeId, slot } = {}) => {
    try {
      const match = /^data:image\/(png|jpeg);base64,/.exec(String(dataUrl || ''));
      if (!match) {
        return { ok: false, error: 'bad-data-url' };
      }
      const theme = resolveTheme(themeId || store.all.themeId);
      const id = String(theme.id || 'theme').replace(/[^a-z0-9-]/gi, '');
      const name = slot ? `${id}-${String(slot).replace(/[^a-z0-9-]/gi, '')}` : id;
      const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
      fs.mkdirSync(wallpaperDir(), { recursive: true });
      const file = path.join(wallpaperDir(), `${name}.${ext}`);
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      rememberWallpaper();
      const res = await themeSystem.setWallpaper(file);
      return { ...res, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('system:setWallpaperFile', async (_e, file) => themeSystem.setWallpaper(file));

  ipcMain.handle('lyrics:get', (_e, meta) => lyrics.get(meta || {}));

  ipcMain.handle('system:desktopIcons', async (_e, hide) => {
    if (hide === undefined) return themeSystem.desktopIcons();
    const res = await themeSystem.setDesktopIcons(!!hide);
    if (res && res.ok) store.patch({ hideDesktopIcons: !!hide }, { silent: true });
    return res;
  });
  ipcMain.handle('system:restoreWallpaper', async () => {
    const previous = store.all.previousWallpaper;
    if (!previous || !fs.existsSync(previous)) return { ok: false, error: 'no-previous' };
    const res = await themeSystem.setWallpaper(previous);
    return { ...res, path: previous };
  });

  ipcMain.handle('media:command', (_e, { action, value, target } = {}) => {
    if (!action) return { ok: false };
    media.command(action, value ?? null, target ?? null);
    return { ok: true };
  });

  ipcMain.handle('media:history', () => mediaHistory);

  ipcMain.handle('display:get', () => display.get());
  ipcMain.handle('display:brightness', (_e, value) => {
    store.patch({ display: { brightness: Number(value) } }, { silent: true });
    return display.setBrightness(value);
  });
  ipcMain.handle('display:contrast', (_e, value) => {
    store.patch({ display: { contrast: Number(value) } }, { silent: true });
    return display.setContrast(value);
  });
  ipcMain.handle('display:warm', (_e, payload = {}) => {
    store.patch({ display: payload });
    applyWarmOverlay();
    return store.all.display;
  });
  ipcMain.handle('display:fullscreen', () => display.fullscreen());
  ipcMain.handle('slideshow:set', (_e, cfg = {}) => {
    store.patch(cfg);
    restartSlideshow();
    return { enabled: store.all.slideshowEnabled, minutes: store.all.slideshowMinutes };
  });
  ipcMain.handle('appHotkeys:set', (_e, map = {}) => {
    store.patch({ appHotkeys: map || {} });
    registerHotkeys();
    return store.all.appHotkeys;
  });

  ipcMain.handle('audio:get', () => audio.get());
  ipcMain.handle('audio:set', (_e, v) => audio.set(v));
  ipcMain.handle('audio:step', (_e, d) => audio.step(d));
  ipcMain.handle('audio:mute', (_e, on) => audio.setMute(on));
  ipcMain.handle('audio:toggleMute', () => audio.toggleMute());
  ipcMain.handle('audio:sessions', () => audio.sessions());
  ipcMain.handle('audio:getApp', (_e, appId) => audio.getApp(appId));
  ipcMain.handle('audio:setApp', (_e, payload = {}) => audio.setApp(payload.appId, payload.value));
  ipcMain.handle('audio:toggleAppMute', (_e, appId) => audio.toggleAppMute(appId));

  ipcMain.handle('apps:list', () => appsForRenderer());
  ipcMain.handle('apps:refresh', async () => {
    await appIndex.scan();
    broadcast('apps', appsForRenderer());
    return appsForRenderer();
  });

  ipcMain.handle('apps:launch', async (_e, payload) => {
    let target = null;
    if (typeof payload === 'string') {
      target = appIndex.find(payload) || (store.all.pinned || []).find((p) => p.id === payload) || null;
    } else if (payload && payload.id) {
      target = appIndex.find(payload.id) || payload;
    }
    if (!target) return { ok: false, error: 'not-found' };
    const res = await appIndex.launch(target);
    if (res.ok) {
      const usage = { ...(store.all.usage || {}) };
      usage[target.id] = (usage[target.id] || 0) + 1;
      const recent = [target.id, ...(store.all.recent || []).filter((r) => r !== target.id)].slice(0, 24);
      store.patch({ usage, recent });
      broadcast('usage', { usage, recent });
    }
    return res;
  });

  ipcMain.handle('apps:pin', (_e, app) => {
    if (!app || !app.id) return pinnedForRenderer();
    const pinned = [...(store.all.pinned || [])];
    if (!pinned.some((p) => p.id === app.id)) {
      pinned.push({
        id: app.id,
        name: app.name,
        kind: app.kind,
        target: app.target,
        args: app.args,
        icon: app.iconPath || null,
      });
    }
    store.patch({ pinned });
    const result = pinnedForRenderer();
    broadcast('pinned', result);
    return result;
  });

  ipcMain.handle('apps:unpin', (_e, id) => {
    const pinned = (store.all.pinned || []).filter((p) => p.id !== id);
    store.patch({ pinned });
    const result = pinnedForRenderer();
    broadcast('pinned', result);
    return result;
  });

  ipcMain.handle('apps:reorder', (_e, ids) => {
    if (!Array.isArray(ids)) return pinnedForRenderer();
    const map = new Map((store.all.pinned || []).map((p) => [p.id, p]));
    const pinned = ids.map((id) => map.get(id)).filter(Boolean);
    store.patch({ pinned });
    const result = pinnedForRenderer();
    broadcast('pinned', result);
    return result;
  });

  ipcMain.handle('overlay:set', (_e, partial) => setOverlay(partial || {}));
  ipcMain.handle('hotkeys:apply', () => {
    registerHotkeys();
    return true;
  });
  ipcMain.handle('overlay:show', () => setOverlay({ visible: true }));
  ipcMain.handle('overlay:hide', () => setOverlay({ visible: false }));
  ipcMain.handle('overlay:toggle', () => setOverlay({ visible: !store.all.overlay.visible }));
  ipcMain.handle('overlay:resize', (_e, payload) => {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    const bounds = overlayWin.getBounds();
    const width = payload && typeof payload === 'object' ? payload.width : bounds.width;
    const height = payload && typeof payload === 'object' ? payload.height : payload;
    return resizeOverlayWindow(width, height);
  });
  ipcMain.handle('overlay:getPos', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return { x: 0, y: 0 };
    const [x, y] = overlayWin.getPosition();
    return { x, y };
  });
  ipcMain.handle('overlay:cursorInside', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    const point = screen.getCursorScreenPoint();
    const bounds = overlayWin.getBounds();
    return (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    );
  });
  ipcMain.handle('overlay:moveTo', (_e, point = {}) => {
    if (!overlayWin || overlayWin.isDestroyed()) return false;
    const x = Math.round(Number(point.x));
    const y = Math.round(Number(point.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    overlayWin.setPosition(x, y);
    return true;
  });

  ipcMain.handle('launcher:show', () => showLauncher());
  ipcMain.handle('launcher:hide', () => {
    if (launcherWin && !launcherWin.isDestroyed()) launcherWin.hide();
  });

  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });
  ipcMain.handle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:hide', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.hide();
  });

  ipcMain.handle('app:quit', () => quitApp());
  ipcMain.handle('app:dataDir', () => userDataDir());
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:openPath', async (_e, p) => {
    if (typeof p === 'string' && p) return shell.openPath(p);
    return 'invalid';
  });
  ipcMain.handle('app:loginItem', (_e, enabled) => {
    const opts = {
      openAtLogin: !!enabled,
      path: process.execPath,
      args: isDev ? [app.getAppPath()] : [],
    };
    app.setLoginItemSettings(opts);
    store.patch({ launchAtLogin: !!enabled });
    return app.getLoginItemSettings();
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function quitApp() {
  quitting = true;
  try { store.flush(); } catch { /* ignore */ }
  try { media.stop(); } catch { /* ignore */ }
  app.quit();
}

/* Dev-only screenshot harness: AURORA_SHOT_DIR=<dir> captures every surface. */
async function runDevShots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const save = async (win, name) => {
    if (!win || win.isDestroyed()) return;
    const image = await win.webContents.capturePage();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
  };
  const run = (code) => mainWin.webContents.executeJavaScript(code, true);

  showMain();
  await wait(1200);
  await run(`document.body.classList.add('no-anim')`);
  await wait(300);

  for (const view of ['themes', 'music', 'dock', 'settings']) {
    await run(`showView('${view}')`);
    await wait(700);
    await save(mainWin, `ui-${view}`);
  }

  await run(`showView('themes')`);
  await wait(400);
  await run(`document.querySelector('#theme-editor').scrollIntoView({ block: 'center' })`);
  await wait(600);
  await save(mainWin, 'ui-theme-editor');

  await run(`showView('themes')`);
  await wait(300);
  await run(`document.querySelector('#wallpaper-card').scrollIntoView({ block: 'center' })`);
  await wait(500);
  await save(mainWin, 'ui-wallpaper-card');

  const wallpaperCheck = await run(`
    (async () => {
      const out = {};
      for (const pattern of ['aurora', 'waves', 'grid', 'dots', 'rings']) {
        const res = await generateWallpaper(state.theme, true, { pattern, slot: 'test-' + pattern });
        out[pattern] = res && res.ok ? 'ok' : String(res && res.error);
      }
      return JSON.stringify(out);
    })()
  `);
  console.log('[shots] wallpaper patterns:', wallpaperCheck);

  await run(`showView('music')`);
  await wait(300);
  await run(`document.querySelector('.music-lower').scrollIntoView({ block: 'center' })`);
  await wait(500);
  await save(mainWin, 'ui-music-lower');
  await run(`showView('settings')`);
  await wait(300);
  await run(`document.querySelector('#apphotkeys-list').scrollIntoView({ block: 'center' })`);
  await wait(500);
  await save(mainWin, 'ui-app-hotkeys');

  await run(`paletteFromWallpaper().then(() => 'ok').catch((e) => 'err:' + e.message)`);
  await wait(1200);
  await save(mainWin, 'ui-wallpaper-palette');

  await run(`saveCustomTheme()`);
  await wait(1200);
  await save(mainWin, 'ui-custom-theme');
  await run(`showView('themes')`);
  await wait(500);
  await save(mainWin, 'ui-themes-custom');
  await run(`deleteCustomTheme(state.theme.id)`);
  await wait(700);
  await run(`selectTheme('aurora')`);

  await run(`showView('themes')`);
  for (const theme of ['sunset', 'neo-tokyo', 'paper', 'matrix', 'glacier']) {
    await run(`selectTheme('${theme}')`);
    await wait(900);
    await save(mainWin, `theme-${theme}`);
  }

  await run(`selectTheme('aurora')`);
  setOverlay({ visible: true });
  await wait(500);
  if (overlayWin && !overlayWin.isDestroyed()) {
    await overlayWin.webContents.executeJavaScript(
      `state.settings.overlay.peekMode = false; state.settings.overlay.spectrum = true; state.peek = false; applyUi();`,
      true
    );
  }
  await wait(600);
  for (const layout of ['compact', 'standard', 'wide']) {
    setOverlay({ layout });
    await wait(900);
    await save(overlayWin, `overlay-${layout}`);
  }
  setOverlay({ layout: 'standard' });

  showLauncher();
  await wait(900);
  await save(launcherWin, 'launcher');
  if (launcherWin) launcherWin.hide();

  console.log('[shots] done ->', dir);
  setTimeout(() => quitApp(), 400);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.overlayr.desktop');
    migrateLegacyUserData();

    store = new Store(userDataDir());
    media = new MediaBridge({ scriptPath: path.join(ROOT, 'scripts', 'media.ps1') });
    audio = new AudioBridge(path.join(ROOT, 'tools', 'AuroraAudio.exe'));
    appIndex = new AppIndex({
      scriptPath: path.join(ROOT, 'scripts', 'scan-apps.ps1'),
      cacheFile: path.join(userDataDir(), 'apps-cache.json'),
      iconDir: iconsDir(),
    });
    themeSystem = new ThemeSystem({ scriptPath: path.join(ROOT, 'scripts', 'theme.ps1') });
    artwork = new ArtworkService(path.join(userDataDir(), 'artwork'));
    lyrics = new LyricsService(path.join(userDataDir(), 'lyrics'), artwork);
    display = new DisplayBridge(path.join(ROOT, 'tools', 'AuroraDisplay.exe'));

    spectrum = new SpectrumBridge(path.join(ROOT, 'tools', 'AuroraSpectrum.exe'), { fps: 20 });
    spectrum.on('bands', (frame) => broadcast('spectrum', frame));

    protocol.handle('aurora-icon', (request) => {
      try {
        const url = new URL(request.url);
        const p = url.searchParams.get('p');
        if (!p) return new Response('not found', { status: 404 });
        return net.fetch(pathToFileURL(p).toString());
      } catch {
        return new Response('bad request', { status: 400 });
      }
    });

    media.on('state', (state) => {
      const artFile = state.art || (state.hasSession ? artwork.cached(state) : null);
      broadcast('media', { ...state, artUrl: iconUrl(artFile) });
      updateTrayStatus(!!state.hasSession && !!state.playing);

      // The spectrum helper is CPU-heavy: only run it while something plays.
      if (spectrum) {
        const cfg = store.all.overlay;
        if (cfg.visible && cfg.spectrum !== false && state.playing) spectrum.start();
        else spectrum.stop();
      }

      const signature = state.hasSession ? `${state.title}|${state.artist || ''}|${state.app || ''}` : '';
      if (signature && signature !== lastHistorySig) {
        lastHistorySig = signature;
        mediaHistory.unshift({
          title: state.title || '',
          artist: state.artist || '',
          app: state.app || '',
          at: Date.now(),
        });
        if (mediaHistory.length > 12) mediaHistory.pop();
        broadcast('media:history', mediaHistory);
      }
      if (state.hasSession && !artFile && state.title) {
        const key = `${state.title}|${state.artist || ''}`;
        if (key !== lastArtKey) {
          lastArtKey = key;
          artwork
            .find({ title: state.title, artist: state.artist })
            .then((file) => {
              if (!file) return;
              const current = media.last;
              if (!current || `${current.title}|${current.artist || ''}` !== key) return;
              broadcast('media', { ...current, artUrl: iconUrl(file), artSource: 'catalogue' });
            })
            .catch(() => {});
        }
      } else if (!state.hasSession) {
        lastArtKey = '';
      }
    });
    media.start();

    store.on('change', (data) => broadcast('settings', data));

    nativeTheme.themeSource = currentTheme().dark ? 'dark' : 'light';

    registerIpc();
    createMainWindow();
    createOverlayWindow();
    createTray();
    registerHotkeys();
    startStats();
    startAudioWatch();
    applyWarmOverlay();
    startFullscreenWatcher();
    restartSlideshow();

    appIndex
      .ensureFresh()
      .then(() => {
        broadcast('apps', appsForRenderer());
        broadcast('pinned', pinnedForRenderer());
      })
      .catch((err) => console.error('[apps] initial scan failed', err));

    const st = await audio.get();
    broadcast('audio', st);

    if (!store.all.seenWelcome) {
      store.patch({ seenWelcome: true });
    }

    app.on('activate', () => showMain());

    if (process.env.AURORA_SHOT_DIR) {
      setTimeout(() => {
        runDevShots(process.env.AURORA_SHOT_DIR).catch((err) => {
          console.error('[shots] failed', err);
          quitApp();
        });
      }, 3000);
    }
  });

  app.on('window-all-closed', () => {
    // Aurora lives in the tray; keep running until the user quits explicitly.
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (media) media.stop();
    if (spectrum) spectrum.stop();
    if (fullscreenTimer) clearInterval(fullscreenTimer);
    if (slideshowTimer) clearInterval(slideshowTimer);
  });
}

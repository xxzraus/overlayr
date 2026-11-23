'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = {
  themeId: 'aurora',
  applyDarkMode: true,
  applyAccent: true,
  applyWallpaper: false,
  overlay: {
    visible: true,
    x: null,
    y: null,
    width: 420,
    layout: 'standard', // compact | standard | wide
    opacity: 0.96,
    radius: 24,
    alwaysOnTop: true,
    clickThrough: false,
    peekMode: true,
    showVisualizer: true,
    showProgress: true,
    showVolume: true,
    showClock: false,
    showStats: false,
    volumeMode: 'app', // app | system
    spectrum: true,
    spectrumStyle: 'bars', // bars | wave | circle
    spectrumSensitivity: 100,
    hideInFullscreen: true,
    accentGlow: true,
  },
  pinned: [],
  usage: {},
  recent: [],
  wallpaperMode: 'auto', // auto | dark | light — how to derive a theme from the wallpaper
  wallpaperPattern: 'aurora', // aurora | waves | grid | dots | rings | custom
  wallpaperLyrics: true, // draw song lyrics on the player wallpaper
  previousWallpaper: null, // what was on the desktop before Overlayr changed it
  wallpaperDrawing: [], // normalized strokes for the custom pattern
  slideshowEnabled: false,
  slideshowMinutes: 30,
  hideDesktopIcons: false,
  wallpaperSource: 'pattern', // pattern | player
  appHotkeys: {},
  display: { brightness: null, contrast: null, warm: false, warmStrength: 45 },
  hotkeys: {
    launcher: 'Control+Alt+Space',
    overlay: 'Control+Alt+M',
    nextTheme: 'Control+Alt+T',
    mute: 'Control+Alt+V',
  },
  launchAtLogin: false,
  language: 'en',
  seenWelcome: false,
  welcomedOverlayr: false,
  customThemes: [],
};

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this._timer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = deepMerge(DEFAULTS, parsed);
    } catch {
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
    return this.data;
  }

  get all() {
    return this.data;
  }

  patch(partial, opts = {}) {
    this.data = deepMerge(this.data, partial);
    this.save();
    if (!opts.silent) this.emit('change', this.data);
    return this.data;
  }

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] save failed', err);
    }
  }
}

module.exports = { Store, DEFAULTS };

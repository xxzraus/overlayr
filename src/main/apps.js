'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

/**
 * Index of installed applications (Start menu shortcuts + UWP packages),
 * with icon extraction handled by scripts/scan-apps.ps1.
 */

const NOISE = [
  /^(деинсталл|uninstall|удалить|remove\b)/i,
  /(readme|release notes|changelog|лицензи|license|документац|documentation|справка|^help\b)/i,
  /(^сайт|^website|^support|поддержка сайта|^online|^веб-сайт)/i,
  /(архивация windows|windows backup|диск восстановления|recovery drive|действие щелчком|click action)/i,
  /(^setup$|^install$|^установить$)/i,
  /(приватный просмотр|private browsing|inprivate)/i,
];

const SYSTEM_HINTS = [
  /(автоматические субтитры|live captions|голосовой доступ|voice access)/i,
  /(инициатор iscsi|iscsi initiator|быстрая проверка|quick assist|средство просмотра событий|event viewer)/i,
  /(монитор ресурсов|resource monitor|конфигурация системы|system configuration|редактор реестра|registry editor)/i,
  /(^службы$|^services$|^параметры$|^settings$|^настройки$|^панель управления$|control panel)/i,
  /(^начало работы$|^get started$|языковые параметры|office language)/i,
  /(подключение к удалённому рабочему столу|remote desktop connection|^ярлык$)/i,
];

function isNoise(app) {
  return NOISE.some((re) => re.test(app.name || ''));
}

function looksSystem(app) {
  if (SYSTEM_HINTS.some((re) => re.test(app.name || ''))) return true;
  const target = String(app.target || '');
  if (app.kind === 'win32' && /\\windows\\(system32|syswow64|systemapps)\\/i.test(target)) return true;
  return false;
}

/** Drops installer/readme junk and tags Windows utilities (ranked last). */
function normalizeApps(list) {
  return (list || [])
    .filter((a) => a && a.name && !isNoise(a))
    .map((a) => ({ ...a, system: looksSystem(a) }));
}

class AppIndex {
  constructor({ scriptPath, cacheFile, iconDir }) {
    this.scriptPath = scriptPath;
    this.cacheFile = cacheFile;
    this.iconDir = iconDir;
    this.apps = [];
    this.scannedAt = 0;
    this.scanning = null;
  }

  loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (Array.isArray(raw.apps)) {
        this.apps = normalizeApps(raw.apps);
        this.scannedAt = raw.scannedAt || 0;
        return true;
      }
    } catch { /* no cache yet */ }
    return false;
  }

  saveCache() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({ scannedAt: this.scannedAt, apps: this.apps }), 'utf8');
    } catch (err) {
      console.error('[apps] cache write failed', err.message);
    }
  }

  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = new Promise((resolve) => {
      const started = Date.now();
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', this.scriptPath,
          '-IconDir', this.iconDir,
          '-MaxIcons', '500',
        ],
        { windowsHide: true, timeout: 90000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          this.scanning = null;
          if (stderr && stderr.trim()) console.error('[apps:ps]', stderr.trim().slice(0, 500));
          if (err) {
            console.error('[apps] scan failed', err.message);
            resolve(this.apps);
            return;
          }
          try {
            const text = String(stdout);
            const jsonStart = text.indexOf('{');
            const parsed = JSON.parse(text.slice(jsonStart));
            if (Array.isArray(parsed.apps)) {
              this.apps = normalizeApps(parsed.apps);
              this.scannedAt = Date.now();
              this.saveCache();
              console.log(`[apps] scanned ${this.apps.length} apps in ${Date.now() - started}ms`);
            }
          } catch (parseErr) {
            console.error('[apps] failed to parse scan output', parseErr.message);
          }
          resolve(this.apps);
        }
      );
    });
    return this.scanning;
  }

  async ensureFresh(maxAgeMs = 15 * 60 * 1000) {
    if (!this.apps.length) this.loadCache();
    if (!this.apps.length || Date.now() - this.scannedAt > maxAgeMs) {
      await this.scan();
    }
    return this.apps;
  }

  find(id) {
    return this.apps.find((a) => a.id === id) || null;
  }

  async launch(app) {
    if (!app) return { ok: false, error: 'unknown-app' };
    try {
      if (app.kind === 'uwp') {
        spawn('explorer.exe', [`shell:AppsFolder\\${app.target}`], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
      }
      const target = app.target || '';
      const ext = path.extname(target).toLowerCase();
      if (ext === '.lnk' || ext === '.url' || ext === '') {
        const res = await shell.openPath(target);
        return { ok: !res, error: res || undefined };
      }
      const args = app.args ? String(app.args).split(/\s+/).filter(Boolean) : [];
      spawn(target, args, {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(target),
        windowsVerbatimArguments: false,
      }).unref();
      return { ok: true };
    } catch (err) {
      // Last resort: let Windows figure it out from the shortcut.
      try {
        const res = await shell.openPath(app.target);
        return { ok: !res, error: res || undefined };
      } catch (err2) {
        return { ok: false, error: String(err2.message || err.message) };
      }
    }
  }
}

module.exports = { AppIndex };

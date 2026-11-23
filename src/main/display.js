'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

/**
 * Wraps tools/AuroraDisplay.exe: DDC/CI brightness & contrast plus a
 * "is the foreground window fullscreen" probe.
 */
class DisplayBridge {
  constructor(exePath) {
    this.exePath = exePath;
    this.available = fs.existsSync(exePath);
    this.last = null;
  }

  run(args, timeout = 5000) {
    if (!this.available) return Promise.resolve({ ok: false, error: 'helper-missing' });
    return new Promise((resolve) => {
      execFile(this.exePath, args, { windowsHide: true, timeout }, (err, stdout) => {
        if (err && !stdout) {
          resolve({ ok: false, error: err.message });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim().split('\n').pop());
          if (seen.has(args[0])) this.last = parsed;
          resolve(parsed);
        } catch {
          resolve({ ok: false, error: 'bad-json' });
        }
      });
    });
  }

  get() {
    return this.run(['brightness', 'get']);
  }

  setBrightness(value) {
    return this.run(['brightness', 'set', String(Math.round(Number(value) || 0))]);
  }

  setContrast(value) {
    return this.run(['contrast', 'set', String(Math.round(Number(value) || 0))]);
  }

  fullscreen() {
    return this.run(['fullscreen'], 2000);
  }
}

const seen = new Set(['brightness', 'contrast', 'fullscreen']);

module.exports = { DisplayBridge };

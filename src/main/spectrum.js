'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');

/**
 * Wraps tools/AuroraSpectrum.exe — a WASAPI loopback spectrum analyser that
 * prints one JSON frame per line. Frames are throttled before they reach the
 * renderer so we do not flood IPC at 30 fps.
 */
class SpectrumBridge extends EventEmitter {
  constructor(exePath, { fps = 20 } = {}) {
    super();
    this.exePath = exePath;
    this.interval = 1000 / fps;
    this.proc = null;
    this.buffer = '';
    this.lastSent = 0;
    this.latest = null;
    this.restarts = 0;
    this.stopping = false;
    this.available = fs.existsSync(exePath);
  }

  start() {
    if (this.proc || !this.available) return;
    this.stopping = false;
    this.proc = spawn(this.exePath, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error('[spectrum]', text.slice(0, 300));
    });
    this.proc.on('error', () => {
      this.available = false;
      this.proc = null;
    });
    this.proc.on('exit', () => {
      this.proc = null;
      if (this.stopping) return;
      this.restarts += 1;
      if (this.restarts > 5) return;
      setTimeout(() => this.start(), 2000);
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line || line[0] !== '{') continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(frame.bands)) continue;
      const now = Date.now();
      if (now - this.lastSent < this.interval) continue;
      this.lastSent = now;
      this.latest = frame;
      this.emit('bands', frame);
    }
    if (this.buffer.length > 100000) this.buffer = '';
  }

  stop() {
    this.stopping = true;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch { /* ignore */ }
      this.proc = null;
    }
  }
}

module.exports = { SpectrumBridge };

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Long-lived PowerShell watcher around the Windows media session API.
 * It streams NDJSON state every ~250ms; commands are handed over through a
 * small JSON file so we never pay PowerShell's ~1.2s startup per click.
 */
class MediaBridge extends EventEmitter {
  constructor({ scriptPath }) {
    super();
    this.scriptPath = scriptPath;
    this.cmdFile = path.join(os.tmpdir(), 'aurora-media-cmd.json');
    this.artDir = path.join(os.tmpdir(), 'aurora-art');
    this.proc = null;
    this.buffer = '';
    this.last = null;
    this.restarts = 0;
    this.stopping = false;
  }

  start() {
    if (this.proc) return;
    this.stopping = false;
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath,
      '-IntervalMs', '400',
      '-CmdFile', this.cmdFile,
      '-ArtDir', this.artDir,
    ];
    this.proc = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error('[media:ps]', text.slice(0, 400));
    });

    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return;
      this.restarts += 1;
      const delay = Math.min(8000, 400 * this.restarts);
      console.error(`[media] watcher exited (${code}), restart in ${delay}ms`);
      setTimeout(() => this.start(), delay);
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line || line[0] !== '{') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type === 'state') {
        this.restarts = 0;
        parsed.receivedAt = Date.now();
        this.last = parsed;
        this.emit('state', parsed);
      } else if (parsed.type === 'error') {
        console.error('[media] bridge error', parsed.message);
      }
    }
    if (this.buffer.length > 200000) this.buffer = '';
  }

  command(action, value = null, target = null) {
    const payload = JSON.stringify(target ? { action, value, target } : { action, value });
    const tmp = this.cmdFile + '.tmp';
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.cmdFile);
    } catch (err) {
      console.error('[media] command failed', err.message);
    }
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

module.exports = { MediaBridge };

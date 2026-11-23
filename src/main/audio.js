'use strict';

const { execFile } = require('child_process');

/** GSMTC app ids are not process names — translate the common cases. */
function processNameFor(appId) {
  if (!appId) return null;
  const base = String(appId).split('!')[0];
  if (/\.exe$/i.test(base)) return base;
  if (/Microsoft\.ZuneMusic/i.test(base)) return 'Music.UI.exe';
  if (/Microsoft\.WindowsMediaPlayer/i.test(base)) return 'wmplayer.exe';
  if (/Microsoft\.MicrosoftEdge/i.test(base)) return 'msedge.exe';
  if (/^MSEdge$/i.test(base)) return 'msedge.exe';
  if (/^Chrome$/i.test(base)) return 'chrome.exe';
  if (/Spotify/i.test(base)) return 'Spotify.exe';
  if (/foobar/i.test(base)) return 'foobar2000.exe';
  if (/AIMP/i.test(base)) return 'AIMP.exe';
  if (/soundcloud/i.test(base)) return 'soundcloud-desktop.exe';
  return `${base}.exe`;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Thin wrapper around the compiled CoreAudio helper (tools/AuroraAudio.exe). */
class AudioBridge {
  constructor(exePath) {
    this.exePath = exePath;
    this.last = { volume: null, muted: false, at: 0 };
  }

  run(args) {
    return new Promise((resolve) => {
      execFile(this.exePath, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
        if (err && !stdout) {
          resolve({ ok: false, error: err.message, volume: null, muted: false });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim().split('\n').pop());
          if (!parsed.app) this.last = { volume: parsed.volume, muted: parsed.muted, at: Date.now() };
          resolve(parsed);
        } catch {
          resolve({ ok: false, error: 'bad-json', volume: null, muted: false });
        }
      });
    });
  }

  get() {
    return this.run(['get']);
  }

  set(percent) {
    const v = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    return this.run(['set', String(v)]);
  }

  step(delta) {
    return this.run(['step', String(Math.round(Number(delta) || 0))]);
  }

  setMute(on) {
    return this.run(['mute', on ? '1' : '0']);
  }

  toggleMute() {
    return this.run(['toggle-mute']);
  }

  /* ---- per application ---- */

  sessions() {
    return this.run(['apps']);
  }

  /**
   * GSMTC ids like "com.soundcloud.desktop" never match an audio session
   * process name directly, so we look at the live session list and pick the
   * closest name (substring match in either direction, active sessions first).
   */
  async resolveProcess(appId) {
    if (!appId) return null;
    const now = Date.now();
    const cached = this.resolved && this.resolved.get(appId);
    if (cached && now - cached.at < 30000) return cached.name;

    const guess = processNameFor(appId);
    const target = normalizeName(String(appId).split('!')[0]);
    const res = await this.sessions();
    const sessions = (res && Array.isArray(res.sessions) && res.sessions) || [];

    let best = null;
    let bestScore = -1;
    for (const session of sessions) {
      if (!session || !session.name || /^system$/i.test(session.name)) continue;
      const name = normalizeName(session.name);
      if (name.length < 4) continue;
      let score = -1;
      if (normalizeName(guess) === name) score = 120;
      else if (name === target) score = 110;
      else if (target.includes(name)) score = 80 + Math.min(20, name.length);
      else if (name.includes(target)) score = 60 + Math.min(20, target.length);
      if (score >= 60 && session.state === 'Active') score += 10;
      if (score > bestScore) {
        bestScore = score;
        best = session.name;
      }
    }

    const resolved = bestScore >= 70 ? best : guess;
    if (!this.resolved) this.resolved = new Map();
    this.resolved.set(appId, { name: resolved, at: now });
    return resolved;
  }

  async getApp(appId) {
    const name = await this.resolveProcess(appId);
    if (!name) return { ok: false, error: 'no-target', volume: null, muted: false };
    const res = await this.run(['app-get', name]);
    if (!res.ok) {
      const sys = await this.get();
      return { ...sys, app: null, fallback: 'system', reason: res.error };
    }
    return { ...res, app: name };
  }

  async setApp(appId, percent) {
    const name = await this.resolveProcess(appId);
    const v = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    if (!name) return { ok: false, error: 'no-target', volume: null, muted: false };
    const res = await this.run(['app-set', name, String(v)]);
    if (!res.ok) return { ok: false, error: res.error || 'session-not-found', volume: null, muted: false };
    return { ...res, app: name };
  }

  async toggleAppMute(appId) {
    const name = await this.resolveProcess(appId);
    if (!name) return { ok: false, error: 'no-target', volume: null, muted: false };
    const res = await this.run(['app-toggle-mute', name]);
    if (!res.ok) return { ok: false, error: res.error || 'session-not-found', volume: null, muted: false };
    return { ...res, app: name };
  }
}

module.exports = { AudioBridge, processNameFor };


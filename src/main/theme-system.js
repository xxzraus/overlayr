'use strict';

const { execFile } = require('child_process');

/** Applies Aurora's colours to Windows itself: dark mode, accent, wallpaper. */
class ThemeSystem {
  constructor({ scriptPath }) {
    this.scriptPath = scriptPath;
  }

  run(extraArgs) {
    return new Promise((resolve) => {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, ...extraArgs];
      execFile('powershell.exe', args, { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        if (err && !stdout) {
          resolve({ ok: false, error: err.message });
          return;
        }
        try {
          resolve(JSON.parse(String(stdout).trim().split('\n').pop()));
        } catch {
          resolve({ ok: false, error: 'bad-json' });
        }
      });
    });
  }

  status() {
    return this.run(['-Action', 'status']);
  }

  setDark(dark) {
    return this.run(['-Action', 'dark', '-Dark', dark ? '1' : '0']);
  }

  setAccent(hex, taskbarAccent = 1) {
    return this.run(['-Action', 'accent', '-Hex', hex, '-TaskbarAccent', String(taskbarAccent)]);
  }

  setWallpaper(filePath) {
    return this.run(['-Action', 'wallpaper', '-Path', filePath]);
  }

  desktopIcons() {
    return this.run(['-Action', 'deskicons-status']);
  }

  setDesktopIcons(hide) {
    return this.run(['-Action', 'deskicons', '-Value', hide ? '1' : '0']);
  }

  applyAll({ dark, accent, wallpaper }) {
    const args = ['-Action', 'all', '-Hex', accent || '#7C5CFF'];
    if (dark === undefined || dark === null) args.push('-SkipDark');
    else args.push('-Dark', dark ? '1' : '0');
    if (wallpaper) args.push('-Path', wallpaper);
    return this.run(args);
  }
}

module.exports = { ThemeSystem };

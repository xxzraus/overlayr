# Changelog

## 1.3.1 — 2026-11-23

### Added
- **Lyrics switch**: the song text on the player wallpaper can be turned off.
- Repository layout, build scripts, CI workflow, changelog and roadmap for public releases.

### Changed
- Build scripts use paths relative to the repository; NSIS and portable builds work from any folder.

## 1.3.0 — 2026-11-23

### Added
- **Player wallpaper**: cover, title, artist and the full song lyrics in 2–4 fitted columns, with a live time and progress bar.
- **Lyrics switch** — the text can be turned off so the wallpaper only shows the cover.
- **More cover sources**: Genius, iTunes, Deezer and Yandex Music are queried in parallel; the first answer wins.
- **Timed lyrics** from LRCLIB (Genius plain text as a fallback), cached on disk.
- **Desktop icons toggle** next to the wallpaper controls.
- **English interface** (default) with a Russian switch in Settings.
- **Warm evening mode** and monitor brightness/contrast (DDC/CI).
- **Restore previous wallpaper** button.
- **Player preview** in the Music page and a recent-tracks history.
- **Custom hotkeys per pinned app**.

### Changed
- Covers no longer show a placeholder while the catalogue lookup is running — the wallpaper waits for the artwork.
- Player wallpaper is rendered at 1920×1080 JPEG, refreshed about once per second in player mode.
- Sidebar artwork removed; navigation buttons have a fixed height.
- The app, installer, shortcuts, tray and window icons use the current Overlayr artwork.

### Fixed
- Per-app volume for players whose audio session name differs from the media app id.
- Wrong cover art from a different artist.
- Peek mode clipping the card in the wide layout.
- Installer showing garbled Cyrillic because the NSIS script lost its UTF-8 BOM.
- Cover race on track change.

## 1.2.0 — 2026-11-16

### Added
- Theme editor with contrast, gamma, gradient, saturation, brightness, glow, radius and background style.
- Wallpaper palette modes (auto / dark / light), theme export and import, profiles on `Ctrl+Alt+F1…F3`.
- Genius cover lookup with strict artist matching.

### Fixed
- Overlay peek mode in the wide layout.
- Theme accent overflow writing a zero accent colour.

## 1.1.0 — 2026-11-15

- First public build: 18 themes, music overlay, dock, launcher, wallpaper generation.

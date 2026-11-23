'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = new Set([
  'media',
  'audio',
  'stats',
  'settings',
  'theme',
  'apps',
  'pinned',
  'usage',
  'hotkeys',
  'spectrum',
  'profile:hotkey',
  'media:history',
  'wallpaper:request',
  'overlay:settings',
  'system:applied',
  'launcher:shown',
]);

contextBridge.exposeInMainWorld('aurora', {
  boot: () => ipcRenderer.invoke('boot'),

  on(channel, callback) {
    if (!EVENT_CHANNELS.has(channel)) return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  settings: {
    patch: (partial) => ipcRenderer.invoke('settings:patch', partial),
  },

  theme: {
    apply: (opts) => ipcRenderer.invoke('theme:apply', opts),
    cycle: () => ipcRenderer.invoke('theme:cycle'),
    export: (theme) => ipcRenderer.invoke('theme:export', theme),
    import: () => ipcRenderer.invoke('theme:import'),
  },

  system: {
    apply: (opts) => ipcRenderer.invoke('system:apply', opts),
    status: () => ipcRenderer.invoke('system:status'),
    wallpaperFromDataUrl: (payload) => ipcRenderer.invoke('system:wallpaperFromDataUrl', payload),
    setWallpaperFile: (file) => ipcRenderer.invoke('system:setWallpaperFile', file),
    restoreWallpaper: () => ipcRenderer.invoke('system:restoreWallpaper'),
    desktopIcons: (hide) => ipcRenderer.invoke('system:desktopIcons', hide),
  },

  media: {
    command: (payload) => ipcRenderer.invoke('media:command', payload),
    history: () => ipcRenderer.invoke('media:history'),
  },

  lyrics: {
    get: (meta) => ipcRenderer.invoke('lyrics:get', meta),
  },

  display: {
    get: () => ipcRenderer.invoke('display:get'),
    brightness: (v) => ipcRenderer.invoke('display:brightness', v),
    contrast: (v) => ipcRenderer.invoke('display:contrast', v),
    warm: (payload) => ipcRenderer.invoke('display:warm', payload),
    fullscreen: () => ipcRenderer.invoke('display:fullscreen'),
  },

  slideshow: {
    set: (cfg) => ipcRenderer.invoke('slideshow:set', cfg),
  },

  appHotkeys: {
    set: (map) => ipcRenderer.invoke('appHotkeys:set', map),
  },

  audio: {
    get: () => ipcRenderer.invoke('audio:get'),
    set: (v) => ipcRenderer.invoke('audio:set', v),
    step: (d) => ipcRenderer.invoke('audio:step', d),
    mute: (on) => ipcRenderer.invoke('audio:mute', on),
    toggleMute: () => ipcRenderer.invoke('audio:toggleMute'),
    sessions: () => ipcRenderer.invoke('audio:sessions'),
    getApp: (appId) => ipcRenderer.invoke('audio:getApp', appId),
    setApp: (appId, v) => ipcRenderer.invoke('audio:setApp', { appId, value: v }),
    toggleAppMute: (appId) => ipcRenderer.invoke('audio:toggleAppMute', appId),
  },

  apps: {
    list: () => ipcRenderer.invoke('apps:list'),
    refresh: () => ipcRenderer.invoke('apps:refresh'),
    launch: (id) => ipcRenderer.invoke('apps:launch', id),
    pin: (app) => ipcRenderer.invoke('apps:pin', app),
    unpin: (id) => ipcRenderer.invoke('apps:unpin', id),
    reorder: (ids) => ipcRenderer.invoke('apps:reorder', ids),
  },

  overlay: {
    set: (partial) => ipcRenderer.invoke('overlay:set', partial),
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    toggle: () => ipcRenderer.invoke('overlay:toggle'),
    resize: (size) => ipcRenderer.invoke('overlay:resize', size),
    getPos: () => ipcRenderer.invoke('overlay:getPos'),
    moveTo: (point) => ipcRenderer.invoke('overlay:moveTo', point),
    cursorInside: () => ipcRenderer.invoke('overlay:cursorInside'),
  },

  launcher: {
    show: () => ipcRenderer.invoke('launcher:show'),
    hide: () => ipcRenderer.invoke('launcher:hide'),
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    hide: () => ipcRenderer.invoke('window:hide'),
  },

  hotkeys: {
    apply: () => ipcRenderer.invoke('hotkeys:apply'),
  },

  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    dataDir: () => ipcRenderer.invoke('app:dataDir'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openPath: (p) => ipcRenderer.invoke('app:openPath', p),
    setLoginItem: (enabled) => ipcRenderer.invoke('app:loginItem', enabled),
  },
});

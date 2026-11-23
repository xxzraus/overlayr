'use strict';

/* Aurora — spotlight launcher renderer */

const api = window.aurora;
const tr = (text) => (window.OverlayrI18n ? window.OverlayrI18n.trText(text) : text);
const $ = (s) => document.querySelector(s);

const state = {
  apps: [],
  pinned: [],
  usage: {},
  filtered: [],
  index: 0,
  settings: null,
};

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function luminance(hex) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function applyTheme(theme, settings) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars || {})) root.style.setProperty(k, v);
  const accent = settings?.accentOverride || theme.accent;
  if (settings?.accentOverride) root.style.setProperty('--accent', settings.accentOverride);
  root.style.setProperty('--on-accent', luminance(accent) > 0.42 ? '#0A0B10' : '#FFFFFF');
}

function score(app, query) {
  if (!query) return 0;
  const name = app.name.toLowerCase();
  const q = query.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  // loose subsequence match ("vsc" -> "Visual Studio Code")
  let i = 0;
  for (const ch of name) {
    if (ch === q[i]) i++;
    if (i === q.length) break;
  }
  return i === q.length ? 30 : -1;
}

function filter() {
  const q = $('#l-input').value.trim();
  const pinnedIds = new Set(state.pinned.map((p) => p.id));
  let list = state.apps
    .map((app) => ({ app, s: score(app, q) }))
    .filter((x) => (q ? x.s >= 0 : true));

  if (q) {
    list.sort((a, b) => b.s - a.s || a.app.name.localeCompare(b.app.name));
  } else {
    list.sort((a, b) => {
      const pa = pinnedIds.has(a.app.id) ? 1 : 0;
      const pb = pinnedIds.has(b.app.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ua = state.usage[a.app.id] || 0;
      const ub = state.usage[b.app.id] || 0;
      if (ua !== ub) return ub - ua;
      const sa = a.app.system ? 1 : 0;
      const sb = b.app.system ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return a.app.name.localeCompare(b.app.name, 'ru');
    });
  }

  state.filtered = list.slice(0, 40).map((x) => x.app);
  state.index = Math.min(state.index, Math.max(0, state.filtered.length - 1));
  render();
}

function render() {
  const list = $('#l-list');
  $('#l-count').textContent = state.filtered.length ? `${state.filtered.length}` : '';
  const pinnedIds = new Set(state.pinned.map((p) => p.id));

  if (!state.filtered.length) {
    list.innerHTML = `<div class="l-empty">${tr('Ничего не найдено. Попробуй другое название.')}</div>`;
    return;
  }

  list.innerHTML = state.filtered
    .map((app, i) => {
      const icon = app.iconUrl
        ? `<img src="${esc(app.iconUrl)}" alt="" />`
        : esc((app.name || '?').charAt(0).toUpperCase());
      return `<div class="l-item ${i === state.index ? 'sel' : ''}" data-i="${i}" data-id="${esc(app.id)}">
        <div class="ico">${icon}</div>
        <div class="nm">${esc(app.name)}</div>
        ${pinnedIds.has(app.id) ? `<span class="tag">${tr('в доке')}</span>` : ''}
      </div>`;
    })
    .join('');

  list.querySelectorAll('.l-item').forEach((node) => {
    node.addEventListener('click', () => {
      state.index = Number(node.dataset.i);
      activate();
    });
    node.addEventListener('mousemove', () => {
      const i = Number(node.dataset.i);
      if (i !== state.index) {
        state.index = i;
        list.querySelectorAll('.l-item').forEach((n, k) => n.classList.toggle('sel', k === i));
      }
    });
  });

  const selected = list.querySelector('.l-item.sel');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

async function activate() {
  const app = state.filtered[state.index];
  if (!app) return;
  api.apps.launch(app.id);
  $('#l-hint').textContent = tr('Запускаю ') + app.name + '…';
  setTimeout(() => api.launcher.hide(), 120);
}

function reset() {
  $('#l-input').value = '';
  $('#l-input').focus();
  state.index = 0;
  $('#l-hint').textContent = '';
  filter();
}

async function init() {
  const payload = await api.boot();
  if (window.OverlayrI18n) {
    window.OverlayrI18n.setLang(payload.settings && payload.settings.language === 'ru' ? 'ru' : 'en');
    window.OverlayrI18n.apply(document);
  }
  state.settings = payload.settings;
  state.apps = payload.apps || [];
  state.pinned = payload.pinned || [];
  state.usage = payload.settings?.usage || {};
  applyTheme(payload.theme, payload.settings);
  filter();

  $('#l-input').addEventListener('input', () => {
    state.index = 0;
    filter();
  });

  $('#l-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.index = Math.min(state.index + 1, state.filtered.length - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.index = Math.max(state.index - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      api.launcher.hide();
    }
  });

  api.on('launcher:shown', reset);
  api.on('apps', (apps) => {
    state.apps = apps;
    filter();
  });
  api.on('pinned', (pinned) => {
    state.pinned = pinned;
    filter();
  });
  api.on('theme', (theme) => applyTheme(theme, state.settings));

  setTimeout(() => $('#l-input').focus(), 60);
}

init().catch((err) => {
  document.body.innerHTML = '<pre style="color:#fff;font-size:11px">' + esc(err.stack || err.message) + '</pre>';
});

// Everything is kept on the phone (localStorage). Storage can be blocked or
// cleared, so every access is guarded and the app still works without it.

import { DEFAULT_SETTINGS } from './score.js';

const K = { settings: 'bam.settings.v1', log: 'bam.log.v1', recent: 'bam.recent.v1' };
const RECENT_MAX = 40;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function localDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const store = {
  settings() {
    const s = { ...DEFAULT_SETTINGS, ...read(K.settings, {}) };
    s.avoid = Array.isArray(s.avoid) ? s.avoid : [];
    s.watch = Array.isArray(s.watch) ? s.watch : [];
    return s;
  },
  saveSettings(s) {
    return write(K.settings, s);
  },

  log() {
    return read(K.log, []);
  },
  addLog(entry) {
    const log = this.log();
    log.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, t: new Date().toISOString(), day: localDayKey(), ...entry });
    return write(K.log, log);
  },
  removeLog(id) {
    return write(K.log, this.log().filter((e) => e.id !== id));
  },

  // Last products looked at, kept so a saved copy still opens with no signal.
  recent() {
    return read(K.recent, []);
  },
  remember(product, level) {
    const list = this.recent().filter((r) => r.product.barcode !== product.barcode);
    list.unshift({ at: new Date().toISOString(), level, product });
    return write(K.recent, list.slice(0, RECENT_MAX));
  },
  recentFor(barcode) {
    return this.recent().find((r) => r.product.barcode === barcode) || null;
  },

  exportAll() {
    return JSON.stringify({ app: 'bam-scan', version: 1, exportedAt: new Date().toISOString(), settings: this.settings(), log: this.log() }, null, 2);
  },
  importAll(text) {
    const data = JSON.parse(text);
    if (data?.app !== 'bam-scan') throw new Error('That file is not a BAM Check backup.');
    if (data.settings) write(K.settings, { ...DEFAULT_SETTINGS, ...data.settings });
    if (Array.isArray(data.log)) write(K.log, data.log);
  },
  wipe() {
    for (const k of Object.values(K)) {
      try { localStorage.removeItem(k); } catch { /* nothing to do */ }
    }
  },
};

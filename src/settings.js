// localStorage-backed settings. No "session" — just persist everything.

import { CONFIG } from './config.js';

const KEY = 'chord-bunny.v1';

const DEFAULTS = {
  mode: 'practice',                 // 'practice' | 'listen'
  enabledChords: ['C', 'D', 'G', 'Em', 'Am'],   // friendly starter set
  showDiagrams: true,
  autoAdvance: true,
  timerEnabled: false,
  timerSecs: 60,
  sensitivity: CONFIG.sensitivity.defaultSlider,   // 0-100 → confidence threshold (config.js)
  minHoldMs: CONFIG.stable.minHoldMs,              // practice matching window base
  micEverEnabled: false,            // sticky: if user enabled mic before, try to auto-prompt
  telemetry: true,                  // log events + record non-silent audio to the local server
  sequence: 'random',               // 'random' pairs, or a progression id from data/progressions.json
};

const listeners = [];
export function onChange(fn) { listeners.push(fn); }

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
}

export function get(key) { return load()[key]; }
export function set(key, value) {
  load();
  cache[key] = value;
  save();
  for (const fn of listeners) fn(key, value);
}
export function update(patch) {
  load();
  Object.assign(cache, patch);
  save();
}
export function all() { return { ...load() }; }

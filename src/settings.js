// localStorage-backed settings. No "session" — just persist everything.

const KEY = 'chord-bunny.v1';

const DEFAULTS = {
  mode: 'practice',                 // 'practice' | 'listen'
  enabledChords: ['C', 'D', 'G', 'Em', 'Am'],   // friendly starter set
  showDiagrams: true,
  autoAdvance: true,
  timerEnabled: false,
  timerSecs: 60,
  sensitivity: 55,                  // 0-100, higher = stricter cosine threshold
  minHoldMs: 350,                   // how long a chord must be held to count
  micEverEnabled: false,            // sticky: if user enabled mic before, try to auto-prompt
};

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
}
export function update(patch) {
  load();
  Object.assign(cache, patch);
  save();
}
export function all() { return { ...load() }; }

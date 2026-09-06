// Local telemetry: batches events and POSTs them to serve.py (./telemetry/
// <session>.jsonl). Nothing leaves the machine; python -m http.server just
// drops the POSTs. `t` is seconds since page load; frame/strum events also
// carry `ts`, the audio-stream clock, which is what recordings are cut on.

import * as settings from './settings.js';
import { CONFIG } from './config.js';

const T0 = performance.now();
export const session = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
export const now = () => (performance.now() - T0) / 1000;

let queue = [];
let enabled = settings.get('telemetry') !== false;
let failed = 0;

export function setEnabled(v) { enabled = !!v; if (!enabled) queue = []; }
export function isEnabled() { return enabled; }

export function log(type, data = {}) {
  if (!enabled) return;
  queue.push(JSON.stringify({ t: +now().toFixed(3), type, ...data }));
  if (queue.length >= 400) flush();
}

export function flush(beacon = false) {
  if (!queue.length || failed > 20) return;
  const body = queue.join('\n') + '\n';
  queue = [];
  const url = `api/telemetry?session=${session}`;
  if (beacon && navigator.sendBeacon) { navigator.sendBeacon(url, body); return; }
  fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
    .then(r => { if (!r.ok) failed++; })
    .catch(() => { failed++; });
}

setInterval(() => flush(), CONFIG.telemetry.flushMs);
addEventListener('pagehide', () => flush(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(true); });

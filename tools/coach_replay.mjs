// Replay the practice coach over a telemetry session: what hints would it
// have shown, when, for which target? Uses the 5/s frame samples and the
// strum events in the log (the live coach sees ~16 frames/s; results are
// close, not identical).
//   node tools/coach_replay.mjs <telemetry/session.jsonl | latest> [--cfg=coach.strayMin:0.1] [--all]
import fs from 'node:fs';
import path from 'node:path';
import { Coach } from '../src/coach.js';
import { applyOverrides, CONFIG } from '../src/config.js';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
if (args.cfg) console.log('config overrides:', applyOverrides(args.cfg).join(' '));
let file = process.argv.slice(2).find(a => !a.startsWith('--')) || 'latest';
const DIR = path.resolve(import.meta.dirname, '../telemetry');
if (file === 'latest') file = fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).map(f => path.join(DIR, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const byId = Object.fromEntries(CHORDS.map(c => [c.id, c]));
const ev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const hints = [];   // { t, target, kind, text }
let target = null;
const coach = new Coach({ chords: CHORDS, onHint: (h, t) => { if (h) hints.push({ t, target: target?.id, ...h }); } });
let nextTick = 0;
for (const e of ev) {
  while (e.t >= nextTick) { coach.tick(nextTick); nextTick += 0.25; }
  if (e.type === 'pair') { target = byId[e.cur] || null; coach.setTarget(target, e.t); }
  else if (e.type === 'match') coach.setMatched(e.t);
  else if (e.type === 'frame') coach.pushFrame({ chroma: e.chroma, level: e.level, peak: e.peak, clip: e.clip, best: e.best, smoothed: e.id, conf: e.conf }, e.t);
  else if (e.type === 'strum') coach.pushStrum({ strings: e.strings }, e.t);
}
const states = ev.filter(e => e.type === 'pair').length;
console.log(`${path.basename(file)}: ${states} targets shown, ${hints.length} hints (C=${JSON.stringify(CONFIG.coach)})`);
const perTarget = new Map();
for (const h of hints) { const m = perTarget.get(h.target) || new Map(); m.set(h.kind, (m.get(h.kind) || 0) + 1); perTarget.set(h.target, m); }
const shown = new Map(); for (const e of ev) if (e.type === 'pair') shown.set(e.cur, (shown.get(e.cur) || 0) + 1);
for (const [id, n] of [...shown.entries()].sort((a, b) => b[1] - a[1])) {
  const m = perTarget.get(id);
  console.log(`  ${id.padEnd(6)} shown ${String(n).padStart(3)}   hints: ${m ? [...m.entries()].map(([k, v]) => `${k}×${v}`).join(' ') : '—'}`);
}
console.log('\nhints in order' + (args.all ? '' : ' (first 25)') + ':');
for (const h of (args.all ? hints : hints.slice(0, 25))) console.log(`  ${h.t.toFixed(1).padStart(7)}s  ${String(h.target).padEnd(4)} ${h.kind.padEnd(15)} ${h.text}`);

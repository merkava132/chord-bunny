// Line a session's recordings up with what the practice screen showed.
//   node tools/session_labels.mjs [session-id | latest] [--rec-dir DIR] [--replay]
// Writes recordings/<session>/labels.jsonl: one row per (segment × screen
// state) with sample offsets, and prints the reconstruction. --replay also
// runs each labelled interval through the detector (basic + enabled
// candidates) and shows what it heard vs the target.
import fs from 'node:fs';
import path from 'node:path';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { decodeWav } from '../src/dsp/wav.js';
import { buildTemplates, scoreTemplates, confidenceOf, StableRule } from '../src/detect.js';
import { applyOverrides } from '../src/config.js';

export const DEFAULT_REC = process.env.CB_REC_DIR || (fs.existsSync('/mnt/aegis/chord-bunny/recordings') ? '/mnt/aegis/chord-bunny/recordings' : path.resolve(import.meta.dirname, '../recordings'));
export const DEFAULT_TEL = path.resolve(import.meta.dirname, '../telemetry');

// Build recordings/<session>/labels.jsonl for one session. Returns the rows
// (empty when the session has no recordings). Pure file I/O, no printing.
export function buildLabels(session, { telDir = DEFAULT_TEL, recDir = DEFAULT_REC } = {}) {
  const ev = fs.readFileSync(path.join(telDir, session + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const segDir = path.join(recDir, session);
  const segs = fs.existsSync(path.join(segDir, 'segments.jsonl')) ? fs.readFileSync(path.join(segDir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  if (!segs.length) return [];
  const anchors = ev.filter(e => e.type === 'frame' && e.ts !== undefined).map(e => [e.t, e.ts - e.t]);
  const toTs = (e) => {
    if (e.ts !== undefined) return e.ts;
    if (!anchors.length) return null;
    let best = anchors[0]; for (const a of anchors) if (Math.abs(a[0] - e.t) < Math.abs(best[0] - e.t)) best = a;
    return +(e.t + best[1]).toFixed(3);
  };
  const pairs = ev.filter(e => e.type === 'pair').map(e => ({ ts: toTs(e), t: e.t, cur: e.cur, next: e.next, reason: e.reason }));
  const matches = ev.filter(e => e.type === 'match').map(e => ({ ts: toTs(e), target: e.target }));
  const misses = ev.filter(e => e.type === 'miss').map(e => ({ ts: toTs(e), target: e.target, heard: e.heard[0] }));
  const rows = [];
  for (const seg of segs) {
    const file = `seg-${String(seg.seg).padStart(4, '0')}.wav`;
    const states = pairs.map((p, i) => ({ ...p, end: pairs[i + 1]?.ts ?? Infinity })).filter(p => p.ts !== null && p.end > seg.ts0 && p.ts < seg.ts1);
    for (const st of states) {
      const a = Math.max(seg.ts0, st.ts), b = Math.min(seg.ts1, st.end);
      const m = matches.filter(x => x.ts >= a && x.ts < b && x.target === st.cur);
      const mi = misses.filter(x => x.ts >= a && x.ts < b);
      rows.push({ seg: seg.seg, file, ts0: +a.toFixed(3), ts1: +(b === Infinity ? seg.ts1 : b).toFixed(3),
        offset0: Math.round((a - seg.ts0) * seg.sr), offset1: Math.round(((b === Infinity ? seg.ts1 : b) - seg.ts0) * seg.sr),
        target: st.cur, next: st.next, shownBecause: st.reason, matched: m.length > 0, matchedAt: m[0] ? +m[0].ts.toFixed(3) : null,
        heardInstead: mi.map(x => x.heard) });
    }
  }
  fs.writeFileSync(path.join(segDir, 'labels.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return rows;
}

// ---- CLI ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (!isMain) { /* imported as a module */ }
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
if (isMain && args.cfg) console.log('config overrides:', applyOverrides(args.cfg).join(' '));   // --cfg=detect.lam:0.4,...
const TEL = args['tel-dir'] || DEFAULT_TEL;
const REC = args['rec-dir'] || DEFAULT_REC;
let session = process.argv.slice(2).find(a => !a.startsWith('--')) || 'latest';
if (isMain && session === 'latest') {
  const files = fs.readdirSync(TEL).filter(f => f.endsWith('.jsonl')).sort((a, b) => fs.statSync(path.join(TEL, b)).mtimeMs - fs.statSync(path.join(TEL, a)).mtimeMs);
  session = files[0].replace(/\.jsonl$/, '');
}
if (isMain) main();
function main() {
const ev = fs.readFileSync(path.join(TEL, session + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const segDir = path.join(REC, session);
const segs = fs.existsSync(path.join(segDir, 'segments.jsonl')) ? fs.readFileSync(path.join(segDir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
if (!segs.length) { console.log(`no recordings for ${session} in ${segDir}`); process.exit(0); }

// page clock (t) → stream clock (ts): use the event's own ts when present,
// else the nearest frame event's (ts − t) offset (the stream clock restarts
// on re-attach, so use the nearest, not a global fit)
const anchors = ev.filter(e => e.type === 'frame' && e.ts !== undefined).map(e => [e.t, e.ts - e.t]);
const toTs = (e) => {
  if (e.ts !== undefined) return e.ts;
  if (!anchors.length) return null;
  let best = anchors[0]; for (const a of anchors) if (Math.abs(a[0] - e.t) < Math.abs(best[0] - e.t)) best = a;
  return +(e.t + best[1]).toFixed(3);
};
// screen states: each 'pair' event starts a state (cur = target, next) until the next one
const pairs = ev.filter(e => e.type === 'pair').map(e => ({ ts: toTs(e), t: e.t, cur: e.cur, next: e.next, reason: e.reason }));
const matches = ev.filter(e => e.type === 'match').map(e => ({ ts: toTs(e), target: e.target }));
const misses = ev.filter(e => e.type === 'miss').map(e => ({ ts: toTs(e), target: e.target, heard: e.heard[0] }));
const sess = ev.find(e => e.type === 'session');
const enabled = new Set(sess?.settings?.enabledChords || []);
for (const e of ev) if (e.type === 'setting' && e.key === 'enabledChords') { enabled.clear(); for (const id of e.value) enabled.add(id); }

const rows = [];
console.log(`session ${session}: ${segs.length} recordings, ${pairs.length} screen states, ${matches.length} matches, ${misses.length} misses  (enabled: ${[...enabled].join(' ')})`);
for (const seg of segs) {
  const file = path.join(segDir, `seg-${String(seg.seg).padStart(4, '0')}.wav`);
  const states = pairs.map((p, i) => ({ ...p, end: pairs[i + 1]?.ts ?? Infinity })).filter(p => p.ts !== null && p.end > seg.ts0 && p.ts < seg.ts1);
  console.log(`\n${path.basename(file)}  ts ${seg.ts0.toFixed(1)}–${seg.ts1.toFixed(1)}  (${(seg.bytes / 2 / seg.sr).toFixed(1)}s)`);
  for (const st of states) {
    const a = Math.max(seg.ts0, st.ts), b = Math.min(seg.ts1, st.end);
    const m = matches.filter(x => x.ts >= a && x.ts < b && x.target === st.cur);
    const mi = misses.filter(x => x.ts >= a && x.ts < b);
    const row = { seg: seg.seg, file: path.basename(file), ts0: +a.toFixed(3), ts1: +(b === Infinity ? seg.ts1 : b).toFixed(3),
      offset0: Math.round((a - seg.ts0) * seg.sr), offset1: Math.round(((b === Infinity ? seg.ts1 : b) - seg.ts0) * seg.sr),
      target: st.cur, next: st.next, shownBecause: st.reason, matched: m.length > 0, matchedAt: m[0] ? +m[0].ts.toFixed(3) : null,
      heardInstead: mi.map(x => x.heard) };
    rows.push(row);
    console.log(`  ${row.ts0.toFixed(1).padStart(6)}–${row.ts1.toFixed(1).padEnd(6)} screen: ${st.cur} → ${st.next}   ${row.matched ? `matched @${row.matchedAt.toFixed(1)}` : 'no match'}${mi.length ? `   heard instead: ${mi.map(x => x.heard).join(' ')}` : ''}`);
  }
}
fs.writeFileSync(path.join(segDir, 'labels.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`\nwrote ${rows.length} rows to ${path.join(segDir, 'labels.jsonl')}`);

if (args.replay) {
  const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
  const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
  const cand = CHORDS.filter(c => c.category === 'basic' || enabled.has(c.id));
  const T = buildTemplates(cand);
  console.log(`\nreplay (${T.length} candidates): per screen state, what the detector hears offline`);
  for (const seg of segs) {
    const file = path.join(segDir, `seg-${String(seg.seg).padStart(4, '0')}.wav`);
    if (!fs.existsSync(file)) continue;
    const wav = decodeWav(fs.readFileSync(file));
    const an = new PitchAnalyzer({ sampleRate: wav.sampleRate, profiles: PROFILES });
    const N = an.opts.fftSize, sm = new Float32Array(an.nP), hist = [], rule = new StableRule();
    const verdicts = [];   // [ts, id, fired]
    for (const { start, frame } of frames(wav.samples, N, 1024)) {
      const ts = seg.ts0 + (start + N / 2) / wav.sampleRate;
      let id = null, silent = rms(frame) < 0.006;
      if (silent) hist.length = 0;
      else {
        const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = 0.5 * sm[i] + 0.5 * act[i];
        const r = scoreTemplates(an.chroma(sm), T), conf = confidenceOf(r, T);
        hist.push(conf >= 0.35 ? T[r.best].id : null); if (hist.length > 5) hist.shift();
        const m = new Map(); for (const h of hist) m.set(h, (m.get(h) || 0) + 1);
        let bp = null, bc = 0; for (const [k, c] of m) if (c > bc) { bc = c; bp = k; }
        id = bc >= 3 ? bp : null;
      }
      verdicts.push([ts, id, rule.push(ts, id, silent)]);
    }
    for (const row of rows.filter(r => r.seg === seg.seg)) {
      const v = verdicts.filter(([ts]) => ts >= row.ts0 && ts < row.ts1);
      const share = new Map(); for (const [, id] of v) if (id) share.set(id, (share.get(id) || 0) + 1);
      const fired = v.filter(([, , f]) => f).map(([ts, , f]) => `${f}@${ts.toFixed(1)}`);
      const tgt = T.find(x => x.ids.includes(row.target));
      const ok = v.filter(([, id]) => id && tgt?.ids.includes(id)).length;
      console.log(`  ${row.ts0.toFixed(1).padStart(6)}–${row.ts1.toFixed(1).padEnd(6)} target ${row.target.padEnd(6)} heard: ${[...share.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${(100 * n / v.length).toFixed(0)}%`).join(' ').padEnd(40)} target-frames ${(100 * ok / Math.max(1, v.length)).toFixed(0)}%  fires: ${fired.join(' ') || '—'}`);
    }
  }
}
}

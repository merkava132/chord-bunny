// Learn a personal chroma profile per chord from labelled recordings and
// measure whether it helps, leave-one-interval-out.
//   node tools/learn_profile.mjs [session ...] [--rec-dir DIR] [--alpha=0.5] [--write data/user/profile.json]
//
// A canonical template scores a chroma q as Σ_{pc∈chord} log(q_pc+ε)/|chord|:
// uniform weights on the chord tones. The personal template replaces the
// uniform weights with the chroma this player's chord actually produces
// (learned from matched practice intervals), blended: w = (1−α)·uniform + α·p.
// Evaluation replays every labelled interval with a profile learned from the
// OTHER intervals: correct-verdict frame share, StableRule fires, delay.
import fs from 'node:fs';
import path from 'node:path';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { decodeWav } from '../src/dsp/wav.js';
import { buildTemplates, scoreTemplates, confidenceOf, StableRule, PC_INDEX } from '../src/detect.js';
import { CONFIG, applyOverrides } from '../src/config.js';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
if (args.cfg) applyOverrides(args.cfg);
const TEL = args['tel-dir'] || path.resolve(import.meta.dirname, '../telemetry');   // --tel-dir for another checkout's sessions
const REC = args['rec-dir'] || process.env.CB_REC_DIR || (fs.existsSync('/mnt/aegis/chord-bunny/recordings') ? '/mnt/aegis/chord-bunny/recordings' : path.resolve(import.meta.dirname, '../recordings'));
const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const ALPHAS = args.alpha ? String(args.alpha).split(',').map(Number) : [0, 0.3, 0.5, 0.7, 1];
const SENS = Number(args.sens ?? 0.35);

let sessions = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!sessions.length) sessions = fs.readdirSync(REC).filter(d => fs.existsSync(path.join(REC, d, 'labels.jsonl')));

// ---- 1. gather labelled intervals with per-frame chroma (replayed once) ----
const intervals = [];   // { target, matched, frames: [{ts, chroma, level, silent}] }
for (const sid of sessions) {
  const dir = path.join(REC, sid);
  const labels = fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const sessLine = fs.readFileSync(path.join(TEL, sid + '.jsonl'), 'utf8').split('\n').find(l => l.includes('"type":"session"')) || '{}';
  const enabled = new Set(JSON.parse(sessLine).settings?.enabledChords || []);
  const cache = new Map();
  for (const r of labels) {
    if (r.shownBecause === 'timer' || r.ts1 - r.ts0 < 1) continue;
    if (!cache.has(r.file)) {
      const wav = decodeWav(fs.readFileSync(path.join(dir, r.file)));
      const meta = fs.readFileSync(path.join(dir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(s => `seg-${String(s.seg).padStart(4, '0')}.wav` === r.file);
      const an = new PitchAnalyzer({ sampleRate: wav.sampleRate, profiles: PROFILES });
      const N = an.opts.fftSize, sm = new Float32Array(an.nP), out = [];
      for (const { start, frame } of frames(wav.samples, N, CONFIG.detect.hop)) {
        const ts = meta.ts0 + (start + N / 2) / wav.sampleRate, level = rms(frame);
        if (level < CONFIG.detect.rmsGate) { out.push({ ts, silent: true, level }); continue; }
        const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = CONFIG.detect.ema * sm[i] + (1 - CONFIG.detect.ema) * act[i];
        out.push({ ts, silent: false, level, chroma: Float32Array.from(an.chroma(sm)) });
      }
      cache.set(r.file, out);
    }
    const fr = cache.get(r.file).filter(f => f.ts >= r.ts0 - 1 && f.ts < r.ts1);   // 1 s of context for the rule warm-up
    intervals.push({ session: sid, target: r.target, matched: r.matched, matchedAt: r.matchedAt, ts0: r.ts0, ts1: r.ts1, frames: fr, enabled });
  }
}
console.log(`${intervals.length} labelled intervals from ${sessions.length} session(s); matched ${intervals.filter(i => i.matched).length}`);

// ---- 2. learn: per chord, the median chroma over the settled part of matched intervals ----
function learn(ivs) {
  const acc = new Map();
  for (const iv of ivs) {
    if (!iv.matched) continue;
    const a = Math.max(iv.ts0 + 0.8, iv.matchedAt - 1.5), b = iv.matchedAt + 0.3;
    for (const f of iv.frames) if (!f.silent && f.ts >= a && f.ts < b) (acc.get(iv.target) || acc.set(iv.target, []).get(iv.target)).push(f.chroma);
  }
  const prof = {};
  for (const [id, list] of acc) {
    if (list.length < 15) continue;
    const p = new Array(12).fill(0);
    for (let i = 0; i < 12; i++) { const col = list.map(c => c[i]).sort((x, y) => x - y); p[i] = col[Math.floor(col.length / 2)]; }
    const s = p.reduce((x, y) => x + y, 0); prof[id] = { chroma: p.map(v => +(v / s).toFixed(4)), n: list.length };
  }
  return prof;
}

// ---- 3. evaluate: leave-one-interval-out ----
function evaluate(alpha) {
  let ok = 0, tot = 0, fired = 0, wrong = 0; const delays = [];
  for (let k = 0; k < intervals.length; k++) {
    const iv = intervals[k];
    const prof = alpha > 0 ? learn(intervals.filter((_, j) => j !== k)) : null;
    const cand = CHORDS.filter(c => c.category === 'basic' || iv.enabled.has(c.id));
    const T = buildTemplates(cand, { profile: prof ? { chords: prof } : null, alpha });
    const tgt = T.find(t => t.ids.includes(iv.target));
    const hist = [], rule = new StableRule(); let first = null;
    for (const f of iv.frames) {
      let id = null;
      if (f.silent) hist.length = 0;
      else {
        const r = scoreTemplates(f.chroma, T), conf = confidenceOf(r, T);
        hist.push(conf >= SENS ? T[r.best].id : null); if (hist.length > CONFIG.detect.smoothingLen) hist.shift();
        const m = new Map(); for (const h of hist) m.set(h, (m.get(h) || 0) + 1);
        let bp = null, bc = 0; for (const [x, c] of m) if (c > bc) { bc = c; bp = x; }
        id = bc >= 3 ? bp : null;
        if (f.ts >= iv.ts0 + 1) { tot++; if (id && tgt.ids.includes(id)) ok++; }   // settled frames only
      }
      const fire = rule.push(f.ts, id, f.silent);
      if (fire && f.ts >= iv.ts0) { if (tgt.ids.includes(fire)) { if (first === null) first = f.ts - iv.ts0; } else wrong++; }
    }
    if (first !== null) { fired++; delays.push(first); }
  }
  delays.sort((a, b) => a - b); const q = p => delays.length ? delays[Math.floor(p * (delays.length - 1))].toFixed(2) : '-';
  return { frameAcc: ok / Math.max(1, tot), fired, wrong, p50: q(.5), p90: q(.9) };
}
console.log('alpha  settled-frame accuracy   intervals fired   wrong fires   delay p50 / p90');
for (const a of ALPHAS) { const r = evaluate(a); console.log(`${a.toFixed(1)}    ${(100 * r.frameAcc).toFixed(1).padStart(6)}%                ${String(r.fired).padStart(3)}/${intervals.length}          ${String(r.wrong).padStart(3)}         ${r.p50}s / ${r.p90}s`); }

if (args.write) {
  const prof = learn(intervals);
  const out = { learnedAt: new Date().toISOString(), sessions, alpha: Number(args.alpha) || 0.5, chords: prof };
  fs.mkdirSync(path.dirname(args.write), { recursive: true });
  fs.writeFileSync(args.write, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${Object.keys(prof).length} chord profiles to ${args.write}:`, Object.entries(prof).map(([id, p]) => `${id} (n=${p.n})`).join(' '));
}

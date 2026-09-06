// Practice-mode "stable chord" rules on GuitarSet: for every lead-sheet chord
// segment, does the rule fire the right chord (a match), how soon, and how
// often does it fire a wrong one? Simulates the app pipeline exactly
// (EMA 0.5, majority-of-5, sensitivity 0.35, basic candidates).
//   node tools/eval_hold.mjs [--chords=basic] [--sens=0.35] [--minseg=1]
import fs from 'node:fs';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { APP_CHORDS, listExcerpts, loadExcerpt } from './guitarset.mjs';
import { buildTemplates, scoreTemplates, confidenceOf, StableRule } from '../src/detect.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const CAND = new Set(String(args.chords || 'basic').split(','));
const T = buildTemplates(APP_CHORDS.filter(c => CAND.has(c.category) || CAND.has(c.id)));
const SENS = Number(args.sens ?? 0.35), MINSEG = Number(args.minseg ?? 1);
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const HOP = 1024;

// rules: state machines over (t, id, silent) → fired id or null
const RULES = {
  app: () => { const r = new StableRule(); return (t, id, silent) => r.push(t, id, silent); },   // what src/detect.js does (minHold 350 ms)
  // current app rule: same id for ≥ hold s, anything else resets; fires once per run
  strict350: () => { let last = null, since = 0, fired = false; return (t, id) => { if (id && id === last) { if (!fired && t - since >= 0.35) { fired = true; return id; } } else { last = id; since = t; fired = false; } return null; }; },
  strict250: () => { let last = null, since = 0, fired = false; return (t, id) => { if (id && id === last) { if (!fired && t - since >= 0.25) { fired = true; return id; } } else { last = id; since = t; fired = false; } return null; }; },
  // tolerant: id holds ≥ frac of the frames in the last win s and is the latest verdict; fires once per id until another id fires or silence
  ...Object.fromEntries([[0.5, 0.6], [0.5, 0.7], [0.7, 0.6], [0.7, 0.7], [1.0, 0.6]].map(([win, frac]) => [`win${win}_${frac}`, () => {
    const q = []; let lastFired = null;
    return (t, id, silent) => {
      if (silent) { q.length = 0; lastFired = null; return null; }
      q.push([t, id]); while (q.length && t - q[0][0] > win) q.shift();
      if (!id || id === lastFired || t - q[0][0] < win * 0.8) return null;
      let n = 0; for (const [, x] of q) if (x === id) n++;
      if (n >= frac * q.length) { lastFired = id; return id; }
      return null;
    };
  }])),
};

const stats = Object.fromEntries(Object.keys(RULES).map(k => [k, { segs: 0, matched: 0, wrong: 0, delay: [] }]));
const names = listExcerpts(f => f.includes('comp') && ['SS3', 'Rock3', 'Rock1'].some(s => f.includes(s)));
for (const name of names) {
  const ex = loadExcerpt(name);
  const an = new PitchAnalyzer({ sampleRate: ex.sampleRate, profiles: PROFILES });
  const N = an.opts.fftSize, sm = new Float32Array(an.nP), hist = [];
  const stream = [];   // [t, smoothedId, silent]
  for (const { start, frame } of frames(ex.samples, N, HOP)) {
    const t = (start + N / 2) / ex.sampleRate;
    if (rms(frame) < 0.006) { hist.length = 0; stream.push([t, null, true]); continue; }
    const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = 0.5 * sm[i] + 0.5 * act[i];
    const r = scoreTemplates(an.chroma(sm), T), conf = confidenceOf(r, T);
    hist.push(conf >= SENS ? T[r.best].id : null); if (hist.length > 5) hist.shift();
    const m = new Map(); for (const h of hist) m.set(h, (m.get(h) || 0) + 1);
    let bp = null, bc = 0; for (const [k, c] of m) if (c > bc) { bc = c; bp = k; }
    stream.push([t, bc >= 3 ? bp : null, false]);
  }
  const segs = ex.chords.filter(c => c.appId && T.some(x => x.ids.includes(c.appId)) && c.t1 - c.t0 >= MINSEG);
  for (const [rule, mk] of Object.entries(RULES)) {
    const fn = mk(); const fires = [];
    for (const [t, id, silent] of stream) { const f = fn(t, id, silent); if (f) fires.push([t, f]); }
    const st = stats[rule];
    for (const seg of segs) {
      st.segs++;
      const inSeg = fires.filter(([t]) => t >= seg.t0 && t < seg.t1);
      const ok = inSeg.find(([, id]) => id === seg.appId);
      if (ok) { st.matched++; st.delay.push(ok[0] - seg.t0); }
      if (inSeg.some(([, id]) => id !== seg.appId)) st.wrong++;
    }
  }
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
console.log(`candidates=${T.length} sens=${SENS} segments≥${MINSEG}s: ${stats.strict350.segs}`);
console.log('rule         matched   wrong-fire   time-to-match p50 / p90');
for (const [k, s] of Object.entries(stats)) console.log(`${k.padEnd(12)} ${(100 * s.matched / s.segs).toFixed(0).padStart(5)}%   ${(100 * s.wrong / s.segs).toFixed(0).padStart(6)}%      ${q(s.delay, .5).toFixed(2)}s / ${q(s.delay, .9).toFixed(2)}s`);

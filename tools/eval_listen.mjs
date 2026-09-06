// Listen-mode display rule on GuitarSet: how often the displayed chord is
// right, and how often the display changes (flicker), for different show /
// gap holds. All 53 chords are candidates, like listen mode.
//   node tools/eval_listen.mjs [--chords=...] [--sens=0.35]
import fs from 'node:fs';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { APP_CHORDS, listExcerpts, loadExcerpt, chordAt } from './guitarset.mjs';
import { buildTemplates, scoreTemplates, confidenceOf } from '../src/detect.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const CAND = args.chords ? new Set(String(args.chords).split(',')) : null;
const T = buildTemplates(CAND ? APP_CHORDS.filter(c => CAND.has(c.category) || CAND.has(c.id)) : APP_CHORDS);
const SENS = Number(args.sens ?? 0.35);
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const HOP = 1024;
const RULES = [[0, 0], [0, 400], [100, 400], [160, 400], [250, 400], [160, 800], [350, 400]];   // [showMs, gapMs]

const stats = RULES.map(() => ({ frames: 0, right: 0, shown: 0, changes: 0, segs: 0 }));
for (const name of listExcerpts(f => f.includes('comp') && ['SS3', 'Rock3', 'Rock1'].some(s => f.includes(s)))) {
  const ex = loadExcerpt(name);
  const an = new PitchAnalyzer({ sampleRate: ex.sampleRate, profiles: PROFILES });
  const N = an.opts.fftSize, sm = new Float32Array(an.nP), hist = [];
  const disp = RULES.map(() => ({ shown: null, cand: null, since: 0, lastSeen: -1e9 }));
  let nseg = 0, prevGt = null;
  for (const { start, frame } of frames(ex.samples, N, HOP)) {
    const t = (start + N / 2) / ex.sampleRate;
    let id = null;
    if (rms(frame) < 0.006) hist.length = 0;
    else {
      const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = 0.5 * sm[i] + 0.5 * act[i];
      const r = scoreTemplates(an.chroma(sm), T), conf = confidenceOf(r, T);
      hist.push(conf >= SENS ? T[r.best].id : null); if (hist.length > 5) hist.shift();
      const m = new Map(); for (const h of hist) m.set(h, (m.get(h) || 0) + 1);
      let bp = null, bc = 0; for (const [k, c] of m) if (c > bc) { bc = c; bp = k; }
      id = bc >= 3 ? bp : null;
    }
    const gt = chordAt(ex.chords, t)?.appId;
    if (gt !== prevGt) { prevGt = gt; if (gt) nseg++; }
    const ms = t * 1000;
    RULES.forEach(([show, gap], i) => {
      const d = disp[i], st = stats[i];
      if (id) {
        if (id === d.shown) { d.lastSeen = ms; d.cand = null; }
        else if (!d.cand || d.cand !== id) { d.cand = id; d.since = ms; }
        else if (ms - d.since >= show) { d.shown = id; d.lastSeen = ms; d.cand = null; st.changes++; }
        if (id !== d.shown && show === 0) { d.shown = id; d.lastSeen = ms; st.changes++; }
      } else {
        d.cand = null;
        if (d.shown && ms - d.lastSeen >= gap) { d.shown = null; st.changes++; }
      }
      if (gt) { st.frames++; if (d.shown) { st.shown++; if (T.find(x => x.id === d.shown)?.ids.includes(gt)) st.right++; } }
    });
  }
  for (const st of stats) st.segs += nseg;
}
console.log(`candidates=${T.length} sens=${SENS}: ${stats[0].frames} chord frames, ${stats[0].segs} chord segments`);
console.log('show/gap   shown   right(all frames)   right(when shown)   display changes per chord segment');
RULES.forEach(([show, gap], i) => { const s = stats[i]; console.log(`${String(show).padStart(3)}/${String(gap).padEnd(4)}  ${(100 * s.shown / s.frames).toFixed(0).padStart(4)}%   ${(100 * s.right / s.frames).toFixed(0).padStart(6)}%   ${(100 * s.right / Math.max(1, s.shown)).toFixed(0).padStart(12)}%   ${(s.changes / s.segs).toFixed(1).padStart(12)}`); });

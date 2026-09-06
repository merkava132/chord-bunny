// Frame-level chord accuracy on GuitarSet.
//   node tools/eval_chords.mjs [--subset=open|all] [--hop=1024] [--verbose]
//                              [--set k=v,k=v]   analyzer option overrides
//                              [--minStrings=3]  only score frames with ≥N strings ringing (GT)
// Reports the original chroma detector ("old") alongside NNLS-based scorers.
import { PitchAnalyzer, frames, rms, voicingPitches } from '../src/dsp/analyzer.js';
import { FFT, hann } from '../src/dsp/fft.js';
import { buildTemplates, scoreTemplates } from '../src/detect.js';
import { APP_CHORDS, listExcerpts, loadExcerpt, chordAt, stringsAt } from './guitarset.mjs';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const HOP = Number(args.hop || 1024);
const PROFILES = args.noprof ? null : JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const SUBSET = args.subset || 'open';
const MIN_STRINGS = Number(args.minStrings ?? 3);
const VERBOSE = !!args.verbose;
const OVERRIDES = Object.fromEntries((args.set ? String(args.set).split(',') : []).map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const SMOOTH = Number(args.smooth ?? 0.5);       // EMA weight on previous activations
const HIST = Number(args.hist ?? 5);              // majority-vote window (frames)
const RMS_GATE = 0.006;
const OPEN = ['SS3', 'Rock3', 'Rock1'];
const GT = args.gt || 'instructed';        // instructed | performed
// --chords=basic,sus,Cmaj7  restrict candidate templates to these categories / ids (GT frames unchanged)
const CAND = args.chords ? new Set(String(args.chords).split(',')) : null;
const CANDIDATES = CAND ? APP_CHORDS.filter(c => CAND.has(c.category) || CAND.has(c.id)) : APP_CHORDS;
const PRIOR = Number(args.prior ?? 0);     // subtract from templates outside the 'basic' category
const PRIORCAT = args.priorcat ? new Set(String(args.priorcat).split(',')) : null;   // …or only from these categories

const PCI = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11, Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10 };

// ---------- (a) original chroma detector ----------
class OldChroma {
  constructor(sr) {
    this.sr = sr; this.N = 8192; this.fft = new FFT(this.N); this.w = hann(this.N);
    this.re = new Float32Array(this.N); this.im = new Float32Array(this.N);
    this.tpl = APP_CHORDS.map(c => { const v = new Float32Array(12); for (const n of c.notes) v[PCI[n]] = 1; let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); for (let i = 0; i < 12; i++) v[i] /= s; return { id: c.id, v }; });
    this.chroma = new Float32Array(12);
    this.sens = 0.20 + (55 / 100) * 0.55;
  }
  classify(frame) {
    const { N, re, im, w } = this;
    for (let i = 0; i < N; i++) re[i] = frame[i] * w[i];
    im.fill(0); this.fft.transform(re, im);
    const c = this.chroma; c.fill(0);
    const kMin = Math.floor(70 * N / this.sr), kMax = Math.ceil(2000 * N / this.sr);
    for (let k = kMin; k <= kMax; k++) {
      const pc = ((Math.round(69 + 12 * Math.log2(k * this.sr / N / 440)) % 12) + 12) % 12;
      c[pc] += re[k] * re[k] + im[k] * im[k];
    }
    let s1 = 0; for (const x of c) s1 += x; if (s1 > 0) for (let i = 0; i < 12; i++) c[i] /= s1;
    let s2 = 0; for (const x of c) s2 += x * x; s2 = Math.sqrt(s2) || 1; for (let i = 0; i < 12; i++) c[i] /= s2;
    let best = null, bs = -1;
    for (const t of this.tpl) { let d = 0; for (let i = 0; i < 12; i++) d += c[i] * t.v[i]; if (d > bs) { bs = d; best = t.id; } }
    return bs >= this.sens ? best : null;
  }
}

// ---------- (b) NNLS scorers ----------
function buildVoicings(an) {
  return CANDIDATES.map(c => {
    const pitches = voicingPitches(c.fingering.frets).filter(p => p > 0);
    const idx = pitches.map(p => an.pitchIndex(p)).filter(i => i >= 0 && i < an.nP);
    const pcs = [...new Set(c.notes.map(n => PCI[n]))];
    const chromaT = new Float32Array(12); for (const pc of pcs) chromaT[pc] = 1;
    let s = 0; for (const x of chromaT) s += x * x; s = Math.sqrt(s); for (let i = 0; i < 12; i++) chromaT[i] /= s;
    return { id: c.id, idx, pcs, chromaT, root: PCI[c.root], h: new Float32Array(idx.length), prior: (PRIORCAT ? PRIORCAT.has(c.category) : c.category !== 'basic') ? PRIOR : 0 };
  });
}
const cosine12 = (a, b) => { let d = 0, na = 0; for (let i = 0; i < 12; i++) { d += a[i] * b[i]; na += a[i] * a[i]; } return na > 0 ? d / Math.sqrt(na) : 0; };

const EPS = Number(args.eps ?? 0.1), LAM = Number(args.lam ?? 0);
const DUMP = args.dump;
const RPEN = Number(args.rpen ?? 0.01), RGW = Number(args.rgw ?? 0.5), RMIX = Number(args.rmix ?? 3);                    // scorer name → print confusion/age stats
// the app's scorer (src/detect.js) on the same candidate list — templates
// dedupe by pitch-class set, so map template scores back onto voicings
const APP_T = buildTemplates(CANDIDATES);
const APP_IDX = CANDIDATES.map(c => APP_T.findIndex(t => t.ids.includes(c.id)));
const APP_SCORES = new Array(APP_T.length);
const SCORERS = {
  app: (an, act, V, ch) => { scoreTemplates(ch, APP_T, APP_SCORES); return V.map((v, i) => APP_SCORES[APP_IDX[i]] - (APP_T[APP_IDX[i]].ids[0] === v.id ? 0 : 1e-6)); },
  chroma: (an, act, V, ch) => V.map(v => cosine12(ch, v.chromaT)),
  // log-likelihood template: geometric mean of chroma on template notes
  // (a missing note is catastrophic) minus mass outside the template
  geo: (an, act, V, ch) => V.map(v => {
    let s = 0, out = 1; for (const pc of v.pcs) { s += Math.log(ch[pc] + EPS); out -= ch[pc]; }
    return s / v.pcs.length - LAM * out - v.prior;
  }),
  geoBass: (an, act, V, ch, bassPc) => V.map(v => {
    let s = 0, out = 1; for (const pc of v.pcs) { s += Math.log(ch[pc] + EPS); out -= ch[pc]; }
    return s / v.pcs.length - LAM * out + (bassPc === v.root ? 0.4 : 0);
  }),
  // per-voicing restricted NNLS: how much of the spectrum does this voicing
  // explain, and are all its strings present?
  recon: (an, act, V, ch, bassPc, mag) => V.map(v => {
    const { explained } = an.solveSubset(mag, v.idx, v.h);
    return explained - RPEN * v.idx.length;
  }),
  reconGeo: (an, act, V, ch, bassPc, mag) => V.map(v => {
    const { h, explained } = an.solveSubset(mag, v.idx, v.h);
    let tot = 0; for (const x of h) tot += x; if (tot <= 0) return -1e9;
    let g = 0; for (const x of h) g += Math.log(x / tot + EPS); g /= h.length;
    return Math.log(explained + 1e-6) + RGW * g;
  }),
  // chroma family + reconstruction tie-break
  geoRecon: (an, act, V, ch, bassPc, mag) => {
    const a = SCORERS.geo(an, act, V, ch), r = SCORERS.recon(an, act, V, ch, bassPc, mag);
    return a.map((x, i) => x + RMIX * r[i]);
  },
  // same idea on exact voicing pitches (activation normalised to unit L1)
  geoV: (an, act, V) => {
    let tot = 0; for (const a of act) tot += a; if (tot <= 0) return V.map(() => -1e9);
    return V.map(v => { let s = 0, inV = 0; for (const i of v.idx) { const a = act[i] / tot; s += Math.log(a + EPS); inV += a; } return s / v.idx.length - LAM * (1 - inV); });
  },
  // chroma cosine + bonus if the lowest strong activation is the chord root
  chromaBass: (an, act, V, ch, bassPc) => V.map(v => cosine12(ch, v.chromaT) + (bassPc === v.root ? 0.12 : 0)),
  // exact-voicing pitch match: mass explained × coverage
  voicing: (an, act, V) => {
    let tot = 0; for (const a of act) tot += a; if (tot <= 0) return V.map(() => 0);
    return V.map(v => {
      let inV = 0, mx = 0; for (const i of v.idx) { inV += act[i]; mx = Math.max(mx, act[i]); }
      let cover = 0; for (const i of v.idx) cover += Math.min(act[i], 0.3 * mx); cover /= (v.idx.length * 0.3 * mx || 1);
      return (inV / tot) * cover;
    });
  },
  // blend: chroma identifies the family, voicing breaks ties among same-family chords
  blend: (an, act, V, ch, bassPc) => {
    const c = SCORERS.chromaBass(an, act, V, ch, bassPc), w = SCORERS.voicing(an, act, V);
    return c.map((x, i) => x + 0.5 * w[i]);
  },
};

function majority(hist) { const m = new Map(); for (const p of hist) m.set(p, (m.get(p) || 0) + 1); let bp = null, bc = 0; for (const [p, c] of m) if (c > bc) { bc = c; bp = p; } return bp; }

function evalExcerpt(name, totals) {
  const ex = loadExcerpt(name);
  const an = new PitchAnalyzer({ sampleRate: ex.sampleRate, profiles: PROFILES, ...OVERRIDES });
  const V = buildVoicings(an);
  const old = new OldChroma(ex.sampleRate);
  const N = an.opts.fftSize;
  const smoothAct = new Float32Array(an.nP);
  const keys = ['old', ...Object.keys(SCORERS)];
  const hist = Object.fromEntries(keys.map(k => [k, []]));
  const hit = Object.fromEntries(keys.map(k => [k, 0]));
  let n = 0;
  for (const { start, frame } of frames(ex.samples, N, HOP)) {
    const t = (start + N / 2) / ex.sampleRate;
    const level = rms(frame);
    // run detectors on every frame (state carries across), score on chord frames only
    const pred = {};
    pred.old = level < RMS_GATE ? null : old.classify(frame);
    if (level < RMS_GATE) { for (const k in SCORERS) pred[k] = null; }
    else {
      const act = an.analyze(frame);
      for (let i = 0; i < an.nP; i++) smoothAct[i] = SMOOTH * smoothAct[i] + (1 - SMOOTH) * act[i];
      const ch = an.chroma(smoothAct);
      let mx = 0; for (const a of smoothAct) mx = Math.max(mx, a);
      let bassPc = -1; for (let i = 0; i < an.nP; i++) if (smoothAct[i] > 0.3 * mx) { bassPc = an.pitches[i] % 12; break; }
      for (const [k, fn] of Object.entries(SCORERS)) {
        const sc = fn(an, smoothAct, V, ch, bassPc, an.mag);
        let bi = 0; for (let i = 1; i < sc.length; i++) if (sc[i] > sc[bi]) bi = i;
        pred[k] = V[bi].id;
      }
    }
    for (const k of keys) { hist[k].push(pred[k]); if (hist[k].length > HIST) hist[k].shift(); }
    const gt = chordAt(GT === 'performed' ? ex.performed : ex.chords, t)?.appId;
    if (!gt) continue;
    const ringing = stringsAt(ex.notes, t).filter(m => m > 0).length;
    if (ringing < MIN_STRINGS) continue;
    n++;
    for (const k of keys) {
      const p = majority(hist[k]), ok = p === gt;
      if (ok) hit[k]++;
      if (k === DUMP) {
        const c = chordAt(GT === 'performed' ? ex.performed : ex.chords, t);
        const fam = CAT_OF.get(gt) || '?'; (DUMPS.fam[fam] ||= { n: 0, hit: 0 }); DUMPS.fam[fam].n++; if (ok) DUMPS.fam[fam].hit++;
        const age = Math.min(9, Math.floor((t - c.t0) / 0.1)); (DUMPS.age[age] ||= { n: 0, hit: 0 }); DUMPS.age[age].n++; if (ok) DUMPS.age[age].hit++;
        if (!ok) { const key = `${gt}→${p}`; DUMPS.conf.set(key, (DUMPS.conf.get(key) || 0) + 1); }
      }
    }
  }
  for (const k of keys) { totals[k] = totals[k] || { hit: 0, n: 0 }; totals[k].hit += hit[k]; totals[k].n += n; }
  return { name, n, acc: Object.fromEntries(keys.map(k => [k, n ? hit[k] / n : 0])) };
}

const names = listExcerpts(f => f.includes('comp') && (SUBSET === 'all' || OPEN.some(s => f.includes(s))));
const totals = {};
const DUMPS = { age: [], conf: new Map(), fam: {} };
const CAT_OF = new Map(APP_CHORDS.map(c => [c.id, c.category]));
const t0 = performance.now();
for (const nm of names) {
  const r = evalExcerpt(nm, totals);
  if (VERBOSE) console.log(nm.padEnd(24), `n=${String(r.n).padStart(4)}`, Object.entries(r.acc).map(([k, v]) => `${k}=${(v * 100).toFixed(0).padStart(3)}%`).join(' '));
}
console.log(`gt=${GT} cand=${CANDIDATES.length} prior=${PRIOR} subset=${SUBSET} files=${names.length} hop=${HOP} minStrings=${MIN_STRINGS} smooth=${SMOOTH} hist=${HIST} set=${JSON.stringify(OVERRIDES)} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
if (DUMP) {
  const errs = [...DUMPS.conf.values()].reduce((a, b) => a + b, 0);
  console.log(`[${DUMP}] accuracy by 100ms since chord change:`, DUMPS.age.map(b => `${(100 * b.hit / b.n).toFixed(0)}%`).join(' '));
  console.log(`[${DUMP}] by GT family:`, Object.entries(DUMPS.fam).map(([f, b]) => `${f} ${(100 * b.hit / b.n).toFixed(0)}% (n=${b.n})`).join(', '));
  console.log(`[${DUMP}] top confusions:`, [...DUMPS.conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${(100 * v / errs).toFixed(0)}%`).join(', '));
}
console.log('  ' + Object.entries(totals).map(([k, c]) => `${k}=${(100 * c.hit / c.n).toFixed(1)}%`).join('  ') + `  [${totals.old.n} chord frames]`);

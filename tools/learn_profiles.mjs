// Learn per-pitch partial amplitude profiles from GuitarSet frames where
// exactly one string is sounding (ground truth). Writes data/partials.json:
//   { "40": [1, a2, a3, ...], ... }   relative to the fundamental
// Frames within 60 ms of a note onset are skipped (attack transient).
import fs from 'node:fs';
import { FFT, hann } from '../src/dsp/fft.js';
import { frames, rms, midiToHz, midiName } from '../src/dsp/analyzer.js';
import { listExcerpts, loadExcerpt, stringsAt } from './guitarset.mjs';

const N = 8192, HOP = 2048, K = 12;
const fft = new FFT(N), win = hann(N), re = new Float32Array(N), im = new Float32Array(N);
const acc = new Map();   // midi → { n, sum: Float64Array(K) } of log amplitudes
const accS = new Map();  // `${string}:${midi}` → same, keyed per string
let frameCount = 0;
for (const name of listExcerpts()) {
  const ex = loadExcerpt(name);
  const sr = ex.sampleRate;
  for (const { start, frame } of frames(ex.samples, N, HOP)) {
    const t = (start + N / 2) / sr;
    const ringing = stringsAt(ex.notes, t);
    const sounding = ringing.map((m, s) => [m, s]).filter(([m]) => m > 0);
    if (sounding.length !== 1) continue;
    const [midiF, s] = sounding[0];
    const note = ex.notes[s].find(n => t >= n.t0 && t < n.t1);
    if (!note || t - note.t0 < 0.06) continue;
    if (rms(frame) < 0.004) continue;
    for (let i = 0; i < N; i++) re[i] = frame[i] * win[i];
    im.fill(0); fft.transform(re, im);
    const f0 = midiToHz(midiF);           // annotated pitch (fractional midi, so tuning drift is handled)
    const amps = new Float64Array(K);
    let ok = true;
    for (let k = 1; k <= K; k++) {
      const bc = k * f0 * N / sr;
      if (bc + 3 >= N / 2) { ok = k > 3; break; }
      let best = 0;
      for (let b = Math.round(bc) - 2; b <= Math.round(bc) + 2; b++) best = Math.max(best, Math.hypot(re[b], im[b]));
      amps[k - 1] = best;
    }
    if (!ok || amps[0] <= 0) continue;
    const midi = Math.round(midiF);
    const e = acc.get(midi) || { n: 0, sum: new Float64Array(K), sq: new Float64Array(K), byString: new Map() };
    for (let k = 0; k < K; k++) { const l = Math.log((amps[k] || 1e-9) / amps[0]); e.sum[k] += l; e.sq[k] += l * l; }
    { const bs = e.byString.get(s) || { n: 0, s2: 0 }; bs.n++; bs.s2 += Math.log((amps[1] || 1e-9) / amps[0]); e.byString.set(s, bs); }
    e.n++; acc.set(midi, e); frameCount++;
    { const key = `${s}:${midi}`; const es = accS.get(key) || { n: 0, sum: new Float64Array(K) };
      for (let k = 0; k < K; k++) es.sum[k] += Math.log((amps[k] || 1e-9) / amps[0]); es.n++; accS.set(key, es); }
  }
}
const out = {};
for (const [midi, e] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
  const prof = Array.from(e.sum, v => Math.exp(v / e.n));
  out[midi] = prof.map(v => Number(v.toFixed(4)));
  const sd = Array.from(e.sq, (q, k) => Math.sqrt(Math.max(0, q / e.n - (e.sum[k] / e.n) ** 2)));
  const per = [...e.byString.entries()].sort((a, b) => a[0] - b[0]).map(([st, v]) => `s${st}:${Math.exp(v.s2 / v.n).toFixed(2)}(${v.n})`).join(' ');
  console.log(`${midiName(midi).padEnd(4)} n=${String(e.n).padStart(4)}  ` + prof.slice(0, 6).map(v => v.toFixed(2)).join(' ') + `  | sd(log a2/a1)=${sd[1].toFixed(2)} sd(a3)=${sd[2].toFixed(2)}  a2 by string: ${per}`);
}
fs.writeFileSync(new URL('../data/partials.json', import.meta.url), JSON.stringify(out));
const outS = {};
for (const [key, e] of accS) if (e.n >= 3) outS[key] = Array.from(e.sum, v => Number(Math.exp(v / e.n).toFixed(4)));
fs.writeFileSync(new URL('../data/partials_by_string.json', import.meta.url), JSON.stringify(outS));
console.log(`${Object.keys(outS).length} (string,pitch) profiles with ≥3 frames → data/partials_by_string.json`);
console.log(`${frameCount} single-string frames, ${Object.keys(out).length} pitches → data/partials.json`);

// Learn per-pitch partial profiles from the note bank (isolated hex-pickup
// notes, tools/note_bank.mjs) — same measurement as tools/learn_profiles.mjs
// but on pickup timbre. Writes testdata/notebank/partials_hex.json so the
// synthetic bench can run with a matched dictionary (tools/eval_synth.mjs
// --profiles=hex) as well as the shipped mic-learned one.
import fs from 'node:fs';
import path from 'node:path';
import { FFT, hann } from '../src/dsp/fft.js';
import { frames, rms, midiToHz, TUNING } from '../src/dsp/analyzer.js';

const BANK = path.resolve(import.meta.dirname, '../testdata/notebank');
const index = JSON.parse(fs.readFileSync(path.join(BANK, 'index.json')));
const buf = fs.readFileSync(path.join(BANK, 'bank.f32'));
const bank = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const sr = index.sampleRate, N = 8192, HOP = 2048, K = 12;
const fft = new FFT(N), win = hann(N), re = new Float32Array(N), im = new Float32Array(N);
const acc = new Map();
let frameCount = 0;
for (const n of index.notes) {
  const x = bank.subarray(n.offset, n.offset + n.length);
  const f0 = midiToHz(n.midi);
  for (const { start, frame } of frames(x, N, HOP)) {
    const t = start / sr;
    if (t < 0.06 || rms(frame) < 0.004) continue;
    for (let i = 0; i < N; i++) re[i] = frame[i] * win[i];
    im.fill(0); fft.transform(re, im);
    const amps = new Float64Array(K); let ok = true;
    for (let k = 1; k <= K; k++) {
      const bc = k * f0 * N / sr; if (bc + 3 >= N / 2) { ok = k > 3; break; }
      let best = 0; for (let b = Math.round(bc) - 2; b <= Math.round(bc) + 2; b++) best = Math.max(best, Math.hypot(re[b], im[b]));
      amps[k - 1] = best;
    }
    if (!ok || amps[0] <= 0) continue;
    const midi = TUNING[n.string] + n.fret;
    const e = acc.get(midi) || { n: 0, sum: new Float64Array(K) };
    for (let k = 0; k < K; k++) e.sum[k] += Math.log((amps[k] || 1e-9) / amps[0]);
    e.n++; acc.set(midi, e); frameCount++;
  }
}
const out = {};
for (const [midi, e] of [...acc.entries()].sort((a, b) => a[0] - b[0])) out[midi] = Array.from(e.sum, v => Number(Math.exp(v / e.n).toFixed(4)));
// fill pitches the bank lacks by borrowing the nearest learned pitch (the app's analyzer wants every pitch 40..81)
const have = Object.keys(out).map(Number);
for (let m = 40; m <= 81; m++) if (!out[m]) { const near = have.reduce((a, b) => Math.abs(b - m) < Math.abs(a - m) ? b : a); out[m] = out[near]; }
fs.writeFileSync(path.join(BANK, 'partials_hex.json'), JSON.stringify(out));
console.log(`${frameCount} frames, ${have.length} pitches learned (+${42 - have.length} borrowed) → testdata/notebank/partials_hex.json`);
const mic = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../data/partials.json')));
for (const m of [40, 45, 50, 55, 59, 64, 69]) console.log(`midi ${m}  mic ${mic[m]?.slice(0, 5).map(v => v.toFixed(2)).join(' ')}   hex ${out[m].slice(0, 5).map(v => v.toFixed(2)).join(' ')}`);

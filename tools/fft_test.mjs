import { FFT } from '../src/dsp/fft.js';
const n = 1024, sr = 8000, f = 440;
const fft = new FFT(n);
const x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / sr);
const re = new Float32Array(n), im = new Float32Array(n);
fft.forward(x, re, im);
let best = 0, bestMag = 0;
for (let k = 0; k <= n / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > bestMag) { bestMag = m; best = k; } }
console.log('peak bin', best, '→', (best * sr / n).toFixed(1), 'Hz (expect ~440); mag', bestMag.toFixed(1), '(expect ~', n / 2, ')');
// naive DFT cross-check on a few bins
for (const k of [3, 56, 57, 200]) {
  let r = 0, i2 = 0;
  for (let t = 0; t < n; t++) { const a = -2 * Math.PI * k * t / n; r += x[t] * Math.cos(a); i2 += x[t] * Math.sin(a); }
  const err = Math.hypot(r - re[k], i2 - im[k]);
  console.log(`bin ${k}: fft=(${re[k].toFixed(3)},${im[k].toFixed(3)}) dft=(${r.toFixed(3)},${i2.toFixed(3)}) err=${err.toExponential(2)}`);
}

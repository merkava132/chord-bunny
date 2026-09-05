// Synthetic smoke test: build a fake "open C" from harmonic series, check that
// the analyzer's top activations land on the voicing pitches.
import { PitchAnalyzer, voicingPitches, midiToHz, midiName } from '../src/dsp/analyzer.js';
const sr = 44100, N = 8192;
const an = new PitchAnalyzer({ sampleRate: sr, fftSize: N });
const frets = [-1, 3, 2, 0, 1, 0];  // open C
const pitches = voicingPitches(frets).filter(p => p > 0);
const x = new Float32Array(N);
for (const p of pitches) {
  const f0 = midiToHz(p);
  for (let k = 1; k <= 8; k++) {
    const a = 0.3 / k, f = k * f0, ph = Math.random() * 6.28;
    for (let i = 0; i < N; i++) x[i] += a * Math.sin(2 * Math.PI * f * i / sr + ph);
  }
}
for (let i = 0; i < N; i++) x[i] += (Math.random() - 0.5) * 0.02;
const t0 = performance.now();
let act;
for (let r = 0; r < 50; r++) act = an.analyze(x);
const dt = (performance.now() - t0) / 50;
const ranked = [...act].map((a, i) => [a, an.pitches[i]]).sort((a, b) => b[0] - a[0]);
console.log(`expected: ${pitches.map(midiName).join(' ')}`);
console.log('top 8   :', ranked.slice(0, 8).map(([a, m]) => `${midiName(m)}=${a.toFixed(2)}`).join(' '));
console.log(`${dt.toFixed(2)} ms/frame (${an.nP} pitches × ${an.nBins} bins)`);

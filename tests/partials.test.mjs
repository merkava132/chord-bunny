// Partial measurement, response fit and application (src/dsp/partials.js, analyzer.mergeUserPartials).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FFT, hann } from '../src/dsp/fft.js';
import { midiToHz, mergeUserPartials } from '../src/dsp/analyzer.js';
import { measurePartials, fitResponse, applyResponse, interpGain, partialHz, OPEN_MIDI } from '../src/dsp/partials.js';

const SR = 48000, N = 8192;
function spectrumOf(samples) {
  const fft = new FFT(N), w = hann(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = samples[i] * w[i];
  fft.transform(re, im);
  return Float32Array.from({ length: N / 2 + 1 }, (_, k) => Math.hypot(re[k], im[k]));
}
// a pluck: decaying sinusoids at the inharmonic partials with the given amplitudes
function pluck(f0, amps, { seconds = 1, decay = 2, noise = 0 } = {}) {
  const n = Math.round(seconds * SR), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let v = 0;
    amps.forEach((a, k) => { v += a * Math.exp(-decay * t * (k + 1) / 2) * Math.sin(2 * Math.PI * partialHz(f0, k + 1) * t + k); });
    out[i] = v + noise * (Math.random() * 2 - 1);
  }
  return out;
}

describe('measurePartials', () => {
  it('recovers known partial amplitudes of a synthetic low E pluck within 10%', () => {
    const amps = [1, 2.2, 1.3, 0.66, 0.22, 0.3, 0.13, 0.06, 0.1, 0.1];
    const s = pluck(midiToHz(40), amps, { decay: 0, noise: 0.001 });
    const m = measurePartials(spectrumOf(s.subarray(0, N)), { sampleRate: SR, fftSize: N, f0: midiToHz(40) });
    assert.equal(m.amps.length, 10);
    m.amps.forEach((a, i) => assert.ok(Math.abs(a - amps[i]) / amps[i] < 0.1, `partial ${i + 1}: ${a} vs ${amps[i]}`));
    assert.ok(m.snr.every(x => x > 4), 'clean partials stand well above the floor');
  });
  it('stops at the analyzer band edge and flags a missing partial by its low snr', () => {
    const f0 = midiToHz(64);   // E4: the 10th partial is above 3200 Hz
    const amps = [1, 0.5, 0, 0.2, 0.1, 0.1, 0.05, 0.05, 0.05, 0.05];
    const m = measurePartials(spectrumOf(pluck(f0, amps, { decay: 0, noise: 0.002 }).subarray(0, N)), { sampleRate: SR, fftSize: N, f0 });
    assert.equal(m.amps.length, 9);
    assert.ok(m.snr[2] < 3, `absent 3rd partial reads as floor (snr ${m.snr[2]})`);
    assert.ok(m.snr[1] > 10);
  });
});

describe('fitResponse / applyResponse', () => {
  const base = { 40: [1, 2.2, 1.3, 0.66, 0.22, 0.3, 0.13, 0.06, 0.1, 0.1], 45: [1, 0.54, 0.15, 0.09, 0.02, 0.01, 0.01, 0.008, 0.01, 0.009],
    50: [1, 0.66, 0.59, 0.21, 0.07, 0.07, 0.13, 0.08, 0.05, 0.04], 55: [1, 0.34, 0.1, 0.09, 0.05, 0.04, 0.03, 0.03, 0.035, 0.02],
    59: [1, 0.15, 0.06, 0.04, 0.02, 0.01, 0.02, 0.01, 0.03, 0.009], 64: [1, 0.09, 0.21, 0.09, 0.05, 0.06, 0.08, 0.03, 0.03, 0.01] };
  const tilt = (f) => Math.pow(f / 200, 0.5);   // +3 dB per octave above 200 Hz: a bright mic
  const measured = Object.fromEntries(Object.entries(base).map(([m, a]) => { const f0 = midiToHz(Number(m)); return [m, a.map((v, i) => v * tilt(partialHz(f0, i + 1)) / tilt(f0))]; }));
  it('recovers a +3 dB/octave tilt from six strings', () => {
    const r = fitResponse(measured, base);
    assert.equal(r.n, 6 * 9);
    for (const [fa, fb] of [[100, 400], [200, 800], [300, 1200]]) {
      const got = 20 * Math.log10(interpGain(r, fb) / interpGain(r, fa));
      assert.ok(Math.abs(got - 6) < 1.5, `${fa}→${fb} Hz: ${got.toFixed(2)} dB, expected ≈6`);
    }
    assert.ok(r.rmsLogResidual < 0.1);
  });
  it('applying the fitted response to the base table reproduces the measurements', () => {
    const r = fitResponse(measured, base), corrected = applyResponse(base, r);
    for (const m of OPEN_MIDI) corrected[m].forEach((v, i) => assert.ok(Math.abs(Math.log(v / measured[m][i])) < 0.15, `midi ${m} partial ${i + 1}: ${v} vs ${measured[m][i].toFixed(3)}`));
    assert.equal(corrected[40][0], 1, 'the fundamental stays 1');
  });
  it('skips partials under minSnr and handles an empty measurement set', () => {
    const r = fitResponse({ 40: measured[40] }, base, { snr: { 40: [9, 9, 1, 9, 9, 9, 9, 9, 9, 9] } });
    assert.equal(r.n, 8);
    const e = fitResponse({}, base);
    assert.equal(e.n, 0); assert.ok(e.gain.every(g => Math.abs(g - 1) < 1e-6));
  });
});

describe('mergeUserPartials', () => {
  const base = { 40: [1, 2, 1], 41: [1, 1.5, 1], 45: [1, 0.5, 0.2] };
  const user = { 40: [1, 1.1, 0.9], meta: { learnedAt: 'x' }, response: { hz: [60, 3400], gain: [1, 1] } };
  it('overrides the measured pitches, keeps the rest (corrected), drops meta/response', () => {
    const out = mergeUserPartials(base, user);
    assert.deepEqual(out[40], [1, 1.1, 0.9]);
    assert.deepEqual(out[41], [1, 1.5, 1]);
    assert.deepEqual(Object.keys(out).sort(), ['40', '41', '45']);
  });
  it('applies a non-flat response to un-measured pitches, relative to their fundamental', () => {
    const out = mergeUserPartials(base, { response: { hz: [60, 3400], gain: [0.5, 2] } });
    assert.ok(out[41][1] > 1.5 && out[41][2] > out[41][1] / 1.5, `brighter response lifts upper partials: ${out[41]}`);
    assert.equal(out[41][0], 1);
  });
  it('by-string table: only a string\'s own open pitch is replaced', () => {
    const byString = { '0:40': [1, 2, 1], '1:40': [1, 3, 1], '1:45': [1, 0.5, 0.2] };
    const out = mergeUserPartials(byString, user, { midiOf: (k) => Number(k.split(':')[1]), overrideKey: (m) => { const s = OPEN_MIDI.indexOf(m); return s < 0 ? null : `${s}:${m}`; } });
    assert.deepEqual(out['0:40'], [1, 1.1, 0.9]);
    assert.deepEqual(out['1:40'], [1, 3, 1]);
  });
  it('no user table → the base table unchanged', () => { assert.equal(mergeUserPartials(base, null), base); });
});

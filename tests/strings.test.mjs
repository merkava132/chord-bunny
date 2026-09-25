import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StringTracker, STRING_DEFAULTS, lineProminence } from '../src/dsp/strings.js';
import { FFT, hann } from '../src/dsp/fft.js';
import { frames, midiToHz } from '../src/dsp/analyzer.js';

const SR = 48000;
function spectrum(x) { const N = x.length, f = new FFT(N), w = hann(N), re = new Float32Array(N), im = new Float32Array(N); for (let i = 0; i < N; i++) re[i] = x[i] * w[i]; f.transform(re, im); return Float32Array.from({ length: N / 2 }, (_, k) => Math.hypot(re[k], im[k])); }
function tone(hz, N, amp = 1, partials = [1]) { const x = new Float32Array(N); for (let i = 0; i < N; i++) for (const [k, a] of partials.entries()) x[i] += amp * a * Math.sin(2 * Math.PI * hz * (k + 1) * i / SR); return x; }
let seed = 7; const noise = (N, amp) => Float32Array.from({ length: N }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return amp * ((seed / 0x7fffffff) * 2 - 1); });

describe('lineProminence', () => {
  const N = STRING_DEFAULTS.f0CheckN, b = Math.round(82.4 * N / SR);
  it('a sounding low E stands far above its neighbours; noise does not', () => {
    const e2 = tone(82.4, N, 0.1), nz = noise(N, 0.01);
    const both = e2.map((v, i) => v + nz[i]);
    assert.ok(lineProminence(spectrum(both), 0, b) > 10);
    assert.ok(lineProminence(spectrum(nz), 0, b) < 3);
  });
  it('the chord\'s upper E partials (E3 + E4) put nothing at 82 Hz', () => {
    const x = tone(164.8, N, 0.1).map((v, i) => v + tone(329.6, N, 0.1)[i] + noise(N, 0.01)[i]);
    assert.ok(lineProminence(spectrum(x), 0, b) < 3);
  });
});

describe('StringTracker muted-string fundamental check', () => {
  // a C-shape strum: A2-string C3, D-string E3, G3, C4, E4 (low E muted) → string 0 must not be reported; the same strum with a real E2 → it is
  const N = 4096, HOP = STRING_DEFAULTS.hop;
  const pluck = (hz, len, t0) => { const x = new Float32Array(len); const s0 = Math.round(t0 * SR); for (let i = s0; i < len; i++) { const dt = (i - s0) / SR; x[i] = 0.2 * Math.exp(-dt * 1.5) * (Math.sin(2 * Math.PI * hz * dt) + 0.5 * Math.sin(2 * Math.PI * 2 * hz * dt) + 0.25 * Math.sin(2 * Math.PI * 3 * hz * dt)); } return x; };
  const run = (withLowE) => {
    const len = SR * 1.2, x = noise(len, 0.002);
    for (const m of [48, 52, 55, 60, 64]) { const p = pluck(midiToHz(m), len, 0.4); for (let i = 0; i < len; i++) x[i] += p[i]; }
    if (withLowE) { const p = pluck(midiToHz(40), len, 0.4); for (let i = 0; i < len; i++) x[i] += p[i]; }
    const tr = new StringTracker({ sampleRate: SR });
    tr.setVoicing([-1, 3, 2, 0, 1, 0]);
    const strums = []; tr.onEvent = (e) => { if (e.type === 'strum') strums.push(e); };
    for (const { start, frame } of frames(x, N, HOP)) tr.process(frame, (start + N / 2) / SR);
    return strums;
  };
  it('does not report the muted low E when only the chord\'s upper strings sound', () => {
    const st = run(false);
    assert.ok(st.length >= 1, 'a strum is detected');
    assert.ok(!st.some(e => e.strings.some(s => s.string === 0 && !s.inferred)), `low E reported: ${JSON.stringify(st.map(e => e.strings.map(s => s.string)))}`);
  });
  it('reports it (as a muted hit, with its prominence) when the low E really rings', () => {
    const st = run(true);
    const hit = st.flatMap(e => e.strings).find(s => s.string === 0 && !s.inferred);
    assert.ok(hit, 'low E reported');
    assert.equal(hit.muted, true);
    assert.ok(hit.f0 >= STRING_DEFAULTS.mutedF0Prom);
  });
});

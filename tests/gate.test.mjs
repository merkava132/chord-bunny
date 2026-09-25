// src/dsp/gate.js + PitchAnalyzer.residual(): a harmonic note fits the
// dictionary, noise does not; the gate follows the residual with an EMA
// that silence resets.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PitchAnalyzer, midiToHz } from '../src/dsp/analyzer.js';
import { GuitarGate } from '../src/dsp/gate.js';

const SR = 48000, N = 8192;
function note(midi, partials = 8) {
  const f0 = midiToHz(midi), out = new Float32Array(N);
  for (let k = 1; k <= partials; k++) { const a = 1 / k; for (let i = 0; i < N; i++) out[i] += a * Math.sin(2 * Math.PI * k * f0 * i / SR); }
  return out;
}
function noise(seed = 1) { let x = seed; const out = new Float32Array(N); for (let i = 0; i < N; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x / 0x7fffffff - 0.5; } return out; }

describe('PitchAnalyzer.residual / flatness', () => {
  const an = new PitchAnalyzer({ sampleRate: SR, fftSize: N });
  it('a harmonic note is mostly explained; white noise is not', () => {
    an.analyze(note(45)); const rn = an.residual(), fn = an.flatness();
    an.analyze(noise()); const rw = an.residual(), fw = an.flatness();
    assert.ok(rn < 0.2, `note residual ${rn}`);
    assert.ok(rw > 0.5, `noise residual ${rw}`);
    assert.ok(fn < fw, `flatness note ${fn} < noise ${fw}`);
  });
  it('a chord of three notes is still explained', () => {
    const c = new Float32Array(N); for (const m of [48, 52, 55]) { const n = note(m); for (let i = 0; i < N; i++) c[i] += n[i]; }
    an.analyze(c); assert.ok(an.residual() < 0.25, `chord residual ${an.residual()}`);
  });
});

describe('GuitarGate', () => {
  const o = { residMax: 0.4, steep: 20, ema: 0.5, threshold: 0.5 };
  it('scores 0.5 at residMax, high below, low above', () => {
    assert.ok(Math.abs(GuitarGate.score(0.4, o) - 0.5) < 1e-9);
    assert.ok(GuitarGate.score(0.2, o) > 0.9);
    assert.ok(GuitarGate.score(0.6, o) < 0.1);
  });
  it('the first sounding frame is not diluted by the EMA; later frames are smoothed', () => {
    const g = new GuitarGate(o);
    assert.ok(g.push(0.1) > 0.9, 'first frame');
    let v; for (let i = 0; i < 4; i++) v = g.push(0.7);
    assert.ok(v < o.threshold, `after four noisy frames ${v}`);
    assert.ok(g.push(0.1) < 0.9, 'one clean frame does not reopen it fully');
    g.silent();
    assert.ok(g.push(0.1) > 0.9, 'after silence the attack frame counts on its own');
  });
});

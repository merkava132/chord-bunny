// Pure parts of the detector: pitch-class helpers, template building,
// scoring and confidence. No audio.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pitchClasses, pcKey, pcSubset, buildTemplates, scoreTemplates, confidenceOf, PC_INDEX } from '../src/detect.js';
import { CONFIG } from '../src/config.js';

const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const by = Object.fromEntries(CHORDS.map(c => [c.id, c]));
const chroma = (weights) => { const v = new Float32Array(12); let s = 0; for (const [n, w] of Object.entries(weights)) { v[PC_INDEX[n]] += w; s += w; } for (let i = 0; i < 12; i++) v[i] /= s; return v; };
const idOf = (T, r, which = 'best') => T[r[which]]?.id;

describe('pitch-class helpers', () => {
  it('pitchClasses is sorted and unique', () => { assert.deepEqual(pitchClasses(by.Cadd9), [0, 2, 4, 7]); assert.deepEqual(pitchClasses(by['G/B']), [2, 7, 11]); });
  it('pcKey identifies twins', () => { assert.equal(pcKey(by.Asus2), pcKey(by.Esus4)); assert.notEqual(pcKey(by.Asus2), pcKey(by.Asus4)); });
  it('pcSubset', () => { assert.ok(pcSubset(by.C, by.Cmaj7)); assert.ok(pcSubset(by.Am, by.Am7)); assert.ok(!pcSubset(by.Cmaj7, by.C)); assert.ok(pcSubset(by.C, by.Am7), 'C E G sits inside A C E G — practice.js also checks the root'); });
});

describe('buildTemplates', () => {
  const T = buildTemplates(CHORDS);
  it('merges chords with the same notes and reports the first id in list order', () => {
    const merged = Object.fromEntries(T.filter(t => t.ids.length > 1).map(t => [t.id, t.ids]));
    assert.deepEqual(merged, {
      C: ['C', 'C/G', 'C/E'], D: ['D', 'D/F#'], G: ['G', 'G/B'], A: ['A', 'A/C#'],
      Asus2: ['Asus2', 'Esus4'], Asus4: ['Asus4', 'Dsus2'], Csus2: ['Csus2', 'Gsus4'], Csus4: ['Csus4', 'Fsus2'],
      Am7: ['Am7', 'Am/G'],
    });
    assert.equal(T.length, CHORDS.length - 10);
  });
  it('carries mask, prior and the perfect score', () => {
    const c = T.find(t => t.id === 'C'), sus = T.find(t => t.id === 'Asus2');
    assert.equal(c.mask, (1 << 0) | (1 << 4) | (1 << 7));
    assert.equal(c.prior, 0);
    assert.equal(sus.prior, CONFIG.detect.prior.sus);
    assert.ok(Math.abs(c.perfect - Math.log(1 / 3 + CONFIG.detect.eps)) < 1e-9);
  });
  it('respects a candidate subset', () => { const B = buildTemplates(CHORDS.filter(c => c.category === 'basic')); assert.equal(B.length, 9); });
});

describe('scoreTemplates / confidenceOf', () => {
  const T = buildTemplates(CHORDS);
  it('a clean C triad is C, and its rival for the margin is not a nested chord', () => {
    const r = scoreTemplates(chroma({ C: 1, E: 1, G: 1 }), T);
    assert.equal(idOf(T, r), 'C');
    const second = T[r.second];
    const cmask = T[r.best].mask;
    assert.ok((second.mask & cmask) !== cmask && (second.mask & cmask) !== second.mask, `runner-up ${second.id} is nested with C`);
    assert.ok(r.scores[r.best] > r.scores[T.findIndex(t => t.id === 'Cadd9')]);
    assert.ok(r.scores[r.best] > r.scores[T.findIndex(t => t.id === 'Cmaj7')]);
  });
  it('the Cmaj7 open voicing (C E G B E) beats plain C when the 7th is really there', () => {
    const r = scoreTemplates(chroma({ C: 1, E: 2, G: 1, B: 1 }), T);
    assert.equal(idOf(T, r), 'Cmaj7');
  });
  it('a sus voicing wins despite its prior', () => {
    const r = scoreTemplates(chroma({ D: 2, G: 1, A: 1 }), T);
    assert.equal(idOf(T, r), 'Dsus4');
    assert.ok(r.scores[r.best] > r.scores[T.findIndex(t => t.id === 'D')], 'D (D F# A) has no F# here');
  });
  it('confidence is in [0, 1], high for a clean triad, low for noise', () => {
    const clean = scoreTemplates(chroma({ C: 1, E: 1, G: 1 }), T);
    const conf = confidenceOf(clean, T);
    assert.ok(conf > 0.8 && conf <= 1, `clean C conf ${conf}`);
    const flat = new Float32Array(12).fill(1 / 12);
    const noisy = scoreTemplates(flat, T);
    const nconf = confidenceOf(noisy, T);
    assert.ok(nconf >= 0 && nconf < 0.3, `flat chroma conf ${nconf}`);
  });
  it('adds a sus chord\'s prior back before judging its fit', () => {
    const ch = chroma({ A: 1, D: 1, E: 1 });
    const r = scoreTemplates(ch, T);
    assert.equal(idOf(T, r), 'Asus4');
    const t = T[r.best], c = CONFIG.confidence;
    const bestScore = r.scores[r.best] + t.prior;
    const fit = Math.max(0, Math.min(1, (bestScore - c.poor) / (t.perfect - c.poor)));
    const margin = Math.max(0, Math.min(1, (bestScore - r.scores[r.second]) / c.margin));
    assert.ok(Math.abs(confidenceOf(r, T) - (c.fitWeight * fit + (1 - c.fitWeight) * margin)) < 1e-9);
    assert.ok(Math.abs(fit - 1) < 1e-9, 'an even 3-note chroma is a perfect fit once the prior is restored');
  });
  it('writes into a provided scores array', () => {
    const out = new Array(T.length);
    const r = scoreTemplates(chroma({ E: 1, G: 1, B: 1 }), T, out);
    assert.equal(r.scores, out); assert.equal(idOf(T, r), 'Em');
  });
});

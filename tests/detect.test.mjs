// Pure parts of the detector: pitch-class helpers, template building,
// scoring and confidence. No audio.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pitchClasses, pcKey, pcSubset, buildTemplates, scoreTemplates, confidenceOf, PC_INDEX, missingDistinguisher, ChromaWindow } from '../src/detect.js';
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
      Em7: ['Em7', 'G6'], Cmaj7: ['Cmaj7', 'Cmaj7-hi'],   // My Song: G6 = the notes of Em7; the x35500 Cmaj7 voicing
    });
    assert.equal(T.length, CHORDS.length - 12);
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

describe('decoy prior (practice mode foils)', () => {
  const four = CHORDS.filter(c => ['Em', 'E', 'G', 'C'].includes(c.id));
  it('docks only templates made entirely of decoys', () => {
    const T = buildTemplates(four, { decoys: new Set(['E', 'C']) });
    const by = (id) => T.find(t => t.ids.includes(id));
    assert.equal(by('E').prior, CONFIG.detect.prior.decoy);
    assert.equal(by('C').prior, CONFIG.detect.prior.decoy);
    assert.equal(by('Em').prior, 0);
    assert.equal(by('G').prior, 0);
  });
  it('breaks an Em/E tie (third missing, equal G and G# leakage) toward the enabled chord', () => {
    const ch = new Float32Array(12).fill(0.01); ch[4] = 0.42; ch[11] = 0.42; ch[7] = 0.03; ch[8] = 0.03;   // E, B strong; G = G# small
    const T = buildTemplates(four, { decoys: new Set(['E', 'C']) });
    assert.ok(T[scoreTemplates(ch, T).best].ids.includes('Em'));
    const T0 = buildTemplates(four);
    const s0 = scoreTemplates(ch, T0).scores, e = T0.findIndex(t => t.ids.includes('E')), em = T0.findIndex(t => t.ids.includes('Em'));
    assert.ok(Math.abs(s0[e] - s0[em]) < 1e-6, 'without the prior it is a tie');
  });
});

describe('distinguishing-note check (CONFIG.stable.thirdMin)', () => {
  const T = buildTemplates(CHORDS.filter(c => ['A', 'Am', 'E', 'Em', 'C', 'G', 'D'].includes(c.id)));
  const by = (id) => T.find(t => t.ids.includes(id));
  const chroma = (parts) => { const ch = new Float32Array(12).fill(0.01); for (const [pc, v] of Object.entries(parts)) ch[PC_INDEX[pc]] = v; return ch; };
  it('a strum with no third at all cannot fire Am (or A)', () => {
    const ch = chroma({ A: 0.47, E: 0.2 });
    assert.equal(missingDistinguisher(ch, by('Am'), T), PC_INDEX.C);
    assert.equal(missingDistinguisher(ch, by('A'), T), PC_INDEX['C#']);
  });
  it('with the minor third present Am fires; C (one note from Am and Em) needs its own C and G', () => {
    assert.equal(missingDistinguisher(chroma({ A: 0.4, C: 0.15, E: 0.2 }), by('Am'), T), null);
    assert.equal(missingDistinguisher(chroma({ C: 0.3, E: 0.2, G: 0.2 }), by('C'), T), null);
    assert.equal(missingDistinguisher(chroma({ E: 0.3, G: 0.3, C: 0.02 }), by('C'), T), PC_INDEX.C);
  });
  it('ChromaWindow averages the last half second and clears on reset', () => {
    const w = new ChromaWindow(0.5);
    w.push(0, chroma({ A: 0.4 })); const m = w.push(0.2, chroma({ A: 0.2 }));
    assert.ok(Math.abs(m[PC_INDEX.A] - 0.3) < 1e-6);
    w.push(1.0, chroma({ A: 0.1 }));   // older frames fall out of the window
    assert.ok(Math.abs(w.mean[PC_INDEX.A] - 0.1) < 1e-6);
    w.reset(); assert.equal(w.q.length, 0);
  });
});

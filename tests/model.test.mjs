// src/model.js: the feature builder, the MLP forward pass against a hand-computed
// case, candidate restriction in scoreModel, and loading the shipped model.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Featurizer, Model, scoreModel, mixResult, featureDim, MODEL_CTX, NONE, loadModelFile } from '../src/model.js';
import { buildTemplates, pcKey } from '../src/detect.js';
import { CONFIG } from '../src/config.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHORDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/chords.json')));

describe('Featurizer', () => {
  it('normalises each frame to a gain-free log vector and pads the context with the oldest frame', () => {
    const fz = new Featurizer(3);
    assert.equal(fz.dim, featureDim(3));
    const f1 = Float32Array.from(fz.push(Float32Array.from([1, 0, 0])));
    // lone pitch: log(1 + 1e-3) − log(1e-3) ≈ 6.9; absent: 0
    assert.ok(Math.abs(f1[0] - (Math.log(1.001) - Math.log(1e-3))) < 1e-5);
    assert.equal(f1[1], 0);
    for (let k = 1; k < MODEL_CTX; k++) assert.equal(f1[k * 3], f1[0], 'context padded with the same frame');
    for (let k = 0; k < MODEL_CTX; k++) assert.equal(f1[MODEL_CTX * 3 + k], 0, 'relative loudness of a padded past is 0');
    const f2 = fz.push(Float32Array.from([10, 10, 0]));   // 10× louder, two pitches
    assert.ok(Math.abs(f2[0] - f2[1]) < 1e-6 && f2[2] === 0);
    assert.ok(Math.abs(f2[MODEL_CTX * 3 + 1] - Math.log(1 / 20)) < 1e-3, 'previous frame was 20× quieter');
    assert.equal(f2[MODEL_CTX * 3 + 0], 0, 'the current frame relative to itself');
    const g = Float32Array.from(new Featurizer(3).push(Float32Array.from([100, 0, 0])));
    assert.ok(Math.abs(g[0] - f1[0]) < 1e-5, 'gain does not change the per-frame vector');
  });
  it('a silent (all-zero) frame gives zeros, not NaN', () => {
    const f = new Featurizer(3).push(new Float32Array(3));
    for (const v of f) assert.ok(Number.isFinite(v));
  });
});

describe('Model forward pass', () => {
  // dim 2, hidden 2, classes: "0,4,7" (C), "none"
  const json = { dim: 2, hidden: 2, classes: ['0,4,7', NONE], mean: [1, 2], std: [2, 4],
    W1: [1, 0, 0, -1], b1: [0.5, 0], W2: [1, 2, -1, 0], b2: [0, 0.25] };
  const m = new Model(json);
  it('matches the hand computation', () => {
    const z = m.forward(Float32Array.from([3, 6]));       // standardised x = (1, 1)
    // h = relu(W1 x + b1) = relu(1·1 + 0·1 + 0.5, 0·1 + (−1)·1 + 0) = (1.5, 0)
    // logits = W2 h + b2 = (1·1.5 + 2·0, −1·1.5 + 0·0 + 0.25) = (1.5, −1.25)
    assert.ok(Math.abs(z[0] - 1.5) < 1e-6 && Math.abs(z[1] - (-1.25)) < 1e-6);
  });
  it('rejects weights whose shape disagrees with dim/hidden/classes', () => {
    assert.throws(() => new Model({ ...json, W1: [1, 2, 3] }), /shape/);
  });
  it('maps templates to classes by pitch-class set and knows none', () => {
    const T = buildTemplates(CHORDS.filter(c => ['C', 'C/G', 'G'].includes(c.id)));
    assert.equal(m.classOf(T.find(t => t.ids.includes('C'))), 0);
    assert.equal(m.classOf(T.find(t => t.ids.includes('G'))), -1);
    assert.equal(m.noneIndex, 1);
  });
});

describe('scoreModel', () => {
  const json = { dim: 1, hidden: 1, classes: ['0,4,7', '2,7,11', '0,4,7,11', NONE], mean: [0], std: [1], W1: [0], b1: [0], W2: [0, 0, 0, 0], b2: [0, 0, 0, 0] };
  const m = new Model(json);
  const T = buildTemplates(CHORDS.filter(c => ['C', 'G', 'Cmaj7'].includes(c.id)));
  const cls = T.map(t => m.classOf(t));
  it('restricts the softmax to the candidates plus none and returns the winner\'s posterior', () => {
    const logits = Float32Array.from([2, 1, 0, -5]);   // C, G, Cmaj7, none
    const r = scoreModel(m, logits, T, new Array(T.length), cls);
    assert.equal(T[r.best].ids[0], 'C');
    const Z = Math.exp(2) + Math.exp(1) + Math.exp(0) + Math.exp(-5);
    assert.ok(Math.abs(r.conf - Math.pow(Math.exp(2) / Z, CONFIG.model.confPow)) < 1e-6, 'posterior on the template scale');
    assert.ok(Math.abs(r.scores[r.best] - Math.log(Math.exp(2) / Z)) < 1e-6);
    assert.equal(T[r.second].ids[0], 'G', 'Cmaj7 is nested with C and is not the runner-up');
  });
  it('a candidate the model does not know can never win; the prior docks decoys like the templates', () => {
    const T2 = buildTemplates(CHORDS.filter(c => ['C', 'Am'].includes(c.id)), { decoys: new Set(['C']) });
    const cls2 = T2.map(t => m.classOf(t));   // Am unknown to this tiny model
    const r = scoreModel(m, Float32Array.from([0, 0, 0, 0]), T2, new Array(2), cls2);
    assert.equal(T2[r.best].ids[0], 'C');
    assert.equal(r.scores[T2.findIndex(t => t.ids[0] === 'Am')], -1e9);
    assert.ok(Math.abs(r.scores[r.best] - (Math.log(0.5) - CONFIG.detect.prior.decoy)) < 1e-6, 'log-posterior over {C, none} minus the decoy prior');
    assert.ok(Math.abs(r.conf - Math.pow(0.5, CONFIG.model.confPow)) < 1e-6, 'confidence is the posterior (without the prior) on the template scale');
  });
});

describe('mixResult (templates + β·model)', () => {
  const json = { dim: 1, hidden: 1, classes: ['0,4,7', '2,7,11', '0,4,7,11', NONE], mean: [0], std: [1], W1: [0], b1: [0], W2: [0, 0, 0, 0], b2: [0, 0, 0, 0] };
  const m = new Model(json);
  const T = buildTemplates(CHORDS.filter(c => ['C', 'G', 'Cmaj7'].includes(c.id)));
  const cls = T.map(t => m.classOf(t));
  const iC = T.findIndex(t => t.ids[0] === 'C'), iG = T.findIndex(t => t.ids[0] === 'G'), iM = T.findIndex(t => t.ids[0] === 'Cmaj7');
  it('breaks a template tie between unrelated chords with the model, keeps the template confidence', () => {
    const tpl = { scores: [0, 0, -1], best: 0, second: 1 }; tpl.scores[iC] = -1; tpl.scores[iG] = -1; tpl.scores[iM] = -2;
    const mdl = scoreModel(m, Float32Array.from([0, 3, 0, -5]), T, new Array(3), cls);   // the model likes G
    const r = mixResult(tpl, mdl, 0.1, T, 0.42);
    assert.equal(r.best, iG);
    assert.equal(r.conf, 0.42);
  });
  it('never decides between a triad and its extension: nested templates share the model term', () => {
    const tpl = { scores: [0, 0, 0], best: 0, second: 1 }; tpl.scores[iC] = -1.0; tpl.scores[iM] = -0.9; tpl.scores[iG] = -3;   // templates prefer Cmaj7 by a hair
    const mdl = scoreModel(m, Float32Array.from([4, -5, -4, -5]), T, new Array(3), cls);   // the model is sure it is plain C
    const r = mixResult(tpl, mdl, 0.5, T, 0.5);
    assert.equal(r.best, iM, 'Cmaj7 still wins: C and Cmaj7 got the same model term');
    assert.ok(Math.abs(r.scores[iC] - r.scores[iM] - (-1.0 - -0.9)) < 1e-6);
  });
});

describe('mixResult sus grouping', () => {
  const json = { dim: 1, hidden: 1, classes: ['9,1,4', '9,2,4', '9,0,4', NONE].map(k => k === NONE ? k : k.split(',').map(Number).sort((a, b) => a - b).join(',')), mean: [0], std: [1], W1: [0], b1: [0], W2: [0, 0, 0, 0], b2: [0, 0, 0, 0] };
  const m = new Model(json);
  const T = buildTemplates(CHORDS.filter(c => ['A', 'Asus4', 'Am'].includes(c.id)));
  const cls = T.map(t => m.classOf(t));
  const iA = T.findIndex(t => t.ids[0] === 'A'), iS = T.findIndex(t => t.ids[0] === 'Asus4'), iM = T.findIndex(t => t.ids[0] === 'Am');
  it('A and Asus4 share the model term, A and Am do not', () => {
    const tpl = { scores: [0, 0, 0], best: 0, second: 1 }; tpl.scores[iA] = -1.0; tpl.scores[iS] = -0.95; tpl.scores[iM] = -3;   // templates prefer Asus4 by a hair
    const like = (id) => { const l = new Float32Array(4).fill(-5); l[cls[T.findIndex(t => t.ids[0] === id)]] = 4; return l; };
    let r = mixResult({ ...tpl, scores: [...tpl.scores] }, scoreModel(m, like('A'), T, new Array(3), cls), 0.5, T, 0.5);
    assert.equal(r.best, iS, 'the model liking A does not flip Asus4 → A');
    const tpl2 = { scores: [0, 0, 0], best: 0, second: 1 }; tpl2.scores[iA] = -1.0; tpl2.scores[iM] = -1.05; tpl2.scores[iS] = -3;   // templates prefer A over Am by a hair
    r = mixResult(tpl2, scoreModel(m, like('Am'), T, new Array(3), cls), 0.5, T, 0.5);
    assert.equal(r.best, iM, 'the model liking Am does flip A → Am (major vs minor is the model\'s call)');
  });
});

describe('shipped model', () => {
  it('loads, covers every chord in data/chords.json plus none, and runs in well under a millisecond', async () => {
    const m = await loadModelFile(path.join(ROOT, CONFIG.model.path));
    assert.ok(m, 'data/model.json present');
    assert.equal(m.dim, featureDim(42));
    const keys = new Set(CHORDS.map(c => pcKey(c)));
    for (const k of keys) assert.ok(m.classIndex.has(k), `class for ${k}`);
    assert.ok(m.classIndex.has(NONE));
    const f = new Float32Array(m.dim).fill(1);
    m.forward(f);
    const t0 = performance.now(); for (let i = 0; i < 200; i++) m.forward(f);
    const perCall = (performance.now() - t0) / 200;
    assert.ok(perCall < 1, `forward pass ${perCall.toFixed(3)} ms`);
  });
});

// Learned frame classifier (optional scoring backend, CONFIG.detect.model).
//
// A small MLP over the analyzer's NNLS pitch activations: the current frame
// and the four before it (each L1-normalised and log-compressed, so the
// input is gain-free) plus the loudness of each context frame relative to
// the current one (attack / decay). Output: one logit per distinct
// pitch-class set in data/chords.json plus "none" (silence, noise, speech,
// attack transients). Trained by tools/train_model.mjs, weights in
// data/model.json (or data/user/model.json, which wins when present).
//
// The same Featurizer runs in the app and in the tools, so a benchmark
// number always describes the code that ships.

import { CONFIG } from './config.js';

export const MODEL_CTX = 5;              // context frames (current + 4 previous)
export const NONE = 'none';
const LOG_FLOOR = 1e-3;                  // log(act/sum + floor) − log(floor): 0 for an absent pitch, ~6.9 for a lone one
const SUM_EPS = 1e-6;

export const featureDim = (nP) => MODEL_CTX * nP + MODEL_CTX;

// Per-frame feature builder with the context ring. push(act) → Float32Array
// view (reused; copy if you keep it). Silent frames are not pushed (the
// detector never scores them), so the context spans across silence exactly
// as it does in the app.
export class Featurizer {
  constructor(nP) {
    this.nP = nP;
    this.dim = featureDim(nP);
    this.ring = [];                       // newest first, ≤ MODEL_CTX entries of { v: Float32Array(nP), logSum }
    this.out = new Float32Array(this.dim);
  }
  reset() { this.ring.length = 0; }
  push(act) {
    const nP = this.nP;
    let sum = 0; for (let i = 0; i < nP; i++) sum += act[i];
    const v = new Float32Array(nP);
    const lf = Math.log(LOG_FLOOR);
    if (sum > 0) for (let i = 0; i < nP; i++) v[i] = Math.log(act[i] / sum + LOG_FLOOR) - lf;
    this.ring.unshift({ v, logSum: Math.log(sum + SUM_EPS) });
    if (this.ring.length > MODEL_CTX) this.ring.length = MODEL_CTX;
    const out = this.out, r = this.ring, cur = r[0].logSum;
    for (let k = 0; k < MODEL_CTX; k++) {
      const e = r[Math.min(k, r.length - 1)];         // pad the past with the oldest frame we have
      out.set(e.v, k * nP);
      let d = e.logSum - cur; if (d > 6) d = 6; else if (d < -6) d = -6;
      out[MODEL_CTX * nP + k] = d;
    }
    return out;
  }
}

// MLP: standardise → W1·x + b1 → ReLU → W2·h + b2. Weights are flat row-major
// Float32Arrays; `classes` are pitch-class keys ("0,4,7") plus "none".
export class Model {
  constructor(json) {
    this.dim = json.dim; this.hidden = json.hidden; this.classes = json.classes;
    this.nC = this.classes.length;
    this.mean = Float32Array.from(json.mean); this.std = Float32Array.from(json.std);
    this.W1 = Float32Array.from(json.W1); this.b1 = Float32Array.from(json.b1);
    this.W2 = Float32Array.from(json.W2); this.b2 = Float32Array.from(json.b2);
    if (this.W1.length !== this.hidden * this.dim || this.W2.length !== this.nC * this.hidden) throw new Error('model: weight shapes do not match dim/hidden/classes');
    this.x = new Float32Array(this.dim); this.h = new Float32Array(this.hidden); this.logits = new Float32Array(this.nC);
    this.classIndex = new Map(this.classes.map((c, i) => [c, i]));
    this.noneIndex = this.classIndex.get(NONE);
    this.meta = json.meta || null;
  }
  // features (Float32Array(dim)) → logits (reused Float32Array(nC))
  forward(f) {
    const { dim, hidden, nC, x, h, logits, W1, b1, W2, b2, mean, std } = this;
    for (let i = 0; i < dim; i++) x[i] = (f[i] - mean[i]) / std[i];
    for (let j = 0; j < hidden; j++) {
      let s = b1[j]; const row = j * dim;
      for (let i = 0; i < dim; i++) s += W1[row + i] * x[i];
      h[j] = s > 0 ? s : 0;
    }
    for (let c = 0; c < nC; c++) {
      let s = b2[c]; const row = c * hidden;
      for (let j = 0; j < hidden; j++) s += W2[row + j] * h[j];
      logits[c] = s;
    }
    return logits;
  }
  // Class index for a template (by its pitch-class set), or -1 if the model
  // does not know that chord (then it can never be the verdict).
  classOf(template) { return this.classIndex.get(template.pcs.join(',')) ?? -1; }
}

// Restrict the logits to the candidate templates (+ none) and write the
// log-posterior of each template into `scores`, minus its prior (decoys,
// sus). Returns { scores, best, second, conf } in the shape scoreTemplates
// returns; conf = posterior of the winner among candidates and none.
export function scoreModel(model, logits, templates, scores, classIdx) {
  const n = templates.length;
  let mx = model.noneIndex >= 0 ? logits[model.noneIndex] : -Infinity;
  for (let i = 0; i < n; i++) { const c = classIdx[i]; if (c >= 0 && logits[c] > mx) mx = logits[c]; }
  let Z = model.noneIndex >= 0 ? Math.exp(logits[model.noneIndex] - mx) : 0;
  for (let i = 0; i < n; i++) { const c = classIdx[i]; if (c >= 0) Z += Math.exp(logits[c] - mx); }
  const logZ = Math.log(Z);
  let best = -1;
  for (let i = 0; i < n; i++) {
    const c = classIdx[i];
    scores[i] = c >= 0 ? logits[c] - mx - logZ - templates[i].prior : -1e9;
    if (best < 0 || scores[i] > scores[best]) best = i;
  }
  let second = -1;
  if (best >= 0) {
    const bm = templates[best].mask;
    for (let i = 0; i < n; i++) {
      if (i === best) continue;
      const m = templates[i].mask, both = m & bm;
      if (both === m || both === bm) continue;          // nested → not a real rival (as in scoreTemplates)
      if (second < 0 || scores[i] > scores[second]) second = i;
    }
  }
  // posterior of the winner, on the template scale (CONFIG.model.confPow, see config.js)
  const conf = best >= 0 ? Math.pow(Math.exp(scores[best] + templates[best].prior), CONFIG.model.confPow) : 0;
  return { scores, best, second, conf };
}

// Mixed scoring (CONFIG.detect.model = 'mix'): the templates decide whether to
// speak — their confidence is computed before mixing and kept — and the model
// breaks their ties: best = argmax(templateScore + beta · logPosterior).
// Mutates and returns the template result. Held-out GuitarSet players, beta
// 0.1: basic candidates 93.8 → 94.5%, all candidates 81.8 → 93.9%; on the
// player's own takes the verdict rate is exactly the templates' (no extra
// fires on TV noise, which the mixed scores would otherwise cause).
// Templates that are nested (Am ⊂ Am7, C ⊂ Cmaj7) or that are a sus chord and
// its same-root major/minor (A · Asus4 · Asus2) share the model term — the max
// log-posterior over the group — so the model never decides between a triad
// and its extension or its suspension: that stays with the templates' size
// bonus, the sus prior and the note evidence. The model has seen most 7ths
// and every sus chord only as synthetic clips: left alone it pulled
// GuitarSet minor7 recall from 42% to 13% and the synth-bench sus fire rate
// from 53% to 17%. What it keeps: root and family (C vs Am vs Em, E vs Em).
export function mixResult(tpl, mdl, beta, templates, conf) {
  const n = templates.length, scores = tpl.scores;
  const term = mixTerm(mdl.scores, templates);
  for (let i = 0; i < n; i++) scores[i] += beta * term[i];
  let best = -1;
  for (let i = 0; i < n; i++) if (best < 0 || scores[i] > scores[best]) best = i;
  let second = -1;
  if (best >= 0) {
    const bm = templates[best].mask;
    for (let i = 0; i < n; i++) {
      if (i === best) continue;
      const m = templates[i].mask, both = m & bm;
      if (both === m || both === bm) continue;
      if (second < 0 || scores[i] > scores[second]) second = i;
    }
  }
  tpl.best = best; tpl.second = second; tpl.conf = conf;
  return tpl;
}

// A sus chord: root and fifth with a 2nd or 4th and no third (Asus2, Dsus4, A7sus4 …).
const isSus = (t) => { const r = t.root, has = (d) => (t.mask >> ((r + d) % 12)) & 1; return r !== undefined && has(0) && has(7) && !has(3) && !has(4) && (has(2) || has(5)); };
// Per template: max over its group (itself, every template whose pitch-class
// set contains or is contained in its own, and — for a sus chord or a
// same-root major/minor triad — the other side of that pair) of the model
// log-posterior + prior, floored at −12. Cached on the template list.
function mixTerm(mscores, templates) {
  const n = templates.length;
  let nest = templates.mixNest;
  if (!nest || nest.length !== n) {
    nest = templates.mixNest = templates.map((t, i) => {
      const out = [], sus = isSus(t);
      for (let j = 0; j < n; j++) {
        const u = templates[j], both = t.mask & u.mask;
        if (both === t.mask || both === u.mask) { out.push(j); continue; }
        if (t.root !== undefined && t.root === u.root && t.pcs.length === 3 && u.pcs.length === 3 && (sus || isSus(u))) out.push(j);
      }
      return out;
    });
  }
  const term = templates.mixTermBuf && templates.mixTermBuf.length === n ? templates.mixTermBuf : (templates.mixTermBuf = new Float32Array(n));
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (const j of nest[i]) { const v = mscores[j] + templates[j].prior; if (v > m) m = v; }
    term[i] = Math.max(-12, m);
  }
  return term;
}

// Node: load from a path. Browser: main.js fetches the JSON and calls new Model().
export async function loadModelFile(path) {
  const fs = await import('node:fs');
  if (!fs.existsSync(path)) return null;
  return new Model(JSON.parse(fs.readFileSync(path, 'utf8')));
}

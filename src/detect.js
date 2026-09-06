// Real-time chord detector (v2).
//   frame (8192) → harmonic-dictionary NNLS pitch activations
//   → octave-weighted chroma → template score (see scoreTemplates)
//   → EMA + majority-of-N smoothing + RMS gate + min-hold
//
// Measured on GuitarSet room-mic recordings (open-voicing subset, frames
// with ≥3 strings ringing): 71% frame accuracy for the old chroma+cosine
// detector → 82% for the v2 scorer with 21 chords → 87% with the nine basic
// chords as candidates (practice mode scores only the chords you enabled
// plus those nine; every extra candidate is a chance to be wrong).
//
// Input-agnostic: caller connects any AudioNode via attach(); a
// FrameStream (src/audio/stream.js) feeds frames to the analyzers.

import { PitchAnalyzer, rms } from './dsp/analyzer.js';
import { captureFrom } from './audio/stream.js';

import { CONFIG } from './config.js';

const D = CONFIG.detect;
const FFT_SIZE = D.fftSize, HOP = D.hop;
// read live so ?cfg= overrides and tools/--cfg apply
const EPS = () => CONFIG.detect.eps;

// Practice matching (see CONFIG.stable): a chord fires when it is the smoothed
// verdict on ≥ frac of the frames in the last `win` seconds.
export class StableRule {
  constructor(winSec = CONFIG.stable.minHoldMs / 1000 * CONFIG.stable.win, frac = CONFIG.stable.frac) { this.win = winSec; this.frac = frac; this.q = []; this.lastFired = null; }
  reset() { this.q.length = 0; this.lastFired = null; }
  // feed one smoothed verdict (null = no verdict; silent = below the RMS gate); returns the id that fires, or null
  push(t, id, silent = false) {
    if (silent) { this.reset(); return null; }
    const q = this.q;
    q.push([t, id]);
    while (q.length && t - q[0][0] > this.win) q.shift();
    if (!id || id === this.lastFired || t - q[0][0] < this.win * 0.8) return null;
    let n = 0;
    for (const [, x] of q) if (x === id) n++;
    if (n < this.frac * q.length) return null;
    this.lastFired = id;
    return id;
  }
}

export const PC_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

// Pitch classes of a chord (sorted, unique). Chords with the same set are
// indistinguishable to the chroma scorer (G and G/B, C and C/E), so they
// share one template.
export function pitchClasses(chord) {
  return [...new Set(chord.notes.map(n => PC_INDEX[n]))].sort((a, b) => a - b);
}
export const pcKey = (chord) => pitchClasses(chord).join(',');
// true if every pitch class of `sub` is in `sup`
export function pcSubset(sub, sup) {
  const S = new Set(pitchClasses(sup));
  return pitchClasses(sub).every(pc => S.has(pc));
}

function mode(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { best = k; bestCount = c; }
  return { value: best, count: bestCount, total: arr.length };
}

// Templates for a chord list: one per distinct pitch-class set (G and G/B
// share one and report the first id in list order). Each template scores a
// chroma q as Σ w_pc·log(q_pc+ε) with w uniform on the chord tones. With a
// personal `profile` ({ chords: { id: { chroma: [12] } } }, learned from the
// player's own matched takes by tools/learn_profile.mjs) the weights become
// (1−alpha)·uniform + alpha·profile for chords that have one — the same
// scorer, tilted toward what this player's chord actually sounds like.
export function buildTemplates(chords, { profile = null, alpha = 0 } = {}) {
  const byKey = new Map();
  const eps = EPS();
  for (const c of chords) {
    const key = pcKey(c);
    const t = byKey.get(key);
    if (t) { t.ids.push(c.id); continue; }
    const pcs = pitchClasses(c);
    let mask = 0; for (const pc of pcs) mask |= 1 << pc;
    let w = null, perfect = Math.log(1 / pcs.length + eps);
    const p = alpha > 0 && profile?.chords?.[c.id]?.chroma;
    if (p) {
      w = new Float32Array(12);
      for (const pc of pcs) w[pc] += (1 - alpha) / pcs.length;
      for (let i = 0; i < 12; i++) w[i] += alpha * p[i];
      perfect = 0; for (let i = 0; i < 12; i++) if (w[i] > 0) perfect += w[i] * Math.log(w[i] + eps);   // score when q = w
    }
    byKey.set(key, { id: c.id, ids: [c.id], pcs, mask, w, prior: CONFIG.detect.prior[c.category] || 0, perfect });
  }
  return [...byKey.values()];
}

// Score every template against a chroma vector (sums to 1). Geometric mean of
// chroma on the template's classes (a missing note is catastrophic), minus
// LAM × mass outside the template, minus the template's prior. Writes into
// `out` if given; returns { scores, best, second } with template indices.
// `second` is the runner-up for the confidence margin and skips templates
// nested with the winner (C inside Cmaj7, Gadd9 around G): those differ by
// one note, so their scores are close by construction and would make every
// verdict look uncertain once the richer chords are candidates.
export function scoreTemplates(ch, templates, out = null) {
  const scores = out || new Array(templates.length);
  const eps = EPS(), lam = CONFIG.detect.lam;
  let best = -1;
  for (let i = 0; i < templates.length; i++) {
    const { pcs, prior, w } = templates[i];
    let s = 0, inside = 0;
    if (w) { for (let pc = 0; pc < 12; pc++) if (w[pc] > 0) s += w[pc] * Math.log(ch[pc] + eps); for (const pc of pcs) inside += ch[pc]; }
    else { for (const pc of pcs) { s += Math.log(ch[pc] + eps); inside += ch[pc]; } s /= pcs.length; }
    s = s - lam * (1 - inside) - prior;
    scores[i] = s;
    if (best < 0 || s > scores[best]) best = i;
  }
  let second = -1;
  if (best >= 0) {
    const bm = templates[best].mask;
    for (let i = 0; i < templates.length; i++) {
      if (i === best) continue;
      const m = templates[i].mask, both = m & bm;
      if (both === m || both === bm) continue;          // nested → not a real rival
      if (second < 0 || scores[i] > scores[second]) second = i;
    }
  }
  return { scores, best, second };
}

// Confidence in the winner (see CONFIG.confidence): part how well the chroma
// fits it, part how far the nearest non-nested rival is behind.
export const CONF = CONFIG.confidence;
export function confidenceOf({ scores, best, second }, templates) {
  const c = CONFIG.confidence, t = templates[best];
  const bestScore = scores[best] + t.prior;          // don't dock a sus chord for its own prior
  const secondScore = second >= 0 ? scores[second] : -Infinity;
  const fit = Math.max(0, Math.min(1, (bestScore - c.poor) / (t.perfect - c.poor)));
  const margin = Math.max(0, Math.min(1, (bestScore - secondScore) / c.margin));
  return c.fitWeight * fit + (1 - c.fitWeight) * margin;
}

export class ChordDetector {
  constructor({ audioContext, chords, profiles = null, profile = null }) {
    this.ctx = audioContext;
    this.chords = chords;
    this.profile = profile;        // personal chroma profile (CONFIG.profile), optional
    this.analyzer = new PitchAnalyzer({ sampleRate: audioContext.sampleRate, fftSize: FFT_SIZE, profiles });
    this.templates = [];
    this.setCandidates(null);
    this.smooth = new Float32Array(this.analyzer.nP);
    this.chroma = new Float32Array(12);
    this.history = [];
    this.stable = new StableRule();
    this.minHoldMs = CONFIG.stable.minHoldMs;
    this.sensitivity = 0.5;
    this.onUpdate = null;
    this.onStable = null;
    this.onFrame = null;           // ({ act, chroma, level, scores }) for visualisation
    this.onRun = null;             // ({ id, ts0, dur }) each time the smoothed verdict changes (telemetry)
    this.run = { id: null, ts0: 0 };
    this.running = false;
    this.capture = null;           // { node, stream, dispose }
    this.attached = null;
    this.extraConsumers = [];      // other analyzers sharing the stream (string tracker)
  }

  // Must be awaited once before attach(); loads the worklet.
  async init() {
    if (this.capture) return;
    this.capture = await captureFrom(this.ctx);
    this.capture.stream.addConsumer({ size: FFT_SIZE, hop: HOP, fn: (frame, t) => this._frame(frame, t) });
    for (const c of this.extraConsumers) this.capture.stream.addConsumer(c);
  }

  // Register another frame consumer ({ size, hop, fn }) on the shared stream.
  addConsumer(c) {
    this.extraConsumers.push(c);
    if (this.capture) this.capture.stream.addConsumer(c);
  }

  attach(sourceNode) {
    if (!this.capture) throw new Error('call init() first');
    if (this.attached) try { this.attached.disconnect(this.capture.node); } catch {}
    sourceNode.connect(this.capture.node);
    this.attached = sourceNode;
    this._reset();
  }

  detach() {
    if (this.attached && this.capture) try { this.attached.disconnect(this.capture.node); } catch {}
    this.attached = null;
    this._reset();
  }

  _reset() {
    this.history.length = 0;
    this.stable.reset();
    this.smooth.fill(0);
    if (this.capture) this.capture.stream.reset();
  }

  // Restrict scoring to these chord ids (null = every chord). Chords with
  // identical pitch-class sets collapse into one template that reports the
  // first id in chord-list order (and all of them via `ids` in callbacks —
  // Asus2/Esus4, Dsus2/Asus4, G/G/B are the same notes to a chroma detector).
  // Fewer candidates → fewer confusions: on GuitarSet the 9 basic chords alone
  // score 87% vs 73% for all 53.
  setCandidates(ids) {
    this.candidateIds = ids ? [...ids] : null;
    const want = ids ? new Set(ids) : null;
    this.templates = buildTemplates(want ? this.chords.filter(c => want.has(c.id)) : this.chords, { profile: this.profile, alpha: CONFIG.profile.alpha });
    this.templateOf = new Map(this.templates.map(t => [t.id, t]));
    this.scores = new Array(this.templates.length);
    if (this.history) this.history.length = 0;   // (constructor calls this before history exists)
    this.stable?.reset();
  }

  setSensitivity(v) { this.sensitivity = v; }
  setMinHold(ms) { this.minHoldMs = ms; this.stable.win = ms / 1000 * CONFIG.stable.win; }

  // Swap the personal profile (after relearning) and rebuild the templates.
  setProfile(profile) { this.profile = profile; this.setCandidates(this.candidateIds); }

  // Audio-stream clock (seconds since attach) — the clock recordings are cut on.
  streamTime() { return this.capture ? this.capture.stream.written / this.capture.stream.sr : 0; }

  // Every chord id that sounds the same as `id` (same pitch-class set).
  equivalents(id) { return this.templateOf.get(id)?.ids || [id]; }

  start({ onUpdate, onStable } = {}) {
    if (onUpdate !== undefined) this.onUpdate = onUpdate;
    if (onStable !== undefined) this.onStable = onStable;
    this.running = true;
  }
  stop() { this.running = false; }

  _frame(frame, t) {
    if (!this.running) return;
    const level = rms(frame);
    const { rmsGate: RMS_GATE, ema: EMA, smoothingLen: SMOOTHING_LEN } = CONFIG.detect;
    let peak = 0, clipped = 0;
    for (let i = 0; i < frame.length; i++) { const a = Math.abs(frame[i]); if (a > peak) peak = a; if (a > 0.985) clipped++; }
    const clip = clipped / frame.length;
    if (level < RMS_GATE) {
      this.history.length = 0;
      this.stable.push(t, null, true);
      if (this.run.id) { if (this.onRun) this.onRun({ id: this.run.id, ts0: +this.run.ts0.toFixed(3), dur: +(t - this.run.ts0).toFixed(3) }); this.run = { id: null, ts0: t }; }
      this._emitUpdate(null, 0, level);
      if (this.onFrame) this.onFrame({ act: null, chroma: null, level, peak, clip, scores: null, t, templates: this.templates });
      return;
    }
    const an = this.analyzer;
    const act = an.analyze(frame);
    for (let i = 0; i < an.nP; i++) this.smooth[i] = EMA * this.smooth[i] + (1 - EMA) * act[i];
    const ch = an.chroma(this.smooth, this.chroma);

    const result = scoreTemplates(ch, this.templates, this.scores);
    const { scores, best } = result;
    if (best < 0) return;
    const bestId = this.templates[best].id;
    const confidence = confidenceOf(result, this.templates);

    const rawId = confidence >= this.sensitivity ? bestId : null;
    this.history.push(rawId);
    if (this.history.length > SMOOTHING_LEN) this.history.shift();
    const m = mode(this.history);
    const smoothed = m.count >= Math.ceil(SMOOTHING_LEN * 0.6) ? m.value : null;

    if (smoothed !== this.run.id) {
      if (this.run.id && this.onRun) this.onRun({ id: this.run.id, ts0: +this.run.ts0.toFixed(3), dur: +(t - this.run.ts0).toFixed(3) });
      this.run = { id: smoothed, ts0: t };
    }
    this._emitUpdate(smoothed, confidence, level);
    if (this.onFrame) this.onFrame({ act: this.smooth, chroma: ch, level, peak, clip, scores, t, bestId, smoothed, confidence, templates: this.templates });

    const fired = this.stable.push(t, smoothed);
    if (fired && this.onStable) this.onStable(fired, confidence, this.equivalents(fired));
  }

  _emitUpdate(chordId, confidence, level) {
    if (this.onUpdate) this.onUpdate(chordId, confidence, level, chordId ? this.equivalents(chordId) : []);
  }
}

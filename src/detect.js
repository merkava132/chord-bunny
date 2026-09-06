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

const FFT_SIZE = 8192;
const HOP = 1024;
const SMOOTHING_LEN = 5;
const EMA = 0.5;
const RMS_GATE = 0.006;
const EPS = 0.1;
// Penalty on chroma mass outside the template. Without it a 4-note template
// (Cmaj7) can only beat its triad (C) when the 7th is as loud as the average
// chord tone, which one high string rarely is. On GuitarSet performed labels,
// basic+7th candidates: 7th recall 23% → 41%, maj7 10% → 27%, min7 15% → 28%,
// at a cost of 88% → 83% on plain triads. No effect when only triads compete.
const LAM = 0.5;
// Sus chords tie with majors whose 3rd is weak (G played with a single B, plus
// A leaking from D's 3rd partial). A small prior breaks those ties toward the
// major: basic 79% → 87% with basic+sus candidates, sus recall unchanged (15%).
const PRIOR = { sus: 0.15 };

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
// share one and report the first id in list order).
export function buildTemplates(chords) {
  const byKey = new Map();
  for (const c of chords) {
    const key = pcKey(c);
    const t = byKey.get(key);
    if (t) { t.ids.push(c.id); continue; }
    const pcs = pitchClasses(c);
    let mask = 0; for (const pc of pcs) mask |= 1 << pc;
    byKey.set(key, { id: c.id, ids: [c.id], pcs, mask, prior: PRIOR[c.category] || 0, perfect: Math.log(1 / pcs.length + EPS) });
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
  let best = -1;
  for (let i = 0; i < templates.length; i++) {
    const { pcs, prior } = templates[i];
    let s = 0, inside = 0;
    for (const pc of pcs) { s += Math.log(ch[pc] + EPS); inside += ch[pc]; }
    s = s / pcs.length - LAM * (1 - inside) - prior;
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

// Confidence in the winner: half how well the chroma fits it, half how far
// the nearest non-nested rival is behind. Tunables shared with
// tools/calibrate.mjs. margin 0.3 (was 0.5 with 21 chords): at the default
// threshold 0.35 the basic set gets a verdict on 79% of chord frames at 94%
// precision (was 69% / 95%), all 53 candidates 78% / 84% (was 68% / 86%).
export const CONF = { margin: 0.3, fitWeight: 0.5 };
export function confidenceOf({ scores, best, second }, templates) {
  const t = templates[best];
  const bestScore = scores[best] + t.prior;          // don't dock a sus chord for its own prior
  const secondScore = second >= 0 ? scores[second] : -Infinity;
  const fit = Math.max(0, Math.min(1, (bestScore + 1.9) / (t.perfect + 1.9)));
  const margin = Math.max(0, Math.min(1, (bestScore - secondScore) / CONF.margin));
  return CONF.fitWeight * fit + (1 - CONF.fitWeight) * margin;
}

export class ChordDetector {
  constructor({ audioContext, chords, profiles = null }) {
    this.ctx = audioContext;
    this.chords = chords;
    this.analyzer = new PitchAnalyzer({ sampleRate: audioContext.sampleRate, fftSize: FFT_SIZE, profiles });
    this.templates = [];
    this.setCandidates(null);
    this.smooth = new Float32Array(this.analyzer.nP);
    this.chroma = new Float32Array(12);
    this.history = [];
    this.lastStable = null;
    this.stableSince = 0;
    this.minHoldMs = 350;
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
    this.lastStable = null;
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
    const want = ids ? new Set(ids) : null;
    this.templates = buildTemplates(want ? this.chords.filter(c => want.has(c.id)) : this.chords);
    this.templateOf = new Map(this.templates.map(t => [t.id, t]));
    this.scores = new Array(this.templates.length);
    if (this.history) this.history.length = 0;   // (constructor calls this before history exists)
    this.lastStable = null;
  }

  setSensitivity(v) { this.sensitivity = v; }
  setMinHold(ms) { this.minHoldMs = ms; }

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
    let peak = 0, clipped = 0;
    for (let i = 0; i < frame.length; i++) { const a = Math.abs(frame[i]); if (a > peak) peak = a; if (a > 0.985) clipped++; }
    const clip = clipped / frame.length;
    if (level < RMS_GATE) {
      this.history.length = 0;
      this.lastStable = null;
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

    const now = performance.now();
    if (smoothed && smoothed === this.lastStable) {
      if (now - this.stableSince >= this.minHoldMs) {
        if (this.onStable) this.onStable(smoothed, confidence, this.equivalents(smoothed));
        this.stableSince = now + 1e9;
      }
    } else {
      this.lastStable = smoothed;
      this.stableSince = now;
    }
  }

  _emitUpdate(chordId, confidence, level) {
    if (this.onUpdate) this.onUpdate(chordId, confidence, level, chordId ? this.equivalents(chordId) : []);
  }
}

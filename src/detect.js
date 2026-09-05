// Real-time chord detector (v2).
//   frame (8192) → harmonic-dictionary NNLS pitch activations
//   → octave-weighted chroma → geometric-mean template score
//   → EMA + majority-of-N smoothing + RMS gate + min-hold
//
// Measured on GuitarSet room-mic recordings (open-voicing subset, frames
// with ≥3 strings ringing): 71% frame accuracy for the old chroma+cosine
// detector → 82% for this one (84% against the performed chord labels).
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

const PC_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

function mode(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { best = k; bestCount = c; }
  return { value: best, count: bestCount, total: arr.length };
}

export class ChordDetector {
  constructor({ audioContext, chords, profiles = null }) {
    this.ctx = audioContext;
    this.chords = chords;
    this.analyzer = new PitchAnalyzer({ sampleRate: audioContext.sampleRate, fftSize: FFT_SIZE, profiles });
    this.templates = chords.map(c => ({ id: c.id, pcs: [...new Set(c.notes.map(n => PC_INDEX[n]))] }));
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

  setSensitivity(v) { this.sensitivity = v; }
  setMinHold(ms) { this.minHoldMs = ms; }

  start({ onUpdate, onStable } = {}) {
    if (onUpdate !== undefined) this.onUpdate = onUpdate;
    if (onStable !== undefined) this.onStable = onStable;
    this.running = true;
  }
  stop() { this.running = false; }

  _frame(frame, t) {
    if (!this.running) return;
    const level = rms(frame);
    if (level < RMS_GATE) {
      this.history.length = 0;
      this.lastStable = null;
      this._emitUpdate(null, 0, level);
      if (this.onFrame) this.onFrame({ act: null, chroma: null, level, scores: null, t });
      return;
    }
    const an = this.analyzer;
    const act = an.analyze(frame);
    for (let i = 0; i < an.nP; i++) this.smooth[i] = EMA * this.smooth[i] + (1 - EMA) * act[i];
    const ch = an.chroma(this.smooth, this.chroma);

    let bestId = null, bestScore = -Infinity, secondScore = -Infinity;
    const scores = new Array(this.templates.length);
    for (let i = 0; i < this.templates.length; i++) {
      const { id, pcs } = this.templates[i];
      let s = 0;
      for (const pc of pcs) s += Math.log(ch[pc] + EPS);
      s /= pcs.length;
      scores[i] = s;
      if (s > bestScore) { secondScore = bestScore; bestScore = s; bestId = id; }
      else if (s > secondScore) secondScore = s;
    }
    // fit: −0.84 is a perfect triad (each of 3 classes at 1/3), ≈ −1.9 is poor
    const fit = Math.max(0, Math.min(1, (bestScore + 1.9) / 1.06));
    const margin = Math.max(0, Math.min(1, (bestScore - secondScore) / 0.5));
    const confidence = 0.5 * fit + 0.5 * margin;

    const rawId = confidence >= this.sensitivity ? bestId : null;
    this.history.push(rawId);
    if (this.history.length > SMOOTHING_LEN) this.history.shift();
    const m = mode(this.history);
    const smoothed = m.count >= Math.ceil(SMOOTHING_LEN * 0.6) ? m.value : null;

    this._emitUpdate(smoothed, confidence, level);
    if (this.onFrame) this.onFrame({ act: this.smooth, chroma: ch, level, scores, t, bestId, confidence });

    const now = performance.now();
    if (smoothed && smoothed === this.lastStable) {
      if (now - this.stableSince >= this.minHoldMs) {
        if (this.onStable) this.onStable(smoothed, confidence);
        this.stableSince = now + 1e9;
      }
    } else {
      this.lastStable = smoothed;
      this.stableSince = now;
    }
  }

  _emitUpdate(chordId, confidence, level) {
    if (this.onUpdate) this.onUpdate(chordId, confidence, level);
  }
}

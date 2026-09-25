// Calibration ("calibrate my chords"): the player strums each enabled chord a
// few times, then plucks each open string, while the app knows for certain
// what is being played. Practice-mode labels are only as good as the guess
// "the player was playing the target"; these intervals are ground truth,
// including for chords the detector keeps missing, and the open-string plucks
// give per-string partial profiles (the confusions Em→E, Am→A, C→Em are
// fifth-harmonic leakage). Each captured step becomes a telemetry `enroll`
// event with the stream-time range (tools/learn_profile.mjs reads them);
// detection itself is untouched here.
//
// Pure state machine — practice.js does the DOM and feeds onset times.

export const ENROLL = {
  strums: 4,          // strums per chord
  plucks: 2,          // plucks per open string
  minGapSec: 0.35,    // closer onsets are one strum (double triggers, rakes)
  settleSec: 1.5,     // after the last onset, let it ring before capturing
  preRollSec: 0.3,    // captured range starts this much before the first onset
};

// Open strings, low to high; `string` is the tracker's index (0 = low E).
export const OPEN_STRINGS = [
  { string: 0, name: 'low E', note: 'E' }, { string: 1, name: 'A', note: 'A' }, { string: 2, name: 'D', note: 'D' },
  { string: 3, name: 'G', note: 'G' }, { string: 4, name: 'B', note: 'B' }, { string: 5, name: 'high e', note: 'E' },
];

// A pseudo-chord for the diagram: one open string, the rest muted.
export function openStringChord(s) {
  const o = OPEN_STRINGS[s];
  return { id: `open-${s}`, name: o.name, fullName: `open ${o.name} string`, category: 'string', notes: [o.note],
    fingering: { frets: OPEN_STRINGS.map(x => x.string === s ? 0 : -1), fingers: [], baseFret: 1 } };
}

// Steps: { kind: 'chord', chord, need } then { kind: 'string', string, name, chord (pseudo), need }.
export function buildSteps(chords, { strings = true, opts = ENROLL } = {}) {
  const steps = chords.map(chord => ({ kind: 'chord', chord, need: opts.strums }));
  if (strings) for (const o of OPEN_STRINGS) steps.push({ kind: 'string', string: o.string, name: o.name, chord: openStringChord(o.string), need: opts.plucks });
  return steps;
}

export class Enrollment {
  // Callbacks:
  //   onShow(step, index, total)               a step is up
  //   onProgress(step, count, need)            an onset counted (also 0 on show)
  //   onCapture({ step, ts0, ts1, count })     the step's interval, after the settle wait
  //   onDone({ chords, strings })              finished or stopped; how many of each were captured
  // now(): the audio-stream clock (what recordings are cut on); schedule(fn, ms) for tests.
  constructor({ steps, now, onShow, onProgress, onCapture, onDone, schedule = (fn, ms) => setTimeout(fn, ms), opts = ENROLL }) {
    this.steps = steps;
    this.now = now;
    this.onShow = onShow; this.onProgress = onProgress; this.onCapture = onCapture; this.onDone = onDone;
    this.schedule = schedule;
    this.o = opts;
    this.active = false;
    this.i = -1;
    this.step = null;
    this.onsets = [];
    this.settling = false;
    this.captured = { chords: 0, strings: 0 };
    this.gen = 0;          // invalidates a scheduled capture after skip/stop
  }

  start() {
    if (this.active) return;
    this.active = true; this.i = -1; this.captured = { chords: 0, strings: 0 };
    this._next();
  }

  // An onset (strum or pluck) at stream time ts — the caller filters clicks.
  onset(ts) {
    if (!this.active || this.settling) return;
    const last = this.onsets[this.onsets.length - 1];
    if (last !== undefined && ts - last < this.o.minGapSec) return;
    this.onsets.push(ts);
    this.onProgress?.(this.step, this.onsets.length, this.step.need);
    if (this.onsets.length < this.step.need) return;
    this.settling = true;
    const gen = this.gen;
    this.schedule(() => { if (this.active && gen === this.gen) this._capture(); }, this.o.settleSec * 1000);
  }

  skip() { if (this.active) this._next(); }
  stop() { if (this.active) this._finish(); }
  // end without callbacks (mode switch)
  abort() { this.active = false; this.gen++; }

  _capture() {
    const ts1 = this.now();
    this.onCapture?.({ step: this.step, ts0: this.onsets[0] - this.o.preRollSec, ts1, count: this.onsets.length });
    this.captured[this.step.kind === 'chord' ? 'chords' : 'strings']++;
    this._next();
  }

  _next() {
    this.gen++;
    this.i++;
    if (this.i >= this.steps.length) return this._finish();
    this.step = this.steps[this.i];
    this.onsets = [];
    this.settling = false;
    this.onShow?.(this.step, this.i, this.steps.length);
    this.onProgress?.(this.step, 0, this.step.need);
  }

  _finish() {
    this.active = false; this.gen++;
    this.onDone?.({ ...this.captured });
  }
}

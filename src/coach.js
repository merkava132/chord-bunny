// Practice coach: turns what the detector and the string tracker measured
// into one short hint about the chord you are holding. Table-driven so a rule
// is a few lines; pure `evaluate()` for tests and tools/coach_replay.mjs,
// stateful `Coach` for the page.
//
// What it can and can't know (see README "what it can't do"): a mono mic
// can't separate two strings an octave apart, so string-level rules only
// speak about strings whose note is unique in the shape; pitch-class rules
// (a stray open-string note) work regardless, but when the same open note
// could come from two strings they name both.

import { CONFIG } from './config.js';
import { pitchClasses, PC_INDEX } from './detect.js';

const NAMES = ['low E', 'A', 'D', 'G', 'B', 'high e'];
const OPEN_PC = [4, 9, 2, 7, 11, 4];          // E A D G B E
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FINGER = { 1: 'index', 2: 'middle', 3: 'ring', 4: 'pinky' };

// --- helpers over the window ---------------------------------------------
function meanChroma(frames) {
  const m = new Float64Array(12);
  let n = 0;
  for (const f of frames) { if (!f.chroma) continue; n++; for (let i = 0; i < 12; i++) m[i] += f.chroma[i]; }
  if (n) for (let i = 0; i < 12; i++) m[i] /= n;
  return { m, n };
}
const span = (frames) => (frames.length ? frames[frames.length - 1].t - frames[0].t : 0);

// Which strings of the shape carry each pitch class, and which are unique.
export function shapeInfo(chord) {
  const frets = chord.fingering.frets, fingers = chord.fingering.fingers || [];
  const TUNING = [40, 45, 50, 55, 59, 64];
  const pcOf = frets.map((f, s) => (f < 0 ? -1 : (TUNING[s] + f) % 12));
  const count = new Map();
  for (const pc of pcOf) if (pc >= 0) count.set(pc, (count.get(pc) || 0) + 1);
  return { frets, fingers, pcOf, unique: pcOf.map(pc => pc >= 0 && count.get(pc) === 1), pcs: new Set(pitchClasses(chord)) };
}

// --- rules, in priority order ---------------------------------------------
// each: { kind, when(ctx) → text | null }
// ctx: { target, frames: [{chroma, level, peak, clip, best, smoothed, conf}],
//        strums: [{strings: [{string, muted, doubled, inferred}]}], shape, C }
export const RULES = [
  {
    kind: 'clipping',
    when: ({ frames, C }) => {
      const n = frames.filter(f => f.clip > 0.002).length;
      return span(frames) >= C.minSpanSec && n / frames.length >= C.clipFrac ? 'input is clipping — lower the mic gain' : null;
    },
  },
  {
    kind: 'quiet',        // strums are happening but almost nothing clears the level gate
    when: ({ frames, strums, C }) => (strums.length >= C.quietStrums && span(frames) < C.quietSpanSec ? 'very quiet — move the mic closer or raise the gain' : null),
  },
  {
    kind: 'other-chord',   // never shown: it only stops the string rules when you're plainly playing something else
    silent: true,
    when: ({ frames, target, C }) => {
      const ids = frames.map(f => f.smoothed).filter(Boolean);
      if (!ids.length) return null;
      const cnt = new Map(); for (const id of ids) cnt.set(id, (cnt.get(id) || 0) + 1);
      const [top, n] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
      return top !== target.id && n / ids.length >= C.otherChord ? top : null;
    },
  },
  {
    kind: 'muted-hit',
    when: ({ strums, shape, C }) => {
      if (strums.length < 2) return null;
      const hits = new Map();
      for (const st of strums) for (const x of st.strings) if (x.muted && !x.inferred && shape.frets[x.string] < 0) hits.set(x.string, (hits.get(x.string) || 0) + 1);
      const bad = [...hits.entries()].filter(([, n]) => n / strums.length >= C.mutedHitFrac).map(([s]) => s).sort();
      if (!bad.length) return null;
      const first = shape.frets.findIndex(f => f >= 0);
      return `you're hitting the ${bad.map(s => NAMES[s]).join(' and ')} string${bad.length > 1 ? 's' : ''} — ${bad.length > 1 ? "they're" : "it's"} muted in this shape; start the strum on the ${NAMES[first]} string`;
    },
  },
  {
    kind: 'open-string',
    when: ({ frames, shape, C, other, lookup }) => {
      const { m } = meanChroma(frames);
      if (span(frames) < C.minSpanSec) return null;
      let inChord = 0; for (const pc of shape.pcs) inChord += m[pc];
      if (inChord < C.chordPresent) return null;
      let bestPc = -1, best = C.strayMin;
      for (let pc = 0; pc < 12; pc++) if (!shape.pcs.has(pc) && m[pc] >= best) { best = m[pc]; bestPc = pc; }
      if (bestPc < 0) return null;
      // if the verdict is mostly another chord, only speak when that chord is
      // explained by the target plus this stray note (G + open E = Em)
      if (other) {
        const o = lookup?.(other);
        if (!o || !pitchClasses(o).every(pc => shape.pcs.has(pc) || pc === bestPc)) return null;
      }
      // which open string could that be? only ones that are fretted or muted in the shape
      const strings = OPEN_PC.map((pc, s) => (pc === bestPc && shape.frets[s] !== 0 ? s : -1)).filter(s => s >= 0);
      if (!strings.length) return null;
      const muted = strings.filter(s => shape.frets[s] < 0), fretted = strings.filter(s => shape.frets[s] > 0);
      if (fretted.length === 1 && !muted.length) {
        const s = fretted[0], fg = FINGER[shape.fingers[s]];
        return `hearing an open ${NAMES[s]} string — ${fg ? `check the ${fg} finger on it` : 'is it fretted?'}`;
      }
      if (fretted.length === 2) return `hearing an open ${NOTE[bestPc]} — the ${NAMES[fretted[0]]} or ${NAMES[fretted[1]]} string isn't fretted`;
      if (muted.length && !fretted.length) return `hearing the open ${NAMES[muted[0]]} string — it's muted in this shape, start the strum lower`;
      return `hearing an open ${NOTE[bestPc]} — the ${strings.map(s => NAMES[s]).join(' or ')} string`;
    },
  },
  {
    kind: 'missing-string',
    when: ({ frames, strums, shape, C, other }) => {
      if (strums.length < 2 || other) return null;
      const { m } = meanChroma(frames);
      if (span(frames) < C.minSpanSec) return null;
      for (let s = 5; s >= 0; s--) {                                // top string first: that's where thirds live
        if (shape.frets[s] < 0 || !shape.unique[s]) continue;
        const pc = shape.pcOf[s];
        if (m[pc] >= C.missingChroma) continue;
        const notStruck = strums.filter(st => !st.strings.some(x => x.string === s && !x.inferred)).length;
        if (notStruck / strums.length >= C.missingFrac) return `the ${NAMES[s]} string isn't ringing — that's where the ${NOTE[pc]} is`;
      }
      return null;
    },
  },
];

// Pure evaluation: the first rule that speaks wins. Returns {kind, text} or null.
// `lookup(id)` → chord object, used to reason about the chord the detector
// hears instead of the target.
export function evaluate({ target, frames, strums, lookup = null }, C = CONFIG.coach) {
  if (!target) return null;
  const shape = shapeInfo(target);
  const ctx = { target, frames, strums, shape, C, lookup, other: null };
  for (const rule of RULES) {
    const r = rule.when(ctx);
    if (!r) continue;
    if (rule.silent) { ctx.other = r; continue; }
    return { kind: rule.kind, text: r };
  }
  return null;
}

// Stateful wrapper for the page: keeps the recent window, rate-limits, and
// tells `onHint` when the shown hint changes. Time is injected (seconds) so
// tools can replay a session.
export class Coach {
  constructor({ onHint = null, chords = [], C = CONFIG.coach } = {}) {
    this.C = C;
    this.onHint = onHint;
    const byId = new Map(chords.map(c => [c.id, c]));
    this.lookup = (id) => byId.get(id);
    this.frames = [];       // [{t, ...}]
    this.strums = [];
    this.target = null;
    this.shownAt = 0;
    this.matched = false;
    this.hint = null;       // { kind, text, since }
    this.lastByKind = new Map();
  }
  setTarget(chord, t) {
    this.target = chord; this.shownAt = t; this.matched = false;
    this.frames.length = 0; this.strums.length = 0;
    this._show(null, t);
  }
  setMatched(t) { this.matched = true; this._show(null, t); }
  pushFrame(f, t) {
    if (f.level < CONFIG.detect.rmsGate) return;
    this.frames.push({ t, chroma: f.chroma ? Float32Array.from(f.chroma) : null, level: f.level, peak: f.peak, clip: f.clip, best: f.best ?? f.bestId ?? null, smoothed: f.smoothed ?? f.id ?? null, conf: f.conf ?? f.confidence ?? 0 });
    this._trim(t);
  }
  pushStrum(ev, t) {
    let peak = 0; for (const x of ev.strings) if (x.peak > peak) peak = x.peak;
    if (peak < this.C.strumPeakMin) return;               // handling noise, keyboard clicks
    this.strums.push({ t, strings: ev.strings }); this._trim(t);
  }
  _trim(t) {
    const w = this.C.windowSec;
    while (this.frames.length && t - this.frames[0].t > w) this.frames.shift();
    while (this.strums.length && t - this.strums[0].t > w) this.strums.shift();
  }
  // call regularly; returns the hint currently shown (or null)
  tick(t) {
    const C = this.C;
    if (this.hint && t - this.hint.since < C.holdSec) return this.hint;
    if (!this.target || this.matched || t - this.shownAt < C.afterSec) { this._show(null, t); return null; }
    const h = evaluate({ target: this.target, frames: this.frames, strums: this.strums, lookup: this.lookup }, C);
    if (!h) { this._show(null, t); return null; }
    if (this.hint && this.hint.kind === h.kind) { this.hint.text = h.text; return this.hint; }
    const last = this.lastByKind.get(h.kind);
    if (last !== undefined && t - last < (C.repeatSecByKind?.[h.kind] ?? C.repeatSec)) { this._show(null, t); return null; }
    this._show(h, t);
    return this.hint;
  }
  _show(h, t) {
    if (!h && !this.hint) return;
    if (h && this.hint && h.kind === this.hint.kind && h.text === this.hint.text) return;
    if (this.hint) this.lastByKind.set(this.hint.kind, t);
    this.hint = h ? { ...h, since: t } : null;
    if (this.onHint) this.onHint(this.hint, t);
  }
}

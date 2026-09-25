// Tempo practice: a metronome grid and the BPM creep. Pure and clock-agnostic
// so node:test drives them with a fake clock; practice.js owns the DOM, the
// WebAudio clicks and the pair advancing.
//
// Metronome — beats on a grid from start(t0), the first bar(s) a count-in
// (bar < 0). Two hand-out methods, each returning every beat exactly once:
//   pending(now)  beats due before now + lookahead → schedule their clicks at
//                 exact audio times (the lookahead pattern: a late timer
//                 never moves the grid)
//   landed(now)   beats whose time has passed → light the dot, end the bar
// setBpm() keeps the next beat where it is and changes the spacing after it.
//
// Creep — record(clean) per bar: after `cleanRun` clean bars in a row the
// tempo goes up `up`, after `missRun` missed bars it comes down `down`;
// unscored bars (null, mic off) keep the streaks. apply() clamps to
// [minBpm, maxBpm]. history keeps the last `historyBars` results for the strip.

import { CONFIG } from './config.js';

export class Metronome {
  constructor({ bpm, beatsPerBar, countInBars = CONFIG.tempo.countInBars, lookahead = CONFIG.tempo.lookaheadSec }) {
    this.bpm = bpm;
    this.beatsPerBar = beatsPerBar;
    this.countInBars = countInBars;
    this.lookahead = lookahead;
    this.running = false;
    this.beats = [];        // generated grid, oldest first (trimmed as beats land)
    this.nextTime = 0;      // time of the next beat to generate
    this.nextIndex = 0;
    this.scheduledN = 0;    // beats handed out by pending()
    this.landedN = 0;       // beats handed out by landed()
  }

  get interval() { return 60 / this.bpm; }

  start(t0) {
    this.running = true;
    this.beats.length = 0;
    this.nextTime = t0; this.nextIndex = 0;
    this.scheduledN = 0; this.landedN = 0;
  }
  stop() { this.running = false; }
  setBpm(bpm) { this.bpm = bpm; }

  _extend(until, inclusive = false) {
    while (inclusive ? this.nextTime <= until : this.nextTime < until) {
      const i = this.nextIndex, n = this.beatsPerBar, bar = Math.floor(i / n) - this.countInBars;
      this.beats.push({ index: i, time: this.nextTime, beat: i % n, bar, countIn: bar < 0 });
      this.nextIndex++;
      this.nextTime += this.interval;
    }
  }

  pending(now) {
    if (!this.running) return [];
    this._extend(now + this.lookahead);
    const out = this.beats.slice(this.scheduledN);
    this.scheduledN = this.beats.length;
    return out;
  }

  landed(now) {
    if (!this.running) return [];
    this._extend(now, true);
    const out = [];
    while (this.landedN < this.beats.length && this.beats[this.landedN].time <= now) out.push(this.beats[this.landedN++]);
    if (this.landedN > 32) {   // trim what both methods are done with
      const drop = Math.min(this.landedN, this.scheduledN);
      this.beats.splice(0, drop); this.landedN -= drop; this.scheduledN -= drop;
    }
    return out;
  }
}

export class Creep {
  constructor(opts = CONFIG.tempo.creep, { minBpm = CONFIG.tempo.minBpm, maxBpm = CONFIG.tempo.maxBpm, historyBars = CONFIG.tempo.historyBars } = {}) {
    this.o = opts;
    this.minBpm = minBpm; this.maxBpm = maxBpm; this.historyBars = historyBars;
    this.history = [];      // last results: true (clean) / false (missed) / null (unscored)
    this.cleanRun = 0; this.missRun = 0;
  }
  resetRuns() { this.cleanRun = 0; this.missRun = 0; }
  // one bar's result → the bpm delta to apply (0 for none)
  record(clean) {
    this.history.push(clean);
    if (this.history.length > this.historyBars) this.history.shift();
    if (clean === null) return 0;
    if (clean) {
      this.missRun = 0;
      if (++this.cleanRun >= this.o.cleanRun) { this.cleanRun = 0; return this.o.up; }
    } else {
      this.cleanRun = 0;
      if (++this.missRun >= this.o.missRun) { this.missRun = 0; return -this.o.down; }
    }
    return 0;
  }
  apply(bpm, delta) { return Math.max(this.minBpm, Math.min(this.maxBpm, bpm + delta)); }
}

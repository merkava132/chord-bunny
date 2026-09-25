// Tempo mode: the metronome grid with a fake clock, and the BPM creep.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Metronome, Creep } from '../src/tempo.js';
import { CONFIG } from '../src/config.js';

const times = (beats) => beats.map(b => +b.time.toFixed(3));

describe('Metronome', () => {
  it('lays a grid from t0 at 60/bpm, one count-in bar (bar -1) before bar 0', () => {
    const m = new Metronome({ bpm: 120, beatsPerBar: 4, lookahead: 0.1 });
    m.start(10);
    const b = m.pending(13);   // everything before 13.1
    assert.deepEqual(times(b), [10, 10.5, 11, 11.5, 12, 12.5, 13]);
    assert.deepEqual(b.map(x => [x.beat, x.bar, x.countIn]), [[0, -1, true], [1, -1, true], [2, -1, true], [3, -1, true], [0, 0, false], [1, 0, false], [2, 0, false]]);
  });

  it('pending hands each beat out once (lookahead ahead of now, and anything landed() generated first); landed once its time has passed', () => {
    const m = new Metronome({ bpm: 120, beatsPerBar: 4, lookahead: 0.1 });
    m.start(10);
    assert.deepEqual(times(m.pending(10.45)), [10, 10.5]);    // 10.5 < 10.55
    assert.deepEqual(times(m.pending(10.45)), []);
    assert.deepEqual(times(m.pending(10.85)), []);            // 11 is not < 10.95
    assert.deepEqual(times(m.pending(10.95)), [11]);
    assert.deepEqual(times(m.landed(10.49)), [10]);
    assert.deepEqual(times(m.landed(10.5)), [10.5]);
    assert.deepEqual(times(m.landed(10.5)), []);
    assert.deepEqual(times(m.landed(12)), [11, 11.5, 12]);    // landed generates the grid too …
    assert.deepEqual(times(m.pending(12)), [11.5, 12]);       // … and pending still hands those out once (too late to click, counters stay aligned)
    assert.deepEqual(times(m.pending(12.45)), [12.5]);
    // the app's interleaving: pending before landed on every tick → every beat is scheduled before it lands
    const m2 = new Metronome({ bpm: 120, beatsPerBar: 4, lookahead: 0.1 });
    m2.start(0);
    for (let t = 0; t <= 4; t += 0.025) { for (const b of m2.pending(t)) assert.ok(b.time >= t - 1e-9, `beat ${b.time} scheduled late at ${t}`); m2.landed(t); }
  });

  it('setBpm keeps the next beat and changes the spacing after it', () => {
    const m = new Metronome({ bpm: 60, beatsPerBar: 4, lookahead: 0.1 });
    m.start(0);
    assert.deepEqual(times(m.pending(1.5)), [0, 1]);          // next generated beat is at 2
    m.setBpm(120);
    assert.deepEqual(times(m.pending(3.5)), [2, 2.5, 3, 3.5]);
  });

  it('stopped: nothing is handed out; trimming keeps the counters consistent', () => {
    const m = new Metronome({ bpm: 240, beatsPerBar: 2, lookahead: 0.1 });
    m.start(0);
    let n = 0;
    for (let t = 0; t < 30; t += 0.05) { m.pending(t); n += m.landed(t).length; }
    assert.equal(n, 120);   // 4 beats/s × 30 s (beat at 0 included, 30 excluded)
    assert.ok(m.beats.length < 64, 'trimmed');
    m.stop();
    assert.deepEqual(m.pending(40), []);
    assert.deepEqual(m.landed(40), []);
  });
});

describe('Creep', () => {
  const opts = { up: 2, down: 2, cleanRun: 4, missRun: 2 };
  it('goes up after 4 clean bars in a row, down after 2 missed, and the run restarts', () => {
    const c = new Creep(opts);
    assert.deepEqual([true, true, true].map(x => c.record(x)), [0, 0, 0]);
    assert.equal(c.record(true), 2);
    assert.deepEqual([true, true, true].map(x => c.record(x)), [0, 0, 0]);   // a new run of 4 is needed
    assert.equal(c.record(false), 0);
    assert.equal(c.record(false), -2);
    assert.equal(c.record(false), 0);
    assert.equal(c.record(false), -2);
  });
  it('a miss resets the clean run; unscored bars do not touch the runs but show in the history', () => {
    const c = new Creep(opts, { historyBars: 8 });
    c.record(true); c.record(true); c.record(true);
    assert.equal(c.record(null), 0);
    assert.equal(c.record(true), 2, 'the null bar did not break the run');
    c.record(true); c.record(true); c.record(false);
    assert.deepEqual([true, true, true].map(x => c.record(x)), [0, 0, 0], 'the miss reset the run');
    assert.deepEqual(c.history, [null, true, true, true, false, true, true, true], 'last 8 results, unscored included');
  });
  it('apply clamps to the configured range', () => {
    const c = new Creep(opts, { minBpm: 40, maxBpm: 200 });
    assert.equal(c.apply(199, 2), 200);
    assert.equal(c.apply(41, -2), 40);
    assert.equal(c.apply(78, 2), 80);
  });
  it('defaults come from CONFIG.tempo', () => {
    const c = new Creep();
    assert.equal(c.o, CONFIG.tempo.creep);
    assert.equal(c.minBpm, CONFIG.tempo.minBpm);
    assert.equal(c.historyBars, CONFIG.tempo.historyBars);
  });
});

// Enrollment: steps, onset counting, settle wait, skip/stop.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Enrollment, ENROLL, buildSteps, openStringChord, OPEN_STRINGS, OnsetDetector } from '../src/enroll.js';

const CH = [{ id: 'G', name: 'G' }, { id: 'C', name: 'C' }];

function make(over = {}) {
  const log = [];
  let t = 10;
  const timers = [];
  const e = new Enrollment({
    steps: buildSteps(CH, { strings: over.strings ?? false }),
    now: () => t,
    schedule: (fn, ms) => timers.push({ fn, ms }),
    onShow: (s, i, n) => log.push(['show', s.kind, s.kind === 'chord' ? s.chord.id : s.string, i, n]),
    onProgress: (s, k, need) => log.push(['progress', k, need]),
    onCapture: (x) => log.push(['capture', x.step.kind, x.step.kind === 'chord' ? x.step.chord.id : x.step.string, +x.ts0.toFixed(2), +x.ts1.toFixed(2), x.count]),
    onDone: (n) => log.push(['done', n.chords, n.strings]),
  });
  return { e, log, timers, setT: (v) => { t = v; } };
}

describe('buildSteps / openStringChord', () => {
  it('chords first (4 strums each), then the six open strings low to high (2 plucks each)', () => {
    const steps = buildSteps(CH);
    assert.equal(steps.length, 8);
    assert.deepEqual(steps.slice(0, 2).map(s => [s.kind, s.chord.id, s.need]), [['chord', 'G', ENROLL.strums], ['chord', 'C', ENROLL.strums]]);
    assert.deepEqual(steps.slice(2).map(s => [s.kind, s.string, s.need]), OPEN_STRINGS.map(o => ['string', o.string, ENROLL.plucks]));
    assert.deepEqual(steps.slice(2).map(s => s.name), ['low E', 'A', 'D', 'G', 'B', 'high e']);
  });
  it('an open-string pseudo-chord has one open string and five muted, for the diagram and the tracker', () => {
    const c = openStringChord(4);
    assert.deepEqual(c.fingering.frets, [-1, -1, -1, -1, 0, -1]);
    assert.equal(c.name, 'B');
    assert.match(c.fullName, /open B string/);
  });
});

describe('Enrollment', () => {
  it('shows the first step on start with a zero count', () => {
    const { e, log } = make();
    e.start();
    assert.deepEqual(log, [['show', 'chord', 'G', 0, 2], ['progress', 0, ENROLL.strums]]);
  });

  it('counts spaced onsets, waits settleSec after the last one, captures the range from 0.3 s before the first', () => {
    const { e, log, timers, setT } = make();
    e.start(); log.length = 0;
    for (const ts of [20, 21, 22, 23]) e.onset(ts);
    assert.deepEqual(log.map(x => x[1]), [1, 2, 3, 4]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, ENROLL.settleSec * 1000);
    e.onset(23.5);                                      // while settling: ignored
    assert.equal(log.length, 4);
    setT(24.5); timers[0].fn();
    assert.deepEqual(log[4], ['capture', 'chord', 'G', +(20 - ENROLL.preRollSec).toFixed(2), 24.5, 4]);
    assert.deepEqual(log[5], ['show', 'chord', 'C', 1, 2]);
  });

  it('merges onsets closer than minGapSec', () => {
    const { e, log } = make();
    e.start(); log.length = 0;
    e.onset(20); e.onset(20.1); e.onset(20.2);
    assert.deepEqual(log, [['progress', 1, ENROLL.strums]]);
    e.onset(20.5);
    assert.equal(log.length, 2);
  });

  it('skip moves on without a capture; a pending capture is dropped', () => {
    const { e, log, timers, setT } = make();
    e.start();
    for (const ts of [20, 21, 22, 23]) e.onset(ts);
    e.skip();                                           // before the settle timer fires
    setT(24.5); timers[0].fn();                         // stale timer: no capture
    assert.ok(!log.some(x => x[0] === 'capture'));
    assert.deepEqual(log.filter(x => x[0] === 'show').map(x => x[2]), ['G', 'C']);
  });

  it('open strings need two plucks; the count reports chords and strings separately', () => {
    const { e, log, timers, setT } = make({ strings: true });
    e.start();
    e.skip(); e.skip();                                 // past both chords
    assert.deepEqual(log[log.length - 2], ['show', 'string', 0, 2, 8]);
    assert.deepEqual(log[log.length - 1], ['progress', 0, ENROLL.plucks]);
    e.onset(30); e.onset(31);
    setT(32.5); timers[0].fn();
    assert.deepEqual(log[log.length - 3], ['capture', 'string', 0, 29.7, 32.5, 2]);
    assert.deepEqual(log[log.length - 2], ['show', 'string', 1, 3, 8]);
    e.stop();
    assert.deepEqual(log[log.length - 1], ['done', 0, 1]);
  });

  it('finishes after the last step and reports how many were captured', () => {
    const { e, log, timers, setT } = make();
    e.start();
    for (const ts of [20, 21, 22, 23]) e.onset(ts);
    setT(25); timers[0].fn();
    e.skip();
    assert.deepEqual(log[log.length - 1], ['done', 1, 0]);
    assert.equal(e.active, false);
    e.onset(30);                                        // inert once done
    assert.deepEqual(log[log.length - 1], ['done', 1, 0]);
  });

  it('stop ends early with the count so far; abort ends silently', () => {
    const a = make(); a.e.start(); a.e.stop();
    assert.deepEqual(a.log[a.log.length - 1], ['done', 0, 0]);
    const b = make(); b.e.start(); b.log.length = 0; b.e.abort();
    assert.deepEqual(b.log, []);
    assert.equal(b.e.active, false);
  });
});

describe('OnsetDetector (energy onsets from frame levels)', () => {
  const HOP = 1024 / 48000;
  // feed a level envelope: array of [seconds, level] segments, linearly interpolated per frame
  const run = (env, det = new OnsetDetector()) => {
    const out = []; let t = 0;
    for (let i = 0; i < env.length - 1; i++) {
      const [d, a] = env[i], [, b] = env[i + 1];
      for (let k = 0; k * HOP < d; k++, t += HOP) if (det.push(t, a + (b - a) * (k * HOP / d))) out.push(+t.toFixed(2));
    }
    return out;
  };
  it('a strum (fast rise from the floor, slow decay) is one onset', () => {
    assert.deepEqual(run([[0.5, 0.005], [0.1, 0.005], [0.15, 0.05], [1.5, 0.05], [0.5, 0.006], [0.1, 0.006]]).length, 1);
  });
  it('four ringing strums count four times, a double-trigger inside minGapSec does not', () => {
    // each entry is [seconds, level at its start], ramping to the next entry's level:
    // 0.1 s rise to 0.05, 0.15 s hold, 0.9 s decay to 0.01, then the next rise
    const env = [[0.5, 0.005], [0.1, 0.005]];
    for (let i = 0; i < 3; i++) env.push([0.15, 0.05], [0.9, 0.05], [0.1, 0.01]);
    env.push([0.15, 0.05], [0.05, 0.05], [0.5, 0.08], [0.1, 0.006]);   // 4th strum, then a rake to 0.08 only 0.2 s after it
    assert.equal(run(env).length, 4);
  });
  it('a chord still ringing does not re-trigger; a louder new strum on top of it does', () => {
    assert.equal(run([[0.5, 0.005], [0.1, 0.005], [0.15, 0.05], [2, 0.05], [1, 0.03], [0.1, 0.03]]).length, 1);   // slow decay only
    assert.equal(run([[0.5, 0.005], [0.1, 0.005], [0.15, 0.05], [1, 0.02], [0.1, 0.02], [0.15, 0.06], [1, 0.06], [0.1, 0.01]]).length, 2);
  });
  it('handling noise below the absolute floor never counts', () => {
    assert.equal(run([[0.5, 0.002], [0.1, 0.002], [0.1, 0.007], [0.5, 0.007], [0.1, 0.002], [0.1, 0.002], [0.1, 0.007], [0.5, 0.007], [0.1, 0.002]]).length, 0);
  });
});

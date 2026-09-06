// StableRule: practice matching over the smoothed verdict stream.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StableRule } from '../src/detect.js';
import { CONFIG } from '../src/config.js';

const HOP = 1024 / 48000;   // 21.3 ms, the detector's verdict rate
// feed `id` for `n` frames starting at t, return [fired ids with times]
function feed(rule, t, id, n, silent = false) {
  const fired = [];
  for (let i = 0; i < n; i++) { t += HOP; const f = rule.push(t, id, silent); if (f) fired.push([+t.toFixed(3), f]); }
  return { t, fired };
}

describe('StableRule', () => {
  it('defaults come from CONFIG.stable', () => {
    const r = new StableRule();
    assert.ok(Math.abs(r.win - CONFIG.stable.minHoldMs / 1000 * CONFIG.stable.win) < 1e-9);
    assert.equal(r.frac, CONFIG.stable.frac);
  });

  it('fires once the window is 80% full and the chord holds ≥ frac of it, then not again', () => {
    const r = new StableRule(0.5, 0.6);
    const { fired } = feed(r, 0, 'C', 60);
    assert.equal(fired.length, 1, 'fires exactly once per chord');
    const [t] = fired[0];
    assert.ok(t >= 0.4 && t < 0.4 + 2 * HOP, `fired at ${t}, expected right after 80% of a 0.5 s window`);
  });

  it('tolerates blank frames at strum onsets (≥60% is enough) but not a minority', () => {
    const r = new StableRule(0.5, 0.6);
    let t = 0, fired = [];
    for (let i = 0; i < 40; i++) { t += HOP; const f = r.push(t, i % 3 === 0 ? null : 'G'); if (f) fired.push(f); }   // 2 of 3 frames G
    assert.deepEqual(fired, ['G']);
    const r2 = new StableRule(0.5, 0.6);
    t = 0; fired = [];
    for (let i = 0; i < 40; i++) { t += HOP; const f = r2.push(t, i % 2 === 0 ? null : 'G'); if (f) fired.push(f); }   // 1 of 2 frames G
    assert.deepEqual(fired, []);
  });

  it('silence resets: the same chord can fire again after a pause', () => {
    const r = new StableRule(0.5, 0.6);
    let s = feed(r, 0, 'C', 40); assert.equal(s.fired.length, 1);
    s = feed(r, s.t, null, 10, true); assert.equal(s.fired.length, 0);
    s = feed(r, s.t, 'C', 40); assert.equal(s.fired.length, 1, 'C fires again after silence');
  });

  it('re-arms after another chord fires', () => {
    const r = new StableRule(0.5, 0.6);
    let s = feed(r, 0, 'C', 40); assert.deepEqual(s.fired.map(f => f[1]), ['C']);
    s = feed(r, s.t, 'C', 40); assert.deepEqual(s.fired, [], 'still C, no re-fire');
    s = feed(r, s.t, 'G', 40); assert.deepEqual(s.fired.map(f => f[1]), ['G']);
    s = feed(r, s.t, 'C', 40); assert.deepEqual(s.fired.map(f => f[1]), ['C'], 'C again after G');
  });

  it('never fires on null and ignores frames before the window has grown', () => {
    const r = new StableRule(0.5, 0.6);
    const s = feed(r, 0, null, 100);
    assert.deepEqual(s.fired, []);
    const r2 = new StableRule(0.5, 0.6);
    assert.equal(r2.push(0.01, 'C'), null);
    assert.equal(r2.push(0.02, 'C'), null);
  });

  it('reset() clears the window and the last fired id', () => {
    const r = new StableRule(0.5, 0.6);
    let s = feed(r, 0, 'C', 40); assert.equal(s.fired.length, 1);
    r.reset();
    s = feed(r, s.t, 'C', 40); assert.equal(s.fired.length, 1);
  });
});

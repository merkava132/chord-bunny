import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, applyOverrides, sensitivityFromSlider } from '../src/config.js';

const snapshot = JSON.stringify(CONFIG);
const restore = () => { const s = JSON.parse(snapshot); for (const k of Object.keys(s)) Object.assign(CONFIG[k], s[k]); };

describe('config.applyOverrides', () => {
  afterEach(restore);
  it('sets numeric leaves and reports what it applied', () => {
    const applied = applyOverrides('detect.lam:0.4,stable.frac:0.7');
    assert.deepEqual(applied, ['detect.lam=0.4', 'stable.frac=0.7']);
    assert.equal(CONFIG.detect.lam, 0.4);
    assert.equal(CONFIG.stable.frac, 0.7);
  });
  it('parses booleans and leaves strings alone', () => {
    CONFIG.detect.flag = false;
    assert.deepEqual(applyOverrides('detect.flag:true'), ['detect.flag=true']);
    assert.equal(CONFIG.detect.flag, true);
    delete CONFIG.detect.flag;
  });
  it('ignores unknown paths and malformed items without throwing', () => {
    const warn = console.warn; const warned = []; console.warn = (m) => warned.push(m);
    try {
      assert.deepEqual(applyOverrides('nope.x:1,detect.nothere:2,garbage,detect.lam'), []);
      assert.equal(warned.length, 2);
    } finally { console.warn = warn; }
    assert.equal(CONFIG.detect.lam, 0.5);
  });
  it('handles empty input', () => { assert.deepEqual(applyOverrides(''), []); assert.deepEqual(applyOverrides(null), []); assert.deepEqual(applyOverrides(undefined), []); });
  it('nested prior categories are reachable', () => {
    applyOverrides('detect.prior.sus:0.2');
    assert.equal(CONFIG.detect.prior.sus, 0.2);
  });
});

describe('config.sensitivityFromSlider', () => {
  it('maps the default slider to the calibrated threshold and the ends to min/max', () => {
    assert.ok(Math.abs(sensitivityFromSlider(CONFIG.sensitivity.defaultSlider) - 0.3475) < 1e-9);
    assert.equal(sensitivityFromSlider(0), CONFIG.sensitivity.min);
    assert.equal(sensitivityFromSlider(100), CONFIG.sensitivity.max);
  });
});

describe('config shape', () => {
  it('has the sections the code reads', () => {
    for (const k of ['detect', 'confidence', 'sensitivity', 'stable', 'listen', 'meter', 'recorder', 'telemetry']) assert.ok(k in CONFIG, k);
    assert.ok(CONFIG.detect.fftSize % 2 === 0 && CONFIG.detect.hop < CONFIG.detect.fftSize);
    assert.ok(CONFIG.stable.frac > 0.5 && CONFIG.stable.frac <= 1);
    assert.ok(CONFIG.recorder.gate >= CONFIG.detect.rmsGate * 0.5);
  });
});

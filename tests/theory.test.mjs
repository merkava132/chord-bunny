import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { relatedness, pickNext } from '../src/theory.js';

const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const by = Object.fromEntries(CHORDS.map(c => [c.id, c]));

describe('theory.relatedness', () => {
  const cases = [['C', 'G', 2], ['C', 'Am', 4], ['C', 'Csus4', 6], ['Am', 'E7', 1], ['Em', 'B7', 1], ['C', 'F#m', 0], ['D', 'Bm', 4], ['G', 'Dsus4', 3]];
  for (const [a, b, want] of cases) it(`${a} → ${b} = ${want}`, () => assert.equal(relatedness(by[a], by[b]), want));
  it('is symmetric', () => { for (const [a, b] of [['C', 'G'], ['Am', 'E7'], ['C', 'Csus4']]) assert.equal(relatedness(by[a], by[b]), relatedness(by[b], by[a])); });
  it('same root always counts', () => { for (const [a, b] of [['C', 'Cmaj7'], ['D', 'Dsus2'], ['Am', 'Am7'], ['G', 'G/B']]) assert.ok(relatedness(by[a], by[b]) >= 3); });
});

describe('theory.pickNext', () => {
  const pool = ['C', 'D', 'G', 'Em', 'Am'].map(id => by[id]);
  it('never returns the current chord', () => { for (let i = 0; i < 300; i++) assert.notEqual(pickNext(by.G, pool).id, 'G'); });
  it('draws from the pool', () => { const ids = new Set(pool.map(c => c.id)); for (let i = 0; i < 100; i++) assert.ok(ids.has(pickNext(by.C, pool).id)); });
  it('weights by relatedness (rng at 0 picks the first option, at 1−ε the last)', () => {
    const options = pool.filter(c => c.id !== 'G');
    assert.equal(pickNext(by.G, pool, () => 0).id, options[0].id);
    assert.equal(pickNext(by.G, pool, () => 0.999999).id, options[options.length - 1].id);
    // a chord with more shared keys is drawn more often
    const counts = {}; for (let i = 0; i < 4000; i++) { const id = pickNext(by.G, pool).id; counts[id] = (counts[id] || 0) + 1; }
    assert.ok(counts.Em > counts.D, `Em (${counts.Em}) should beat D (${counts.D}) after G`);
  });
  it('falls back to uniform when nothing is related', () => {
    const far = [by.C, by['F#m']];
    for (let i = 0; i < 20; i++) assert.equal(pickNext(by.C, far).id, 'F#m');
  });
  it('handles no current chord and empty pools', () => {
    assert.ok(pool.map(c => c.id).includes(pickNext(null, pool).id));
    assert.equal(pickNext(by.C, [by.C]), null);
    assert.equal(pickNext(by.C, []), null);
  });
});

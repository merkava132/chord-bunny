// data/progressions.json: every chord exists; capo / bpm are sane; names unique.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CHORDS = new Set(JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url))).map(c => c.id));
const P = JSON.parse(fs.readFileSync(new URL('../data/progressions.json', import.meta.url)));

describe('progressions.json', () => {
  it('uses only known chord ids, at least two per progression', () => {
    for (const p of P) { assert.ok(p.chords.length >= 2, p.id); for (const c of p.chords) assert.ok(CHORDS.has(c), `${p.id}: ${c}`); }
  });
  it('ids and names are unique', () => {
    assert.equal(new Set(P.map(p => p.id)).size, P.length); assert.equal(new Set(P.map(p => p.name)).size, P.length);
  });
  it('capo, bpm and beatsPerChord are sane when present', () => {
    for (const p of P) {
      if ('capo' in p) assert.ok(Number.isInteger(p.capo) && p.capo >= 0 && p.capo <= 7, `${p.id}: capo`);
      if ('bpm' in p) assert.ok(p.bpm >= 30 && p.bpm <= 300, `${p.id}: bpm`);
      if ('beatsPerChord' in p) assert.ok([2, 4, 8].includes(p.beatsPerChord), `${p.id}: beatsPerChord`);
    }
  });
  it('Hotel California: verse loop, chorus and the whole song, capo 2 at 73 bpm', () => {
    const by = Object.fromEntries(P.map(p => [p.id, p]));
    assert.deepEqual(by['hotel-verse'].chords, ['Am', 'E7', 'G', 'D', 'F', 'C', 'Dm', 'E7']);
    assert.deepEqual(by['hotel-chorus'].chords, ['F', 'C', 'E7', 'Am', 'F', 'C', 'Dm', 'E7']);
    assert.equal(by['hotel-full'].chords.length, 120);
    for (const id of ['hotel-verse', 'hotel-chorus', 'hotel-full']) { assert.equal(by[id].capo, 2); assert.equal(by[id].bpm, 73); }
  });
});

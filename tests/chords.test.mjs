// data/chords.json integrity: the voicing must actually sound the chord.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TUNING, PC_NAMES } from '../src/dsp/analyzer.js';
import { PC_INDEX } from '../src/detect.js';

const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const CATEGORIES = new Set(['basic', 'barre', 'sus', 'add9', 'maj7', 'minor7', 'seventh', 'slash']);
const pcName = (midi) => PC_NAMES[((midi % 12) + 12) % 12];

describe('chords.json', () => {
  it('has unique ids and known categories', () => {
    const ids = CHORDS.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate id');
    for (const c of CHORDS) assert.ok(CATEGORIES.has(c.category), `${c.id}: unknown category ${c.category}`);
  });

  it('every chord has the fields the app reads', () => {
    for (const c of CHORDS) {
      for (const k of ['id', 'name', 'fullName', 'category', 'root', 'quality', 'notes', 'fingering']) assert.ok(k in c, `${c.id} missing ${k}`);
      assert.equal(c.fingering.frets.length, 6, `${c.id}: frets`);
      assert.equal(c.fingering.fingers.length, 6, `${c.id}: fingers`);
      assert.ok(c.notes.length >= 3, `${c.id}: notes`);
      assert.ok(c.root in PC_INDEX, `${c.id}: root ${c.root}`);
      assert.equal(PC_INDEX[c.root], PC_INDEX[c.notes[0]], `${c.id}: notes[0] should be the root`);
    }
  });

  it('fretted notes are chord tones (the fifth may be omitted), nothing else', () => {
    for (const c of CHORDS) {
      const sounding = new Set(c.fingering.frets.map((f, s) => f >= 0 ? pcName(TUNING[s] + f) : null).filter(Boolean));
      const tones = new Set(c.notes.map(n => PC_NAMES[PC_INDEX[n]]));
      for (const n of sounding) assert.ok(tones.has(n), `${c.id}: voicing sounds ${n}, not a chord tone of ${[...tones]}`);
      const fifth = PC_NAMES[(PC_INDEX[c.root] + 7) % 12];
      for (const n of tones) if (!sounding.has(n)) assert.equal(n, fifth, `${c.id}: chord tone ${n} is not in the voicing`);
    }
  });

  it('diagram geometry: frets fit the 5-fret grid from baseFret, nut shown only when baseFret is 1', () => {
    for (const c of CHORDS) {
      const { frets, baseFret = 1 } = c.fingering;
      for (const f of frets) if (f > 0) {
        const rel = f - baseFret + 1;
        assert.ok(rel >= 1 && rel <= 5, `${c.id}: fret ${f} off the grid at baseFret ${baseFret}`);
      }
      if (baseFret === 1) assert.ok(Math.max(...frets) <= 5, `${c.id}: needs a baseFret`);
      if (baseFret > 1) assert.ok(!frets.includes(0), `${c.id}: open strings with baseFret ${baseFret} would not be drawable`);
    }
  });

  it('slash chords carry their bass note and it is the lowest sounding string', () => {
    for (const c of CHORDS.filter(c => c.category === 'slash')) {
      assert.ok(c.bass, `${c.id}: bass`);
      assert.ok(c.id.includes('/'), `${c.id}: slash id`);
      const lowest = c.fingering.frets.findIndex(f => f >= 0);
      assert.equal(pcName(TUNING[lowest] + c.fingering.frets[lowest]), PC_NAMES[PC_INDEX[c.bass]], `${c.id}: bass note`);
      assert.notEqual(PC_INDEX[c.bass], PC_INDEX[c.root], `${c.id}: a slash chord's bass is not its root`);
    }
  });

  it('basic chords are the open major/minor triads the practice scoper always includes', () => {
    const basic = CHORDS.filter(c => c.category === 'basic').map(c => c.id).sort();
    assert.deepEqual(basic, ['A', 'Am', 'C', 'D', 'Dm', 'E', 'Em', 'F', 'G']);
  });
});

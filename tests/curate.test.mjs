// tools/curate.mjs: which recordings survive the recorder's prune, and why.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreSession, select, selectMirror, curate, TIER_A } from '../tools/curate.mjs';

const cat = (id) => (['C', 'D', 'E', 'F', 'G', 'A', 'Dm', 'Em', 'Am'].includes(id) ? 'basic' : 'sus');
const seg = (n, ts0, ts1, bytes = 1000) => ({ seg: n, ts0, ts1, bytes, sr: 48000 });

describe('scoreSession', () => {
  const events = [
    { type: 'enroll', ts: 12, kind: 'chord', chord: 'C', ts0: 5, ts1: 12 },
    { type: 'label', ts: 40, target: 'G', kind: 'fp', heard: ['G'], ts0: 31, ts1: 40 },
    { type: 'match', ts: 52, target: 'Am' }, { type: 'match', ts: 55, target: 'Gsus4' }, { type: 'match', ts: 58, target: 'Asus2' },
    { type: 'miss', ts: 75, target: 'C', heard: ['Em'] },
  ];
  const segments = [seg(0, 0, 20), seg(1, 20, 30), seg(2, 30, 45), seg(3, 45, 60), seg(4, 70, 80), seg(5, 100, 110), seg(6, 110, 120)];
  const rows = scoreSession({ id: 's', events, segments, noise: [[100, null]], categoryOf: cat });
  const by = Object.fromEntries(rows.map(r => [r.seg, r]));
  it('a calibration take is tier A', () => { assert.equal(by[0].tier, 'A'); assert.match(by[0].reasons[0], /calibration: C/); });
  it('a player-labelled window is tier A', () => { assert.equal(by[2].tier, 'A'); assert.match(by[2].reasons[0], /player-labelled: fp G/); });
  it('rare-chord matches outrank plain practice matches', () => {
    assert.equal(by[3].tier, 'A'); assert.ok(by[3].score >= TIER_A);
    assert.match(by[3].reasons.join(' '), /rare chords: Gsus4 Asus2/);
    assert.match(by[3].reasons.join(' '), /3 matches/);
  });
  it('a miss alone is tier B; nothing of interest is tier C with score 0', () => {
    assert.equal(by[4].tier, 'B'); assert.equal(by[4].score, 5);
    assert.equal(by[1].tier, 'C'); assert.equal(by[1].score, 0);
  });
  it('ambient ranges contribute one small sample segment, the rest score 0', () => {
    assert.equal(by[5].score, 5); assert.deepEqual(by[5].reasons, ['ambient sample']);
    assert.equal(by[6].score, 0);
  });
});

describe('select', () => {
  const rows = [
    { session: 'a', seg: 0, bytes: 500, score: 100, tier: 'A', mtime: 1 },
    { session: 'a', seg: 1, bytes: 500, score: 30, tier: 'B', mtime: 2 },
    { session: 'a', seg: 2, bytes: 500, score: 20, tier: 'B', mtime: 3 },
    { session: 'b', seg: 0, bytes: 500, score: 25, tier: 'B', mtime: 4 },
    { session: 'b', seg: 1, bytes: 5000, score: 100, tier: 'A', mtime: 5 },
  ];
  it('keeps every tier A even over budget, then fills by score within the per-session share', () => {
    const k = select(rows, { budgetBytes: 1500, perSessionShare: 0.5 });
    const ids = k.map(r => r.session + r.seg).sort();
    assert.ok(ids.includes('a0') && ids.includes('b1'), 'tier A always kept');
    assert.ok(!ids.includes('a2'), 'budget exhausted before the lowest tier B');
  });
  it('mirror takes tier A first, then the best of the rest, within its budget', () => {
    const m = selectMirror(rows, 1100).map(r => r.session + r.seg);
    assert.deepEqual(m, ['a0', 'a1']);   // b1 (5000 B) does not fit; a1 is the best tier B that does
  });
});

describe('curate (end to end on a fixture)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-curate-'));
  const rec = path.join(tmp, 'recordings'), keep = path.join(tmp, 'keep'), tel = path.join(tmp, 'telemetry'), mirror = path.join(tmp, 'mirror');
  fs.mkdirSync(path.join(rec, 's1'), { recursive: true }); fs.mkdirSync(tel);
  const segs = [seg(0, 0, 10, 4000), seg(1, 10, 20, 4000), seg(2, 20, 30, 4000)];
  fs.writeFileSync(path.join(rec, 's1', 'segments.jsonl'), segs.map(s => JSON.stringify(s)).join('\n') + '\n');
  for (const s of segs) fs.writeFileSync(path.join(rec, 's1', `seg-000${s.seg}.wav`), Buffer.alloc(s.bytes, 1));
  fs.writeFileSync(path.join(tel, 's1.jsonl'), [
    { t: 0, type: 'session', session: 's1' },
    { t: 5, type: 'enroll', ts: 5, kind: 'chord', chord: 'Am', ts0: 1, ts1: 5 },
    { t: 15, type: 'match', ts: 15, target: 'C' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  it('links the calibration and the practice take, skips the empty segment, writes the index and mirrors the best', () => {
    const m = curate({ recDir: rec, keepDir: keep, telDir: tel, mirrorDir: mirror, budgetBytes: 1e6, mirrorBytes: 4500, categoryOf: cat });
    assert.equal(m.segments, 2);
    assert.ok(fs.existsSync(path.join(keep, 's1', 'seg-0000.wav')) && fs.existsSync(path.join(keep, 's1', 'seg-0001.wav')));
    assert.ok(!fs.existsSync(path.join(keep, 's1', 'seg-0002.wav')));
    assert.equal(fs.statSync(path.join(keep, 's1', 'seg-0000.wav')).nlink, 2, 'same filesystem → hard link');
    const idx = fs.readFileSync(path.join(keep, 's1', 'keep.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(idx.map(r => r.tier), ['A', 'B']);
    assert.ok(fs.existsSync(path.join(keep, 'telemetry', 's1.jsonl')), 'labels travel with the audio');
    assert.ok(fs.existsSync(path.join(mirror, 's1', 'seg-0000.wav')) && !fs.existsSync(path.join(mirror, 's1', 'seg-0001.wav')), 'mirror budget fits only the tier A take');
  });
  it('survives the original being pruned, and a re-run changes nothing', () => {
    fs.rmSync(path.join(rec, 's1', 'seg-0000.wav'));
    const m = curate({ recDir: rec, keepDir: keep, telDir: tel, mirrorDir: null, budgetBytes: 1e6, categoryOf: cat });
    assert.equal(m.segments, 2); assert.equal(m.actions.linked, 0);
    assert.equal(fs.readFileSync(path.join(keep, 's1', 'seg-0000.wav')).length, 4000);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

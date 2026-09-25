// tools/stats.mjs: practice statistics from telemetry — what counts and what doesn't.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSession, aggregate, sessionStart } from '../tools/stats.mjs';

const line = (o) => JSON.stringify(o);
// mic on at 5 s; a timer advance before that is not practice; a noise range from ts 24 hides the last target
const A = [
  { t: 0.0, type: 'session', session: 'a', settings: {} },
  { t: 0.1, type: 'pair', ts: 0, cur: 'D', next: 'C', reason: 'fresh' },
  { t: 3.0, type: 'pair', ts: 0, cur: 'C', next: 'G', reason: 'timer' },
  { t: 5.0, type: 'mic', state: 'on', sampleRate: 48000 },
  { t: 10.0, type: 'pair', ts: 5, cur: 'C', next: 'G', reason: 'reroll' },
  { t: 12.1, type: 'match', ts: 7.1, target: 'C', heard: ['C'], sinceShown: 2.1, advanced: true },
  { t: 12.3, type: 'pair', ts: 7.3, cur: 'G', next: 'Am', reason: 'advance' },
  { t: 13.0, type: 'miss', ts: 8, target: 'G', heard: ['C'], conf: 0.4, sinceShown: 0.7 },     // the C still ringing: not a confusion
  { t: 15.3, type: 'miss', ts: 10.3, target: 'G', heard: ['Em'], conf: 0.4, sinceShown: 3.0 },
  { t: 16.0, type: 'match', ts: 11, target: 'G', heard: ['G'], sinceShown: 3.7, advanced: true },
  { t: 16.2, type: 'pair', ts: 11.2, cur: 'Am', next: 'C', reason: 'advance' },
  { t: 20.0, type: 'pair', ts: 15, cur: 'C', next: 'G', reason: 'timer' },
  { t: 22.0, type: 'match', ts: 17, target: 'C', heard: ['C'], sinceShown: 2.0, advanced: true },
  { t: 22.2, type: 'pair', ts: 17.2, cur: 'G', next: 'Em', reason: 'advance' },
  { t: 24.0, type: 'label', ts: 19, target: 'G', kind: 'fp', heard: ['G'], ts0: 7.3, ts1: 11.2 },
  { t: 30.0, type: 'pair', ts: 25, cur: 'Em', next: 'C', reason: 'timer' },
  { t: 31.0, type: 'strum', ts: 26, strings: [] },   // not parsed
  { t: 32.0, type: 'frame', ts: 27, level: 0.1 },    // not parsed
];
const B = [   // one match: below the session floor
  { t: 0, type: 'session', session: 'b', settings: {} }, { t: 1, type: 'mic', state: 'on' },
  { t: 2, type: 'pair', ts: 1, cur: 'C', next: 'G', reason: 'fresh' }, { t: 4, type: 'match', ts: 3, target: 'C', heard: ['C'], sinceShown: 2, advanced: true },
];
const text = (evs) => evs.map(line).join('\n') + '\n';
const NOW = new Date(2026, 8, 21, 12, 0, 0);   // local 2026-09-21 noon
const sessions = () => [
  { id: '2026-09-20T18-00-00-aaaa', events: parseSession(text(A)), noise: [[24, null]] },
  { id: '2026-09-19T18-00-00-bbbb', events: parseSession(text(B)), noise: [] },
];

describe('parseSession', () => {
  it('keeps only the event types the stats need and survives a torn last line', () => {
    const ev = parseSession(text(A) + '{"t":40,"type":"pair","cur":"G"');
    assert.deepEqual([...new Set(ev.map(e => e.type))].sort(), ['label', 'match', 'mic', 'miss', 'pair', 'session']);
  });
  it('reads the wall-clock start from the session id (UTC)', () => {
    assert.equal(sessionStart('2026-09-25T02-32-27-ho9k').toISOString(), '2026-09-25T02:32:27.000Z');
  });
});

describe('aggregate', () => {
  const st = aggregate(sessions(), { minMatches: 2, days: 7, now: NOW });
  it('drops sessions under the match floor, targets before the mic, and annotated noise', () => {
    assert.equal(st.totals.sessions, 1);
    assert.equal(st.totals.targets, 5);           // C G Am C G — not D/C before the mic, not Em in the noise
    assert.equal(st.totals.matched, 3);
  });
  it('per chord: shown, matched, time to match, what was heard instead (minus the previous chord ringing)', () => {
    const by = Object.fromEntries(st.chords.map(c => [c.id, c]));
    assert.deepEqual([by.C.shown, by.C.matched, by.C.p50], [2, 2, 2.1]);
    assert.deepEqual([by.G.shown, by.G.matched, by.G.p50], [2, 1, 3.7]);
    assert.deepEqual(by.G.heardInstead, [{ id: 'Em', n: 1 }]);
    assert.deepEqual([by.Am.shown, by.Am.matched, by.Am.p50], [1, 0, null]);
  });
  it('transitions follow advance / timer pairs, not fresh or reroll ones', () => {
    assert.deepEqual(Object.keys(st.transitions).sort(), ['Am→C', 'C→G', 'G→Am']);
    assert.deepEqual([st.transitions['C→G'].n, st.transitions['C→G'].matched, st.transitions['C→G'].p50], [2, 1, 3.7]);
    assert.equal(st.transitions['G→Am'].rate, 0);
    assert.equal(st.slowest[0].from + '→' + st.slowest[0].to, 'C→G');   // n ≥ 2 only
  });
  it('minutes are practice time with idle gaps removed; days, streak and the last-N-days series', () => {
    assert.equal(st.sessions[0].minutes, 0.2);      // 10.0 … 22.2 s of practice events
    assert.equal(st.allDays.length, 1);
    assert.equal(st.allDays[0].day, '2026-09-20');
    assert.equal(st.totals.streak, 1);              // practised yesterday
    assert.equal(st.days.length, 7);
    assert.equal(st.days[6].day, '2026-09-21');
    assert.equal(st.days[5].minutes, 0.2);
  });
  it('counts the player\'s labels', () => {
    assert.deepEqual([st.labels.fp, st.labels.fn], [1, 0]);
    assert.equal(st.labels.recent[0].target, 'G');
  });
  it('a long idle gap does not count as practice', () => {
    const ev = parseSession(text([...A, { t: 3000, type: 'pair', ts: 2995, cur: 'C', next: 'G', reason: 'timer' }, { t: 3002, type: 'match', ts: 2997, target: 'C', heard: ['C'], sinceShown: 2, advanced: true }]));
    const s2 = aggregate([{ id: '2026-09-20T18-00-00-aaaa', events: ev, noise: [[24, 2990]] }], { minMatches: 2, now: NOW });
    assert.equal(s2.sessions[0].minutes, 0.2);
    assert.equal(s2.totals.targets, 6);
  });
});

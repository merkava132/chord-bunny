// Segment recorder on synthetic chunks; fetch is stubbed.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../src/audio/recorder.js';

const SR = 48000, CHUNK = 512;
let uploads;
function make(opts = {}) {
  uploads = [];
  globalThis.fetch = (url, init) => { uploads.push({ url, bytes: init.body.byteLength, keepalive: init.keepalive }); return Promise.resolve({ ok: true }); };
  const segments = [];
  const r = new Recorder({ sampleRate: SR, session: 'test', onSegment: (m) => segments.push(m), ...opts });
  r.segments = segments;
  return r;
}
// push n chunks of a sine at `amp` (chunk rms ≈ amp/√2); returns the stream time after them
function push(r, ts, amp, n, music = false) {
  const chunk = new Float32Array(CHUNK);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < CHUNK; i++) chunk[i] = amp * Math.sin(0.3 * (k * CHUNK + i));
    ts += CHUNK / SR;
    if (music) r.noteMusic(ts);
    r.push(chunk, ts);
  }
  return ts;
}
const silence = (r, ts, sec) => push(r, ts, 0.0003, Math.round(sec * SR / CHUNK));

describe('Recorder', () => {
  it('typing-like clicks (short peaks in silence) open nothing', () => {
    const r = make();
    let ts = 0;
    for (let c = 0; c < 40; c++) { ts = push(r, ts, 0.02, 1); ts = push(r, ts, 0.0005, 13); }   // 10 ms click every 150 ms
    assert.equal(r.recording, false);
    assert.equal(uploads.length, 0);
  });

  it('a strum with chord-like frames is recorded with pre-roll and tail, as 16-bit samples', () => {
    const r = make();
    let ts = silence(r, 0, 1);
    const t0 = ts;
    ts = push(r, ts, 0.015, Math.round(2 * SR / CHUNK), true);      // 2 s strum
    ts = silence(r, ts, 2.5);                                           // > tailSec
    assert.equal(uploads.length, 1);
    assert.equal(r.segments.length, 1);
    const m = r.segments[0];
    assert.ok(m.ts0 <= t0 && m.ts0 >= t0 - 0.5 - 0.02, `pre-roll: ts0 ${m.ts0} vs strum start ${t0}`);
    assert.ok(m.dur >= 4.4 && m.dur <= 4.6, `duration ${m.dur} = pre-roll + strum + tail`);
    assert.equal(uploads[0].bytes % (2 * CHUNK), 0, 'WAV body is whole chunks of 16-bit samples');
    assert.ok(Math.abs(uploads[0].bytes / 2 / SR - m.dur) < 0.02, `bytes ${uploads[0].bytes} vs dur ${m.dur}s (dur is rounded to 10 ms)`);
    assert.match(uploads[0].url, /api\/audio\?session=test&seg=0&sr=48000&ts0=/);
    assert.equal(uploads[0].keepalive, false, 'big bodies cannot use keepalive');
  });

  it('a loud stretch with no chord-like frame (a bump) is dropped, not uploaded', () => {
    const r = make();
    let ts = push(r, 0, 0.02, Math.round(1 * SR / CHUNK));           // 1 s loud, no noteMusic
    ts = silence(r, ts, 2.5);
    assert.equal(uploads.length, 0);
    assert.equal(r.dropped, 1);
  });

  it('a stream-clock reset (re-attach) closes the open segment and starts fresh', () => {
    const r = make();
    let ts = push(r, 0, 0.015, Math.round(1.5 * SR / CHUNK), true);
    assert.equal(r.recording, true);
    push(r, 0, 0.0003, 1);                                              // ts goes backwards
    assert.equal(uploads.length, 1, 'open segment flushed');
    assert.ok(r.segments[0].ts1 <= ts + 1e-6);
  });

  it('a take longer than maxSec is split into contiguous segments; the last one is marked final', () => {
    const r = make({ maxSec: 4 });
    let ts = push(r, 0, 0.015, Math.round(5 * SR / CHUNK), true);
    ts = silence(r, ts, 3);
    // 5 s of strum + 2 s tail → [0,4] cut by maxSec, [4,7] ended by the tail.
    // (A follow-on segment holding only the tail is dropped — no chord-like
    // frame in it — and the previous continues flag then dangles; consumers
    // must check that seg N+1 exists with ts0 == ts1 before joining files.)
    const segs = r.segments;
    assert.equal(segs.length, 2, `${segs.length} segments`);
    for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(segs[i].ts0 - segs[i - 1].ts1) < 1e-6, 'contiguous');
    assert.ok(segs.slice(0, -1).every(m => m.continues), 'all but the last continue');
    assert.equal(segs[segs.length - 1].continues, false, 'ended by the tail, not by maxSec');
    assert.equal(uploads.length, segs.length);
  });

  it('stop() flushes what is in progress; disabled recorders ignore input', () => {
    const r = make();
    push(r, 0, 0.015, Math.round(1 * SR / CHUNK), true);
    r.stop();
    assert.equal(uploads.length, 1);
    const r2 = make(); r2.enabled = false;
    push(r2, 0, 0.015, Math.round(1 * SR / CHUNK), true); r2.stop();
    assert.equal(uploads.length, 0);
  });

  it('ignores blips shorter than 0.3 s', () => {
    const r = make();
    let ts = push(r, 0, 0.02, 10, true);                               // ~0.1 s
    r.stop(ts);
    assert.equal(uploads.length, 0);
  });
});

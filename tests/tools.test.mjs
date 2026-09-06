// The two session tools on a small fixture: they must run and say the right things.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const FIXTURE = path.join(ROOT, 'tests/fixtures/session.jsonl');
const run = (tool, args) => execFileSync(process.execPath, [path.join(ROOT, 'tools', tool), ...args], { encoding: 'utf8', cwd: ROOT });

describe('telemetry_report', () => {
  const out = run('telemetry_report.mjs', [FIXTURE]);
  it('summarises the session header, mic and signal', () => {
    assert.match(out, /19 events/);
    assert.match(out, /enabled=C G Am/);
    assert.match(out, /mic: on Test Mic sr=48000/);
    assert.match(out, /clipping in 33% of playing frames/);
  });
  it('reports practice outcomes, carry-over misses and confusions', () => {
    assert.match(out, /practice: 3 targets shown, 1 matched, 1 by timer/);
    assert.match(out, /1 of 2 misses were the previous chord still ringing/);
    assert.match(out, /G\s+shown\s+1\s+matched\s+0\s+heard instead: Em×1/);
    assert.match(out, /time to match: median 2\.2s/);
  });
  it('reports runs, listen verdicts, strums and recordings', () => {
    assert.match(out, /verdict runs: 1/);
    assert.match(out, /listen: 2 verdicts/);
    assert.match(out, /strums: 1/);
    assert.match(out, /recordings: 1 segments/);
  });
});

describe('session_labels', () => {
  const session = `fixture-${process.pid}`;
  const telDir = path.join(ROOT, 'telemetry');
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rec-'));
  before(() => {
    fs.mkdirSync(telDir, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(telDir, session + '.jsonl'));
    fs.mkdirSync(path.join(recDir, session), { recursive: true });
    fs.writeFileSync(path.join(recDir, session, 'segments.jsonl'), JSON.stringify({ seg: 0, sr: 48000, ts0: 0, ts1: 4.0, bytes: 384000, wall: 0 }) + '\n');
  });
  after(() => { fs.rmSync(path.join(telDir, session + '.jsonl'), { force: true }); fs.rmSync(recDir, { recursive: true, force: true }); });

  it('lines screen states up with the recording and writes labels.jsonl with sample offsets', () => {
    const out = run('session_labels.mjs', [session, `--rec-dir=${recDir}`]);
    assert.match(out, /1 recordings, 3 screen states, 1 matches, 2 misses/);
    assert.match(out, /screen: C → G\s+matched @1\.2/);
    assert.match(out, /screen: G → Am\s+no match\s+heard instead: C Em/);
    const rows = fs.readFileSync(path.join(recDir, session, 'labels.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows.length, 2, 'two screen states overlap the 0–4 s recording');
    assert.deepEqual(rows.map(r => r.target), ['C', 'G']);
    assert.equal(rows[0].offset0, 0);
    assert.equal(rows[0].offset1, Math.round(1.3 * 48000));
    assert.equal(rows[1].matched, false);
    assert.deepEqual(rows[1].heardInstead, ['C', 'Em']);
  });
  it('says so when a session has no recordings', () => {
    const out = run('session_labels.mjs', [session, `--rec-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'cb-empty-'))}`]);
    assert.match(out, /no recordings for/);
  });
});

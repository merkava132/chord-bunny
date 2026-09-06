// serve.py end to end: static files, telemetry and audio sinks, pruning.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let proc, base, recDir, session;
before(async () => {
  const port = await freePort();
  recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-serve-'));
  session = `fixture-serve-${process.pid}`;
  proc = spawn('python3', ['serve.py', '--port', String(port), '--rec-dir', recDir, '--max-rec-mb', '1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${base}/api/status`); if (r.ok) return; } catch {} await wait(100); }
  throw new Error('serve.py did not come up');
});
after(() => { proc.kill(); fs.rmSync(recDir, { recursive: true, force: true }); fs.rmSync(path.join(ROOT, 'telemetry', session + '.jsonl'), { force: true }); });

const wav = (seconds, sr = 48000) => new Uint8Array(seconds * sr * 2);   // silent int16 PCM

describe('serve.py', () => {
  it('serves the app with no-cache so deploys do not leave stale modules', async () => {
    const r = await fetch(`${base}/index.html`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.match(await r.text(), /<title>chord-bunny<\/title>/);
    const m = await fetch(`${base}/src/config.js`);
    assert.equal(m.status, 200);
  });

  it('/api/status describes where things go', async () => {
    const s = await (await fetch(`${base}/api/status`)).json();
    assert.equal(s.recDir, recDir);
    assert.equal(s.maxRecBytes, 1e6);
    assert.ok(Array.isArray(s.sessions));
    assert.ok(typeof s.recBytes === 'number');
  });

  it('appends telemetry lines per session and rejects bad session ids', async () => {
    const url = `${base}/api/telemetry?session=${session}`;
    assert.equal((await fetch(url, { method: 'POST', body: '{"t":0,"type":"a"}\n' })).status, 204);
    assert.equal((await fetch(url, { method: 'POST', body: '{"t":1,"type":"b"}' })).status, 204);   // no trailing newline
    const lines = fs.readFileSync(path.join(ROOT, 'telemetry', session + '.jsonl'), 'utf8').trim().split('\n');
    assert.deepEqual(lines.map(l => JSON.parse(l).type), ['a', 'b']);
    assert.equal((await fetch(`${base}/api/telemetry?session=../x`, { method: 'POST', body: 'x' })).status, 400);
    assert.equal((await fetch(`${base}/api/telemetry`, { method: 'POST', body: 'x' })).status, 400);
    assert.equal((await fetch(`${base}/api/nope?session=${session}`, { method: 'POST', body: 'x' })).status, 404);
  });

  it('writes a valid WAV per segment plus segments.jsonl', async () => {
    const body = wav(2);
    const r = await fetch(`${base}/api/audio?session=${session}&seg=3&sr=48000&ts0=1.5&ts1=3.5`, { method: 'POST', body });
    assert.equal(r.status, 204);
    const f = path.join(recDir, session, 'seg-0003.wav');
    const buf = fs.readFileSync(f);
    assert.equal(buf.length, 44 + body.length);
    assert.equal(buf.toString('latin1', 0, 4), 'RIFF');
    assert.equal(buf.toString('latin1', 8, 12), 'WAVE');
    assert.equal(buf.readUInt16LE(22), 1, 'mono');
    assert.equal(buf.readUInt32LE(24), 48000, 'sample rate');
    assert.equal(buf.readUInt16LE(34), 16, 'bits');
    assert.equal(buf.readUInt32LE(40), body.length, 'data length');
    const meta = fs.readFileSync(path.join(recDir, session, 'segments.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(meta.map(m => [m.seg, m.sr, m.ts0, m.ts1, m.bytes]), [[3, 48000, 1.5, 3.5, body.length]]);
  });

  it('prunes the oldest recordings past the cap', async () => {
    // cap is 1 MB; each 4 s segment is 384 KB → the 2 s one above and the first of these go
    for (const seg of [4, 5, 6]) {
      await fetch(`${base}/api/audio?session=${session}&seg=${seg}&sr=48000&ts0=0&ts1=4`, { method: 'POST', body: wav(4) });
      await wait(20);
    }
    const files = fs.readdirSync(path.join(recDir, session)).filter(f => f.endsWith('.wav')).sort();
    const total = files.reduce((s, f) => s + fs.statSync(path.join(recDir, session, f)).size, 0);
    assert.ok(total <= 1e6, `${total} bytes kept`);
    assert.ok(files.includes('seg-0006.wav'), 'newest survives');
    assert.ok(!files.includes('seg-0003.wav'), 'oldest pruned');
    const s = await (await fetch(`${base}/api/status`)).json();
    assert.ok(s.recBytes <= 1e6 && s.sessions.includes(session));
  });
});

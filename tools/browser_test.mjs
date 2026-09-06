// End-to-end browser test: headless Chrome + a WAV as the fake microphone.
//   node tools/browser_test.mjs <excerpt-name> [--mode=listen|practice] [--chord=G] [--shots=dir] [--port=9333] [--app=http://localhost:8732] [--extra=recmax=5]
// Requires the app served at --app (default http://localhost:8732/, ./start.sh).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadExcerpt, chordAt } from './guitarset.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
const name = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!name) { console.error('usage: node tools/browser_test.mjs <excerpt> [--mode=] [--chord=] [--shots=dir]'); process.exit(1); }
const PORT = Number(args.port || 9333);
const MODE = args.mode || 'listen';
const SHOTS = args.shots || path.join(os.tmpdir(), 'chord-bunny-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const ex = loadExcerpt(name);
const wav = path.resolve('testdata/audio', `${name}_mic.wav`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-chrome-'));
const APP = String(args.app || 'http://localhost:8732').replace(/\/$/, '');
const url = `${APP}/?autostart=1&mode=${MODE}${args.chord ? `&chord=${args.chord}` : ''}${args.extra ? `&${args.extra}` : ''}`;

const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--window-size=${args.width || 1100},${args.height || 900}`, '--force-device-scale-factor=1',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}%noloop`,
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' }, detached: true });   // clean env: inherited vars break Chrome IPC on this box
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d; });
const cleanup = () => { try { process.kill(-chrome.pid, 'SIGTERM'); } catch {} try { chrome.kill('SIGKILL'); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try { const list = await (await fetch(`http://localhost:${PORT}/json`)).json(); const t = list.find(x => x.type === 'page'); if (t) return t; } catch {}
    await sleep(200);
  }
  throw new Error('chrome did not come up: ' + chromeErr.slice(-500));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } else if (m.method) this.events.push(m); }; }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description)); return r.result.value; }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; }
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const cdp = new CDP(ws);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
await cdp.send('Page.navigate', { url });
// wait for the app + mic
let started = false;
for (let i = 0; i < 60 && !started; i++) { await sleep(250); try { started = await cdp.eval('typeof window.__micStartedAt === "number"'); } catch {} }
if (!started) { const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded').map(e => JSON.stringify(e.params).slice(0, 300)); console.error('mic never started', errs.join('\n')); process.exit(2); }
const micStart = await cdp.eval('window.__micStartedAt');
console.log(`mic started; sampling UI for ${ex.duration.toFixed(1)}s (${name}, mode=${MODE})`);

const samples = [];
const readState = `(() => {
  const q = (s) => document.querySelector(s);
  const mode = ${JSON.stringify(MODE)};
  const heard = mode === 'listen' ? q('#listen-chord').textContent : q('#heard-chord').textContent;
  const view = mode === 'listen' ? q('#listen-strings') : q('#cur-strings');
  const bars = [...view.querySelectorAll('.sbar')].map(b => (b.dataset.state || 'silent')[0]).join('');
  const strum = view.querySelector('.strum-line').textContent.trim();
  const fb = view.querySelector('.strum-fb').textContent.trim();
  const tr = window.__cb.tracker;
  return { t: (performance.now() - window.__micStartedAt) / 1000, heard, bars, strum, fb, h: tr ? Array.from(tr.h.subarray(0, 6)).map(v => +v.toFixed(1)) : null, frets: tr ? tr.frets : null };
})()`;
const end = Date.now() + (args.stopAfterShots ? 1e9 : ex.duration * 1000 + 500);
let shotN = 0;
const shotTimes = (args.shotAt ? String(args.shotAt).split(',').map(Number) : [4, 10, 18]);
while (Date.now() < end) {
  const st = await cdp.eval(readState);
  samples.push(st);
  if (shotN < shotTimes.length && st.t >= shotTimes[shotN]) { await cdp.shot(path.join(SHOTS, `${name}-${MODE}-${args.width || 1100}w-${shotTimes[shotN]}s.png`)); shotN++; }
  if (args.stopAfterShots && shotN >= shotTimes.length) break;
  await sleep(250);
}
const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
if (errs.length) console.log('page exceptions:', errs.slice(0, 5).join('\n'));

// compare heard chord vs GT (listen mode); the fake mic starts a little after getUserMedia resolves
let n = 0, hit = 0; const conf = new Map();
for (const s of samples) {
  const gt = chordAt(ex.chords, s.t)?.appId; if (!gt) continue;
  n++; if (s.heard === gt) hit++; else conf.set(`${gt}→${s.heard}`, (conf.get(`${gt}→${s.heard}`) || 0) + 1);
}
console.log(`heard == GT chord in ${hit}/${n} samples (${(100 * hit / Math.max(1, n)).toFixed(0)}%)`);
console.log('confusions:', [...conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(' '));
console.log('timeline (t heard bars strum | feedback):');
for (const s of samples.filter((_, i) => i % 4 === 0)) console.log(`  ${s.t.toFixed(1).padStart(5)} ${String(s.heard).padEnd(4)} ${s.bars} ${s.strum.padEnd(34)} | ${s.fb}`);
console.log('screenshots in', SHOTS);
cleanup();
process.exit(0);

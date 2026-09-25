// Learn this player's open-string partial profiles and mic/guitar frequency
// response from the calibration plucks ("calibrate my chords" → telemetry
// `enroll` events of kind 'string', stream-time ranges into the recordings).
//   node tools/learn_response.mjs [session ...|latest] [--all] [--rec-dir=DIR] [--tel-dir=DIR]
//        [--write=data/user/partials.json] [--verbose]
// Each pluck is found as an energy onset (src/enroll.js OnsetDetector on the
// detector's 8192/1024 RMS framing); its 0.3–1.0 s of sustain is averaged as
// a magnitude spectrum and the partials k = 1..10 are peak-picked at
// k·f0·√(1+B·k²) (src/dsp/partials.js). Per string the plucks' profiles are
// combined by geometric mean. The response G(f) is fitted so that
// measured/GuitarSet ≈ G(f_k)/G(f_1) across all strings (fitResponse) and the
// analyzer applies it to every pitch (analyzer.mergeUserPartials).
//
// Output (--write): { "<midi>": [1, a2, …] for each measured open string,
//   meta: { learnedAt, sessions, plucks: { "<string>": n }, snr: { "<midi>": [...] },
//          fundamentalProminence: [6 × dB | null], rigNote },
//   response: { hz, gain, n, rmsLogResidual } }
import fs from 'node:fs';
import path from 'node:path';
import { FFT, hann } from '../src/dsp/fft.js';
import { frames, rms, midiToHz, midiName } from '../src/dsp/analyzer.js';
import { decodeWav } from '../src/dsp/wav.js';
import { OnsetDetector, ENROLL, OPEN_STRINGS } from '../src/enroll.js';
import { measurePartials, fitResponse, interpGain, OPEN_MIDI } from '../src/dsp/partials.js';
import { CONFIG } from '../src/config.js';
import { DEFAULT_REC, DEFAULT_TEL } from './session_labels.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
const TEL = args['tel-dir'] || DEFAULT_TEL, REC = args['rec-dir'] || DEFAULT_REC;
const N = CONFIG.detect.fftSize, HOP = CONFIG.detect.hop;
const SUSTAIN = [0.3, 1.0];          // seconds after the pluck to average
const BASE = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));

let sessions = process.argv.slice(2).filter(a => !a.startsWith('--'));
const hasStringEnroll = (sid) => { const f = path.join(TEL, sid + '.jsonl'); return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('"type":"enroll"') && fs.existsSync(path.join(REC, sid, 'segments.jsonl')); };
if (sessions.includes('latest')) sessions = fs.readdirSync(TEL).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, '')).filter(hasStringEnroll).sort().slice(-1);
if (!sessions.length || args.all) sessions = fs.readdirSync(TEL).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, '')).filter(hasStringEnroll).sort();
if (!sessions.length) { console.log('no session with calibration plucks (settings → calibrate, with the mic on)'); console.log('summary: response: none yet'); process.exit(0); }

const fft = new FFT(N), win = hann(N), re = new Float32Array(N), im = new Float32Array(N), magBuf = new Float32Array(N / 2 + 1);
function magnitude(frame) { for (let i = 0; i < N; i++) re[i] = frame[i] * win[i]; im.fill(0); fft.transform(re, im); for (let k = 0; k <= N / 2; k++) magBuf[k] = Math.hypot(re[k], im[k]); return magBuf; }

// per string: list of { amps, snr, session, ts }
const plucks = new Map();
for (const sid of sessions) {
  const ev = fs.readFileSync(path.join(TEL, sid + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const wins = ev.filter(e => e.type === 'enroll' && e.kind === 'string');
  if (!wins.length) continue;
  const dir = path.join(REC, sid);
  const segs = fs.readFileSync(path.join(dir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const wavCache = new Map();
  const wavOf = (seg) => { if (!wavCache.has(seg.seg)) wavCache.set(seg.seg, decodeWav(fs.readFileSync(path.join(dir, `seg-${String(seg.seg).padStart(4, '0')}.wav`)))); return wavCache.get(seg.seg); };
  for (const w of wins) {
    const s = w.string, midi = OPEN_MIDI[s], f0 = midiToHz(midi);
    const covering = segs.filter(sg => sg.ts1 > w.ts0 && sg.ts0 < w.ts1 + SUSTAIN[1]);
    let found = 0;
    for (const sg of covering) {
      const wav = wavOf(sg); if (wav.sampleRate !== 48000 && args.verbose) console.log(`  note: ${sid} seg ${sg.seg} is ${wav.sampleRate} Hz`);
      const det = new OnsetDetector(ENROLL), onsets = [];
      const list = [];
      for (const { start, frame } of frames(wav.samples, N, HOP)) { const ts = sg.ts0 + (start + N / 2) / wav.sampleRate; list.push([ts, start]); if (det.push(ts, rms(frame)) && ts >= w.ts0 && ts < w.ts1) onsets.push(ts); }
      for (const o of onsets) {
        const acc = new Float64Array(N / 2 + 1); let n = 0;
        for (const [ts, start] of list) if (ts >= o + SUSTAIN[0] && ts < o + SUSTAIN[1] && start + N <= wav.samples.length) { const mg = magnitude(wav.samples.subarray(start, start + N)); for (let k = 0; k <= N / 2; k++) acc[k] += mg[k]; n++; }
        if (n < 8) { if (args.verbose) console.log(`  ${sid} string ${s}: pluck at ${o.toFixed(2)}s has only ${n} sustain frames — skipped`); continue; }
        for (let k = 0; k <= N / 2; k++) acc[k] /= n;
        const m = measurePartials(acc, { sampleRate: wav.sampleRate, fftSize: N, f0 });
        if (m.snr[0] < 2) { if (args.verbose) console.log(`  ${sid} string ${s}: pluck at ${o.toFixed(2)}s — fundamental only ${m.snr[0].toFixed(1)}× the floor, skipped`); continue; }
        (plucks.get(s) || plucks.set(s, []).get(s)).push({ ...m, session: sid, ts: o }); found++;
      }
    }
    if (args.verbose || !found) console.log(`${sid} string ${s} (${OPEN_STRINGS[s].name}, ${midiName(midi)}) ${w.ts0.toFixed(1)}–${w.ts1.toFixed(1)}s: ${found} pluck(s) measured${found ? '' : ' — no clean pluck in the window'}`);
  }
}

// combine per string: geometric mean of amps, mean snr
const measured = {}, snrTab = {}, nPlucks = {};
for (const [s, list] of [...plucks].sort((a, b) => a[0] - b[0])) {
  const midi = OPEN_MIDI[s], K = Math.min(...list.map(p => p.amps.length));
  const amps = [], snr = [];
  for (let k = 0; k < K; k++) { amps.push(+Math.exp(list.reduce((a, p) => a + Math.log(Math.max(p.amps[k], 1e-6)), 0) / list.length).toFixed(4)); snr.push(+(list.reduce((a, p) => a + Math.min(p.snr[k], 1e3), 0) / list.length).toFixed(1)); }
  measured[midi] = amps; snrTab[midi] = snr; nPlucks[s] = list.length;
}
const response = fitResponse(measured, BASE, { snr: snrTab });
// Rig check: how far each open string's fundamental line stands above the
// bins around it (dB; null = string not measured). The onboard mic jack rolls
// off under ~100 Hz: when the low E's 82 Hz line is not there, the string
// tracker cannot see the low E directly and the detector only hears its
// partials (which are also E3's and E4's) — worth telling the player.
const PROMINENCE_MIN_DB = 6;
const fundamentalProminence = OPEN_MIDI.map((m, s) => nPlucks[s] ? +(20 * Math.log10(Math.max(snrTab[m][0], 1e-3))).toFixed(1) : null);
const weak = fundamentalProminence.map((p, s) => p !== null && p < PROMINENCE_MIN_DB ? s : -1).filter(s => s >= 0);
const rigNote = weak.map(s => `${OPEN_STRINGS[s].name} fundamental not present on this input (${midiToHz(OPEN_MIDI[s]).toFixed(0)} Hz below the floor)${s === 0 ? ' — the string tracker will not see the low E directly' : ''}`).join('; ');

// ---- print ----
console.log(`sessions: ${sessions.join(' ')}`);
console.log('string  midi  plucks   a2/a1  a3/a1  a4/a1   (GuitarSet a2 a3 a4)   snr a1..a4');
for (const s of Object.keys(nPlucks).map(Number).sort()) {
  const m = OPEN_MIDI[s], a = measured[m], g = BASE[m] || [];
  console.log(`  ${OPEN_STRINGS[s].name.padEnd(7)} ${String(m).padStart(3)}   ${String(nPlucks[s]).padStart(3)}     ${a.slice(1, 4).map(v => v.toFixed(2).padStart(5)).join('  ')}   (${g.slice(1, 4).map(v => v.toFixed(2)).join(' ')})   ${snrTab[m].slice(0, 4).map(v => v.toFixed(0)).join(' ')}`);
}
if (response.n) console.log(`response fit: ${response.n} partial ratios, rms log residual ${response.rmsLogResidual}\n  ` + response.hz.map((hz, i) => `${hz}Hz ${(20 * Math.log10(response.gain[i])).toFixed(1).padStart(5)}dB`).join('  '));
else console.log('response fit: nothing to fit');
console.log('fundamental prominence (dB over the surrounding bins): ' + fundamentalProminence.map((p, s) => `${OPEN_STRINGS[s].name} ${p === null ? '–' : p}`).join('  '));
const strings = Object.keys(nPlucks).length;
console.log(`summary: response: ${strings} string${strings === 1 ? '' : 's'} (${Object.values(nPlucks).reduce((a, b) => a + b, 0)} plucks)${rigNote ? '; ' + rigNote : ''}`);

if (args.write) {
  const out = { ...measured, meta: { learnedAt: new Date().toISOString(), sessions, plucks: nPlucks, snr: snrTab, fundamentalProminence, rigNote: rigNote || null }, response };
  fs.mkdirSync(path.dirname(args.write), { recursive: true });
  fs.writeFileSync(args.write, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${args.write}`);
}

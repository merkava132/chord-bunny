// Run a recording through the app's detector offline and print the chord
// timeline — for the user's own takes (recordings/<session>/seg-NNNN.wav).
//   node tools/replay.mjs <file.wav> [--chords=basic,sus|ids] [--sens=0.35] [--all]
import fs from 'node:fs';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { decodeWav } from '../src/dsp/wav.js';
import { buildTemplates, scoreTemplates, confidenceOf } from '../src/detect.js';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('usage: node tools/replay.mjs <file.wav> [--chords=...] [--sens=0.35] [--all]'); process.exit(1); }
const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const CAND = args.chords ? new Set(String(args.chords).split(',')) : null;
const T = buildTemplates(CAND ? CHORDS.filter(c => CAND.has(c.category) || CAND.has(c.id)) : CHORDS);
const SENS = Number(args.sens ?? 0.35);

const wav = decodeWav(fs.readFileSync(file));
const an = new PitchAnalyzer({ sampleRate: wav.sampleRate, profiles: PROFILES });
const N = an.opts.fftSize, HOP = 1024;
const sm = new Float32Array(an.nP);
const hist = [];
let peak = 0, clipped = 0; for (const v of wav.samples) { const a = Math.abs(v); if (a > peak) peak = a; if (a > 0.985) clipped++; }
console.log(`${file}: ${(wav.samples.length / wav.sampleRate).toFixed(1)}s @${wav.sampleRate}Hz  peak ${peak.toFixed(2)}  clipped ${(100 * clipped / wav.samples.length).toFixed(2)}%  candidates ${T.length}`);
const timeline = [];   // { t, id, conf }
for (const { start, frame } of frames(wav.samples, N, HOP)) {
  const t = (start + N / 2) / wav.sampleRate;
  const level = rms(frame);
  let id = null, conf = 0, best = null;
  if (level >= 0.006) {
    const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = 0.5 * sm[i] + 0.5 * act[i];
    const r = scoreTemplates(an.chroma(sm), T);
    conf = confidenceOf(r, T); best = T[r.best].id;
    hist.push(conf >= SENS ? best : null); if (hist.length > 5) hist.shift();
    const m = new Map(); for (const h of hist) m.set(h, (m.get(h) || 0) + 1);
    let bp = null, bc = 0; for (const [k, c] of m) if (c > bc) { bc = c; bp = k; }
    id = bc >= 3 ? bp : null;
  } else hist.length = 0;
  timeline.push({ t, id, conf, best, level });
}
// collapse to runs
const runs = [];
for (const s of timeline) {
  const last = runs[runs.length - 1];
  if (last && last.id === s.id) { last.t1 = s.t; last.n++; last.conf += s.conf; }
  else runs.push({ id: s.id, t0: s.t, t1: s.t, n: 1, conf: s.conf });
}
for (const r of runs) if (args.all || r.id) console.log(`  ${r.t0.toFixed(2).padStart(6)}–${r.t1.toFixed(2).padEnd(6)} ${String(r.id ?? '—').padEnd(7)} ${(r.t1 - r.t0 + HOP / wav.sampleRate).toFixed(2)}s  conf ${(r.conf / r.n).toFixed(2)}`);
const heard = new Map(); for (const s of timeline) if (s.id) heard.set(s.id, (heard.get(s.id) || 0) + 1);
console.log('share:', [...heard.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / timeline.length).toFixed(0)}%`).join('  '));

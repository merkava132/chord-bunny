// Per-frame features for the guitar-likeness gate (src/dsp/gate.js), from
// the player's own recordings and GuitarSet, written as JSONL so rules can
// be tried offline in seconds.
//   node tools/gate_features.mjs [--out=/mnt/aegis/chord-bunny/gate/features.jsonl] [--gs=8]
// Labels: guitar = 50–500 ms after a telemetry strum in a practice session
// (before any annotated noise range), tv = frames inside data/user/sessions.json
// noise ranges, gs = GuitarSet frames with ≥3 strings ringing, other = the rest.
import fs from 'node:fs';
import path from 'node:path';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { decodeWav } from '../src/dsp/wav.js';
import { buildTemplates, scoreTemplates, confidenceOf } from '../src/detect.js';
import { CONFIG } from '../src/config.js';
import { GuitarGate } from '../src/dsp/gate.js';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
const OUT = args.out || '/mnt/aegis/chord-bunny/gate/features.jsonl';
const REC = '/mnt/aegis/chord-bunny/recordings';
const MAIN = '/home/sanctumsanctorum/projects/chord-bunny';   // sessions and annotations live in the main checkout (gitignored)
const TEL = args['tel-dir'] || (fs.existsSync(path.resolve(import.meta.dirname, '../telemetry/2026-09-25T02-32-27-ho9k.jsonl')) ? path.resolve(import.meta.dirname, '../telemetry') : path.join(MAIN, 'telemetry'));
const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const PARTIALS = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const META = (() => { for (const p of [new URL('../data/user/sessions.json', import.meta.url), path.join(MAIN, 'data/user/sessions.json')]) { try { return JSON.parse(fs.readFileSync(p)); } catch {} } return {}; })();
const T = buildTemplates(CHORDS.filter(c => c.category === 'basic'));
const N = CONFIG.detect.fftSize, HOP = CONFIG.detect.hop, EMA = CONFIG.detect.ema;
const out = fs.createWriteStream(OUT);
let n = 0;

// run one sample buffer through the analyzer chain, calling label(ts) per frame
function run(samples, sr, tsOf, label, tag) {
  const an = new PitchAnalyzer({ sampleRate: sr, fftSize: N, profiles: PARTIALS });
  const sm = new Float32Array(an.nP), gate = new GuitarGate();
  for (const { start, frame } of frames(samples, N, HOP)) {
    const ts = tsOf(start + N / 2), level = rms(frame);
    if (level < CONFIG.detect.rmsGate) { gate.silent(); continue; }
    const lab = label(ts); if (!lab) continue;
    const act = an.analyze(frame);
    for (let i = 0; i < an.nP; i++) sm[i] = EMA * sm[i] + (1 - EMA) * act[i];
    const ch = an.chroma(sm);
    const r = scoreTemplates(ch, T), conf = confidenceOf(r, T);
    const f = GuitarGate.features({ an, act, chroma: ch, level, fit: r.scores[r.best], conf });
    const g = gate.push(f.resid);
    let peak = 0; for (let i = 0; i < frame.length; i++) { const a = Math.abs(frame[i]); if (a > peak) peak = a; }
    out.write(JSON.stringify({ tag, ts: +ts.toFixed(3), label: lab, level: +level.toFixed(4), peak: +peak.toFixed(3), g: +g.toFixed(3), ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, +(+v).toFixed(4)])) }) + '\n');
    n++;
  }
}

for (const sid of ['2026-09-06T07-01-53-zd8g', '2026-09-25T02-32-27-ho9k']) {
  const ev = fs.readFileSync(path.join(TEL, sid + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const strums = ev.filter(e => e.type === 'strum').map(e => e.ts).sort((a, b) => a - b);
  const noise = META[sid]?.noise || [];
  const inNoise = ts => noise.some(([a, b]) => ts >= a + 60 && ts < (b ?? Infinity));   // +60 s: the annotation's start is uncertain
  const beforeNoise = ts => !noise.some(([a]) => ts >= a - 60);
  let si = 0;
  const label = ts => {
    if (inNoise(ts)) return 'tv';
    if (!beforeNoise(ts)) return null;
    while (si < strums.length && strums[si] + 0.5 < ts) si++;
    for (let k = si; k < strums.length && strums[k] + 0.05 <= ts; k++) if (ts >= strums[k] + 0.05 && ts < strums[k] + 0.5) return 'guitar';
    return 'other';
  };
  const segs = fs.readFileSync(path.join(REC, sid, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const sg of segs) {
    si = 0;
    const wav = decodeWav(fs.readFileSync(path.join(REC, sid, `seg-${String(sg.seg).padStart(4, '0')}.wav`)));
    run(wav.samples, wav.sampleRate, i => sg.ts0 + i / wav.sampleRate, label, sid.slice(-4));
  }
  console.log(sid, 'done', n);
}
// GuitarSet: a few comp excerpts, frames with ≥3 strings ringing
const { listExcerpts, loadExcerpt, stringsAt } = await import('./guitarset.mjs');
const names = listExcerpts(f => f.includes('comp')).slice(0, Number(args.gs ?? 8));
for (const name of names) {
  const ex = loadExcerpt(name);
  run(ex.samples, ex.sampleRate, i => i / ex.sampleRate, t => stringsAt(ex.notes, t).filter(m => m > 0).length >= 3 ? 'gs' : null, 'gs');
}
out.end(() => console.log(`wrote ${n} frames to ${OUT}`));

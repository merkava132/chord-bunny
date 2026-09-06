// Bench on the synthetic chord clips (tools/synth_chords.mjs): the app's own
// pipeline (buildTemplates / scoreTemplates / confidenceOf / StableRule, EMA,
// majority-of-5, threshold) on every clip, reported per chord family.
//   node tools/eval_synth.mjs [--sets=all,basic,basic+sus,basic+7ths,mysong] [--variants=clean,restrum,openMuted,missingTop,weakTop,missingInner]
//                             [--profiles=mic|hex] [--sens=0.35] [--cfg=detect.lam:0.4] [--chord=Cmaj7] [--json=out.json] [--confusions]
// Metrics per clip, over frames from 0.35 s after the strum while the level is
// above the gate: recall = share of those frames whose smoothed verdict names
// the target (or a twin with the same notes); fire = StableRule fires the
// target within 1.0 s; wrongFire = it fires something else first.
import fs from 'node:fs';
import path from 'node:path';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { decodeWav } from '../src/dsp/wav.js';
import { buildTemplates, scoreTemplates, confidenceOf, StableRule } from '../src/detect.js';
import { CONFIG, applyOverrides } from '../src/config.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
if (args.cfg) console.log('config overrides:', applyOverrides(args.cfg).join(' '));
if (args.listen) applyOverrides(`detect.sizeBonus:${CONFIG.listen.sizeBonus}`);   // --listen: open-world scoring as in listen mode
const ROOT = path.resolve(import.meta.dirname, '..');
const CHORDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/chords.json')));
const PROFILES = JSON.parse(fs.readFileSync(args.profiles === 'hex' ? path.join(ROOT, 'testdata/notebank/partials_hex.json') : path.join(ROOT, 'data/partials.json')));
const SENS = Number(args.sens ?? 0.35);
const MYSONG = ['Am', 'Asus4', 'Asus2', 'Em', 'C', 'Am7', 'G', 'F', 'Gsus4', 'D', 'Dsus2', 'Fsus4', 'Fmaj7', 'Cmaj7', 'Em7'];
const SETS = {
  all: () => CHORDS,
  basic: () => CHORDS.filter(c => c.category === 'basic'),
  'basic+sus': () => CHORDS.filter(c => ['basic', 'sus'].includes(c.category)),
  'basic+7ths': () => CHORDS.filter(c => ['basic', 'maj7', 'minor7', 'seventh'].includes(c.category)),
  'basic+add9': () => CHORDS.filter(c => ['basic', 'add9'].includes(c.category)),
  'basic+slash': () => CHORDS.filter(c => ['basic', 'slash'].includes(c.category)),
  'basic+barre': () => CHORDS.filter(c => ['basic', 'barre'].includes(c.category)),
  mysong: () => CHORDS.filter(c => c.category === 'basic' || MYSONG.includes(c.id)),
};
const setNames = String(args.sets || 'all,basic,basic+sus,basic+7ths,mysong').split(',');
const variants = new Set(String(args.variants || 'clean,restrum,openMuted,missingTop,weakTop,missingInner').split(','));
const labels = fs.readFileSync(path.join(ROOT, 'testdata/synth/labels.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(l => variants.has(l.variant) && (!args.chord || l.id === args.chord));

// analyse every clip once: per frame (t, level, chroma) — templates are scored per set afterwards
const cache = new Map();
let an = null;
function analyse(file) {
  if (cache.has(file)) return cache.get(file);
  const wav = decodeWav(fs.readFileSync(path.join(ROOT, file)));
  if (!an || an.opts.sampleRate !== wav.sampleRate) an = new PitchAnalyzer({ sampleRate: wav.sampleRate, profiles: PROFILES });
  const N = an.opts.fftSize, sm = new Float32Array(an.nP), out = [];
  for (const { start, frame } of frames(wav.samples, N, CONFIG.detect.hop)) {
    const t = (start + N / 2) / wav.sampleRate, level = rms(frame);
    if (level < CONFIG.detect.rmsGate) { out.push({ t, level, chroma: null }); continue; }
    const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = CONFIG.detect.ema * sm[i] + (1 - CONFIG.detect.ema) * act[i];
    out.push({ t, level, chroma: Float32Array.from(an.chroma(sm)) });
  }
  cache.set(file, out);
  return out;
}

const results = {};
for (const setName of setNames) {
  const cand = SETS[setName]?.(); if (!cand) { console.error(`unknown set ${setName}`); continue; }
  const T = buildTemplates(cand);
  const inSet = new Set(cand.map(c => c.id));
  const fam = {};   // category → { clips, recall, fire, wrong, conf, confusions }
  for (const l of labels) {
    if (!inSet.has(l.id)) continue;                       // a chord outside the candidate set can't be recognised; skip
    const fr = analyse(l.file);
    const tgt = T.find(x => x.ids.includes(l.id));
    const hist = [], rule = new StableRule();
    let n = 0, hit = 0, confSum = 0, fired = null, firedAt = null, wrong = null; const conf = new Map();
    for (const f of fr) {
      let id = null;
      if (!f.chroma) { hist.length = 0; rule.push(f.t, null, true); continue; }
      const r = scoreTemplates(f.chroma, T), c = confidenceOf(r, T);
      hist.push(c >= SENS ? T[r.best].id : null); if (hist.length > CONFIG.detect.smoothingLen) hist.shift();
      const m = new Map(); for (const h of hist) m.set(h, (m.get(h) || 0) + 1);
      let bp = null, bc = 0; for (const [k, v] of m) if (v > bc) { bc = v; bp = k; }
      id = bc >= Math.ceil(CONFIG.detect.smoothingLen * 0.6) ? bp : null;
      const fire = rule.push(f.t, id);
      if (fire && f.t <= 1.0 && fired === null) { if (tgt.ids.includes(fire)) { fired = true; firedAt = f.t; } else { fired = false; wrong = fire; } }
      if (f.t < 0.35 || f.t > (l.restrumAt ? l.restrumAt + 1.3 : 1.3) || (l.restrumAt && f.t >= l.restrumAt && f.t < l.restrumAt + 0.35)) continue;   // ringing window
      n++; confSum += c;
      if (id && tgt.ids.includes(id)) hit++; else if (id) conf.set(id, (conf.get(id) || 0) + 1);
    }
    const e = fam[l.category] ||= { clips: 0, frames: 0, hit: 0, fire: 0, wrong: 0, conf: 0, byChord: {}, confusions: new Map() };
    e.clips++; e.frames += n; e.hit += hit; e.conf += confSum; if (fired === true) e.fire++; if (fired === false) e.wrong++;
    const bc = e.byChord[l.id] ||= { clips: 0, frames: 0, hit: 0, fire: 0 }; bc.clips++; bc.frames += n; bc.hit += hit; if (fired === true) bc.fire++;
    for (const [k, v] of conf) e.confusions.set(`${l.id}→${k}`, (e.confusions.get(`${l.id}→${k}`) || 0) + v);
  }
  results[setName] = fam;
  console.log(`\n== candidates: ${setName} (${T.length} templates, profiles=${args.profiles || 'mic'}, variants=${[...variants].join('/')})`);
  console.log('family    clips  recall  fire≤1s  wrongfire  conf');
  const order = ['basic', 'barre', 'sus', 'add9', 'maj7', 'minor7', 'seventh', 'slash'];
  for (const f of order) { const e = fam[f]; if (!e) continue;
    console.log(`${f.padEnd(9)} ${String(e.clips).padStart(4)}   ${(100 * e.hit / Math.max(1, e.frames)).toFixed(0).padStart(4)}%   ${(100 * e.fire / e.clips).toFixed(0).padStart(4)}%     ${(100 * e.wrong / e.clips).toFixed(0).padStart(4)}%   ${(e.conf / Math.max(1, e.frames)).toFixed(2)}`); }
  if (args.confusions) for (const f of order) { const e = fam[f]; if (!e) continue;
    const top = [...e.confusions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(100 * v / e.frames).toFixed(0)}%`).join(', ');
    if (top) console.log(`  ${f}: ${top}`); }
  if (args.chords) for (const f of order) { const e = fam[f]; if (!e) continue;
    console.log(`  ${f}: ` + Object.entries(e.byChord).map(([id, b]) => `${id} ${(100 * b.hit / Math.max(1, b.frames)).toFixed(0)}%/${(100 * b.fire / b.clips).toFixed(0)}%`).join('  ')); }
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify(results, (k, v) => v instanceof Map ? Object.fromEntries(v) : v, 1));

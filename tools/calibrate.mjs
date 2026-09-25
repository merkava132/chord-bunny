// Confidence calibration for the app scorer (src/detect.js): coverage vs
// precision per threshold, for a candidate set.
//   node tools/calibrate.mjs [--chords=basic,sus,...|ids] [--margin=0.5] [--fitw=0.5] [--gt=performed]
import fs from 'node:fs';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { APP_CHORDS, listExcerpts, loadExcerpt, chordAt, stringsAt } from './guitarset.mjs';
import { buildTemplates, scoreTemplates, confidenceOf, CONF } from '../src/detect.js';
import { Featurizer, scoreModel, loadModelFile } from '../src/model.js';
import { CONFIG, applyOverrides } from '../src/config.js';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
if (args.cfg) console.log('config overrides:', applyOverrides(args.cfg).join(' '));   // --cfg=detect.lam:0.4,...
if (args.listen) applyOverrides(`detect.sizeBonus:${CONFIG.listen.sizeBonus}`);   // --listen: open-world scoring as in listen mode
if (args.margin) CONF.margin = Number(args.margin);
if (args.fitw) CONF.fitWeight = Number(args.fitw);
const CAND = args.chords ? new Set(String(args.chords).split(',')) : null;
const T = buildTemplates(CAND ? APP_CHORDS.filter(c => CAND.has(c.category) || CAND.has(c.id)) : APP_CHORDS);
// --model[=path]: the learned classifier's posterior as confidence; --players=01,03 restricts to those players
const MODEL = args.model ? await loadModelFile(new URL(args.model === true ? '../' + CONFIG.model.path : args.model, import.meta.url).pathname) : null;
if (args.model && !MODEL) { console.error('no model file'); process.exit(1); }
const CLS = MODEL ? T.map(t => MODEL.classOf(t)) : null, MSCORES = new Array(T.length);
const PLAYERS = args.players ? new Set(String(args.players).split(',')) : null;
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const rows = [];   // { conf, ok, chordFrame }
for (const name of listExcerpts(f => f.includes('comp') && ['SS3', 'Rock3', 'Rock1'].some(s => f.includes(s)) && (!PLAYERS || PLAYERS.has(f.slice(0, 2))))) {
  const ex = loadExcerpt(name);
  const an = new PitchAnalyzer({ sampleRate: ex.sampleRate, profiles: PROFILES });
  const sm = new Float32Array(an.nP), fz = MODEL ? new Featurizer(an.nP) : null;
  for (const { start, frame } of frames(ex.samples, 8192, 1024)) {
    const t = (start + 4096) / ex.sampleRate;
    if (rms(frame) < 0.006) continue;
    const act = an.analyze(frame);
    const r = MODEL ? scoreModel(MODEL, MODEL.forward(fz.push(act)), T, MSCORES, CLS) : null;
    for (let i = 0; i < an.nP; i++) sm[i] = 0.5 * sm[i] + 0.5 * act[i];
    const ch = an.chroma(sm);
    const res = r || scoreTemplates(ch, T);
    const conf = confidenceOf(res, T);
    const gt = chordAt(args.gt === 'performed' ? ex.performed : ex.chords, t)?.appId;
    const chordFrame = !!gt && stringsAt(ex.notes, t).filter(m => m > 0).length >= 3;
    rows.push({ conf, ok: !!gt && T[res.best].ids.includes(gt), chordFrame });
  }
}
console.log(`cand=${T.length} templates ${MODEL ? 'scorer=model' : `margin=${CONF.margin} fitw=${CONF.fitWeight}`}${PLAYERS ? ` players=${[...PLAYERS].join(',')}` : ''}: ${rows.length} frames (${rows.filter(r => r.chordFrame).length} chord frames)`);
console.log('thr   coverage(chord frames)  precision(verdicts on chord frames)');
for (const thr of MODEL ? [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] : [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6]) {
  const cf = rows.filter(r => r.chordFrame), v = cf.filter(r => r.conf >= thr);
  console.log(`${thr.toFixed(2)}  ${(100 * v.length / cf.length).toFixed(0).padStart(4)}%                  ${(100 * v.filter(r => r.ok).length / Math.max(1, v.length)).toFixed(0).padStart(4)}%`);
}

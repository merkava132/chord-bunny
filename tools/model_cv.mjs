// Leave-one-player-out cross-validation of the learned classifier against the
// template scorer, on the same frames, so the numbers line up with
// docs/BENCH.md (all six GuitarSet players): for each player, train a model
// on the other five (+ synth clips not built from that player's notes, + the
// player's own sessions if given) and score that player's excerpts with
// tools/eval_chords.mjs --model.
//   node tools/model_cv.mjs [--players=00,01,02,03,04,05] [--hidden=64] [--dropout=0.2] [--noise=0.1] [--epochs=14]
//                           [--sessions=id] [--out=/mnt/aegis/chord-bunny/features/cv] [--json=docs/model_cv.json]
// Prints frame-weighted accuracy for basic candidates (instructed labels) and
// all candidates (open-world scoring), and extended-chord recall by family on
// performed labels, templates vs model.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
const PLAYERS = String(args.players || '00,01,02,03,04,05').split(',');
const OUT = args.out || '/mnt/aegis/chord-bunny/features/cv';
fs.mkdirSync(OUT, { recursive: true });
const run = (tool, a) => execFileSync(process.execPath, [path.join(ROOT, 'tools', tool), ...a], { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26 });
const trainArgs = ['--hidden=' + (args.hidden || 64), '--dropout=' + (args.dropout ?? 0.2), '--noise=' + (args.noise ?? 0.1), '--epochs=' + (args.epochs || 14), '--stride=' + (args.stride || 1)];

// eval_chords prints "  old=..%  app=..%  model=..%  ...  [N chord frames]"
const parseEval = (out) => {
  const last = out.trim().split('\n').pop();
  const n = Number(/\[(\d+) chord frames\]/.exec(last)?.[1] || 0);
  const get = (k) => Number(new RegExp(`\\b${k}=([\\d.]+)%`).exec(last)?.[1] || 0) / 100;
  return { n, app: get('app'), model: get('model') };
};
// --dump=<scorer> prints "[scorer] by GT family: basic 71% (n=17208), maj7 ..."
const parseFamilies = (out, scorer) => {
  const line = out.split('\n').find(l => l.startsWith(`[${scorer}] by GT family:`)) || '';
  const fam = {};
  for (const m of line.matchAll(/(\w+) (\d+)% \(n=(\d+)\)/g)) fam[m[1]] = { acc: Number(m[2]) / 100, n: Number(m[3]) };
  return fam;
};

const folds = [];
const t0 = performance.now();
for (const p of PLAYERS) {
  const model = path.join(OUT, `model-holdout-${p}.json`);
  const log = run('train_model.mjs', ['train', `--holdout=${p}`, ...trainArgs, `--write=${model}`, ...(args.sessions ? [`--sessions=${args.sessions}`] : [])]);
  const best = /best epoch (\d+), holdout chord-frame acc ([\d.]+)%/.exec(log);
  const basic = parseEval(run('eval_chords.mjs', [`--model=${model}`, `--players=${p}`, '--chords=basic']));
  const all = parseEval(run('eval_chords.mjs', [`--model=${model}`, `--players=${p}`, '--listen']));
  const perfT = run('eval_chords.mjs', [`--model=${model}`, `--players=${p}`, '--subset=all', '--gt=performed', '--chords=basic,maj7,minor7,seventh', '--dump=app']);
  const perfM = run('eval_chords.mjs', [`--model=${model}`, `--players=${p}`, '--subset=all', '--gt=performed', '--chords=basic,maj7,minor7,seventh', '--dump=model']);
  const fold = { player: p, rawFrameAcc: best ? Number(best[2]) / 100 : null, bestEpoch: best ? Number(best[1]) : null, basic, all, familiesT: parseFamilies(perfT, 'app'), familiesM: parseFamilies(perfM, 'model') };
  folds.push(fold);
  console.log(`player ${p}: raw-frame ${best?.[2]}% (epoch ${best?.[1]})  basic: templates ${(100 * basic.app).toFixed(1)}% model ${(100 * basic.model).toFixed(1)}% (n=${basic.n})  all: templates ${(100 * all.app).toFixed(1)}% model ${(100 * all.model).toFixed(1)}% (n=${all.n})  (${((performance.now() - t0) / 60000).toFixed(1)} min)`);
}
const agg = (key, who) => { let h = 0, n = 0; for (const f of folds) { h += f[key][who] * f[key].n; n += f[key].n; } return { acc: h / Math.max(1, n), n }; };
const famAgg = (which) => { const out = {}; for (const f of folds) for (const [k, v] of Object.entries(f[which])) { const o = out[k] ||= { hit: 0, n: 0 }; o.hit += v.acc * v.n; o.n += v.n; } return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { acc: v.hit / Math.max(1, v.n), n: v.n }])); };
const summary = { basic: { templates: agg('basic', 'app'), model: agg('basic', 'model') }, all: { templates: agg('all', 'app'), model: agg('all', 'model') }, families: { templates: famAgg('familiesT'), model: famAgg('familiesM') }, folds, trainArgs };
console.log('\nleave-one-player-out, frame-weighted over all six players:');
console.log(`  open subset, basic candidates (instructed):  templates ${(100 * summary.basic.templates.acc).toFixed(1)}%  model ${(100 * summary.basic.model.acc).toFixed(1)}%  (${summary.basic.templates.n} chord frames)`);
console.log(`  open subset, all candidates (open world):    templates ${(100 * summary.all.templates.acc).toFixed(1)}%  model ${(100 * summary.all.model.acc).toFixed(1)}%`);
console.log('  all files, performed labels, basic+7ths candidates, recall by family:');
for (const k of Object.keys(summary.families.templates)) console.log(`    ${k.padEnd(8)} templates ${(100 * summary.families.templates[k].acc).toFixed(0)}%  model ${(100 * (summary.families.model[k]?.acc || 0)).toFixed(0)}%  (n=${summary.families.templates[k].n})`);
if (args.json) fs.writeFileSync(path.resolve(ROOT, args.json), JSON.stringify(summary, null, 1));

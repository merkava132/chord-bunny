// Train the learned frame classifier (src/model.js) — pure JS, no deps.
//
//   node tools/train_model.mjs extract [--gs=DIR] [--synth=DIR] [--sessions=id,id] [--out=DIR] [--workers=N]
//       Per-frame features (Featurizer) + class labels for every source, one
//       .f32/.lab pair per file under --out (default /mnt/aegis/chord-bunny/features).
//       Sources: GuitarSet excerpts (audio/ + jams/ under --gs; performed label
//       when the app knows the chord, else the lead-sheet one; ≥2 strings
//       ringing → chord, 0 → "none", 1 → skipped; label N with sound → none),
//       synthetic chord clips (labels.jsonl under --synth; frames ≥ 0.1 s after
//       the strum → the intended chord), the player's own matched practice
//       intervals (recordings + labels.jsonl for --sessions), and optional
//       noise files (--noise=DIR of WAVs → none).
//   node tools/train_model.mjs train [--holdout=01,03] [--hidden=96] [--epochs=16] [--lr=2e-3]
//       [--stride=2] [--no-synth] [--no-user] [--write=data/model.json] [--seed=1]
//       Held-out GuitarSet players never enter training; synth clips whose notes
//       came from a held-out player's hex takes are dropped too (timbre leak).
//       Prints per-epoch validation accuracy on the held-out players.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { decodeWav } from '../src/dsp/wav.js';
import { buildTemplates, pcKey, scoreTemplates } from '../src/detect.js';
import { CONFIG } from '../src/config.js';
import { Featurizer, NONE, featureDim } from '../src/model.js';
import { loadExcerpt, listExcerpts, chordAt, stringsAt } from './guitarset.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = Object.fromEntries(process.argv.slice(3).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
const CHORDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/chords.json')));
const PARTIALS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/partials.json')));
export const CLASSES = [...buildTemplates(CHORDS).map(t => t.pcs.join(',')), NONE];
const CLASS_INDEX = new Map(CLASSES.map((c, i) => [c, i]));
const CLASS_OF_ID = new Map(CHORDS.map(c => [c.id, CLASS_INDEX.get(pcKey(c))]));
const NONE_IDX = CLASSES.length - 1;
const N = CONFIG.detect.fftSize, HOP = CONFIG.detect.hop, GATE = CONFIG.detect.rmsGate;
const NP = 42, DIM = featureDim(NP);
const FEAT_DIR = args.out || '/mnt/aegis/chord-bunny/features';

// ---------- extraction (runs in workers) ----------
// One analyzer per sample rate; frames below the gate are skipped without
// touching the featurizer's context, exactly as ChordDetector does.
const analyzers = new Map();
function analyzerFor(sr) { if (!analyzers.has(sr)) analyzers.set(sr, new PitchAnalyzer({ sampleRate: sr, fftSize: N, profiles: PARTIALS })); return analyzers.get(sr); }

// Augmentation (--augment=N extra copies per source): pink noise at a random
// SNR (8–30 dB re the clip's RMS) and a random first-order spectral tilt
// (±6 dB/octave-ish), so the model meets mics, rooms and gains it has not
// seen — the player's own recordings are noisier and duller than GuitarSet's.
function augment(samples, rnd) {
  const out = new Float32Array(samples.length);
  let ss = 0; for (const v of samples) ss += v * v; const rms0 = Math.sqrt(ss / samples.length) || 1e-4;
  const snrDb = 8 + 22 * rnd(), noiseRms = rms0 / Math.pow(10, snrDb / 20);
  const tilt = (rnd() - 0.5) * 0.8;                     // y = x + tilt·(x − x[n−1]) : >0 brightens, <0 dulls
  let b0 = 0, b1 = 0, b2 = 0, prev = 0;                 // Paul Kellet's pink-noise filter (economy version)
  for (let i = 0; i < samples.length; i++) {
    const w = 2 * rnd() - 1;
    b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
    const pink = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    const x = samples[i];
    out[i] = x + tilt * (x - prev) + pink * noiseRms;
    prev = x;
  }
  return out;
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// samples → rows of [features, label] for frames where labelAt(t) ≥ 0
function extractSamples(samples, sr, labelAt) {
  const an = analyzerFor(sr), fz = new Featurizer(an.nP), feats = [], labels = [];
  for (const { start, frame } of frames(samples, N, HOP)) {
    const t = (start + N / 2) / sr;
    if (rms(frame) < GATE) continue;
    const f = fz.push(an.analyze(frame));
    const y = labelAt(t);
    if (y < 0) continue;
    feats.push(Float32Array.from(f)); labels.push(y);
  }
  return { feats, labels };
}

function extractGuitarSet(name, dir) {
  const ex = loadExcerpt(name, dir);
  const labelAt = (t) => {
    const perf = chordAt(ex.performed, t), inst = chordAt(ex.chords, t);
    const id = perf?.appId || inst?.appId || null;
    const ringing = stringsAt(ex.notes, t).filter(m => m > 0).length;
    if (id) return ringing >= 2 ? CLASS_OF_ID.get(id) : ringing === 0 ? NONE_IDX : -1;
    const lab = perf?.label || inst?.label;
    if (lab === 'N' && ringing === 0) return NONE_IDX;
    return -1;                                          // a chord the app does not know (jazz voicings) or a lone note
  };
  return { ...extractSamples(maybeAugment(ex.samples, ex.sampleRate), ex.sampleRate, labelAt), meta: { kind: 'gs', name, player: name.slice(0, 2), sr: ex.sampleRate } };
}

function extractSynth(label, synthDir) {
  const file = path.isAbsolute(label.file) ? label.file : path.join(synthDir, path.relative(path.join(ROOT, 'testdata/synth'), path.join(ROOT, label.file)));
  const wav = decodeWav(fs.readFileSync(file));
  const cls = CLASS_OF_ID.get(label.id);
  const players = [...new Set(label.notes.map(n => n.src.slice(0, 2)))];
  return { ...extractSamples(maybeAugment(wav.samples, wav.sampleRate), wav.sampleRate, (t) => t >= 0.1 ? cls : -1), meta: { kind: 'synth', name: `${label.id}-${label.variant}-${path.basename(label.file, '.wav')}`, id: label.id, variant: label.variant, players, sr: wav.sampleRate } };
}

function extractSession(sid, recDir) {
  const dir = path.join(recDir, sid);
  const rows = fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.matched && r.matchedAt !== null);
  const segs = fs.readFileSync(path.join(dir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const feats = [], labels = [];
  for (const seg of segs) {
    const mine = rows.filter(r => r.seg === seg.seg).map(r => ({ a: Math.max(r.ts0 + 0.8, r.matchedAt - 1.5), b: r.matchedAt + 0.3, y: CLASS_OF_ID.get(r.target) }));
    if (!mine.length) continue;
    const wav = decodeWav(fs.readFileSync(path.join(dir, `seg-${String(seg.seg).padStart(4, '0')}.wav`)));
    const r = extractSamples(maybeAugment(wav.samples, wav.sampleRate), wav.sampleRate, (t) => { const ts = seg.ts0 + t; for (const m of mine) if (ts >= m.a && ts < m.b) return m.y; return -1; });
    feats.push(...r.feats); labels.push(...r.labels);
  }
  return { feats, labels, meta: { kind: 'user', name: sid, sr: 48000 } };
}

function extractNoise(file) {
  const wav = decodeWav(fs.readFileSync(file));
  return { ...extractSamples(wav.samples, wav.sampleRate, () => NONE_IDX), meta: { kind: 'noise', name: path.basename(file, '.wav'), sr: wav.sampleRate } };
}

function writeFeatures(outDir, key, r) {
  if (!r.labels.length) return 0;
  const n = r.labels.length, f = new Float32Array(n * DIM);
  for (let i = 0; i < n; i++) f.set(r.feats[i], i * DIM);
  fs.writeFileSync(path.join(outDir, key + '.f32'), Buffer.from(f.buffer));
  fs.writeFileSync(path.join(outDir, key + '.lab'), Buffer.from(Int16Array.from(r.labels).buffer));
  fs.writeFileSync(path.join(outDir, key + '.json'), JSON.stringify({ ...r.meta, n, dim: DIM, classes: CLASSES.length }));
  return n;
}

let AUG = null;   // set per task: a (samples, sr) → samples transform, or null
const maybeAugment = (samples, sr) => AUG ? AUG(samples, sr) : samples;
if (!isMainThread) {
  const { tasks, outDir } = workerData;
  let n = 0;
  for (const t of tasks) {
    AUG = t.aug ? ((samples) => augment(samples, rng(t.aug))) : null;
    const r = t.kind === 'gs' ? extractGuitarSet(t.name, t.dir) : t.kind === 'synth' ? extractSynth(t.label, t.dir) : t.kind === 'user' ? extractSession(t.sid, t.dir) : extractNoise(t.file);
    if (t.aug) r.meta.aug = t.aug;
    n += writeFeatures(outDir, t.key, r);
  }
  parentPort.postMessage(n);
} else {
  const cmd = process.argv[2];
  if (cmd === 'extract') await extract();
  else if (cmd === 'train') await train();
  else { console.error('usage: node tools/train_model.mjs extract|train [options]'); process.exit(1); }
}

// ---------- extract: fan the sources out over workers ----------
async function extract() {
  const gsDir = args.gs || '/mnt/aegis/chord-bunny/guitarset';
  const synthDir = args.synth || '/mnt/aegis/chord-bunny/synth';
  const recDir = args['rec-dir'] || '/mnt/aegis/chord-bunny/recordings';
  const sessions = args.sessions ? String(args.sessions).split(',') : [];
  fs.mkdirSync(FEAT_DIR, { recursive: true });
  const tasks = [];
  if (fs.existsSync(path.join(gsDir, 'audio'))) for (const name of listExcerpts(() => true, gsDir)) tasks.push({ kind: 'gs', name, dir: gsDir, key: `gs-${name}` });
  if (fs.existsSync(path.join(synthDir, 'labels.jsonl'))) for (const [i, l] of fs.readFileSync(path.join(synthDir, 'labels.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).entries()) tasks.push({ kind: 'synth', label: { ...l, file: path.join(synthDir, l.file.replace(/^.*\/synth\//, '')) }, dir: synthDir, key: `synth-${String(i).padStart(4, '0')}` });
  for (const sid of sessions) tasks.push({ kind: 'user', sid, dir: recDir, key: `user-${sid}` });
  if (args.noise) for (const f of fs.readdirSync(args.noise).filter(f => f.endsWith('.wav'))) tasks.push({ kind: 'noise', file: path.join(args.noise, f), key: `noise-${path.basename(f, '.wav')}` });
  const NAUG = Number(args.augment || 0);   // extra augmented copies of every guitar source (not of noise files)
  for (const t of [...tasks]) if (t.kind !== 'noise') for (let a = 1; a <= NAUG; a++) tasks.push({ ...t, key: `${t.key}.aug${a}`, aug: a * 7919 + tasks.length });
  const fresh = tasks.filter(t => args.force || !fs.existsSync(path.join(FEAT_DIR, t.key + '.json')));
  console.log(`${tasks.length} sources (${fresh.length} to extract) → ${FEAT_DIR}; classes ${CLASSES.length}, dim ${DIM}`);
  const W = Math.min(Number(args.workers || Math.max(1, os.cpus().length - 2)), Math.max(1, fresh.length));
  const t0 = performance.now();
  let done = 0;
  await Promise.all(Array.from({ length: W }, (_, w) => new Promise((resolve, reject) => {
    const mine = fresh.filter((_, i) => i % W === w);
    if (!mine.length) return resolve();
    const worker = new Worker(new URL(import.meta.url), { workerData: { tasks: mine, outDir: FEAT_DIR }, argv: process.argv.slice(2) });
    worker.on('message', (n) => { done += n; });
    worker.on('error', reject);
    worker.on('exit', (c) => c === 0 ? resolve() : reject(new Error(`worker ${w} exit ${c}`)));
  })));
  console.log(`extracted ${done} frames in ${((performance.now() - t0) / 1000).toFixed(0)} s with ${W} workers`);
}

// ---------- train ----------
function loadFeatureSets(filter) {
  const metas = fs.readdirSync(FEAT_DIR).filter(f => f.endsWith('.json')).map(f => ({ key: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(FEAT_DIR, f), 'utf8')) })).filter(m => m.dim === DIM && m.classes === CLASSES.length && filter(m));
  const total = metas.reduce((s, m) => s + m.n, 0);
  const X = new Float32Array(total * DIM), Y = new Int16Array(total), src = new Uint8Array(total);
  let o = 0;
  for (const m of metas) {
    const b = fs.readFileSync(path.join(FEAT_DIR, m.key + '.f32')), l = fs.readFileSync(path.join(FEAT_DIR, m.key + '.lab'));
    X.set(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4), o * DIM);
    Y.set(new Int16Array(l.buffer, l.byteOffset, l.byteLength / 2), o);
    src.fill(m.kind === 'gs' ? 0 : m.kind === 'synth' ? 1 : m.kind === 'user' ? 2 : 3, o, o + m.n);
    o += m.n;
  }
  return { X, Y, src, n: total, metas };
}

async function train() {
  const holdout = new Set(args.holdout === undefined ? ['01', '03'] : String(args.holdout).split(',').filter(Boolean));
  const H = Number(args.hidden || 96), EPOCHS = Number(args.epochs || 16), LR0 = Number(args.lr || 2e-3), STRIDE = Number(args.stride || 2), SEED = Number(args.seed || 1), WD = Number(args.wd ?? 1e-5), BATCH = 256;
  const isTrain = (m) => (!m.aug || !args['no-aug']) && (m.kind === 'gs' ? !holdout.has(m.player)
    : m.kind === 'synth' ? !args['no-synth'] && !m.players.some(p => holdout.has(p))
    : m.kind === 'user' ? !args['no-user'] : !args['no-noise']);
  const USER_W = Number(args['user-weight'] || 1);   // oversample the player's own frames this many times
  const tr = loadFeatureSets(isTrain), va = loadFeatureSets(m => m.kind === 'gs' && !m.aug && holdout.has(m.player));
  const counts = new Int32Array(CLASSES.length); for (let i = 0; i < tr.n; i += STRIDE) counts[tr.Y[i]]++;
  const bySrc = [0, 0, 0, 0]; for (let i = 0; i < tr.n; i++) bySrc[tr.src[i]]++;
  console.log(`train: ${tr.n} frames (${tr.metas.length} sources: guitarset ${bySrc[0]}, synth ${bySrc[1]}, user ${bySrc[2]}, noise ${bySrc[3]}), stride ${STRIDE}; holdout players ${[...holdout].join(',') || 'none'}: ${va.n} frames`);
  const nTrain = Math.ceil(tr.n / STRIDE);
  // class weights: inverse sqrt frequency, clipped
  const mean = nTrain / CLASSES.length, cw = new Float32Array(CLASSES.length);
  for (let c = 0; c < CLASSES.length; c++) cw[c] = counts[c] ? Math.min(4, Math.max(0.25, Math.sqrt(mean / counts[c]))) : 0;
  console.log('frames per class (train):', CLASSES.map((c, i) => `${c === NONE ? 'none' : (CHORDS.find(x => pcKey(x) === c)?.id || c)}:${counts[i]}`).join(' '));
  // standardisation
  const mu = new Float64Array(DIM), sd = new Float64Array(DIM);
  for (let i = 0; i < tr.n; i += STRIDE) for (let k = 0; k < DIM; k++) mu[k] += tr.X[i * DIM + k];
  for (let k = 0; k < DIM; k++) mu[k] /= nTrain;
  for (let i = 0; i < tr.n; i += STRIDE) for (let k = 0; k < DIM; k++) { const d = tr.X[i * DIM + k] - mu[k]; sd[k] += d * d; }
  for (let k = 0; k < DIM; k++) sd[k] = Math.sqrt(sd[k] / nTrain) || 1;
  // parameters (He init) + Adam state
  const C = CLASSES.length, rnd = rng(SEED);
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const W1 = new Float32Array(H * DIM), b1 = new Float32Array(H), W2 = new Float32Array(C * H), b2 = new Float32Array(C);
  for (let i = 0; i < W1.length; i++) W1[i] = gauss() * Math.sqrt(2 / DIM);
  for (let i = 0; i < W2.length; i++) W2[i] = gauss() * Math.sqrt(2 / H);
  const P = [W1, b1, W2, b2], G = P.map(p => new Float32Array(p.length)), M = P.map(p => new Float32Array(p.length)), V = P.map(p => new Float32Array(p.length));
  const x = new Float32Array(DIM), h = new Float32Array(H), z = new Float32Array(C), dz = new Float32Array(C), dh = new Float32Array(H);
  const forward = (X, i) => {
    for (let k = 0; k < DIM; k++) x[k] = (X[i * DIM + k] - mu[k]) / sd[k];
    for (let j = 0; j < H; j++) { let s = b1[j]; const row = j * DIM; for (let k = 0; k < DIM; k++) s += W1[row + k] * x[k]; h[j] = s > 0 ? s : 0; }
    let mx = -Infinity;
    for (let c = 0; c < C; c++) { let s = b2[c]; const row = c * H; for (let j = 0; j < H; j++) s += W2[row + j] * h[j]; z[c] = s; if (s > mx) mx = s; }
    let Z = 0; for (let c = 0; c < C; c++) { z[c] = Math.exp(z[c] - mx); Z += z[c]; }
    for (let c = 0; c < C; c++) z[c] /= Z;                 // z = softmax
  };
  // The template scorer on the same held-out frames (chroma rebuilt from the
  // current frame's block of the feature vector; no EMA) — the raw-frame
  // baseline the model has to beat before the smoothing pipeline is even involved.
  const T_ALL = buildTemplates(CHORDS), tplClass = T_ALL.map(t => CLASS_INDEX.get(t.pcs.join(',')));
  const PITCH_W = Float32Array.from({ length: NP }, (_, i) => { const m = 40 + i; return m <= 64 ? 1 : Math.max(0.25, 1 - 0.75 * (m - 64) / 17); });
  const chromaOf = (X, i, out) => { out.fill(0); let s = 0; for (let k = 0; k < NP; k++) { const a = (Math.exp(X[i * DIM + k] + Math.log(1e-3)) - 1e-3) * PITCH_W[k]; out[(40 + k) % 12] += a; s += a; } if (s > 0) for (let c = 0; c < 12; c++) out[c] /= s; return out; };
  const ch12 = new Float32Array(12), tplScores = new Array(T_ALL.length);
  const evaluate = (S) => {
    const hit = new Int32Array(C), tot = new Int32Array(C); let loss = 0, tplHit = 0, tplTot = 0;
    for (let i = 0; i < S.n; i++) {
      forward(S.X, i); const y = S.Y[i]; let b = 0; for (let c = 1; c < C; c++) if (z[c] > z[b]) b = c;
      tot[y]++; if (b === y) hit[y]++; loss -= Math.log(z[y] + 1e-9);
      if (y !== C - 1) { tplTot++; const r = scoreTemplates(chromaOf(S.X, i, ch12), T_ALL, tplScores); if (tplClass[r.best] === y) tplHit++; }
    }
    let chordHit = 0, chordTot = 0; for (let c = 0; c < C - 1; c++) { chordHit += hit[c]; chordTot += tot[c]; }
    return { loss: loss / Math.max(1, S.n), chordAcc: chordHit / Math.max(1, chordTot), noneAcc: hit[C - 1] / Math.max(1, tot[C - 1]), tplAcc: tplHit / Math.max(1, tplTot), n: S.n };
  };
  const DROPOUT = Number(args.dropout ?? 0), NOISE = Number(args.noise ?? 0);   // hidden-unit dropout; gaussian noise on standardised inputs (train only)
  const mask = new Uint8Array(H);
  let idx = new Uint32Array(nTrain); for (let i = 0; i < nTrain; i++) idx[i] = i * STRIDE;
  if (USER_W > 1) { const extra = []; for (let i = 0; i < tr.n; i += STRIDE) if (tr.src[i] === 2) for (let k = 1; k < USER_W; k++) extra.push(i); idx = Uint32Array.from([...idx, ...extra]); }
  const nIdx = idx.length;
  let step = 0; const t0 = performance.now();
  let best = null;
  for (let ep = 1; ep <= EPOCHS; ep++) {
    const lr = LR0 * (ep <= 6 ? 1 : Math.pow(0.7, ep - 6));
    for (let i = nIdx - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    let lossSum = 0;
    for (let b0 = 0; b0 < nIdx; b0 += BATCH) {
      for (const g of G) g.fill(0);
      const bn = Math.min(BATCH, nIdx - b0);
      for (let bi = 0; bi < bn; bi++) {
        const i = idx[b0 + bi], y = tr.Y[i], w = cw[y];
        forward(tr.X, i);
        if (NOISE > 0 || DROPOUT > 0) {   // re-run the net with noise / dropout applied
          if (NOISE > 0) for (let k = 0; k < DIM; k++) x[k] += NOISE * gauss();
          for (let j = 0; j < H; j++) { let s = b1[j]; const row = j * DIM; for (let k = 0; k < DIM; k++) s += W1[row + k] * x[k]; mask[j] = DROPOUT > 0 && rnd() < DROPOUT ? 0 : 1; h[j] = s > 0 && mask[j] ? s / (1 - DROPOUT) : 0; }
          let mx = -Infinity;
          for (let c = 0; c < C; c++) { let s = b2[c]; const row = c * H; for (let j = 0; j < H; j++) s += W2[row + j] * h[j]; z[c] = s; if (s > mx) mx = s; }
          let Z = 0; for (let c = 0; c < C; c++) { z[c] = Math.exp(z[c] - mx); Z += z[c]; }
          for (let c = 0; c < C; c++) z[c] /= Z;
        }
        lossSum -= w * Math.log(z[y] + 1e-9);
        for (let c = 0; c < C; c++) dz[c] = w * (z[c] - (c === y ? 1 : 0)) / bn;
        for (let j = 0; j < H; j++) { let s = 0; for (let c = 0; c < C; c++) { s += W2[c * H + j] * dz[c]; G[2][c * H + j] += dz[c] * h[j]; } dh[j] = h[j] > 0 ? s : 0; }
        for (let c = 0; c < C; c++) G[3][c] += dz[c];
        for (let j = 0; j < H; j++) { const d = dh[j]; if (d === 0) continue; const row = j * DIM; for (let k = 0; k < DIM; k++) G[0][row + k] += d * x[k]; G[1][j] += d; }
      }
      step++;
      const b1c = 1 - Math.pow(0.9, step), b2c = 1 - Math.pow(0.999, step);
      for (let p = 0; p < P.length; p++) {
        const par = P[p], g = G[p], m = M[p], v = V[p], decay = p % 2 === 0 ? WD : 0;
        for (let k = 0; k < par.length; k++) {
          const gk = g[k] + decay * par[k];
          m[k] = 0.9 * m[k] + 0.1 * gk; v[k] = 0.999 * v[k] + 0.001 * gk * gk;
          par[k] -= lr * (m[k] / b1c) / (Math.sqrt(v[k] / b2c) + 1e-8);
        }
      }
    }
    const ev = va.n ? evaluate(va) : null;
    console.log(`epoch ${String(ep).padStart(2)}  lr ${lr.toExponential(1)}  train loss ${(lossSum / nIdx).toFixed(3)}` + (ev ? `  holdout: loss ${ev.loss.toFixed(3)}  chord-frame acc ${(100 * ev.chordAcc).toFixed(1)}% (templates ${(100 * ev.tplAcc).toFixed(1)}%)  none acc ${(100 * ev.noneAcc).toFixed(1)}%` : '') + `  (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
    if (!ev || !best || ev.chordAcc > best.chordAcc) best = { ...ev, ep, W1: Float32Array.from(W1), b1: Float32Array.from(b1), W2: Float32Array.from(W2), b2: Float32Array.from(b2) };
  }
  if (args.write) {
    const r5 = (a) => Array.from(a, v => +v.toFixed(5));
    const json = { version: 1, dim: DIM, hidden: H, classes: CLASSES, mean: r5(mu), std: r5(sd), W1: r5(best.W1), b1: r5(best.b1), W2: r5(best.W2), b2: r5(best.b2),
      meta: { trainedAt: new Date().toISOString(), holdoutPlayers: [...holdout], epochs: EPOCHS, bestEpoch: best.ep, trainFrames: nTrain, sources: bySrc, holdoutChordFrameAcc: best.chordAcc, holdoutTemplateAcc: best.tplAcc, dropout: DROPOUT, noise: NOISE, seed: SEED } };
    const out = path.resolve(ROOT, args.write);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(json));
    console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, best epoch ${best.ep}, holdout chord-frame acc ${(100 * best.chordAcc).toFixed(1)}%)`);
  }
}

// Learn a personal chroma profile per chord from labelled recordings and
// measure whether it helps, leave-one-interval-out.
//   node tools/learn_profile.mjs [session ...] [--rec-dir DIR] [--alpha=0.5] [--write data/user/profile.json] [--gold-weight=3] [--user-partials=none]
//
// A canonical template scores a chroma q as Σ_{pc∈chord} log(q_pc+ε)/|chord|:
// uniform weights on the chord tones. The personal template replaces the
// uniform weights with the chroma this player's chord actually produces
// (learned from matched practice intervals), blended: w = (1−α)·uniform + α·p.
// Evaluation replays every labelled interval with a profile learned from the
// OTHER intervals: correct-verdict frame share, StableRule fires, delay.
import fs from 'node:fs';
import path from 'node:path';
import { PitchAnalyzer, frames, rms, mergeUserPartials } from '../src/dsp/analyzer.js';
import { OnsetDetector, ENROLL } from '../src/enroll.js';
import { decodeWav } from '../src/dsp/wav.js';
import { buildTemplates, scoreTemplates, confidenceOf, StableRule, PC_INDEX } from '../src/detect.js';
import { CONFIG, applyOverrides } from '../src/config.js';
import { buildLabels } from './session_labels.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
if (args.cfg) applyOverrides(args.cfg);
const TEL = args['tel-dir'] || path.resolve(import.meta.dirname, '../telemetry');   // --tel-dir for another checkout's sessions
const REC = args['rec-dir'] || process.env.CB_REC_DIR || (fs.existsSync('/mnt/aegis/chord-bunny/recordings') ? '/mnt/aegis/chord-bunny/recordings' : path.resolve(import.meta.dirname, '../recordings'));
const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const BASE_PARTIALS = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
// the partial table the live analyzer runs with: GuitarSet corrected by the calibrated response (--user-partials=none to skip)
const upPath = args['user-partials'] === 'none' ? null : path.resolve(import.meta.dirname, '..', CONFIG.profile.partialsPath);
const USER_PARTIALS = upPath && CONFIG.profile.userPartials && fs.existsSync(upPath) ? JSON.parse(fs.readFileSync(upPath, 'utf8')) : null;
const PROFILES = mergeUserPartials(BASE_PARTIALS, USER_PARTIALS);
// Calibration takes (telemetry `enroll`, kind chord) are gold: the app knew what was played. They weigh
// GOLD_W× a practice match and the whole window counts except the attack after each strum.
const GOLD_W = Number(args['gold-weight'] ?? 3), ATTACK_SEC = 0.15;
const ALPHAS = args.alpha ? String(args.alpha).split(',').map(Number) : [0, 0.3, 0.5, 0.7, 1];
const SENS = Number(args.sens ?? 0.35);

let sessions = process.argv.slice(2).filter(a => !a.startsWith('--'));
// no sessions given (or --all): every session that has recordings and telemetry; labels are (re)built
if (!sessions.length || args.all) sessions = fs.readdirSync(REC).filter(d => fs.existsSync(path.join(REC, d, 'segments.jsonl')) && fs.existsSync(path.join(TEL, d + '.jsonl')));
for (const sid of sessions) {
  const rows = buildLabels(sid, { telDir: TEL, recDir: REC });
  if (!rows.length) console.log(`${sid}: no labelled recordings`);
}
sessions = sessions.filter(sid => fs.existsSync(path.join(REC, sid, 'labels.jsonl')));

// ---- 1. gather labelled intervals with per-frame chroma (replayed once) ----
const intervals = [];   // { target, matched, frames: [{ts, chroma, level, silent}] }
for (const sid of sessions) {
  const dir = path.join(REC, sid);
  const labels = fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const lines = fs.readFileSync(path.join(TEL, sid + '.jsonl'), 'utf8').split('\n').filter(Boolean);
  const sessLine = lines.find(l => l.includes('"type":"session"')) || '{}';
  const enabled = new Set(JSON.parse(sessLine).settings?.enabledChords || []);
  const enroll = lines.filter(l => l.includes('"type":"enroll"')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e?.type === 'enroll');
  const segsAll = fs.readFileSync(path.join(dir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const fileOf = (sg) => `seg-${String(sg.seg).padStart(4, '0')}.wav`;
  const cache = new Map();
  const framesOfFile = (file) => {
    if (!cache.has(file)) {
      const wav = decodeWav(fs.readFileSync(path.join(dir, file)));
      const meta = segsAll.find(s => fileOf(s) === file);
      const an = new PitchAnalyzer({ sampleRate: wav.sampleRate, profiles: PROFILES });
      const N = an.opts.fftSize, sm = new Float32Array(an.nP), out = [];
      for (const { start, frame } of frames(wav.samples, N, CONFIG.detect.hop)) {
        const ts = meta.ts0 + (start + N / 2) / wav.sampleRate, level = rms(frame);
        if (level < CONFIG.detect.rmsGate) { out.push({ ts, silent: true, level }); continue; }
        const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = CONFIG.detect.ema * sm[i] + (1 - CONFIG.detect.ema) * act[i];
        out.push({ ts, silent: false, level, chroma: Float32Array.from(an.chroma(sm)) });
      }
      cache.set(file, out);
    }
    return cache.get(file);
  };
  // practice rows that overlap the calibration span are not practice (no pair events are logged while calibrating)
  const span = enroll.length ? [Math.min(...enroll.map(e => e.ts0)) - 0.5, Math.max(...enroll.map(e => e.ts1))] : null;
  for (const r of labels) {
    if (r.shownBecause === 'timer' || r.ts1 - r.ts0 < 1) continue;
    if (span && r.ts1 > span[0] && r.ts0 < span[1]) continue;
    const fr = framesOfFile(r.file).filter(f => f.ts >= r.ts0 - 1 && f.ts < r.ts1);   // 1 s of context for the rule warm-up
    intervals.push({ session: sid, target: r.target, matched: r.matched, matchedAt: r.matchedAt, ts0: r.ts0, ts1: r.ts1, frames: fr, enabled });
  }
  for (const e of enroll.filter(e => e.kind === 'chord')) {
    const covering = segsAll.filter(sg => sg.ts1 > e.ts0 - 1 && sg.ts0 < e.ts1).sort((a, b) => a.ts0 - b.ts0);
    if (!covering.length) continue;
    const fr = [];
    for (const sg of covering) for (const f of framesOfFile(fileOf(sg))) if (f.ts >= e.ts0 - 1 && f.ts < e.ts1) fr.push(f);
    const det = new OnsetDetector(ENROLL), attacks = [];
    for (const f of fr) if (det.push(f.ts, f.level) && f.ts >= e.ts0) attacks.push(f.ts);
    intervals.push({ session: sid, target: e.chord, matched: true, matchedAt: e.ts1, gold: true, attacks, ts0: e.ts0, ts1: e.ts1, frames: fr, enabled });
  }
}
const nGold = intervals.filter(i => i.gold).length, nPractice = intervals.filter(i => !i.gold && i.matched).length;
console.log(`${intervals.length} labelled intervals from ${sessions.length} session(s); matched ${intervals.filter(i => i.matched).length} (${nPractice} practice matches + ${nGold} calibration takes, gold ×${GOLD_W}); partials: ${USER_PARTIALS ? 'calibrated' : 'GuitarSet'}`);

// ---- 2. learn: per chord, the median chroma over the settled part of matched intervals ----
function learn(ivs) {
  const acc = new Map();
  for (const iv of ivs) {
    if (!iv.matched) continue;
    const list = acc.get(iv.target) || acc.set(iv.target, []).get(iv.target);
    if (iv.gold) {   // the whole take, minus the attack after each strum, GOLD_W times
      for (const f of iv.frames) if (!f.silent && f.ts >= iv.ts0 && f.ts < iv.ts1 && !iv.attacks.some(o => f.ts >= o && f.ts < o + ATTACK_SEC)) for (let w = 0; w < GOLD_W; w++) list.push(f.chroma);
      continue;
    }
    const a = Math.max(iv.ts0 + 0.8, iv.matchedAt - 1.5), b = iv.matchedAt + 0.3;
    for (const f of iv.frames) if (!f.silent && f.ts >= a && f.ts < b) list.push(f.chroma);
  }
  const prof = {};
  for (const [id, list] of acc) {
    if (list.length < 15) continue;
    const p = new Array(12).fill(0);
    for (let i = 0; i < 12; i++) { const col = list.map(c => c[i]).sort((x, y) => x - y); p[i] = col[Math.floor(col.length / 2)]; }
    const s = p.reduce((x, y) => x + y, 0); prof[id] = { chroma: p.map(v => +(v / s).toFixed(4)), n: list.length };
  }
  return prof;
}

// ---- 3. evaluate: leave-one-interval-out ----
function evaluate(alpha) {
  let ok = 0, tot = 0, fired = 0, wrong = 0; const delays = [];
  for (let k = 0; k < intervals.length; k++) {
    const iv = intervals[k];
    const prof = alpha > 0 ? learn(intervals.filter((_, j) => j !== k)) : null;
    const cand = CHORDS.filter(c => c.category === 'basic' || iv.enabled.has(c.id));
    const T = buildTemplates(cand, { profile: prof ? { chords: prof } : null, alpha });
    const tgt = T.find(t => t.ids.includes(iv.target));
    const hist = [], rule = new StableRule(); let first = null;
    for (const f of iv.frames) {
      let id = null;
      if (f.silent) hist.length = 0;
      else {
        const r = scoreTemplates(f.chroma, T), conf = confidenceOf(r, T);
        hist.push(conf >= SENS ? T[r.best].id : null); if (hist.length > CONFIG.detect.smoothingLen) hist.shift();
        const m = new Map(); for (const h of hist) m.set(h, (m.get(h) || 0) + 1);
        let bp = null, bc = 0; for (const [x, c] of m) if (c > bc) { bc = c; bp = x; }
        id = bc >= 3 ? bp : null;
        if (f.ts >= iv.ts0 + 1) { tot++; if (id && tgt.ids.includes(id)) ok++; }   // settled frames only
      }
      const fire = rule.push(f.ts, id, f.silent);
      if (fire && f.ts >= iv.ts0) { if (tgt.ids.includes(fire)) { if (first === null) first = f.ts - iv.ts0; } else wrong++; }
    }
    if (first !== null) { fired++; delays.push(first); }
  }
  delays.sort((a, b) => a - b); const q = p => delays.length ? delays[Math.floor(p * (delays.length - 1))].toFixed(2) : '-';
  return { frameAcc: ok / Math.max(1, tot), fired, wrong, p50: q(.5), p90: q(.9) };
}
console.log('alpha  settled-frame accuracy   intervals fired   wrong fires   delay p50 / p90');
for (const a of ALPHAS) { const r = evaluate(a); console.log(`${a.toFixed(1)}    ${(100 * r.frameAcc).toFixed(1).padStart(6)}%                ${String(r.fired).padStart(3)}/${intervals.length}          ${String(r.wrong).padStart(3)}         ${r.p50}s / ${r.p90}s`); }

if (args.write) {
  const prof = learn(intervals);
  const out = { learnedAt: new Date().toISOString(), sessions, alpha: Number(args.alpha) || 0.5, gold: nGold, practiceMatched: nPractice, partials: USER_PARTIALS ? 'calibrated' : 'GuitarSet', chords: prof };
  fs.mkdirSync(path.dirname(args.write), { recursive: true });
  fs.writeFileSync(args.write, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${Object.keys(prof).length} chord profiles to ${args.write}:`, Object.entries(prof).map(([id, p]) => `${id} (n=${p.n})`).join(' '));
}

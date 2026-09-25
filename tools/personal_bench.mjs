// Personal benchmark: the player's own practice takes, replayed offline with
// the detector configured as it was live (enabled chords, sensitivity, min
// hold, personal profile), scored against what the practice screen asked for.
//
// The labels are weak: the first second of a target is the chord change and
// a target with no strums was a pause, not a miss. So only "played" intervals
// count (≥ --min-strums strums, ≥ 1.5 s, some sound after the first second)
// and frame accuracy skips the first second. A session counts by default when
// the app matched ≥ 10 targets in it (the 36-hour open-tab session does not).
//
//   node tools/personal_bench.mjs [session ...] [--all] [--cfg=a.b:v,...]
//        [--profile=PATH|none] [--alpha=0.5] [--sens=0.35] [--hold=350]
//        [--min-strums=2] [--verbose] [--json=FILE] [--write=docs/PERSONAL.md]
//
// Per-frame chroma is cached next to the recordings (cache/seg-NNNN.<key>.f32)
// so config sweeps take seconds; the key covers the analyzer settings that
// shape the chroma (fftSize, hop, ema, rmsGate). Anything downstream —
// templates, profile, scoring, confidence, smoothing, StableRule — is
// recomputed every run, exactly as src/detect.js does it.
import fs from 'node:fs';
import path from 'node:path';
import { PitchAnalyzer, frames, rms, mergeUserPartials } from '../src/dsp/analyzer.js';
import { createHash } from 'node:crypto';
import { decodeWav } from '../src/dsp/wav.js';
import { buildTemplates, scoreTemplates, confidenceOf, StableRule } from '../src/detect.js';
import { Featurizer, scoreModel, mixResult, loadModelFile } from '../src/model.js';
import { CONFIG, applyOverrides, sensitivityFromSlider } from '../src/config.js';
import { buildLabels, DEFAULT_REC, DEFAULT_TEL } from './session_labels.mjs';
import { GuitarGate } from '../src/dsp/gate.js';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
if (args.cfg) console.log('config overrides:', applyOverrides(args.cfg).join(' '));
const TEL = args['tel-dir'] || DEFAULT_TEL, REC = args['rec-dir'] || DEFAULT_REC;
const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const BASE_PARTIALS = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
// --user-partials=none|PATH: the calibration-derived table (default: CONFIG.profile.partialsPath when present)
const upPath = args['user-partials'] === 'none' ? null : (typeof args['user-partials'] === 'string' ? args['user-partials'] : path.resolve(import.meta.dirname, '..', CONFIG.profile.partialsPath));
const USER_PARTIALS = upPath && CONFIG.profile.userPartials && fs.existsSync(upPath) ? JSON.parse(fs.readFileSync(upPath, 'utf8')) : null;
const PARTIALS = mergeUserPartials(BASE_PARTIALS, USER_PARTIALS);
const UP_KEY = USER_PARTIALS ? '.up' + createHash('md5').update(JSON.stringify(PARTIALS)).digest('hex').slice(0, 8) : '';
const PROGRESSIONS = (() => { try { const p = JSON.parse(fs.readFileSync(new URL('../data/progressions.json', import.meta.url))); return Array.isArray(p) ? p : (p.progressions || []); } catch { return []; } })();
const MIN_STRUMS = Number(args['min-strums'] ?? 2), MIN_DUR = 1.5, SETTLE = 1.0, WARMUP = 1.0;
const profilePath = args.profile === 'none' ? null : (args.profile || path.resolve(import.meta.dirname, '..', CONFIG.profile.path));
const PROFILE = profilePath && fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : null;
const ALPHA = args.alpha !== undefined ? Number(args.alpha) : (PROFILE ? CONFIG.profile.alpha : 0);
const L = CONFIG.detect.smoothingLen, NEED = Math.ceil(L * 0.6);
const KEY = `f${CONFIG.detect.fftSize}h${CONFIG.detect.hop}g${CONFIG.detect.rmsGate}${UP_KEY}.act`;   // raw activations depend on the partial table
const PITCHES = []; for (let m = 40; m <= 81; m++) PITCHES.push(m);   // PitchAnalyzer defaults (minMidi..maxMidi)
const NPITCH = PITCHES.length, ROW = 2 + NPITCH;   // ts, level, act[nP]
// guitar-likeness gate (src/dsp/gate.js): --gate forces it on, --no-gate off, default CONFIG.gate.enabled; --gate-thr=X overrides the threshold
const GATE_ON = args['no-gate'] ? false : args.gate ? true : !!CONFIG.gate.enabled;
if (args['gate-thr'] !== undefined) CONFIG.gate.threshold = Number(args['gate-thr']);
if (args['gate-resid'] !== undefined) CONFIG.gate.residMax = Number(args['gate-resid']);
if (args['gate-ema'] !== undefined) CONFIG.gate.ema = Number(args['gate-ema']);
const KNEE = Number(args.knee ?? 64), FLOOR = Number(args.floor ?? 0.25);   // chroma folding (analyzer DEFAULTS chromaKnee / chromaFloor)
const CHROMA_W = Float32Array.from(PITCHES, m => m <= KNEE ? 1 : Math.max(FLOOR, 1 - (1 - FLOOR) * (m - KNEE) / Math.max(1, 81 - KNEE)));
if (args.decoy !== undefined) applyOverrides(`detect.prior.decoy:${args.decoy}`);   // --decoy=X sweeps CONFIG.detect.prior.decoy
const DECOY = CONFIG.detect.prior.decoy || 0;
// --model[=path]: score with the learned classifier (src/model.js) instead of the templates
const MODEL = args.model ? await loadModelFile(path.resolve(import.meta.dirname, '..', args.model === true ? CONFIG.model.path : String(args.model))) : null;
if (args.model && !MODEL) { console.error('no model file'); process.exit(1); }
const MIX = Number(args.mix || 0);   // --mix=β with --model: template score + β·(model log-posterior) instead of the model alone
// per-session annotations (data/user/sessions.json): { "<session>": { noise: [[ts0, ts1|null], …], note } } — stream-ts ranges of non-guitar audio (TV, talk)
const SESSIONS_META = (() => { try { return JSON.parse(fs.readFileSync(new URL('../data/user/sessions.json', import.meta.url))); } catch { return {}; } })();
function fold(sm, out) { out.fill(0); let s = 0; for (let i = 0; i < NPITCH; i++) { const v = sm[i] * CHROMA_W[i]; out[PITCHES[i] % 12] += v; s += v; } if (s > 0) for (let i = 0; i < 12; i++) out[i] /= s; return out; }
const RULE = args.rule || 'stable', RULE_FRAC = Number(args['rule-frac'] ?? CONFIG.stable.frac), MIN_VERDICTS = Number(args['min-verdicts'] ?? 8), WIN_MUL = Number(args.win ?? CONFIG.stable.win);
// Experimental hold rule: among the non-null verdicts in the window, `id` needs ≥ frac share and ≥ minN verdicts.
// Frames without a verdict (low confidence between strums) no longer dilute the denominator.
class VerdictRule {
  constructor(win, frac, minN) { this.win = win; this.frac = frac; this.minN = minN; this.q = []; this.lastFired = null; }
  reset() { this.q.length = 0; this.lastFired = null; }
  push(t, id, silent = false) {
    if (silent) { this.reset(); return null; }
    const q = this.q; q.push([t, id]); while (q.length && t - q[0][0] > this.win) q.shift();
    if (!id || id === this.lastFired) return null;
    let n = 0, tot = 0; for (const [, x] of q) if (x) { tot++; if (x === id) n++; }
    if (tot < this.minN || n < this.frac * tot) return null;
    this.lastFired = id; return id;
  }
}
const makeRule = (holdMs) => RULE === 'verdicts' ? new VerdictRule(holdMs / 1000 * WIN_MUL, RULE_FRAC, MIN_VERDICTS) : new StableRule(holdMs / 1000 * WIN_MUL, CONFIG.stable.frac);

// ---- sessions ----
const countType = (sid, type) => { let n = 0; for (const l of fs.readFileSync(path.join(TEL, sid + '.jsonl'), 'utf8').split('\n')) if (l.includes(`"type":"${type}"`)) n++; return n; };
let sessions = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (sessions.includes('latest')) sessions = fs.readdirSync(TEL).filter(f => f.endsWith('.jsonl')).sort().slice(-1).map(f => f.replace(/\.jsonl$/, ''));
if (!sessions.length) {
  sessions = fs.readdirSync(REC).filter(d => fs.existsSync(path.join(REC, d, 'segments.jsonl')) && fs.existsSync(path.join(TEL, d + '.jsonl'))).sort();
  if (!args.all) sessions = sessions.filter(s => countType(s, 'match') >= 10);
}

// ---- per-frame chroma, cached ----
function segFrames(dir, seg) {
  const name = `seg-${String(seg.seg).padStart(4, '0')}`;
  const cacheFile = path.join(dir, 'cache', `${name}.${KEY}.f32`);
  if (fs.existsSync(cacheFile)) { const b = fs.readFileSync(cacheFile); const f = new Float32Array(b.byteLength / 4); new Uint8Array(f.buffer).set(b); return f; }
  const wav = decodeWav(fs.readFileSync(path.join(dir, name + '.wav')));
  const an = new PitchAnalyzer({ sampleRate: wav.sampleRate, fftSize: CONFIG.detect.fftSize, profiles: PARTIALS });
  if (an.nP !== NPITCH) throw new Error(`analyzer has ${an.nP} pitches, bench expects ${NPITCH}`);
  const N = CONFIG.detect.fftSize, HOP = CONFIG.detect.hop, rows = [];
  for (const { start, frame } of frames(wav.samples, N, HOP)) {
    const ts = seg.ts0 + (start + N / 2) / wav.sampleRate, level = rms(frame);
    rows.push(ts, level);
    if (level < CONFIG.detect.rmsGate) { for (let i = 0; i < NPITCH; i++) rows.push(0); continue; }   // silent: detector skips the frame
    const act = an.analyze(frame); for (let i = 0; i < NPITCH; i++) rows.push(act[i]);
  }
  const f = Float32Array.from(rows);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, Buffer.from(f.buffer));
  return f;
}
// Gate value per frame (GuitarGate over the NNLS residual, silence resets it), cached beside the activations.
// Keyed by the gate's own parameters so sweeps recompute only when they change.
function gateFrames(dir, seg) {
  const name = `seg-${String(seg.seg).padStart(4, '0')}`, G = CONFIG.gate;
  const cacheFile = path.join(dir, 'cache', `${name}.${KEY}.gate-r${G.residMax}-s${G.steep}-e${G.ema}.f32`);
  if (fs.existsSync(cacheFile)) { const b = fs.readFileSync(cacheFile); const f = new Float32Array(b.byteLength / 4); new Uint8Array(f.buffer).set(b); return f; }
  const wav = decodeWav(fs.readFileSync(path.join(dir, name + '.wav')));
  const an = new PitchAnalyzer({ sampleRate: wav.sampleRate, fftSize: CONFIG.detect.fftSize, profiles: PARTIALS });
  const gate = new GuitarGate(), rows = [];
  for (const { frame } of frames(wav.samples, CONFIG.detect.fftSize, CONFIG.detect.hop)) {
    if (rms(frame) < CONFIG.detect.rmsGate) { gate.silent(); rows.push(1); continue; }
    rows.push(gate.push(an.residual(an.analyze(frame))));
  }
  const f = Float32Array.from(rows);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, Buffer.from(f.buffer));
  return f;
}
// frames of one segment within [a, b) as objects; the EMA runs over the whole segment (its state survives silent frames, as in the detector)
function framesIn(f, a, b, gf = null) {
  const out = [], sm = new Float32Array(NPITCH), EMA = CONFIG.detect.ema, fz = MODEL ? new Featurizer(NPITCH) : null;
  for (let i = 0; i < f.length; i += ROW) {
    const ts = f[i], level = f[i + 1], silent = level < CONFIG.detect.rmsGate;
    let feat = null;
    if (!silent) {
      for (let k = 0; k < NPITCH; k++) sm[k] = EMA * sm[k] + (1 - EMA) * f[i + 2 + k];
      if (fz) feat = Float32Array.from(fz.push(f.subarray(i + 2, i + 2 + NPITCH)));   // raw activations, as the detector feeds the model
    }
    if (ts < a || ts >= b) continue;
    out.push({ ts, level, silent, chroma: silent ? null : fold(sm, new Float32Array(12)), feat, gate: gf ? gf[i / ROW] : 1 });
  }
  return out;
}

// ---- the detector's decision chain on a frame list (src/detect.js _frameInner + StableRule) ----
function mode(arr) { const c = new Map(); for (const v of arr) c.set(v, (c.get(v) || 0) + 1); let bv = null, bc = -1; for (const [k, n] of c) if (n > bc) { bv = k; bc = n; } return { value: bv, count: bc }; }
function simulate(fr, T, sens, holdMs, ts0, tgt = null, strums = []) {
  const hist = [], rule = makeRule(holdMs);
  const fires = [], settled = new Map(), diag = []; let settledN = 0, sound = 0;
  for (const f of fr) {
    let id = null;
    if (f.silent) { hist.length = 0; rule.push(f.ts, null, true); continue; }
    let r;
    if (MODEL && MIX) {   // as ChordDetector does in 'mix' mode: template confidence, mixed argmax
      const tpl = scoreTemplates(f.chroma, T), c = tpl.best >= 0 ? confidenceOf(tpl, T) : 0;
      r = mixResult(tpl, scoreModel(MODEL, MODEL.forward(f.feat), T, new Array(T.length), T.cls), MIX, T, c);
    } else r = MODEL ? scoreModel(MODEL, MODEL.forward(f.feat), T, new Array(T.length), T.cls) : scoreTemplates(f.chroma, T);
    if (r.best >= 0) {
      const conf = confidenceOf(r, T);
      if (f.ts >= ts0 + SETTLE) diag.push([tgt ? tgt.ids.includes(T[r.best].id) : false, conf, f.level, strums.some(s => f.ts >= s + 0.05 && f.ts < s + 0.5), T[r.best].id]);
      hist.push(conf >= sens && (!GATE_ON || f.gate >= CONFIG.gate.threshold) ? T[r.best].id : null); if (hist.length > L) hist.shift();
      const m = mode(hist); id = m.count >= NEED ? m.value : null;
      const fired = rule.push(f.ts, id);
      if (fired && f.ts >= ts0) fires.push({ ts: f.ts, id: fired });
    }
    if (f.ts >= ts0) sound++;
    if (f.ts >= ts0 + SETTLE) { settledN++; settled.set(id, (settled.get(id) || 0) + 1); }
  }
  return { fires, settled, settledN, sound, diag };
}

// ---- gather intervals ----
const intervals = [];
for (const sid of sessions) {
  const rows = buildLabels(sid, { telDir: TEL, recDir: REC });
  if (!rows.length) { console.log(`${sid}: no labelled recordings`); continue; }
  const ev = fs.readFileSync(path.join(TEL, sid + '.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });   // a live file may end mid-line
  const settings = { ...(ev.find(e => e.type === 'session')?.settings || {}) };
  // settings snapshot at each pair event (setting events arrive in time order)
  const snapAtPair = [];
  for (const e of ev) { if (e.type === 'setting') settings[e.key] = e.value; if (e.type === 'pair') snapAtPair.push([e.ts, { ...settings }]); }
  const strums = ev.filter(e => e.type === 'strum').map(e => e.ts);
  const dir = path.join(REC, sid);
  const segs = fs.readFileSync(path.join(dir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const cache = new Map(), gcache = new Map();
  for (const r of rows) {
    const dur = r.ts1 - r.ts0;
    if (dur < MIN_DUR) continue;
    const st = [...snapAtPair].reverse().find(([ts]) => ts !== null && ts <= r.ts0 + 0.02)?.[1] || settings;
    const enabled = new Set(st.enabledChords || []);
    const seq = st.sequence && st.sequence !== 'random' ? (PROGRESSIONS.find(p => p.id === st.sequence)?.chords || []) : [];
    for (const id of seq) enabled.add(id);
    const cand = CHORDS.filter(c => c.category === 'basic' || enabled.has(c.id));
    const noise = (SESSIONS_META[sid]?.noise || []).some(([a, b]) => r.ts1 > a && r.ts0 < (b ?? Infinity));
    const seg = segs.find(s => s.seg === r.seg);
    if (!cache.has(r.seg)) cache.set(r.seg, segFrames(dir, seg));
    if (GATE_ON && !gcache.has(r.seg)) gcache.set(r.seg, gateFrames(dir, seg));
    const fr = framesIn(cache.get(r.seg), r.ts0 - WARMUP, r.ts1, GATE_ON ? gcache.get(r.seg) : null);
    const strumTs = strums.filter(ts => ts >= r.ts0 && ts < r.ts1), n = strumTs.length;
    intervals.push({ session: sid, target: r.target, ts0: r.ts0, ts1: r.ts1, dur, strums: n, strumTs, enabled, noise, live: r.matched ? 'match' : r.shownBecause, liveMatchedAt: r.matchedAt, cand, fr,
      sens: args.sens !== undefined ? Number(args.sens) : sensitivityFromSlider(st.sensitivity ?? CONFIG.sensitivity.defaultSlider),
      hold: args.hold !== undefined ? Number(args.hold) : (st.minHoldMs ?? CONFIG.stable.minHoldMs) });
  }
}

// ---- run ----
const templCache = new Map();
const templatesFor = (cand, enabled = new Set()) => {
  const k = cand.map(c => c.id).join(',') + '|' + [...enabled].join(',');
  if (!templCache.has(k)) { const T = buildTemplates(cand, { profile: PROFILE, alpha: ALPHA, decoys: new Set(cand.map(c => c.id).filter(id => !enabled.has(id))) }); if (MODEL) T.cls = T.map(t => MODEL.classOf(t)); templCache.set(k, T); }
  return templCache.get(k);
};
const results = [];
for (const iv of intervals) {
  const T = templatesFor(iv.cand, iv.enabled);
  const tgt = T.find(t => t.ids.includes(iv.target));
  const sim = simulate(iv.fr, T, iv.sens, iv.hold, iv.ts0, tgt, iv.strumTs);
  const played = !iv.noise && iv.strums >= MIN_STRUMS && sim.sound >= 10;
  const first = sim.fires.find(f => tgt && tgt.ids.includes(f.id));
  const wrongBefore = sim.fires.filter(f => !(tgt && tgt.ids.includes(f.id)) && (!first || f.ts < first.ts)).map(f => f.id);
  const wrongAll = sim.fires.filter(f => !(tgt && tgt.ids.includes(f.id))).map(f => f.id);
  const heard = [...sim.settled].filter(([id]) => id).sort((a, b) => b[1] - a[1]).map(([id, n]) => [id, n / Math.max(1, sim.settledN)]);
  const tgtShare = heard.filter(([id]) => tgt && tgt.ids.includes(id)).reduce((s, [, v]) => s + v, 0);
  const firstStrum = iv.strumTs[0] ?? null;
  results.push({ ...iv, played, diag: sim.diag, hit: !!first, delay: first ? first.ts - iv.ts0 : null, reaction: firstStrum !== null ? firstStrum - iv.ts0 : null, delayFromStrum: first && firstStrum !== null ? first.ts - firstStrum : null, wrongBefore, wrongAll, heard, tgtShare, settledN: sim.settledN });
}

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (x) => `${(100 * x).toFixed(0)}%`;
const played = results.filter(r => r.played);
const summary = {
  sessions, intervals: results.length, played: played.length,
  liveHit: played.filter(r => r.live === 'match').length / Math.max(1, played.length),
  hit: played.filter(r => r.hit).length / Math.max(1, played.length),
  wrongFirst: played.filter(r => r.wrongBefore.length).length / Math.max(1, played.length),
  wrongFires: played.reduce((s, r) => s + r.wrongAll.length, 0),
  delayP50: q(played.filter(r => r.hit).map(r => r.delay), 0.5), delayP90: q(played.filter(r => r.hit).map(r => r.delay), 0.9),
  reactionP50: q(played.map(r => r.reaction).filter(x => x !== null), 0.5), strumDelayP50: q(played.map(r => r.delayFromStrum).filter(x => x !== null), 0.5), strumDelayP90: q(played.map(r => r.delayFromStrum).filter(x => x !== null), 0.9),
  frameAcc: played.reduce((s, r) => s + r.tgtShare * r.settledN, 0) / Math.max(1, played.reduce((s, r) => s + r.settledN, 0)),
  noVerdict: played.reduce((s, r) => s + (r.heard.length ? 1 - r.heard.reduce((a, [, v]) => a + v, 0) : 1) * r.settledN, 0) / Math.max(1, played.reduce((s, r) => s + r.settledN, 0)),
};

// ---- per-target table ----
const byTarget = new Map();
for (const r of played) (byTarget.get(r.target) || byTarget.set(r.target, []).get(r.target)).push(r);
const targetRows = [...byTarget].sort((a, b) => b[1].length - a[1].length).map(([id, rs]) => {
  const conf = new Map();
  for (const r of rs) for (const [h, v] of r.heard) if (!r.cand.find(c => c.id === id) || h !== id) conf.set(h, (conf.get(h) || 0) + v * r.settledN);
  const totalN = rs.reduce((s, r) => s + r.settledN, 0);
  const T = templatesFor(rs[0].cand, rs[0].enabled), tgt = T.find(t => t.ids.includes(id));
  const top = [...conf].filter(([h]) => !(tgt && tgt.ids.includes(h))).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, n]) => `${h} ${pct(n / Math.max(1, totalN))}`).join(', ');
  return { id, n: rs.length, live: rs.filter(r => r.live === 'match').length / rs.length, hit: rs.filter(r => r.hit).length / rs.length, delay: q(rs.filter(r => r.hit).map(r => r.delay), 0.5),
    wrongFirst: rs.filter(r => r.wrongBefore.length).length / rs.length, frameAcc: rs.reduce((s, r) => s + r.tgtShare * r.settledN, 0) / Math.max(1, totalN), heardInstead: top };
});

// ---- print ----
const lines = [];
lines.push(`personal bench — ${sessions.length} session(s): ${sessions.join(' ')}`);
lines.push(`partials: ${USER_PARTIALS ? `${upPath} (${Object.keys(USER_PARTIALS.meta?.plucks || {}).length} strings, response ${USER_PARTIALS.response?.n ?? 0} ratios)` : 'GuitarSet only'}`);
lines.push(`profile: ${PROFILE ? `${profilePath} (alpha ${ALPHA}, ${Object.keys(PROFILE.chords || {}).length} chords)` : 'none'}${args.cfg ? `   cfg: ${args.cfg}` : ''}   knee/floor ${KNEE}/${FLOOR}  decoy ${DECOY}  rule ${RULE}${MODEL ? `   scorer: ${MIX ? `templates + ${MIX}·model` : 'model'} (${MODEL.classes.length} classes, hidden ${MODEL.hidden})` : ''}`);
lines.push(`${results.length} target intervals, ${played.length} played (≥${MIN_STRUMS} strums, ≥${MIN_DUR}s, sound after the first second)`);
lines.push(`  live app matched ${pct(summary.liveHit)}   offline: target fired ${pct(summary.hit)}, wrong chord fired first ${pct(summary.wrongFirst)} (${summary.wrongFires} wrong fires), delay p50 ${summary.delayP50?.toFixed(2)}s p90 ${summary.delayP90?.toFixed(2)}s`);
lines.push(`  player: first strum ${summary.reactionP50?.toFixed(2)}s after the target appears; detector: target fired ${summary.strumDelayP50?.toFixed(2)}s (p90 ${summary.strumDelayP90?.toFixed(2)}s) after that first strum`);
const noiseIv = results.filter(r => r.noise);
if (noiseIv.length) { const nf = noiseIv.reduce((s, r) => s + r.settledN, 0), nv = noiseIv.reduce((s, r) => s + r.heard.reduce((a, [, v]) => a + v, 0) * r.settledN, 0); lines.push(`  noise (annotated non-guitar audio): ${noiseIv.length} intervals, ${noiseIv.filter(r => r.hit).length} target fires, ${noiseIv.reduce((s, r) => s + r.wrongAll.length, 0)} other fires, verdict on ${pct(nv / Math.max(1, nf))} of sounding frames, live app matched ${noiseIv.filter(r => r.live === 'match').length}`); }
lines.push(`  settled frames: target ${pct(summary.frameAcc)}, no verdict ${pct(summary.noVerdict)}, other chord ${pct(1 - summary.frameAcc - summary.noVerdict)}`);
lines.push('');
lines.push('  target  played  live-hit  off-hit  delay-p50  wrong-first  frame-acc  heard instead (settled frames)');
for (const t of targetRows) lines.push(`  ${t.id.padEnd(7)} ${String(t.n).padStart(5)}   ${pct(t.live).padStart(6)}   ${pct(t.hit).padStart(6)}   ${(t.delay?.toFixed(2) ?? '-').padStart(6)}s     ${pct(t.wrongFirst).padStart(6)}    ${pct(t.frameAcc).padStart(6)}   ${t.heardInstead}`);
console.log(lines.join('\n'));
if (args.diag) {
  const all = played.flatMap(r => r.diag), tb = all.filter(d => d[0]).map(d => d[1]), ob = all.filter(d => !d[0]).map(d => d[1]);
  const qs = (xs) => [0.1, 0.25, 0.5, 0.75, 0.9].map(p => q(xs, p)?.toFixed(2)).join(' / ');
  console.log(`\n  diag (settled frames of played intervals, n=${all.length}): target is argmax on ${pct(tb.length / Math.max(1, all.length))}`);
  console.log(`    confidence p10/25/50/75/90  when target is argmax: ${qs(tb)}\n                                when another chord is: ${qs(ob)}`);
  for (const thr of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4]) console.log(`    threshold ${thr.toFixed(2)}: verdict on ${pct(all.filter(d => d[1] >= thr).length / all.length)} of frames, precision ${pct(all.filter(d => d[1] >= thr && d[0]).length / Math.max(1, all.filter(d => d[1] >= thr).length))}`);
  const lv = all.map(d => d[2]); console.log(`    level p10/25/50/75/90: ${qs(lv)}`);
  const sa = all.filter(d => d[3]);
  console.log(`  strum-aligned frames (50–500 ms after a strum, n=${sa.length}): target is argmax on ${pct(sa.filter(d => d[0]).length / Math.max(1, sa.length))}, conf p25/50/75 ${[0.25, 0.5, 0.75].map(p => q(sa.filter(d => d[0]).map(d => d[1]), p)?.toFixed(2)).join(' / ')} when it is`);
  for (const thr of [0.2, 0.3, 0.35]) console.log(`    threshold ${thr.toFixed(2)}: verdict on ${pct(sa.filter(d => d[1] >= thr).length / Math.max(1, sa.length))} of strum-aligned frames, precision ${pct(sa.filter(d => d[1] >= thr && d[0]).length / Math.max(1, sa.filter(d => d[1] >= thr).length))}`);
  // argmax confusion on strum-aligned frames, per target
  const conf = new Map();
  for (const r of played) for (const d of r.diag) if (d[3]) { const k = r.target; (conf.get(k) || conf.set(k, new Map()).get(k)).set(d[4], ((conf.get(k).get(d[4])) || 0) + 1); }
  for (const [k, m] of [...conf].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) { const tot = [...m.values()].reduce((x, y) => x + y, 0); console.log(`    ${k.padEnd(4)} argmax: ${[...m].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => `${id} ${pct(n / tot)}`).join('  ')}`); }
}
if (args.verbose) {
  console.log('\n  per interval (played only):');
  for (const r of played) console.log(`  ${r.session.slice(11, 19)} ${r.ts0.toFixed(1).padStart(7)}–${r.ts1.toFixed(1).padEnd(7)} ${r.target.padEnd(4)} strums ${String(r.strums).padStart(2)}  live ${r.live.padEnd(5)}  off ${r.hit ? `hit@${r.delay.toFixed(1)}s` : 'miss   '}  wrong-first ${r.wrongBefore.join(',') || '-'}  heard ${r.heard.slice(0, 3).map(([h, v]) => `${h} ${pct(v)}`).join(' ')}`);
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify({ summary, targets: targetRows, intervals: played.map(({ fr, cand, ...r }) => r) }, null, 1));
if (args.write) {
  const md = [`# Personal benchmark`, '', `Generated by \`node tools/personal_bench.mjs\` at ${new Date().toISOString()}.`, '', 'The player\'s own practice recordings replayed with the live configuration (see the tool header for what "played" means).', '', '```', ...lines, '```', ''].join('\n');
  fs.writeFileSync(args.write, md);
}

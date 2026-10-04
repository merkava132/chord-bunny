// Keep the recordings that are worth keeping, before the recorder's size cap
// prunes them (2026-09-25: a tab left open with the mic on filled the cap and
// the prune deleted every earlier practice take — the benchmark's best data).
//
//   node tools/curate.mjs [--rec-dir=DIR] [--keep-dir=DIR] [--tel-dir=DIR]
//        [--budget-mb=4000] [--mirror-dir=data/user/keep] [--mirror-mb=1000]
//        [--meta=data/user/sessions.json] [--dry-run] [--gc] [--json] [--quiet]
//
// Scoring (per recorded segment, from the session's telemetry):
//   calibration take   (`enroll` window overlaps)        +100  tier A
//   player-labelled    (`label` N/Y window overlaps)      +80  tier A
//   rare-chord match   (target not a basic chord)         +50 per chord, cap 100
//   practice matches   (`match` events inside)            +10 each, cap 40
//   misses             (`miss` events inside)              +5 each, cap 15
//   ambient            (inside an annotated noise range)    0, except the first
//                      segment of each range: +5 (a small negative sample)
//   nothing of interest                                     0 — never kept
// Tier A (score ≥ 50) is always kept. The rest fills `budget` by score, then
// recency, at most 40% of the budget per session. Kept segments are hard
// links when the keep dir is on the same filesystem (zero bytes; serve.py's
// prune skips files with a second link), copies otherwise. A small mirror of
// the best (tier A first) goes to `mirror-dir` on another disk, within
// `mirror-mb`. The telemetry (the labels) and data/user/*.json are mirrored
// into the keep dir too — audio without its labels is noise.
//
// Idempotent: re-runs add new segments and never remove kept ones (`--gc`
// drops the lowest-scored tier-B segments that no longer fit the budget).
// Output: keep/<session>/keep.jsonl (one row per kept segment: score, reasons)
// and keep/manifest.json.
import fs from 'node:fs';
import path from 'node:path';
import { parseSession } from './stats.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));

export const TIER_A = 50;
const CAP = { rare: 100, match: 40, miss: 15 };
const PTS = { enroll: 100, label: 80, rare: 50, match: 10, miss: 5, ambientSample: 5 };

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}
const overlaps = (a0, a1, b0, b1) => a1 > b0 && a0 < (b1 ?? Infinity);

// Score every segment of one session. Pure: takes parsed events and the
// segment index, returns rows sorted by segment.
export function scoreSession({ id, events, segments, noise = [], categoryOf = () => 'basic' }) {
  const enrolls = events.filter(e => e.type === 'enroll');
  const labels = events.filter(e => e.type === 'label');
  const matches = events.filter(e => e.type === 'match');
  const misses = events.filter(e => e.type === 'miss');
  const sampled = new Set();   // noise ranges that already contributed their sample segment
  const rows = [];
  for (const seg of [...segments].sort((a, b) => a.seg - b.seg)) {
    const { ts0, ts1 } = seg;
    const reasons = [];
    let score = 0;
    const noiseIdx = noise.findIndex(([a, b]) => ts0 >= a && ts1 <= (b ?? Infinity));
    if (noiseIdx >= 0) {
      if (!sampled.has(noiseIdx)) { sampled.add(noiseIdx); score = PTS.ambientSample; reasons.push('ambient sample'); }
      rows.push({ seg: seg.seg, ts0, ts1, bytes: seg.bytes || 0, score, tier: 'C', reasons });
      continue;
    }
    const en = enrolls.filter(e => overlaps(ts0, ts1, e.ts0, e.ts1));
    if (en.length) { score += PTS.enroll; reasons.push(`calibration: ${[...new Set(en.map(e => e.kind === 'chord' ? e.chord : `string ${e.string}`))].join(' ')}`); }
    const lb = labels.filter(e => overlaps(ts0, ts1, e.ts0, e.ts1));
    if (lb.length) { score += PTS.label; reasons.push(`player-labelled: ${lb.map(e => `${e.kind} ${e.target}`).join(' ')}`); }
    const m = matches.filter(e => e.ts >= ts0 && e.ts < ts1);
    const rare = [...new Set(m.map(e => e.target).filter(t => categoryOf(t) !== 'basic'))];
    if (rare.length) { score += Math.min(CAP.rare, PTS.rare * rare.length); reasons.push(`rare chords: ${rare.join(' ')}`); }
    if (m.length) { score += Math.min(CAP.match, PTS.match * m.length); reasons.push(`${m.length} match${m.length === 1 ? '' : 'es'}`); }
    const mi = misses.filter(e => e.ts >= ts0 && e.ts < ts1);
    if (mi.length) { score += Math.min(CAP.miss, PTS.miss * mi.length); reasons.push(`${mi.length} miss${mi.length === 1 ? '' : 'es'}`); }
    rows.push({ seg: seg.seg, ts0, ts1, bytes: seg.bytes || 0, score, tier: score >= TIER_A ? 'A' : score > 0 ? 'B' : 'C', reasons });
  }
  return rows;
}

// Choose what to keep across sessions. rows: [{ session, seg, bytes, score, tier, mtime }]
export function select(rows, { budgetBytes, perSessionShare = 0.4 }) {
  const keep = rows.filter(r => r.tier === 'A');
  let used = keep.reduce((s, r) => s + r.bytes, 0);
  const perSession = new Map(); for (const r of keep) perSession.set(r.session, (perSession.get(r.session) || 0) + r.bytes);
  const cap = perSessionShare * budgetBytes;
  const rest = rows.filter(r => r.tier === 'B').sort((a, b) => b.score - a.score || (b.mtime || 0) - (a.mtime || 0));
  for (const r of rest) {
    const s = perSession.get(r.session) || 0;
    if (used + r.bytes > budgetBytes || s + r.bytes > cap) continue;
    keep.push(r); used += r.bytes; perSession.set(r.session, s + r.bytes);
  }
  return keep;
}

// Mirror: tier A first, then the best of tier B, within mirrorBytes.
export function selectMirror(kept, mirrorBytes) {
  const out = []; let used = 0;
  for (const r of [...kept].sort((a, b) => (a.tier === b.tier ? b.score - a.score : a.tier === 'A' ? -1 : 1))) {
    if (used + r.bytes > mirrorBytes) continue;
    out.push(r); used += r.bytes;
  }
  return out;
}

function linkOrCopy(src, dst) {
  if (fs.existsSync(dst)) return 'exists';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.linkSync(src, dst); return 'linked'; }
  catch (e) { if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e; fs.copyFileSync(src, dst); return 'copied'; }
}
function copyIfChanged(src, dst) {
  const a = fs.statSync(src);
  try { const b = fs.statSync(dst); if (b.size === a.size && b.mtimeMs >= a.mtimeMs) return false; } catch {}
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst); fs.utimesSync(dst, a.atime, a.mtime);
  return true;
}

export function curate({ recDir, keepDir, telDir, mirrorDir = null, budgetBytes, mirrorBytes = 0, meta = {}, categoryOf, dryRun = false, gc = false, log = () => {} }) {
  const sessions = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter(d => fs.existsSync(path.join(recDir, d, 'segments.jsonl'))) : [];
  const all = [];
  for (const id of sessions) {
    const tel = path.join(telDir, id + '.jsonl');
    const events = fs.existsSync(tel) ? parseSession(fs.readFileSync(tel, 'utf8')) : [];
    const segments = readJsonl(path.join(recDir, id, 'segments.jsonl'));
    const rows = scoreSession({ id, events, segments, noise: meta[id]?.noise || [], categoryOf });
    for (const r of rows) {
      const file = `seg-${String(r.seg).padStart(4, '0')}.wav`;
      const src = path.join(recDir, id, file), dst = path.join(keepDir, id, file);
      const present = fs.existsSync(src), kept = fs.existsSync(dst);
      if (!present && !kept) continue;                       // pruned before we got to it
      const st = present ? fs.statSync(src) : fs.statSync(dst);
      all.push({ ...r, session: id, file, src, dst, present, kept, bytes: st.size, mtime: st.mtimeMs });
    }
  }
  const already = all.filter(r => r.kept);
  const chosen = select(all.filter(r => r.tier !== 'C' || r.score > 0), { budgetBytes });
  const chosenKey = new Set(chosen.map(r => r.session + '/' + r.file));
  // never drop what is already kept unless --gc says the budget demands it
  const final = [...chosen];
  for (const r of already) if (!chosenKey.has(r.session + '/' + r.file)) { if (!gc) final.push(r); }
  const actions = { linked: 0, copied: 0, exists: 0, removed: 0, mirrored: 0 };
  if (!dryRun) {
    for (const r of final) {
      if (r.kept) { actions.exists++; continue; }
      if (!r.present) continue;
      actions[linkOrCopy(r.src, r.dst)]++;
    }
    if (gc) for (const r of already) if (!chosenKey.has(r.session + '/' + r.file)) { fs.rmSync(r.dst, { force: true }); actions.removed++; }
    // per-session index + the labels that make the audio meaningful
    const bySession = new Map();
    for (const r of final) (bySession.get(r.session) || bySession.set(r.session, []).get(r.session)).push(r);
    for (const [id, rows] of bySession) {
      const dir = path.join(keepDir, id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'keep.jsonl'), rows.sort((a, b) => a.seg - b.seg).map(r => JSON.stringify({ seg: r.seg, file: r.file, ts0: r.ts0, ts1: r.ts1, bytes: r.bytes, score: r.score, tier: r.tier, reasons: r.reasons })).join('\n') + '\n');
      for (const f of ['segments.jsonl', 'labels.jsonl']) { const s = path.join(recDir, id, f); if (fs.existsSync(s)) copyIfChanged(s, path.join(dir, f)); }
      const tel = path.join(telDir, id + '.jsonl'); if (fs.existsSync(tel)) copyIfChanged(tel, path.join(keepDir, 'telemetry', id + '.jsonl'));
    }
    // every session's telemetry (small, and it is the labels) + the user data files
    if (fs.existsSync(telDir)) for (const f of fs.readdirSync(telDir)) if (f.endsWith('.jsonl')) copyIfChanged(path.join(telDir, f), path.join(keepDir, 'telemetry', f));
    const userDir = path.join(ROOT, 'data', 'user');
    if (fs.existsSync(userDir)) for (const f of fs.readdirSync(userDir)) if (f.endsWith('.json')) copyIfChanged(path.join(userDir, f), path.join(keepDir, 'data-user', f));
    // mirror on another disk: the best, within its own budget
    if (mirrorDir && mirrorBytes > 0) {
      for (const r of selectMirror(final, mirrorBytes)) {
        const dst = path.join(mirrorDir, r.session, r.file), src = r.kept ? r.dst : r.src;
        if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); actions.mirrored++;
      }
      for (const [id] of bySession) { const k = path.join(keepDir, id, 'keep.jsonl'); if (fs.existsSync(k) && fs.existsSync(path.join(mirrorDir, id))) copyIfChanged(k, path.join(mirrorDir, id, 'keep.jsonl')); }
      if (fs.existsSync(path.join(keepDir, 'telemetry'))) for (const f of fs.readdirSync(path.join(keepDir, 'telemetry'))) copyIfChanged(path.join(keepDir, 'telemetry', f), path.join(mirrorDir, 'telemetry', f));
    }
  }
  const bytes = final.reduce((s, r) => s + r.bytes, 0);
  const manifest = { updatedAt: new Date().toISOString(), recDir, keepDir, mirrorDir, budgetBytes, mirrorBytes, sessions: new Set(final.map(r => r.session)).size, segments: final.length, bytes,
    tiers: { A: final.filter(r => r.tier === 'A').length, B: final.filter(r => r.tier === 'B').length, C: final.filter(r => r.tier === 'C').length },
    candidates: all.length, actions, dryRun };
  if (!dryRun) { fs.mkdirSync(keepDir, { recursive: true }); fs.writeFileSync(path.join(keepDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n'); }
  log(manifest, final);
  return manifest;
}

// ---- CLI ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const recDir = path.resolve(args['rec-dir'] || process.env.CB_REC_DIR || (fs.existsSync('/mnt/aegis/chord-bunny/recordings') ? '/mnt/aegis/chord-bunny/recordings' : path.join(ROOT, 'recordings')));
  const keepDir = path.resolve(args['keep-dir'] || (path.basename(recDir) === 'recordings' ? path.join(path.dirname(recDir), 'keep') : recDir + '-keep'));
  const telDir = path.resolve(args['tel-dir'] || path.join(ROOT, 'telemetry'));
  const mirrorDir = args['mirror-dir'] === 'none' ? null : path.resolve(args['mirror-dir'] || path.join(ROOT, 'data', 'user', 'keep'));
  const meta = (() => { try { return JSON.parse(fs.readFileSync(args.meta || path.join(ROOT, 'data', 'user', 'sessions.json'), 'utf8')); } catch { return {}; } })();
  const cats = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'chords.json'), 'utf8')).map(c => [c.id, c.category]));
  const manifest = curate({ recDir, keepDir, telDir, mirrorDir, meta, categoryOf: (id) => cats.get(id) || 'basic',
    budgetBytes: Number(args['budget-mb'] ?? 4000) * 1e6, mirrorBytes: Number(args['mirror-mb'] ?? 1000) * 1e6, dryRun: !!args['dry-run'], gc: !!args.gc,
    log: (m, final) => {
      if (args.json) return;
      if (args.quiet) { console.log(`keep: ${m.segments} segments, ${(m.bytes / 1e6).toFixed(0)} MB (A ${m.tiers.A}, B ${m.tiers.B}, C ${m.tiers.C}); +${m.actions.linked} linked, +${m.actions.copied} copied, ${m.actions.mirrored} mirrored${m.dryRun ? ' (dry run)' : ''}`); return; }
      console.log(`${m.candidates} recorded segments in ${recDir}\nkeep → ${keepDir}${m.dryRun ? ' (dry run)' : ''}: ${m.segments} segments, ${(m.bytes / 1e6).toFixed(0)} MB of ${(m.budgetBytes / 1e6).toFixed(0)} MB; tier A ${m.tiers.A}, B ${m.tiers.B}, ambient samples ${m.tiers.C}`);
      if (mirrorDir) console.log(`mirror → ${mirrorDir}: ${m.actions.mirrored} new file(s), budget ${(m.mirrorBytes / 1e6).toFixed(0)} MB`);
      const bySession = new Map(); for (const r of final) (bySession.get(r.session) || bySession.set(r.session, []).get(r.session)).push(r);
      for (const [id, rows] of [...bySession].sort()) {
        const a = rows.filter(r => r.tier === 'A'), mb = rows.reduce((s, r) => s + r.bytes, 0) / 1e6;
        console.log(`  ${id}: ${rows.length} kept (${mb.toFixed(0)} MB), tier A ${a.length}${a.length ? ' — ' + [...new Set(a.flatMap(r => r.reasons.filter(x => /calibration|labelled|rare/.test(x))))].slice(0, 4).join('; ') : ''}`);
      }
    } });
  if (args.json) console.log(JSON.stringify(manifest));
}

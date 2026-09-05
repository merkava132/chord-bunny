// Per-string evaluation against GuitarSet's hex-pickup ground truth.
//   node tools/eval_strings.mjs [--subset=open|all] [--set k=v,...] [--verbose]
// For each chord segment the hypothesis voicing = the shape the player is
// holding (mode of GT per-string pitches); muted strings → open pitch.
// Reports: per-frame string presence accuracy/F1, onset recall/precision,
// strum string-set Jaccard, direction accuracy, note duration error.
import fs from 'node:fs';
import { frames, TUNING } from '../src/dsp/analyzer.js';
import { StringTracker } from '../src/dsp/strings.js';
import { listExcerpts, loadExcerpt, chordAt, stringsAt } from './guitarset.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SUBSET = args.subset || 'open';
const VERBOSE = !!args.verbose;
const OVERRIDES = Object.fromEntries((args.set ? String(args.set).split(',') : []).map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const PROFILES = args.noprof ? null : JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const PROFILES_S = (args.noprof || args.nostr) ? null : JSON.parse(fs.readFileSync(new URL('../data/partials_by_string.json', import.meta.url)));
const OPEN = ['SS3', 'Rock3', 'Rock1'];

// shape the player holds during a segment: per string, most common rounded pitch (or -1)
function segmentShape(notes, t0, t1) {
  return notes.map((list, s) => {
    const cnt = new Map();
    for (const n of list) { const a = Math.max(n.t0, t0), b = Math.min(n.t1, t1); if (b > a) { const m = Math.round(n.midi); cnt.set(m, (cnt.get(m) || 0) + b - a); } }
    let best = -1, bd = 0; for (const [m, d] of cnt) if (d > bd) { bd = d; best = m; }
    return best < 0 ? -1 : best - TUNING[s];
  });
}
function gtStrums(notes, t0, t1) {
  const on = []; notes.forEach((l, s) => l.forEach(n => { if (n.t0 >= t0 && n.t0 < t1) on.push({ t: n.t0, s, dur: n.t1 - n.t0 }); }));
  on.sort((a, b) => a.t - b.t);
  const evs = []; let i = 0;
  while (i < on.length) { let j = i + 1; while (j < on.length && on[j].t - on[j - 1].t < 0.04 && on[j].t - on[i].t < 0.08) j++; const ev = on.slice(i, j); let sum = 0; for (let a = 0; a < ev.length - 1; a++) sum += Math.sign(ev[a + 1].s - ev[a].s); evs.push({ t: ev[0].t, tLast: ev[ev.length - 1].t, notes: ev, strings: new Set(ev.map(e => e.s)), dir: ev.length < 2 ? 'single' : sum > 0 ? 'down' : sum < 0 ? 'up' : 'flat' }); i = j; }
  return evs;
}

const tot = { frames: 0, hit: 0, tp: 0, fp: 0, fn: 0, perString: Array.from({ length: 6 }, () => ({ tp: 0, fp: 0, fn: 0, tn: 0 })),
  gtStrum: 0, detStrum: 0, matched: 0, jacc: 0, dirN: 0, dirHit: 0, durErr: [], durN: 0, dirConf: {}, tErr: { uniq: [], dbl: [], muted: [] },
  uniq: { tp: 0, fp: 0, fn: 0 }, dbl: { tp: 0, fp: 0, fn: 0 }, onGt: 0, onDet: 0, onHit: 0 };

for (const name of listExcerpts(f => f.includes('comp') && (SUBSET === 'all' || OPEN.some(s => f.includes(s))))) {
  const ex = loadExcerpt(name);
  const tr = new StringTracker({ sampleRate: ex.sampleRate, profiles: PROFILES, profilesByString: PROFILES_S, ...OVERRIDES });
  const N = tr.o.fftSize, HOP = tr.o.hop;
  const segs = ex.chords.filter(c => c.appId && c.t1 - c.t0 > 0.5).map(c => ({ ...c, shape: segmentShape(ex.notes, c.t0, c.t1) }));
  const events = []; tr.onEvent = (e) => events.push(e);
  let segI = -1;
  const local = { frames: 0, hit: 0 };
  for (const { start, frame } of frames(ex.samples, N, HOP)) {
    const t = (start + N / 2) / ex.sampleRate;
    const si = segs.findIndex(c => t >= c.t0 && t < c.t1);
    if (si !== segI) { segI = si; if (si >= 0) tr.setVoicing(segs[si].shape); }
    const st = tr.process(frame, t);
    if (si < 0 || t - segs[si].t0 < 0.1) continue;
    // per-frame presence (evaluate every 4th hop to keep it cheap)
    if (tr.frameIndex % 4) continue;
    const gt = stringsAt(ex.notes, t).map(m => m > 0 ? 1 : 0);
    const pr = tr.present(st.h);
    let allOk = true;
    for (let s = 0; s < 6; s++) {
      const ps = tot.perString[s], cls = tr.doubled[s] ? tot.dbl : tot.uniq;
      if (gt[s] && pr[s]) { ps.tp++; tot.tp++; cls.tp++; } else if (!gt[s] && pr[s]) { ps.fp++; tot.fp++; cls.fp++; allOk = false; } else if (gt[s] && !pr[s]) { ps.fn++; tot.fn++; cls.fn++; allOk = false; } else ps.tn++;
    }
    tot.frames++; local.frames++; if (allOk) { tot.hit++; local.hit++; }
  }
  // strum-level
  const det = events.filter(e => e.type === 'strum');
  const offs = events.filter(e => e.type === 'note-off');
  let gtCount = 0, matched = 0, jacc = 0, dirN = 0, dirHit = 0;
  {
    const on = []; ex.notes.forEach(l => l.forEach(n => on.push(n.t0))); on.sort((a, b) => a - b);
    const clusters = []; for (const t of on) { if (clusters.length && t - clusters[clusters.length - 1] < 0.03) continue; clusters.push(t); }
    const inSeg = clusters.filter(t => segs.some(c => t >= c.t0 + 0.1 && t < c.t1));
    const detT = det.map(d => d.t).filter(t => segs.some(c => t >= c.t0 + 0.1 && t < c.t1));
    tot.onGt += inSeg.length; tot.onDet += detT.length;
    const used = new Set();
    for (const g of inSeg) { let bi = -1, bd = 0.05; detT.forEach((d, i) => { if (!used.has(i) && Math.abs(d - g) < bd) { bd = Math.abs(d - g); bi = i; } }); if (bi >= 0) { used.add(bi); tot.onHit++; } }
  }
  for (const seg of segs) {
    for (const g of gtStrums(ex.notes, seg.t0 + 0.1, seg.t1)) {
      if (g.notes.length < 2) continue;
      gtCount++;
      // nearest detected strum within ±60 ms
      let best = null, bd = 0.06;
      for (const d of det) { const dd = Math.abs(d.t - g.t); if (dd < bd) { bd = dd; best = d; } }
      if (!best) continue;
      matched++;
      const ds = new Set(best.strings.map(s => s.string));
      const inter = [...ds].filter(s => g.strings.has(s)).length, uni = new Set([...ds, ...g.strings]).size;
      jacc += inter / uni;
      if ((g.dir === 'down' || g.dir === 'up') && g.notes.length >= 3 && g.tLast - g.t >= 0.012) {
        dirN++; if (best.direction === g.dir) dirHit++;
        const k = `${g.dir}→${best.direction}`; tot.dirConf[k] = (tot.dirConf[k] || 0) + 1;
        if (args.dirdump && (tot.dirDumped = (tot.dirDumped || 0) + 1) <= 14) console.log(`  ${name} t=${g.t.toFixed(3)} GT ${g.dir}: ${g.notes.map(n => `${n.s}@${n.t.toFixed(3)}`).join(' ')}  | det ${best.direction} spread=${best.spreadMs.toFixed(0)}: ${best.strings.map(x => `${x.string}@${x.t == null ? 'inf' : x.t.toFixed(3)}`).join(' ')}`);
      }
      // per-string onset timing error by class
      for (const n of g.notes) { const d = best.strings.find(x => x.string === n.s); if (!d || d.t == null) continue; const cls = d.muted ? 'muted' : d.doubled ? 'dbl' : 'uniq'; tot.tErr[cls].push(1000 * (d.t - n.t)); }
      // duration: for each GT note in this strum, find the detector's ringing duration
      for (const n of g.notes) {
        const ds2 = best.strings.find(s => s.string === n.s); if (!ds2) continue;
        const off = offs.find(o => o.string === n.s && o.t > ds2.t && o.t - ds2.t < 8);
        if (!off) continue;
        tot.durErr.push(Math.abs(off.duration - n.dur)); tot.durN++;
      }
    }
  }
  tot.gtStrum += gtCount; tot.detStrum += det.length; tot.matched += matched; tot.jacc += jacc; tot.dirN += dirN; tot.dirHit += dirHit;
  if (VERBOSE) console.log(`${name.padEnd(24)} presence(all-6-right)=${(100 * local.hit / local.frames).toFixed(0)}%  strums gt=${gtCount} det=${det.length} matched=${matched} jacc=${(jacc / Math.max(1, matched)).toFixed(2)} dir=${dirHit}/${dirN}`);
}
const P = tot.tp / (tot.tp + tot.fp), R = tot.tp / (tot.tp + tot.fn);
tot.durErr.sort((a, b) => a - b);
console.log(`set=${JSON.stringify(OVERRIDES)}`);
console.log(`presence: all-6-correct ${(100 * tot.hit / tot.frames).toFixed(1)}% of ${tot.frames} frames; per-string P=${(100 * P).toFixed(1)}% R=${(100 * R).toFixed(1)}% F1=${(200 * P * R / (P + R)).toFixed(1)}%`);
const f1 = (c) => { const p = c.tp / (c.tp + c.fp || 1), r = c.tp / (c.tp + c.fn || 1); return `P=${(100 * p).toFixed(0)}% R=${(100 * r).toFixed(0)}% F1=${(200 * p * r / (p + r || 1)).toFixed(1)}%`; };
console.log(`  unique-pitch strings: ${f1(tot.uniq)} (${tot.uniq.tp + tot.uniq.fn} ringing)   octave-doubled strings: ${f1(tot.dbl)} (${tot.dbl.tp + tot.dbl.fn} ringing)`);
console.log(`onsets: GT ${tot.onGt}, detected ${tot.onDet}, recall ${(100 * tot.onHit / tot.onGt).toFixed(1)}%, precision ${(100 * tot.onHit / tot.onDet).toFixed(1)}% (±50 ms)`);
console.log('  per string (lowE→highE) F1: ' + tot.perString.map(p => { const pp = p.tp / (p.tp + p.fp || 1), rr = p.tp / (p.tp + p.fn || 1); return (200 * pp * rr / (pp + rr || 1)).toFixed(0) + '%'; }).join(' '));
console.log(`strums: GT ${tot.gtStrum}, detected ${tot.detStrum}, matched ${tot.matched} (recall ${(100 * tot.matched / tot.gtStrum).toFixed(1)}%, precision ${(100 * tot.matched / tot.detStrum).toFixed(1)}%); string-set Jaccard ${(tot.jacc / tot.matched).toFixed(2)}; direction ${tot.dirHit}/${tot.dirN} = ${(100 * tot.dirHit / tot.dirN).toFixed(1)}%`);
console.log('  direction confusion:', JSON.stringify(tot.dirConf));
for (const [k, v] of Object.entries(tot.tErr)) { if (!v.length) continue; const a = [...v].sort((x, y) => x - y), ab = v.map(Math.abs).sort((x, y) => x - y); console.log(`  onset timing (${k}, n=${v.length}): median signed ${a[a.length >> 1].toFixed(1)} ms, median |err| ${ab[ab.length >> 1].toFixed(1)} ms, p75 |err| ${ab[Math.floor(ab.length * 0.75)].toFixed(1)} ms`); }
console.log(`sustain: ${tot.durN} notes, median |dur error| ${(1000 * tot.durErr[tot.durErr.length >> 1]).toFixed(0)} ms, p75 ${(1000 * tot.durErr[Math.floor(tot.durErr.length * 0.75)]).toFixed(0)} ms`);

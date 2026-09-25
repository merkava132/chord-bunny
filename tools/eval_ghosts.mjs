// Ghost-string probe: when the tracker reports string S struck, how much
// fundamental is actually there? Compares true vs false string-S strikes on
// GuitarSet (hex-pickup ground truth) and, for the player's own recordings,
// strums on shapes where S is played vs muted (data/chords.json fingerings).
//   node tools/eval_ghosts.mjs --string=0 [--session=ID [--rec-dir=DIR] [--max-ts=T]] [--set=k=v,...]
// Features per reported strike: tracker peak, max fundamental support
// (StringTracker.support), and the profile-free ratio R = |X(f0)| / |X(2f0)|
// over the onset window.
import fs from 'node:fs';
import path from 'node:path';
import { frames, TUNING, PitchAnalyzer } from '../src/dsp/analyzer.js';
import { StringTracker } from '../src/dsp/strings.js';
import { decodeWav } from '../src/dsp/wav.js';
import { listExcerpts, loadExcerpt } from './guitarset.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const S = Number(args.string ?? 0);
const OVERRIDES = Object.fromEntries((args.set ? String(args.set).split(',') : []).map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const PROFILES_S = JSON.parse(fs.readFileSync(new URL('../data/partials_by_string.json', import.meta.url)));
const CHORDS = JSON.parse(fs.readFileSync(new URL('../data/chords.json', import.meta.url)));
const OPEN = ['SS3', 'Rock3', 'Rock1'];

function segmentShape(notes, t0, t1) {
  return notes.map((list, s) => { const cnt = new Map(); for (const n of list) { const a = Math.max(n.t0, t0), b = Math.min(n.t1, t1); if (b > a) { const m = Math.round(n.midi); cnt.set(m, (cnt.get(m) || 0) + b - a); } } let best = -1, bd = 0; for (const [m, d] of cnt) if (d > bd) { bd = d; best = m; } return best < 0 ? -1 : best - TUNING[s]; });
}

// Run the tracker over samples with a voicing schedule; call onStrike(ev, feats) for each reported strike of string S.
const HR_N = Number(args.hrn ?? 16384), HR_AT = Number(args.hrat ?? 0.02);   // high-resolution low-band check: 16384-point window starting HR_AT s after the onset
function run(samples, sr, voicingAt, onStrike, tBase = 0) {
  const tr = new StringTracker({ sampleRate: sr, profiles: PROFILES, profilesByString: PROFILES_S, ...OVERRIDES });
  const N = tr.o.fftSize, HOP = tr.o.hop;
  const hr = new PitchAnalyzer({ sampleRate: sr, fftSize: HR_N, minHz: 40, maxHz: 1200, pitchList: [40, 45], partials: 2 });
  const hrBin = (hz) => Math.round(hz * HR_N / sr);
  const hrPick = (mag, b, w = 1) => { let m = 0; for (let k = b - w; k <= b + w; k++) if (k >= hr.kMin && k <= hr.kMax) m = Math.max(m, mag[k - hr.kMin]); return m; };
  const hzOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
  const ring = [];   // per frame: { t, sup, m1, m2 }
  let cur = null;
  tr.onEvent = (ev) => {
    if (ev.type !== 'strum') return;
    const x = ev.strings.find(q => q.string === S && !q.inferred); if (!x) return;
    const w = ring.filter(f => f.t >= ev.t - 0.01 && f.t <= ev.t + 0.1);
    const late = ring.filter(f => f.t >= ev.t + 0.07 && f.t <= ev.t + 0.18);   // after the strum transient
    if (!w.length || !late.length) return;
    let sup = 0, m1 = 0, m2 = 0, rMax = 0; const rs = [];
    for (const f of w) { sup = Math.max(sup, f.sup); m1 = Math.max(m1, f.m1); m2 = Math.max(m2, f.m2); const r = f.m1 / (f.m2 + 1e-9); rs.push(r); rMax = Math.max(rMax, r); }
    rs.sort((a, b) => a - b);
    const lr = late.map(f => f.m1 / (f.m2 + 1e-9)).sort((a, b) => a - b), lm1 = late.map(f => f.m1).sort((a, b) => a - b);
    // fundamental vs the string's own activation: is |X(f0)| in proportion to what h[S] says the string is doing (peak-normalised)?
    // high-resolution spectrum of the ring after the transient: fundamental of S vs its 2nd partial, and vs the next string's fundamental (leakage check)
    const st0 = Math.round((ev.t + HR_AT - tBase) * sr); let hr1 = 0, hr2 = 0, hrNb = 0, hrFloor = 0;
    if (st0 >= 0 && st0 + HR_N <= samples.length) {
      const mag = hr.spectrum(samples.subarray(st0, st0 + HR_N));
      const f0 = hzOf(tr.pitches[S]);
      hr1 = hrPick(mag, hrBin(f0)); hr2 = hrPick(mag, hrBin(2 * f0));
      const nb = S < 5 ? tr.pitches[S + 1] : tr.pitches[S - 1]; hrNb = hrPick(mag, hrBin(hzOf(nb)));
      const lo = hrBin(f0) - 6, hi = hrBin(f0) + 6; let n = 0; for (let k = lo; k <= hi; k++) if (k >= hr.kMin && k <= hr.kMax && Math.abs(k - hrBin(f0)) > 1) { hrFloor += mag[k - hr.kMin]; n++; } hrFloor /= Math.max(1, n);
    }
    onStrike(ev, { peak: x.peak, muted: x.muted, sup, r: m1 / (m2 + 1e-9), rMax, rMed: rs[rs.length >> 1], m1, m2,
      rLate: lr[lr.length >> 1], m1Late: lm1[lm1.length >> 1] / (m1 + 1e-9), f0PerPeak: lm1[lm1.length >> 1] / (x.peak + 1e-9),
      hrR: hr1 / (hr2 + 1e-9), hrNb: hr1 / (hrNb + 1e-9), hrProm: hr1 / (hrFloor + 1e-9), hr1 });
  };
  for (const { start, frame } of frames(samples, N, HOP)) {
    const t = tBase + (start + N / 2) / sr;
    const v = voicingAt(t);
    if (v && v !== cur) { cur = v; tr.setVoicing(v); }
    if (!cur) continue;
    tr.process(frame, t);
    const an = tr.an, mag = an.spectrum(frame), b1 = tr.f0Bin[S], b2 = Math.round(2 * 440 * Math.pow(2, (tr.pitches[S] - 69) / 12) * N / sr);
    const pick = (b) => { let m = 0; for (let k = b - 1; k <= b + 1; k++) if (k >= an.kMin && k <= an.kMax) m = Math.max(m, mag[k - an.kMin]); return m; };
    ring.push({ t, sup: tr.support[S], m1: pick(b1), m2: pick(b2) }); if (ring.length > 60) ring.shift();
  }
}

const q = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const qs = (xs) => [0.1, 0.25, 0.5, 0.75, 0.9].map(p => q(xs, p).toFixed(2)).join(' / ');
function report(title, tru, fal) {
  console.log(`\n${title}: ${tru.length} true / ${fal.length} false string-${S} strikes reported`);
  for (const k of ['peak', 'r', 'rLate', 'hrR', 'hrNb', 'hrProm']) console.log(`  ${k.padEnd(9)} p10/25/50/75/90  true: ${qs(tru.map(x => x[k]))}   false: ${qs(fal.map(x => x[k]))}`);
  for (const k of ['r', 'hrR', 'hrProm']) {
    const ths = k === 'hrProm' ? [1.5, 2, 3, 4, 6, 8, 12] : [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6];
    console.log(`  gate on ${k} ≥ θ → true kept / false kept:  ` + ths.map(th => `${th}: ${(100 * tru.filter(x => x[k] >= th).length / Math.max(1, tru.length)).toFixed(0)}%/${(100 * fal.filter(x => x[k] >= th).length / Math.max(1, fal.length)).toFixed(0)}%`).join('  '));
  }
}

if (!args.session) {
  const tru = [], fal = [], sounding = [], silent = []; let gtOnsets = 0;
  for (const name of listExcerpts(f => f.includes('comp') && OPEN.some(s => f.includes(s)))) {
    const ex = loadExcerpt(name);
    const segs = ex.chords.filter(c => c.appId && c.t1 - c.t0 > 0.5).map(c => ({ ...c, shape: segmentShape(ex.notes, c.t0, c.t1) }));
    gtOnsets += ex.notes[S].filter(n => segs.some(c => n.t0 >= c.t0 + 0.1 && n.t0 < c.t1)).length;
    run(ex.samples, ex.sampleRate, (t) => segs.find(c => t >= c.t0 && t < c.t1)?.shape || null, (ev, f) => {
      if (!segs.some(c => ev.t >= c.t0 + 0.1 && ev.t < c.t1)) return;
      const hit = ex.notes[S].some(n => Math.abs(n.t0 - ev.t) < 0.06);
      const snd = ex.notes[S].some(n => ev.t + 0.05 >= n.t0 && ev.t + 0.05 < n.t1);
      (hit ? tru : fal).push(f); if (!hit && snd) sounding.push(f); else if (!hit) silent.push(f);
    });
  }
  console.log(`GuitarSet open subset: ${gtOnsets} ground-truth string-${S} onsets; tracker reported ${tru.length + fal.length} (recall ${(100 * tru.length / gtOnsets).toFixed(0)}%, precision ${(100 * tru.length / (tru.length + fal.length)).toFixed(0)}%); ${sounding.length} of the false ones had the string still ringing from an earlier strike`);
  report('GuitarSet, false = no onset within 60 ms', tru, fal);
  report('GuitarSet, false = string not sounding at all (ghosts)', tru, silent);
} else {
  const REC = args['rec-dir'] || '/mnt/aegis/chord-bunny/recordings', dir = path.join(REC, args.session);
  const labels = fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const segs = fs.readFileSync(path.join(dir, 'segments.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const byId = new Map(CHORDS.map(c => [c.id, c]));
  const maxTs = args['max-ts'] ? Number(args['max-ts']) : Infinity;
  const played = [], muted = [];
  for (const sg of segs) {
    if (sg.ts0 > maxTs) continue;
    const rows = labels.filter(r => r.seg === sg.seg);
    if (!rows.length) continue;
    const wav = decodeWav(fs.readFileSync(path.join(dir, `seg-${String(sg.seg).padStart(4, '0')}.wav`)));
    run(wav.samples, wav.sampleRate, (t) => { const r = rows.find(x => t >= x.ts0 && t < x.ts1); return r ? byId.get(r.target)?.fingering?.frets || null : null; }, (ev, f) => {
      const r = rows.find(x => ev.t >= x.ts0 + 0.5 && ev.t < x.ts1); if (!r || ev.t > maxTs) return;
      const frets = byId.get(r.target)?.fingering?.frets; if (!frets) return;
      (frets[S] >= 0 ? played : muted).push({ ...f, target: r.target });
    }, sg.ts0);
  }
  console.log(`session ${args.session}: string ${S} reported struck ${played.length}× on shapes where it is played, ${muted.length}× where it is muted (${[...new Set(muted.map(x => x.target))].join(' ')})`);
  report('player', played, muted);
}

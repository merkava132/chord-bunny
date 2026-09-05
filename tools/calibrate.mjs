// Confidence calibration for the geo scorer: coverage vs precision per threshold.
import fs from 'node:fs';
import { PitchAnalyzer, frames, rms } from '../src/dsp/analyzer.js';
import { APP_CHORDS, listExcerpts, loadExcerpt, chordAt, stringsAt } from './guitarset.mjs';
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const PCI = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11, Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10 };
const T = APP_CHORDS.map(c => ({ id: c.id, pcs: [...new Set(c.notes.map(n => PCI[n]))] }));
const rows = [];   // { conf, fit, margin, ok, chordFrame }
for (const name of listExcerpts(f => f.includes('comp') && ['SS3', 'Rock3', 'Rock1'].some(s => f.includes(s)))) {
  const ex = loadExcerpt(name);
  const an = new PitchAnalyzer({ sampleRate: ex.sampleRate, profiles: PROFILES });
  const sm = new Float32Array(an.nP); const hist = [];
  for (const { start, frame } of frames(ex.samples, 8192, 1024)) {
    const t = (start + 4096) / ex.sampleRate;
    if (rms(frame) < 0.006) { hist.length = 0; continue; }
    const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = 0.5 * sm[i] + 0.5 * act[i];
    const ch = an.chroma(sm);
    let b = -Infinity, s2 = -Infinity, bid = null;
    for (const { id, pcs } of T) { let s = 0; for (const pc of pcs) s += Math.log(ch[pc] + 0.1); s /= pcs.length; if (s > b) { s2 = b; b = s; bid = id; } else if (s > s2) s2 = s; }
    const fit = Math.max(0, Math.min(1, (b + 1.9) / 1.06)), margin = Math.max(0, Math.min(1, (b - s2) / 0.5));
    const gt = chordAt(ex.chords, t)?.appId;
    const chordFrame = !!gt && stringsAt(ex.notes, t).filter(m => m > 0).length >= 3;
    rows.push({ conf: 0.5 * fit + 0.5 * margin, fit, margin, ok: bid === gt, chordFrame, hasGt: !!gt });
  }
}
console.log(`${rows.length} frames (${rows.filter(r => r.chordFrame).length} chord frames)`);
console.log('thr   coverage(chord frames)  precision(verdicts on chord frames)  precision(all verdicts w/ GT)');
for (const thr of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
  const cf = rows.filter(r => r.chordFrame), v = cf.filter(r => r.conf >= thr);
  const all = rows.filter(r => r.hasGt && r.conf >= thr);
  console.log(`${thr.toFixed(2)}  ${(100 * v.length / cf.length).toFixed(1).padStart(6)}%                 ${(100 * v.filter(r => r.ok).length / Math.max(1, v.length)).toFixed(1).padStart(6)}%                        ${(100 * all.filter(r => r.ok).length / Math.max(1, all.length)).toFixed(1).padStart(6)}%`);
}
// which component predicts correctness better?
const auc = (key) => { const pos = rows.filter(r => r.chordFrame && r.ok).map(r => r[key]), neg = rows.filter(r => r.chordFrame && !r.ok).map(r => r[key]); let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0; return s / (pos.length * neg.length); };
console.log('AUC: conf', auc('conf').toFixed(3), 'fit', auc('fit').toFixed(3), 'margin', auc('margin').toFixed(3));

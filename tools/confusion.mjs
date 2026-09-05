// Confusion matrix + boundary analysis for one scorer config.
import { PitchAnalyzer, frames, rms, voicingPitches } from '../src/dsp/analyzer.js';
import { APP_CHORDS, listExcerpts, loadExcerpt, chordAt, stringsAt } from './guitarset.mjs';
const PCI = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11, Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10 };
const cosine12 = (a, b) => { let d = 0, na = 0; for (let i = 0; i < 12; i++) { d += a[i] * b[i]; na += a[i] * a[i]; } return na > 0 ? d / Math.sqrt(na) : 0; };
const OPEN = ['SS3', 'Rock3', 'Rock1'];
const conf = new Map(); const byAge = []; let n = 0, hit = 0;
for (const name of listExcerpts(f => f.includes('comp') && OPEN.some(s => f.includes(s)))) {
  const ex = loadExcerpt(name);
  const an = new PitchAnalyzer({ sampleRate: ex.sampleRate, compress: 1.0 });
  const V = APP_CHORDS.map(c => { const idx = voicingPitches(c.fingering.frets).filter(p => p > 0).map(p => an.pitchIndex(p)); const t = new Float32Array(12); for (const nn of c.notes) t[PCI[nn]] = 1; let s = 0; for (const x of t) s += x * x; s = Math.sqrt(s); for (let i = 0; i < 12; i++) t[i] /= s; return { id: c.id, idx, chromaT: t, root: PCI[c.root] }; });
  const N = 8192, sm = new Float32Array(an.nP); const hist = [];
  for (const { start, frame } of frames(ex.samples, N, 1024)) {
    const t = (start + N / 2) / ex.sampleRate;
    let pred = null;
    if (rms(frame) >= 0.006) {
      const act = an.analyze(frame); for (let i = 0; i < an.nP; i++) sm[i] = 0.5 * sm[i] + 0.5 * act[i];
      const ch = an.chroma(sm); let mx = 0; for (const a of sm) mx = Math.max(mx, a);
      let bass = -1; for (let i = 0; i < an.nP; i++) if (sm[i] > 0.3 * mx) { bass = an.pitches[i] % 12; break; }
      let tot = 0; for (const a of sm) tot += a;
      const sc = V.map(v => { let inV = 0, m2 = 0; for (const i of v.idx) { inV += sm[i]; m2 = Math.max(m2, sm[i]); } let cov = 0; for (const i of v.idx) cov += Math.min(sm[i], 0.3 * m2); cov /= (v.idx.length * 0.3 * m2 || 1); return cosine12(ch, v.chromaT) + (bass === v.root ? 0.12 : 0) + 0.5 * (inV / tot) * cov; });
      let bi = 0; for (let i = 1; i < sc.length; i++) if (sc[i] > sc[bi]) bi = i; pred = V[bi].id;
    }
    hist.push(pred); if (hist.length > 5) hist.shift();
    const m = new Map(); for (const p of hist) m.set(p, (m.get(p) || 0) + 1); let bp = null, bc = 0; for (const [p, c] of m) if (c > bc) { bc = c; bp = p; }
    const c = chordAt(ex.chords, t); if (!c?.appId) continue;
    if (stringsAt(ex.notes, t).filter(x => x > 0).length < 3) continue;
    n++; const ok = bp === c.appId; if (ok) hit++;
    const age = Math.min(9, Math.floor((t - c.t0) / 0.1)); (byAge[age] ||= { n: 0, hit: 0 }); byAge[age].n++; if (ok) byAge[age].hit++;
    if (!ok) { const k = `${c.appId}→${bp}`; conf.set(k, (conf.get(k) || 0) + 1); }
  }
}
console.log(`overall ${(100 * hit / n).toFixed(1)}%  (${n} frames)`);
console.log('accuracy by time since chord change (100ms bins):', byAge.map(b => `${(100 * b.hit / b.n).toFixed(0)}%`).join(' '));
console.log('top confusions (gt→pred):');
for (const [k, v] of [...conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log(`  ${k.padEnd(12)} ${v} (${(100 * v / (n - hit)).toFixed(0)}% of errors)`);

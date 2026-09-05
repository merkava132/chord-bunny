// Dump per-string activation vs GT for a time range of one excerpt.
//   node tools/trace.mjs 00_Rock3-148-C_comp 1.55 2.6 [every=2]
import fs from 'node:fs';
import { frames, TUNING, midiName } from '../src/dsp/analyzer.js';
import { StringTracker } from '../src/dsp/strings.js';
import { loadExcerpt, chordAt, stringsAt } from './guitarset.mjs';
const [name, a, b, every = 2] = process.argv.slice(2);
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const ex = loadExcerpt(name);
const PROFILES_S = JSON.parse(fs.readFileSync(new URL('../data/partials_by_string.json', import.meta.url)));
const tr = new StringTracker({ sampleRate: ex.sampleRate, profiles: PROFILES, profilesByString: PROFILES_S });
const seg = chordAt(ex.chords, (Number(a) + Number(b)) / 2);
// shape = mode of GT pitches in segment
const shape = ex.notes.map((l, s) => { const c = new Map(); for (const n of l) { const x = Math.max(n.t0, seg.t0), y = Math.min(n.t1, seg.t1); if (y > x) c.set(Math.round(n.midi), (c.get(Math.round(n.midi)) || 0) + y - x); } let bm = -1, bd = 0; for (const [m, d] of c) if (d > bd) { bd = d; bm = m; } return bm < 0 ? -1 : bm - TUNING[s]; });
console.log(`segment ${seg.label} shape ${shape.map(f => f < 0 ? 'x' : f).join('')} = ${shape.map((f, s) => f < 0 ? 'x' : midiName(TUNING[s] + f)).join(' ')}`);
tr.setVoicing(shape);
const evs = []; tr.onEvent = e => evs.push(e);
let i = 0;
console.log('   t     GT      h0    h1    h2    h3    h4    h5   noise  flux  onset');
for (const { start, frame } of frames(ex.samples, tr.o.fftSize, tr.o.hop)) {
  const t = (start + tr.o.fftSize / 2) / ex.sampleRate;
  const st = tr.process(frame, t);
  if (t < Number(a) || t > Number(b)) continue;
  if (i++ % Number(every)) continue;
  const gt = stringsAt(ex.notes, t).map(m => m > 0 ? '#' : '.').join('');
  console.log(`${t.toFixed(3)} ${gt}  ${Array.from(st.h, v => v.toFixed(1).padStart(5)).join(' ')}  ${st.noise.toFixed(1).padStart(5)} ${st.flux.toFixed(1).padStart(5)} ${st.onset ? '*' : ' '}  sup=${Array.from(tr.support, v => v.toFixed(2)).join(' ')} pres=${Array.from(st.present).join('')}`);
}
for (const e of evs) if (e.t >= Number(a) && e.t <= Number(b)) console.log(e.type === 'strum' ? `STRUM t=${e.t.toFixed(3)} ${e.direction} spread=${e.spreadMs.toFixed(0)}ms strings=${e.strings.map(s => `${s.string}@${s.t == null ? 'inf' : s.t.toFixed(3)}`).join(' ')}` : `off s${e.string} t=${e.t.toFixed(3)} dur=${e.duration.toFixed(2)}`);

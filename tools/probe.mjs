// Print activations for frames of a given GT chord in one excerpt.
//   node tools/probe.mjs 00_SS3-98-C_comp Em [maxFrames]
import fs from 'node:fs';
import { PitchAnalyzer, frames, rms, midiName, TUNING } from '../src/dsp/analyzer.js';
import { loadExcerpt, chordAt, stringsAt } from './guitarset.mjs';
const [name, want, maxN = 6] = process.argv.slice(2);
const PROFILES = JSON.parse(fs.readFileSync(new URL('../data/partials.json', import.meta.url)));
const ex = loadExcerpt(name);
const an = new PitchAnalyzer({ sampleRate: ex.sampleRate, profiles: PROFILES });
const N = 8192; let shown = 0;
const PC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
for (const { start, frame } of frames(ex.samples, N, 1024)) {
  const t = (start + N / 2) / ex.sampleRate;
  const c = chordAt(ex.chords, t); if (!c || c.appId !== want) continue;
  if (t - c.t0 < 0.4 || t - c.t0 > 0.6) continue;
  if (rms(frame) < 0.006) continue;
  const gtStrings = stringsAt(ex.notes, t);
  const act = an.analyze(frame);
  const ch = an.chroma(act);
  const ranked = [...act].map((a, i) => [a, an.pitches[i]]).sort((a, b) => b[0] - a[0]).slice(0, 9);
  console.log(`t=${t.toFixed(2)} GT strings: ${gtStrings.map((m, s) => m > 0 ? midiName(Math.round(m)) : 'x').join(' ')}`);
  console.log(`   act: ${ranked.map(([a, m]) => `${midiName(m)}=${a.toFixed(0)}`).join(' ')}`);
  console.log(`   chroma: ${PC.map((n, i) => `${n}=${(ch[i] * 100).toFixed(0)}`).join(' ')}`);
  if (++shown >= maxN) break;
}

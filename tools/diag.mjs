import { frames, rms, midiName, TUNING } from '../src/dsp/analyzer.js';
import { listExcerpts, loadExcerpt, chordAt, stringsAt } from './guitarset.mjs';
for (const name of listExcerpts(f => f.includes('comp'))) {
  const ex = loadExcerpt(name);
  const levels = [];
  for (const { frame } of frames(ex.samples, 8192, 4096)) levels.push(rms(frame));
  levels.sort((a, b) => a - b);
  const med = levels[levels.length >> 1], p90 = levels[Math.floor(levels.length * 0.9)];
  const gated = levels.filter(l => l < 0.006).length / levels.length;
  // performed-vs-instructed label agreement
  const perf = new Map();
  for (const p of ex.performed) perf.set(p.label, (perf.get(p.label) || 0) + p.t1 - p.t0);
  const top = [...perf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, d]) => `${l}(${d.toFixed(0)}s)`).join(' ');
  // voicing: sample notes at chord midpoints, show fret per string
  const voicings = new Map();
  for (const c of ex.chords) {
    if (!c.appId) continue;
    const mids = stringsAt(ex.notes, (c.t0 + c.t1) / 2, 0.05);
    const fr = mids.map((m, s) => m < 0 ? 'x' : String(Math.round(m) - TUNING[s])).join('');
    const key = `${c.appId}:${fr}`;
    voicings.set(key, (voicings.get(key) || 0) + 1);
  }
  const vtop = [...voicings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}×${n}`).join(' ');
  console.log(`${name.padEnd(24)} rms med=${med.toFixed(4)} p90=${p90.toFixed(4)} gated=${(gated * 100).toFixed(0)}%  | ${top}\n${''.padEnd(24)} voicings: ${vtop}`);
}

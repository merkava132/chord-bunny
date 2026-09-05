// Ground-truth strum statistics: cluster per-string note onsets into strum
// events and report spread / direction / string counts.
import { listExcerpts, loadExcerpt } from './guitarset.mjs';
const CLUSTER = 0.08;     // onsets within 80 ms belong to the same strum
const spreads = [], counts = [], dirs = { down: 0, up: 0, flat: 0 };
let files = 0;
for (const name of listExcerpts(f => f.includes('comp') && ['SS3', 'Rock3', 'Rock1'].some(s => f.includes(s)))) {
  const ex = loadExcerpt(name); files++;
  const onsets = [];
  ex.notes.forEach((list, s) => list.forEach(n => onsets.push({ t: n.t0, s, dur: n.t1 - n.t0 })));
  onsets.sort((a, b) => a.t - b.t);
  let i = 0;
  while (i < onsets.length) {
    let j = i + 1;
    while (j < onsets.length && onsets[j].t - onsets[j - 1].t < CLUSTER / 2 && onsets[j].t - onsets[i].t < CLUSTER) j++;
    const ev = onsets.slice(i, j);
    if (ev.length >= 3) {
      const spread = ev[ev.length - 1].t - ev[0].t;
      spreads.push(spread); counts.push(ev.length);
      // direction: Spearman-ish slope of string index vs onset order
      let sum = 0; for (let a = 0; a < ev.length - 1; a++) sum += Math.sign(ev[a + 1].s - ev[a].s);
      if (sum > 0) dirs.down++; else if (sum < 0) dirs.up++; else dirs.flat++;
    }
    i = j;
  }
}
spreads.sort((a, b) => a - b);
const q = (p) => (spreads[Math.floor(p * (spreads.length - 1))] * 1000).toFixed(0);
console.log(`${files} files, ${spreads.length} strums with ≥3 strings`);
console.log(`spread (first→last string onset): p10=${q(0.1)}ms p25=${q(0.25)}ms p50=${q(0.5)}ms p75=${q(0.75)}ms p90=${q(0.9)}ms`);
const hist = {}; for (const c of counts) hist[c] = (hist[c] || 0) + 1;
console.log('strings per strum:', Object.entries(hist).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('direction:', dirs);

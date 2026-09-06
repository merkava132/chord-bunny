// Summarise a telemetry session (what the app heard, how practice went).
//   node tools/telemetry_report.mjs [telemetry/<session>.jsonl | latest] [--frames]
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '../telemetry');
const args = process.argv.slice(2);
let file = args.find(a => !a.startsWith('--')) || 'latest';
if (file === 'latest') {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).map(f => path.join(DIR, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  file = files[0];
}
const ev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const by = (t) => ev.filter(e => e.type === t);
const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '–';
const q = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const sess = by('session')[0];
const dur = ev.length ? ev[ev.length - 1].t : 0;
console.log(`${path.basename(file)}  ${ev.length} events  ${(dur / 60).toFixed(1)} min  chords=${sess?.chords}  enabled=${sess?.settings?.enabledChords?.join(' ')}`);
for (const m of by('mic')) console.log(`mic: ${m.state} ${m.label || m.error || ''} sr=${m.sampleRate || ''} @${m.t}s`);
const modes = by('mode').map(m => `${m.mode}@${m.t.toFixed(0)}s`); if (modes.length) console.log('modes:', modes.join(' '));
const sets = by('setting').filter(s => s.key !== 'mode'); if (sets.length) console.log('settings changed:', sets.map(s => `${s.key}=${JSON.stringify(s.value).slice(0, 40)}`).join(', '));

// --- signal ---
const fr = by('frame'), playing = fr.filter(f => f.conf !== undefined);
if (fr.length) {
  const levels = playing.map(f => f.level), peaks = playing.map(f => f.peak), clips = playing.filter(f => f.clip > 0.001).length;
  console.log(`\nsignal: ${fr.length} frame samples, ${playing.length} while playing (${pct(playing.length, fr.length)} of sampled time)`);
  console.log(`  level median ${q(levels, .5)?.toFixed(3)} p90 ${q(levels, .9)?.toFixed(3)}   peak median ${q(peaks, .5)?.toFixed(2)} max ${Math.max(0, ...peaks).toFixed(2)}   clipping in ${pct(clips, playing.length)} of playing frames`);
  const confs = playing.map(f => f.conf);
  const verdict = playing.filter(f => f.id).length;
  console.log(`  confidence median ${q(confs, .5)?.toFixed(2)} p25 ${q(confs, .25)?.toFixed(2)} p75 ${q(confs, .75)?.toFixed(2)}   verdict on ${pct(verdict, playing.length)} of playing frames`);
  const heard = new Map(); for (const f of playing) if (f.id) heard.set(f.id, (heard.get(f.id) || 0) + 1);
  console.log('  heard (frame share):', [...heard.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${pct(v, verdict)}`).join('  '));
}

// --- stable runs (how long each verdict held; practice needs ≥ minHold) ---
const runs = by('run');
if (runs.length) {
  const perId = new Map();
  for (const r of runs) { const e = perId.get(r.id) || { n: 0, durs: [] }; e.n++; e.durs.push(r.dur); perId.set(r.id, e); }
  console.log(`\nverdict runs: ${runs.length}, median ${q(runs.map(r => r.dur), .5).toFixed(2)}s, ${pct(runs.filter(r => r.dur >= 0.35).length, runs.length)} held ≥0.35s`);
  console.log('  ' + [...perId.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([id, e]) => `${id} ×${e.n} med ${q(e.durs, .5).toFixed(2)}s max ${Math.max(...e.durs).toFixed(1)}s`).join('  '));
}

// --- practice ---
const pairs = by('pair'), matches = by('match'), misses = by('miss');
if (pairs.length) {
  console.log(`\npractice: ${pairs.length} targets shown, ${matches.length} matched, ${pairs.filter(p => p.reason === 'timer').length} by timer, ${pairs.filter(p => p.reason === 'reroll').length} rerolls`);
  const lat = matches.map(m => m.sinceShown);
  if (lat.length) console.log(`  time to match: median ${q(lat, .5).toFixed(1)}s p90 ${q(lat, .9).toFixed(1)}s`);
  const perTarget = new Map();
  for (const p of pairs) { const e = perTarget.get(p.cur) || { shown: 0, matched: 0, heard: new Map() }; e.shown++; perTarget.set(p.cur, e); }
  for (const m of matches) { const e = perTarget.get(m.target); if (e) e.matched++; }
  // a miss within 1 s of the advance where the previous target is heard is just the old chord still ringing
  let carry = 0;
  for (const m of misses) {
    const i = pairs.findIndex(p => p.t > m.t) - 1, prev = pairs[i - 1]?.cur;
    if (m.sinceShown < 1 && m.heard[0] === prev) { carry++; continue; }
    const e = perTarget.get(m.target); if (e) e.heard.set(m.heard[0], (e.heard.get(m.heard[0]) || 0) + 1);
  }
  if (carry) console.log(`  (${carry} of ${misses.length} misses were the previous chord still ringing within 1 s of the advance)`);
  for (const [id, e] of [...perTarget.entries()].sort((a, b) => b[1].shown - a[1].shown)) {
    const instead = [...e.heard.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(' ');
    console.log(`  ${id.padEnd(7)} shown ${String(e.shown).padStart(2)}  matched ${String(e.matched).padStart(2)}${instead ? `  heard instead: ${instead}` : ''}`);
  }
  const trans = new Map(); for (let i = 1; i < pairs.length; i++) { const k = `${pairs[i - 1].cur}→${pairs[i].cur}`; trans.set(k, (trans.get(k) || 0) + 1); }
  console.log('  transitions:', [...trans.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v}`).join('  '));
}

// --- listen ---
const verdicts = by('verdict').filter(v => v.id);
if (verdicts.length) {
  const gaps = []; for (let i = 1; i < verdicts.length; i++) gaps.push(verdicts[i].t - verdicts[i - 1].t);
  console.log(`\nlisten: ${verdicts.length} verdicts, median ${q(gaps, .5)?.toFixed(2)}s apart, ${pct(gaps.filter(g => g < 0.5).length, gaps.length)} within 0.5s of the previous (flicker)`);
  console.log('  sequence:', verdicts.slice(-30).map(v => v.id).join(' '));
}

// --- strings / recordings ---
const strums = by('strum');
if (strums.length) {
  const dirs = new Map(); for (const s of strums) dirs.set(s.direction, (dirs.get(s.direction) || 0) + 1);
  console.log(`\nstrums: ${strums.length}  direction: ${[...dirs.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}  strings/strum median ${q(strums.map(s => s.strings.length), .5)}`);
}
const recs = by('rec');
if (recs.length) console.log(`\nrecordings: ${recs.length} segments, ${(recs.reduce((s, r) => s + r.dur, 0) / 60).toFixed(1)} min of audio (session ${sess?.session})`);
if (args.includes('--frames')) for (const f of playing.slice(-40)) console.log(`  ${f.t.toFixed(1).padStart(7)} lvl ${f.level.toFixed(3)} pk ${f.peak.toFixed(2)} ${String(f.id || '—').padEnd(6)} conf ${f.conf.toFixed(2)}  top ${f.top.map(([i, s]) => `${i}:${s}`).join(' ')}`);

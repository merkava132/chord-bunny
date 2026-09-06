// Realistic chord clips for every voicing in data/chords.json, mixed from the
// real single-string notes in testdata/notebank (tools/note_bank.mjs).
//   node tools/synth_chords.mjs [--out=testdata/synth] [--seed=1] [--clean=6] [--len=2.5]
// Variants per chord (labels.jsonl says which):
//   clean       random note instances, strum down/up with 5–25 ms between strings, ±4 dB per string
//   restrum     two strums 0.9 s apart
//   openMuted   every "x" string struck as its open string (the user hits open A on D)
//   missingTop  highest sounding string not struck
//   weakTop     highest string −12 dB (the user's top string is quiet)
//   missingInner one random fretted inner string not struck
// A (string, fret) with no bank note is borrowed from the nearest fret on the
// same string (±3) and resampled; `shifted` in the label. Timbre is the
// hexaphonic pickup, not a mic: partial structure is real, room and body
// resonance are not.
import fs from 'node:fs';
import path from 'node:path';
import { encodeWav } from '../src/dsp/wav.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const ROOT = path.resolve(import.meta.dirname, '..');
const BANK = path.join(ROOT, 'testdata/notebank');
const OUT = path.resolve(ROOT, args.out || 'testdata/synth');
const LEN = Number(args.len ?? 2.5), N_CLEAN = Number(args.clean ?? 6);
const CHORDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/chords.json')));
const index = JSON.parse(fs.readFileSync(path.join(BANK, 'index.json')));
const bankBuf = fs.readFileSync(path.join(BANK, 'bank.f32'));
const bank = new Float32Array(bankBuf.buffer, bankBuf.byteOffset, bankBuf.byteLength / 4);
const SR = index.sampleRate;

// seeded RNG (mulberry32) so the bench is reproducible
let seed = Number(args.seed ?? 1) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const uni = (a, b) => a + rnd() * (b - a);

const byKey = new Map();
for (const n of index.notes) { const k = `${n.string}:${n.fret}`; (byKey.get(k) || byKey.set(k, []).get(k)).push(n); }
// prefer long ring-outs: pick among the longest half of the instances
const pickLong = (arr) => { const s = [...arr].sort((a, b) => b.gap - a.gap); return pick(s.slice(0, Math.max(1, Math.ceil(s.length / 2)))); };
// every note normalised to the same RMS over its first 100 ms, so a softly
// picked bank note and a hard one contribute alike (per-string ±dB is applied on top)
const REF_RMS = 0.1;
function noteSamples(n) {
  const x = bank.subarray(n.offset, n.offset + n.length);
  const m = Math.min(x.length, Math.round(0.1 * SR)); let ss = 0; for (let i = 0; i < m; i++) ss += x[i] * x[i];
  const g = REF_RMS / Math.max(1e-4, Math.sqrt(ss / m));
  const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  return y;
}

function resample(x, ratio) {           // ratio > 1 → higher pitch, shorter
  const n = Math.floor(x.length / ratio), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * ratio, j = Math.floor(p), f = p - j; y[i] = x[j] * (1 - f) + (x[j + 1] ?? 0) * f; }
  return y;
}
// a note for (string, fret): exact if available, else nearest fret ±3 resampled
function noteFor(s, fret) {
  const exact = byKey.get(`${s}:${fret}`);
  if (exact?.length) { const n = pickLong(exact); return { samples: noteSamples(n), src: n.src, shifted: 0 }; }
  for (let d = 1; d <= 3; d++) for (const f of [fret - d, fret + d]) {
    const c = byKey.get(`${s}:${f}`);
    if (c?.length) { const n = pickLong(c); return { samples: resample(noteSamples(n), Math.pow(2, (fret - f) / 12)), src: n.src, shifted: fret - f }; }
  }
  throw new Error(`no note for string ${s} fret ${fret}`);
}

fs.mkdirSync(OUT, { recursive: true });
const labels = [];
let clips = 0;
function render(chord, variant, k, { strings, gainsDb, direction, restrumAt = null }) {
  const out = new Float32Array(Math.round(LEN * SR));
  const notes = [];
  const order = direction === 'down' ? [...strings].sort((a, b) => a.s - b.s) : [...strings].sort((a, b) => b.s - a.s);
  const strums = restrumAt === null ? [0] : [0, restrumAt];
  for (const t0 of strums) {
    let t = t0;
    for (const { s, fret } of order) {
      const n = noteFor(s, fret);
      const g = Math.pow(10, (gainsDb[s] ?? 0) / 20);
      const start = Math.round(t * SR);
      const x = n.samples;
      for (let i = 0; i < x.length && start + i < out.length; i++) out[start + i] += x[i] * g;
      if (t0 === 0) notes.push({ string: s, fret, src: n.src, shifted: n.shifted, gainDb: +(gainsDb[s] ?? 0).toFixed(1), at: +t.toFixed(4) });
      t += uni(0.005, 0.025);
    }
  }
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.5 / peak;
  const dir = path.join(OUT, chord.id.replace('/', '_over_'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${variant}-${k}.wav`);
  fs.writeFileSync(file, encodeWav(out, SR));
  labels.push({ file: path.relative(ROOT, file), id: chord.id, category: chord.category, variant, direction, restrumAt, notes });
  clips++;
}

for (const chord of CHORDS) {
  const frets = chord.fingering.frets;
  const sounding = frets.map((f, s) => ({ s, fret: f })).filter(x => x.fret >= 0);
  const muted = frets.map((f, s) => ({ s, fret: f })).filter(x => x.fret < 0);
  const top = sounding[sounding.length - 1];
  const gains = () => Object.fromEntries(sounding.map(x => [x.s, uni(-4, 4)]));
  for (let k = 0; k < N_CLEAN; k++) render(chord, 'clean', k, { strings: sounding, gainsDb: gains(), direction: k % 3 === 2 ? 'up' : 'down' });
  for (let k = 0; k < 2; k++) render(chord, 'restrum', k, { strings: sounding, gainsDb: gains(), direction: 'down', restrumAt: 0.9 });
  if (muted.length) for (let k = 0; k < 2; k++) {
    const g = gains(); for (const m of muted) g[m.s] = -3;
    render(chord, 'openMuted', k, { strings: [...sounding, ...muted.map(m => ({ s: m.s, fret: 0 }))], gainsDb: g, direction: 'down' });
  }
  if (sounding.length > 3) render(chord, 'missingTop', 0, { strings: sounding.filter(x => x !== top), gainsDb: gains(), direction: 'down' });
  { const g = gains(); g[top.s] = -12; render(chord, 'weakTop', 0, { strings: sounding, gainsDb: g, direction: 'down' }); }
  const inner = sounding.filter(x => x.fret > 0 && x !== top && x !== sounding[0]);
  if (inner.length) { const drop = pick(inner); render(chord, 'missingInner', 0, { strings: sounding.filter(x => x !== drop), gainsDb: gains(), direction: 'down' }); }
}
fs.writeFileSync(path.join(OUT, 'labels.jsonl'), labels.map(l => JSON.stringify(l)).join('\n') + '\n');
const shifted = labels.reduce((n, l) => n + l.notes.filter(x => x.shifted).length, 0), total = labels.reduce((n, l) => n + l.notes.length, 0);
console.log(`${clips} clips for ${CHORDS.length} chords → ${OUT} (${(clips * LEN / 60).toFixed(1)} min); ${shifted}/${total} notes borrowed from a neighbouring fret`);

// Build a bank of real single-string guitar notes from GuitarSet's debleeded
// hexaphonic-pickup takes (testdata/hex/*_hex_cln.wav, one channel per
// string, low E first) and their JAMS note annotations.
//   node tools/note_bank.mjs [--min-gap=0.8] [--max-len=2.5] [--out=testdata/notebank]
// Each note is cut from its onset to the next onset on the same string (the
// string keeps ringing past the annotated duration), so `gap` is the natural
// ring-out available. Output: <out>/bank.f32 (concatenated Float32 samples)
// + <out>/index.json ({ sampleRate, notes: [{ string, fret, midi, offset, length, gap, src }] }).
import fs from 'node:fs';
import path from 'node:path';
import { decodeWav } from '../src/dsp/wav.js';
import { TUNING } from '../src/dsp/analyzer.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const HEX = path.resolve(import.meta.dirname, '../testdata/hex');
const JAMS = path.resolve(import.meta.dirname, '../testdata/jams');
const OUT = path.resolve(import.meta.dirname, '..', args.out || 'testdata/notebank');
const MIN_GAP = Number(args['min-gap'] ?? 0.8);     // s of ring-out before the next note on that string
const MAX_LEN = Number(args['max-len'] ?? 2.5);
const PRE = 0.005;                                   // s before the annotated onset
const MIN_RMS = 0.01;                                // reject dead / mis-annotated notes

fs.mkdirSync(OUT, { recursive: true });
const notes = [];
const chunks = [];
let offset = 0, sampleRate = 0;
for (const f of fs.readdirSync(HEX).filter(f => f.endsWith('_hex_cln.wav')).sort()) {
  const base = f.replace('_hex_cln.wav', '');
  const jp = path.join(JAMS, base + '.jams');
  if (!fs.existsSync(jp)) { console.error(`no jams for ${base}`); continue; }
  const wav = decodeWav(fs.readFileSync(path.join(HEX, f)), { split: true });
  if (wav.channels.length !== 6) { console.error(`${f}: ${wav.channels.length} channels, skipped`); continue; }
  sampleRate = sampleRate || wav.sampleRate;
  if (wav.sampleRate !== sampleRate) throw new Error('mixed sample rates');
  const jams = JSON.parse(fs.readFileSync(jp));
  let kept = 0, seen = 0;
  for (const a of jams.annotations) {
    if (a.namespace !== 'note_midi') continue;
    const s = Number(a.annotation_metadata.data_source);
    const ch = wav.channels[s];
    const ev = [...a.data].sort((x, y) => x.time - y.time);
    for (let i = 0; i < ev.length; i++) {
      seen++;
      const e = ev[i], fret = Math.round(e.value - TUNING[s]);
      if (fret < 0 || fret > 15 || Math.abs(e.value - TUNING[s] - fret) > 0.4) continue;   // bends / mis-tracked
      const next = ev[i + 1]?.time ?? Infinity;
      const gap = Math.min(next - e.time, MAX_LEN + PRE);
      if (gap < MIN_GAP) continue;
      const a0 = Math.max(0, Math.round((e.time - PRE) * sampleRate)), a1 = Math.min(ch.length, Math.round((e.time - PRE + gap) * sampleRate));
      let seg = Float32Array.from(ch.subarray(a0, a1));
      // the annotations miss some re-plucks: cut at the first energy rise
      // (> +6 dB over the running minimum of the last 60 ms) after the attack
      const hop = Math.round(0.01 * sampleRate), env = [];
      for (let k = 0; k + hop <= seg.length; k += hop) { let ss = 0; for (let j = k; j < k + hop; j++) ss += seg[j] * seg[j]; env.push(Math.sqrt(ss / hop)); }
      let cut = -1;
      for (let k = 12; k < env.length; k++) { let mn = Infinity; for (let j = k - 6; j < k; j++) mn = Math.min(mn, env[j]); if (env[k] > 2 * mn && env[k] > 0.01) { cut = k; break; } }
      if (cut >= 0) { seg = seg.subarray(0, (cut - 1) * hop); if (seg.length < MIN_GAP * sampleRate) continue; }
      let ss = 0; for (let k = 0; k < Math.min(seg.length, sampleRate * 0.3); k++) ss += seg[k] * seg[k];
      if (Math.sqrt(ss / Math.min(seg.length, sampleRate * 0.3)) < MIN_RMS) continue;
      const fade = Math.min(seg.length, Math.round(0.02 * sampleRate));       // fade the tail so the cut doesn't click
      for (let k = 0; k < fade; k++) seg[seg.length - 1 - k] *= k / fade;
      let peak = 0; for (const v of seg) peak = Math.max(peak, Math.abs(v));
      notes.push({ string: s, fret, midi: +e.value.toFixed(2), offset, length: seg.length, gap: +(seg.length / sampleRate).toFixed(3), dur: +e.duration.toFixed(3), peak: +peak.toFixed(3), truncated: cut >= 0, src: base });
      chunks.push(seg); offset += seg.length; kept++;
    }
  }
  console.error(`${base}: ${kept}/${seen} notes kept`);
}
const all = new Float32Array(offset); let p = 0; for (const c of chunks) { all.set(c, p); p += c.length; }
fs.writeFileSync(path.join(OUT, 'bank.f32'), Buffer.from(all.buffer));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ sampleRate, notes }, null, 0));
const cover = new Map(); for (const n of notes) cover.set(`${n.string}:${n.fret}`, (cover.get(`${n.string}:${n.fret}`) || 0) + 1);
console.log(`${notes.length} notes, ${(offset / sampleRate / 60).toFixed(1)} min, ${cover.size} (string,fret) pairs covered → ${OUT}`);
for (let s = 0; s < 6; s++) console.log(`  string ${s}: ` + Array.from({ length: 13 }, (_, f) => `${f}:${cover.get(`${s}:${f}`) || '-'}`).join(' '));

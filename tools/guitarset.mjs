// GuitarSet loader for the eval harness: WAV + JAMS → { samples, sampleRate,
// chords: [{t0,t1,label,appId}], notes: [[{t0,t1,midi}] × 6 strings] }.
import fs from 'node:fs';
import path from 'node:path';
import { decodeWav } from '../src/dsp/wav.js';

export const TESTDATA = path.resolve(import.meta.dirname, '../testdata');
export const APP_CHORDS = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../data/chords.json')));
const APP_IDS = new Set(APP_CHORDS.map(c => c.id));

const ENH = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
const QUAL = { maj: '', min: 'm', maj7: 'maj7', min7: 'm7', '7': '7', dom7: '7', sus2: 'sus2', sus4: 'sus4' };

// JAMS chord label (e.g. "G:maj(2)/1", "A:min", "N") → app chord id or null.
export function jamsToAppId(label) {
  if (label === 'N' || label === 'X') return null;
  // "G:maj(2)/1" → root G, quality maj (extensions in parens and bass ignored)
  const m = /^([A-G][#b]?):([a-z0-9]+)/.exec(label);
  if (!m) return null;
  const root = ENH[m[1]] ?? m[1];
  const q = QUAL[m[2]];
  if (q === undefined) return null;
  const id = root + q;
  return APP_IDS.has(id) ? id : null;
}

export function listExcerpts(filter = () => true) {
  return fs.readdirSync(path.join(TESTDATA, 'audio'))
    .filter(f => f.endsWith('.wav') && filter(f))
    .sort()
    .map(f => f.replace('_mic.wav', ''));
}

export function loadExcerpt(name) {
  const wav = decodeWav(fs.readFileSync(path.join(TESTDATA, 'audio', `${name}_mic.wav`)));
  const jams = JSON.parse(fs.readFileSync(path.join(TESTDATA, 'jams', `${name}.jams`)));
  const chordAnn = jams.annotations.filter(a => a.namespace === 'chord');
  // [0] = instructed lead-sheet chords, [1] = performed (with voicing hints)
  const chords = chordAnn[0].data.map(e => ({
    t0: e.time, t1: e.time + e.duration, label: e.value, appId: jamsToAppId(e.value),
  }));
  const performed = (chordAnn[1] || chordAnn[0]).data.map(e => ({
    t0: e.time, t1: e.time + e.duration, label: e.value, appId: jamsToAppId(e.value),
  }));
  const notes = [[], [], [], [], [], []];
  for (const a of jams.annotations) {
    if (a.namespace !== 'note_midi') continue;
    const s = Number(a.annotation_metadata.data_source);
    for (const e of a.data) notes[s].push({ t0: e.time, t1: e.time + e.duration, midi: e.value });
    notes[s].sort((x, y) => x.t0 - y.t0);
  }
  const tempo = jams.annotations.find(a => a.namespace === 'tempo')?.data[0]?.value ?? null;
  return { name, samples: wav.samples, sampleRate: wav.sampleRate, duration: jams.file_metadata.duration, chords, performed, notes, tempo };
}

export function chordAt(chords, t) {
  for (const c of chords) if (t >= c.t0 && t < c.t1) return c;
  return null;
}

// Which strings have a note sounding at time t (with the note's midi).
export function stringsAt(notes, t, tol = 0) {
  return notes.map(list => {
    for (const n of list) if (t >= n.t0 - tol && t < n.t1 + tol) return n.midi;
    return -1;
  });
}

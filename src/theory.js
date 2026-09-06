// Which chords make sense next to each other. Used by practice mode so that
// a transition is always one you'd meet in a song: both chords fit a common
// key, or they share a root (C → Csus4 → C, D → Dsus2, Am → Am7 …).

import { pitchClasses } from './detect.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];   // admits E7 in A minor, B7 in E minor
const PC_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

// 24 scales as bitmasks over the 12 pitch classes
const SCALES = [];
for (let tonic = 0; tonic < 12; tonic++) {
  for (const shape of [MAJOR, HARMONIC_MINOR]) {
    let mask = 0;
    for (const d of shape) mask |= 1 << ((tonic + d) % 12);
    SCALES.push(mask);
  }
}

const maskCache = new WeakMap();
function keyMask(chord) {
  let m = maskCache.get(chord);
  if (m === undefined) {
    let pcs = 0;
    for (const pc of pitchClasses(chord)) pcs |= 1 << pc;
    m = 0;
    SCALES.forEach((s, i) => { if ((pcs & s) === pcs) m |= 1 << i; });
    maskCache.set(chord, m);
  }
  return m;
}

function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }

// 0 = unrelated; otherwise the number of keys both chords fit, +3 for a
// shared root.
export function relatedness(a, b) {
  const shared = popcount(keyMask(a) & keyMask(b));
  const sameRoot = PC_INDEX[a.root] === PC_INDEX[b.root] ? 3 : 0;
  return shared + sameRoot;
}

// Pick the chord to practise after `current` from `pool`, weighted by
// relatedness. Falls back to a uniform pick when nothing is related (or
// there is no current chord).
export function pickNext(current, pool, rng = Math.random) {
  const options = pool.filter(c => !current || c.id !== current.id);
  if (options.length === 0) return null;
  if (!current) return options[Math.floor(rng() * options.length)];
  const weights = options.map(c => relatedness(current, c));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total === 0) return options[Math.floor(rng() * options.length)];
  let r = rng() * total;
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r < 0) return options[i];
  }
  return options[options.length - 1];
}

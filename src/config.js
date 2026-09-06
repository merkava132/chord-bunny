// Every tunable in one place, with the evidence for its value. The app and
// the eval tools import the same object, so a benchmark number always
// describes the code that ships.
//
// Experiments without editing: any leaf can be overridden from the URL,
//   ?cfg=detect.lam:0.4,stable.frac:0.7,listen.showMs:100
// (applied by applyOverrides() at startup; the effective config is logged in
// the telemetry `session` event). Tools accept the same string via --cfg=.

export const CONFIG = {
  detect: {
    fftSize: 8192,        // 186 ms @ 48 kHz — pitch resolution for the low strings
    hop: 1024,            // 21 ms verdict rate
    ema: 0.5,             // activation smoothing across frames
    smoothingLen: 5,      // majority-of-N on raw verdicts (needs ≥60% agreement)
    rmsGate: 0.006,       // below this the frame is silence
    eps: 0.1,             // log floor in the geometric-mean template score
    // Penalty on chroma mass outside the template. Without it a 4-note
    // template (Cmaj7) only beats its triad when the 7th is as loud as the
    // average chord tone. GuitarSet performed labels, basic+7th candidates:
    // 7th recall 23→41%, maj7 10→27%, min7 15→28%, plain triads 88→83%.
    // No effect when only triads compete.
    lam: 0.5,
    // Per-category prior subtracted from the score. Sus chords tie with majors
    // whose 3rd is weak (G with a single B, A leaking from D's 3rd partial);
    // 0.15 on sus: basic 79→87% with basic+sus candidates, sus recall unchanged.
    prior: { sus: 0.15 },
  },
  confidence: {
    // conf = fitWeight·fit + (1−fitWeight)·margin; margin = (best − runner-up)/margin,
    // runner-up skips templates nested with the winner. margin 0.3 (was 0.5
    // with 21 chords): at threshold 0.35 the basic set gets a verdict on 79%
    // of chord frames at 94% precision, all 53 candidates 78% / 84%.
    margin: 0.3,
    fitWeight: 0.5,
    poor: -1.9,           // template score that counts as "no fit at all"
  },
  sensitivity: {
    // slider 0–100 → confidence threshold; 55 (default) → 0.35
    min: 0.10, max: 0.55, defaultSlider: 55,
  },
  stable: {
    // Practice matching: a chord fires when it is the smoothed verdict on
    // ≥ frac of the frames in the last minHold × win seconds (blank frames at
    // strum onsets no longer reset it). GuitarSet ≥2 s segments: 83→93%
    // matched, wrong fires 4→7% (tools/eval_hold.mjs).
    win: 1.4,
    frac: 0.6,
    minHoldMs: 350,       // user setting default
  },
  listen: {
    // Show a chord only after it has held showMs; keep it through gaps
    // shorter than gapMs. 160/400: 1.9 display changes per chord segment vs
    // 8.6 with none, 80% right when shown (tools/eval_listen.mjs).
    showMs: 160,
    gapMs: 400,
  },
  meter: {
    // practice meter: threshold at the midpoint, threshold + span fills it
    span: 0.25,
    idleMax: 0.45,        // fill while there is no verdict, scaled by conf/threshold
  },
  recorder: {
    gate: 0.006,          // RMS over gateSec must reach this (typing ≈0.002, quiet strum ≈0.01)
    gateSec: 0.1,
    preRollSec: 0.5,
    tailSec: 2,
    maxSec: 60,
    musicConf: 0.25,      // a segment with no frame at this confidence is dropped (bumps, clicks)
  },
  telemetry: {
    flushMs: 2000,
    frameEvery: 10,       // frame samples: every Nth frame while playing (~5/s) …
    silentEvery: 50,      // … and every Nth in silence (~1/s)
  },
  profile: {
    // Personal chroma profile (data/user/profile.json, written by
    // tools/learn_profile.mjs from the player's own matched takes). Template
    // weights become (1−alpha)·uniform + alpha·profile for chords that have
    // one. Leave-one-out on the first session (77 intervals, basic chords):
    // settled-frame accuracy 56→59%, wrong fires 18→14, median delay
    // 2.21→2.05 s. Absent file → canonical templates, no change.
    alpha: 0.5,
    path: 'data/user/profile.json',
  },
  strings: {
    // per-string tracker defaults live in src/dsp/strings.js (STRING_DEFAULTS);
    // they were tuned on GuitarSet note annotations and are not app-level knobs
  },
};

// "a.b.c:val,d.e:val" → mutate CONFIG. Numbers parse as numbers, true/false as
// booleans. Unknown paths are ignored with a console warning. Returns the list
// of applied overrides for logging.
export function applyOverrides(spec) {
  const applied = [];
  if (!spec) return applied;
  for (const item of String(spec).split(',')) {
    const [path, raw] = item.split(':');
    if (!path || raw === undefined) continue;
    const keys = path.trim().split('.');
    let node = CONFIG;
    for (const k of keys.slice(0, -1)) node = node?.[k];
    const leaf = keys[keys.length - 1];
    if (!node || !(leaf in node)) { console.warn(`config: unknown key ${path}`); continue; }
    const v = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    node[leaf] = v;
    applied.push(`${path}=${v}`);
  }
  return applied;
}

export const sensitivityFromSlider = (v) => CONFIG.sensitivity.min + (v / 100) * (CONFIG.sensitivity.max - CONFIG.sensitivity.min);

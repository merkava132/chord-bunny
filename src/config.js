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
    // whose 3rd is weak (G with a single B, A leaking from D's 3rd partial).
    // 0.15 gave basic 79→87% with basic+sus candidates on GuitarSet; 0.10
    // keeps 86% there and lifts sus fires on the real-note bench 65→70%
    // (my-song set) and 57→72% (all 53). docs/BENCH.md.
    prior: { sus: 0.10 },
    // Size bonus: + sizeBonus·log|T| per template. The geometric mean compares
    // each tone with an absolute floor, so a 4-note template needs its 7th as
    // loud as the average tone to beat its triad; a full likelihood would
    // compare with the expected share 1/|T| (sizeBonus 1) but then triads
    // collapse (GuitarSet all-53 3%). 0.25 is the closed-world setting used
    // in practice mode, where the user declared which chords are in play:
    // real-note bench, basic+7ths candidates, fires within 1 s — basic 86→79%,
    // maj7 40→71%, min7 41→63%, 7th 65→77%; my-song set maj7 44→69%,
    // min7 25→56%, basics 88→85%. No effect when only triads compete.
    // Listen mode (open world) uses CONFIG.listen.sizeBonus.
    sizeBonus: 0.25,
    // beta > 0 switches the per-tone score to the power mean ((ch·|T|)^beta−1)/beta
    // (0.25 ≈ half-way to cosine); measured worse than sizeBonus, kept for experiments
    beta: 0,
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
    // open world: the simpler chord is the better guess. With 0.25 the
    // GuitarSet all-53 benchmark drops 75.6→62.5%; with 0 it is 74.4%
    // (sus prior 0.10), real-note bench maj7 fires 38%, min7 41%.
    sizeBonus: 0,
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
  coach: {
    // Practice hints (src/coach.js). Evaluated only while the target is unmatched.
    afterSec: 3,          // no hints in the first seconds of a new target (chord change)
    windowSec: 3,         // recent frames / strums considered
    holdSec: 4,           // a shown hint stays at least this long
    repeatSec: 10,        // the same kind is not shown again within this …
    repeatSecByKind: { quiet: 60, clipping: 30 },   // … unless listed here (setup problems don't need repeating)
    minSpanSec: 1.2,      // the playing frames in the window must span at least this long
    strayMin: 0.08,       // mean chroma of a non-chord pitch class that counts as a stray open string
    chordPresent: 0.4,    // the target's own pitch classes must carry this much of the chroma (else you're playing something else)
    otherChord: 0.6,      // …and if another chord is the verdict this often, stay quiet (the heard label says it)
    mutedHitFrac: 0.5,    // strums hitting a muted string, to call it out
    missingFrac: 0.5,     // strums not reaching a unique-note string …
    missingChroma: 0.06,  // … while that note is this weak in the chroma
    clipFrac: 0.2,        // frames with clipping, to warn
    strumPeakMin: 2,      // a strum counts only if some string's activation peak reaches this (typing clicks ≈0.9, strums ≈5)
    quietStrums: 4,       // strums seen while (almost) nothing passes the level gate → "very quiet"
    quietSpanSec: 0.3,    // …i.e. the frames above the gate span less than this
  },
  input: {
    meterDecay: 0.85,     // header level meter fall per update
    loopbackPattern: 'monitor|loopback|hdmi|stereo mix|what u hear',   // device labels that are not a microphone
  },
  debug: {
    hz: 8,                // debug panel refresh rate
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

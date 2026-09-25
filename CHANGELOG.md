# Changelog

## v1.2.0 — 2026-09-24 (the "make it awesome" night)

Six parallel branches, each measured before merging.

- **Tempo mode**: metronome with a count-in, the pair advances on the bar,
  an 8-bar clean/missed strip, BPM creep (+2 after 4 clean bars, −2 after 2
  missed), and the next four chords of the progression shown under the pair.
- **Progress + drill weak spots**: `tools/stats.mjs` and `GET /api/stats`
  turn the telemetry into minutes per day, per-chord match rate and the
  slowest transitions (settings → progress). Random pairs now lean toward
  the transitions you match slowly or miss (`CONFIG.smart`).
- **Muted-string ghosts**: a string muted in the shape counts as struck only
  when its fundamental is really there (`STRING_DEFAULTS.mutedF0Prom`):
  613 → 32 false low-E strikes on the player's session, played strings
  unchanged. The player's input carries no 82 Hz, so the low E is never seen
  directly on this rig; the app says so instead of guessing.
- **Guitar-likeness gate** (`CONFIG.gate`): NNLS residual > 0.4 → no
  verdict. TV/speech verdict frames pass 27%, guitar 97%; cost one target
  in 420. (The "12 matches on the comedy show" were the player's last minute
  of practice — the annotation was 65 s early; the TV produced no matches.)
- **Calibration learning**: `tools/learn_response.mjs` measures your
  guitar + mic's partial amplitudes per open string and fits a response
  correction (`data/user/partials.json`); calibration chord takes are gold
  intervals for `learn_profile.mjs`. The chroma profile is now off by
  default (`CONFIG.profile.alpha` 0): two leave-one-out runs on 408
  intervals put the canonical templates ahead.
- **Learned classifier** (`src/model.js`, `CONFIG.detect.model`, off): a
  17k-parameter MLP on the NNLS activations, trained in pure JS on all 360
  GuitarSet excerpts + synth clips + speech. Beats the templates on unseen
  players (basic 87.1 → 89.8% mixed, open world 74.3 → 85.1% raw) but not on
  the player's own takes (86 → 75% targets fired), and it learned timbre for
  the chords it only saw synthesised. docs/MODEL.md; retrain with your
  calibration takes when there are some.
- Diagrams: base-fret label no longer clipped; CI runs `npm test` on push;
  personal benchmark tolerates half-written telemetry.

Personal benchmark (3 sessions, 374 played targets, docs/PERSONAL.md):
target fired 86%, wrong chord first 10%, time to match p50 2.04 s.

## v1.1.0 — 2026-09-24

- **My Song (Angel Beats!) complete**: all 24 chords of the tab, nine of them
  new (G6, Em9, Fmaj7#11, Gadd11, D6sus2, Bsus4, Eb, Dsus2/F#, the x35500
  Cmaj7). "play" lists the song by section, 1–8 in learning order, plus the
  whole song in order (156 changes). The "my song" preset ticks all 24.
- **Ground truth from the player**: N / Y after each advance flags a wrong
  match or a missed chord; settings → calibrate records each ticked chord
  (4 strums) and the six open strings (2 plucks) as labelled takes. The
  strum counter uses energy onsets; the string tracker's events re-trigger
  on a ringing chord.
- **Detection**: un-ticked basic chords are docked as decoys
  (`CONFIG.detect.prior.decoy`), from the personal benchmark on the player's
  own recordings (`npm run bench:personal`, docs/PERSONAL.md): wrong chord
  fired first 15 → 10%, time to match −0.15 s.
- Mic: Front Mic Boost was back at +30 dB after a reboot (13% clipped
  frames); +10 dB now, persisted.

## v1.0.0 "Cottontail" — 2026-09-24 (MVP)

The version the user called "I like it a lot". Frozen as the baseline for the
accuracy work that follows; every later number is measured against this.

- 53 chords (open, barre, sus2/sus4, add9, maj7, min7, 7th, slash), presets
  "pop set" / "my song", relatedness-driven next-chord choice.
- Detection: NNLS harmonic dictionary → chroma → geometric-mean templates,
  closed-world scoring in practice (enabled ∪ basic), open-world in listen.
- Per-string tracking on the diagram, strum direction, coach hints.
- Personal chroma profile learned from the player's own matched takes.
- Telemetry + mic recordings (serve.py), offline replay and report tools,
  GuitarSet + real-note synth benchmarks (docs/BENCH.md), 66 tests.

Baseline on the player's own session of 2026-09-24 (21.8 min, C D G Em Am):
151 targets shown, 119 matched by detection (79%), time to match median 2.2 s
/ p90 4.6 s, 13% of playing frames clipping.

# Changelog

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

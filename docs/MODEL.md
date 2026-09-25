# Learned chord classifier

`src/model.js` — an optional scoring backend for the detector, off by
default (`CONFIG.detect.model`). Trained by `tools/train_model.mjs`, weights
in `data/model.json`. This page is the evidence; the numbers are regenerated
by `npm run model:cv` (docs/model_cv.json) and `npm run bench:personal`.

## What it is

A two-layer MLP over what the analyzer already computes every 21 ms:

- **input (215)**: the NNLS pitch activations (42 pitches, E2–A5) of the
  current frame and the four before it, each L1-normalised and
  log-compressed (`log(a/Σa + 1e-3)`), so the input is gain-free — the
  player's +10 dB mic and GuitarSet's room mic look alike — plus the
  loudness of each context frame relative to the current one (attack and
  decay in five numbers). No spectrum bins: those depend on the sample rate
  (44.1 kHz GuitarSet, 48 kHz here); pitch activations do not.
- **hidden**: 64 ReLU units, dropout 0.2 and input noise 0.1 while training.
- **output (51)**: one logit per distinct pitch-class set in
  `data/chords.json` (50 — G6 and Em7, G and G/B … share a class exactly as
  they share a template) plus **none** (silence, room noise, speech, attack
  transients, lone notes).
- 17k parameters, `data/model.json` ≈ 150 KB, a forward pass ≈ 0.02 ms.

Three ways to use it, `CONFIG.detect.model`:

| value | chord = | speaks when |
|---|---|---|
| `false` | template argmax | template confidence ≥ threshold |
| `'model'` | model argmax among the candidates + none | posterior^4.7 ≥ threshold (`CONFIG.model.confPow`, see below) |
| `'mix'` | argmax of template score + 0.1 · model log-posterior | template confidence ≥ threshold (unchanged) |

Everything downstream is shared: the candidate restriction of practice
mode (the model's softmax runs over the candidates and none only), the decoy
and sus priors (subtracted in log-posterior space), EMA/majority smoothing,
StableRule, the sensitivity slider. Try it live with `?cfg=detect.model:mix`.

## Training data

- **GuitarSet** (Xi et al. 2018, CC-BY 4.0): every mono-mic excerpt of the
  six players (`testdata/fetch_guitarset.py mic.wav` into
  /mnt/aegis/chord-bunny/guitarset), comp and solo. Label per frame: the
  performed chord when the app knows it, else the lead-sheet chord; ≥ 2
  strings ringing → that chord, 0 → none, 1 → skipped; jazz voicings the
  app does not have → skipped.
- **Synthetic chords** (`tools/synth_chords.mjs`): every voicing in
  `data/chords.json` (62 chords, 759 clips) mixed from real hex-pickup notes
  — the only source for the rare chords; frames ≥ 0.1 s after the strum.
- **The player's own takes**: matched practice intervals of session zd8g
  (2026-09-06), oversampled ×5. Session ho9k (2026-09-24) is never trained
  on; it is the personal benchmark below.
- **Speech**: ten minutes of a public-domain LibriVox reading → none. The
  player's TV audio (ho9k, annotated) is evaluation only.
- **Augmentation**: two extra copies of every guitar source with pink noise
  at 8–30 dB SNR and a random spectral tilt (`--augment=2`).

Held-out means held out: a GuitarSet player's excerpts *and* every synth
clip built from that player's notes leave the training set together.

## Results

(numbers below are filled in by the run recorded in docs/model_cv.json and
the personal bench; see the commit message for the run that produced them)

RESULTS_PLACEHOLDER

## How to retrain

```
npm run model:extract      # features → /mnt/aegis/chord-bunny/features (seconds, 12 workers)
npm run model:cv           # leave-one-player-out, templates vs model, docs/model_cv.json
npm run model:train        # data/model.json (hold-out 01,03 by default; --holdout= to change)
node tools/train_model.mjs train --sessions=<id> --write=data/user/model.json   # a model that has seen this player
```

`tools/eval_chords.mjs --model`, `tools/calibrate.mjs --model` and
`tools/personal_bench.mjs --model [--mix=β]` report the model on the usual
benchmarks; `--players=01,03` restricts GuitarSet to held-out players.

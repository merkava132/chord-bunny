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
| `'mix'` | argmax of template score + 0.1 · model log-posterior (shared inside a nest and between a sus chord and its triads) | template confidence ≥ threshold (unchanged) |

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

### GuitarSet, leave-one-player-out (docs/model_cv.json, 2026-09-25)

Same 15,696 chord frames as docs/BENCH.md (open subset: SS3 / Rock3 / Rock1,
≥ 3 strings ringing), each player scored by a model that never saw that
player's excerpts or notes. "mix" is the shipped `'mix'` mode (β 0.1, nest-
and sus-aware).

| | templates | model | mix |
|---|---|---|---|
| basic candidates (practice default), instructed labels | 87.1% | 89.0% | **89.8%** |
| all candidates (listen mode, open world) | 74.3% | **85.1%** | 77.0% |

Per player, basic / all: 00 87.6 / 72.4 → mix 91.9 / 76.2 · 01 95.8 / 86.3 →
94.9 / 85.9 · 02 77.7 / 62.0 → 81.7 / 66.0 · 03 92.3 / 78.3 → 94.5 / 81.1 ·
04 79.6 / 71.8 → 82.1 / 72.4 · 05 89.0 / 76.7 → 91.9 / 80.9.

Extended chords, all 42 files, performed labels, basic + maj7 + min7 + 7th
candidates, recall by family of the played chord:

| family | n | templates | model | mix |
|---|---|---|---|---|
| basic | 17208 | 71% | 88% | 73% |
| seventh | 1666 | 51% | 34% | 52% |
| maj7 | 1080 | 37% | 26% | 40% |
| minor7 | 510 | 42% | 8% | 44% |
| sus | 427 | 0% | 0% | 0% |

The model alone is biased toward plain triads on GuitarSet's jazz voicings:
it has seen most 7ths and every sus chord only as synthetic hex-pickup
clips, and learned the timbre along with the chord. A plain mix (model term
per template) inherited that: minor7 42 → 13%, and on the synthetic bench
sus fire rate 53 → 17%. The shipped mix therefore shares the model term
inside a nest (C · Cmaj7 · Cadd9) and between a sus chord and its same-root
triads (A · Asus2 · Asus4): the model decides root and family (C vs Am vs
Em, E vs Em), the templates decide the extension and the suspension. That
gives up most of the open-world gain (86.8 → 77.0%) to keep every family at
or above the templates.

### The player's own takes (session ho9k, 2026-09-24, 206 played targets)

The model that ships was trained on players 00 / 02 / 04 / 05, the synth
clips, session zd8g (×5) and ten minutes of speech; ho9k is untouched.

| | templates (+ personal profile) | model | mix |
|---|---|---|---|
| target fired | **88%** | 74% | **88%** |
| wrong chord fired first | **10%** | 10% | 11% |
| time to match p50 / p90 | 2.04 / 4.17 s | 2.15 / 4.32 s | 2.04 / 4.01 s |
| settled frames, target is argmax | 42% | 40% | 43% |
| strum-aligned frames, target is argmax | 44% | 42% | 45% |
| fires on 10 min of TV speech (23 intervals) | 0 | 0 | 0 |

### Synthetic bench, clips containing notes of the held-out players (331 clips)

Hex-pickup timbre, so partly out of domain for the app; the templates on the
same clips for reference. Fire rate within 1 s / wrong fire, "my song"
candidate set: basic 77 / 17% (templates) vs 74 / 17% (mix); sus 53 / 42%
vs 28 / 56%. basic + 7ths: basic 57 / 17% vs 63 / 20%, maj7 89 / 0% vs
89 / 0%.

### Confidence (players 01 + 03, basic candidates, tools/calibrate.mjs --model)

| threshold on p^4.7 | coverage of chord frames | precision |
|---|---|---|
| 0.20 | 87% | 98% |
| 0.35 (slider default) | 83% | 98% |
| 0.60 | 75% | 99% |

Templates at 0.35: 86% / 97%.

## Verdict

Off by default. On real microphone audio it has never seen (six GuitarSet
players, cross-validated) the mix beats the templates on every metric —
+2.7 points with the practice candidate set, +2.7 in the open world, every
7th family up — and the model alone is a much better open-world classifier
(+10.8). But on the player's own practice takes it is a wash (88% → 88% of
targets fired, one more wrong fire in 206), and on the chord families it
only knows from synthetic clips it is worse: sus chords, which this player
practises, fire half as often on the synthetic bench. "Wins clearly" has to
include the player and the sus set, and it does not yet. What would change
that: real recordings of sus and 7th chords (the calibrate step in settings
records exactly those — a model trained with them is
`node tools/train_model.mjs extract --sessions=<ids>` then
`train --write=data/user/model.json`, picked up automatically), and more of
the player's own matched takes.
Until then: `?cfg=detect.model:mix` to try it, `:model` for the raw
classifier.

Training: 14 epochs over ~1.3 M frames (stride 1) take ~5 min single-threaded;
feature extraction for 3,361 sources takes ~40 s with 14 workers; a
six-fold CV ~20 min. Model file 145 KB; forward pass 0.02 ms.

## How to retrain

```
npm run model:extract      # features → /mnt/aegis/chord-bunny/features (seconds, 12 workers)
npm run model:cv           # leave-one-player-out, templates vs model, docs/model_cv.json
npm run model:train        # data/model.json (hold-out 01,03 by default; --holdout= to change)
node tools/train_model.mjs extract --sessions=<id> && node tools/train_model.mjs train --user-weight=5 --write=data/user/model.json   # a model that has seen this player
```

`tools/eval_chords.mjs --model`, `tools/calibrate.mjs --model` and
`tools/personal_bench.mjs --model [--mix=β]` report the model on the usual
benchmarks; `--players=01,03` restricts GuitarSet to held-out players.

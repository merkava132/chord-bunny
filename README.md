# chord-bunny

A guitar chord transition trainer that listens, inspired by [dkthehuman.com/chord-bunny](https://www.dkthehuman.com/chord-bunny/).

Two random chords on screen. Play them. The mic picks up what you played and advances the moment you nail the next one — no timer required, no "start session" ritual. Just open it and play.

It also watches the **strings**: which ones rang, which one you missed, whether you hit a string that should be muted, how long each keeps ringing, and (when the timing is clear) whether that was a down- or upstrum.

## Modes

- **practice** — pair of chords; auto-advances on detection. Optional timer. Per-string feedback against the chord you're supposed to be holding.
- **listen** — free-form chord recognizer. Plays your mic OR an audio file you load. Shows what it hears, with per-string activity for the detected shape.

## Run it

```sh
./start.sh
```

Opens `http://localhost:8732/` in your browser. Click the mic chip (top right) the first time to grant mic permission; from then on it auto-prompts on page load.

`getUserMedia` requires `localhost` or HTTPS — `file://` won't work, hence the tiny server.

## How detection works

Chord detection (`src/detect.js`, `src/dsp/analyzer.js`):

1. `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl` all **off** (those eat guitar transients).
2. An `AudioWorklet` ships raw samples to a `FrameStream` (`src/audio/`) that hands out overlapping frames to each analyzer at its own window/hop.
3. Every 23 ms, an 8192-sample window is decomposed by **non-negative least squares onto a dictionary of harmonic templates**, one per MIDI pitch on the neck. Partial amplitudes for each pitch were **learned from GuitarSet** single-string frames (`data/partials.json`) — real guitars are nothing like 1/k: a low E's 2nd partial is 2× its fundamental through a room mic, while an A3's is 0.2×.
4. Activations are folded to 12 pitch classes and scored against each chord with a **geometric-mean template** (a missing chord tone is catastrophic, extra mass is not). Cosine similarity against binary templates, the classic approach, can't tell C from Am7 when a little noise lands on A.
5. EMA + majority-of-5 smoothing, RMS gate, calibrated confidence gate, min-hold before a chord counts as "stable".

Per-string tracking (`src/dsp/strings.js`) runs every 6 ms with exactly six templates (one per string of the shape being held, using per-string learned profiles) plus a flat noise basis. Spectral flux finds strums; each string is "struck" if its activation rises *and* survives the attack transient; each string's onset is timed from the steepest rise of its activation (amplitude-independent under a Hann window); Kendall's tau over the reliably-timed strings gives the direction; sustain is tracked until the activation decays.

### What it measures, honestly

Benchmarked against [GuitarSet](https://github.com/marl/GuitarSet) (CC-BY 4.0) room-mic recordings, the six players' takes of the open-position progressions, frames where ≥3 strings are ringing:

| | old chroma+cosine | now |
|---|---|---|
| chord frame accuracy (instructed labels) | 71.3% | **81.6%** |
| chord frame accuracy (performed labels) | 73.9% | **84.3%** |
| end-to-end in headless Chrome, listen mode, one take | — | 92% of samples, 2 wrong verdicts in 155 |

Per string (hex-pickup ground truth): presence F1 77%, onsets 66% recall / 93% precision, strum string-set Jaccard 0.57, direction 57% overall (≈68% when the tracker commits), per-string onset timing ≈10 ms median error.

Two limits are physics, not code:

- **Octave-doubled strings can't be separated from a mono mic.** In an open G the G string (G3) and high e (G4) are spectrally nested — every partial of G4 is a partial of G3. Separating them means reading partial-amplitude ratios, and those vary 2–5× from pluck to pluck (σ≈1 in the log domain, measured). The UI shows those strings hollow ("inferred" from strum contiguity) and says "can't tell (octave)" instead of "missing".
- **Per-string timing floors out around 8 ms.** Telling a string's fundamental apart from a neighbour's harmonic 10–20 Hz away needs ~10 Hz of frequency resolution, and time-frequency uncertainty makes that ≳8 ms of timing uncertainty. Strings in a strum are ~8 ms apart, so direction is only shown when the spread is wide enough to be sure.

## Tuning

Settings → **detection**:

- **sensitivity** — confidence a frame needs before it counts. Calibrated so the default gives a verdict on ~77% of chord frames with ~91% precision; raise it if you see wrong chords, lower it if it says "—" too much.
- **min hold (ms)** — how long the same chord must be detected before counting as "matched".

## Development

```
tools/eval_chords.mjs      chord accuracy vs GuitarSet (old detector side by side, scorer variants, sweeps)
tools/eval_strings.mjs     per-string presence / onsets / strum sets / direction / sustain vs hex-pickup GT
tools/learn_profiles.mjs   re-learn data/partials*.json from single-string frames
tools/calibrate.mjs        confidence threshold → coverage / precision table
tools/browser_test.mjs     headless Chrome end-to-end: a WAV as the fake mic, samples the live UI
tools/trace.mjs, probe.mjs per-frame dumps for staring at one strum
testdata/fetch_guitarset.py  pulls the subset out of the Zenodo zip by HTTP range requests (no 3 GB download)
```

`node tools/eval_chords.mjs --verbose` after fetching test data. The browser test needs Chrome and a clean environment (see `docs/FRICTION_LOG.md`).

## File layout

```
index.html / styles.css        UI shell, dark theme
start.sh                       python -m http.server, opens browser
data/chords.json               21 open-position chords with fingerings
data/partials*.json            learned partial-amplitude profiles (per pitch, per string×pitch)
src/
  main.js       app bootstrap, mic lifecycle, settings UI, dev hooks (?autostart&mode&chord)
  settings.js   localStorage persistence
  diagrams.js   SVG chord-chart renderer (strings carry data-string for live colouring)
  detect.js     chord detector: frames → NNLS activations → chroma → template scores
  practice.js   chord-bunny game loop
  listen.js     free-form recognizer (mic OR file)
  strings-ui.js per-string bars, sustain timers, strum readout, diagram lighting
  audio/        AudioWorklet capture + FrameStream
  dsp/          fft, wav decoder, PitchAnalyzer (NNLS), StringTracker
```

## Future ideas

- Self-calibrate the partial profiles to *your* guitar and mic from a few open-string plucks.
- BPM-creep mode: speed up as you nail transitions.
- Strum-tightness trainer: metronome + the onset detector we already have.
- Chord audio playback via Tone.js `PluckSynth`.

# chord-bunny

A guitar chord transition trainer that listens, inspired by [dkthehuman.com/chord-bunny](https://www.dkthehuman.com/chord-bunny/).

Two random chords on screen. Play them. The mic picks up what you played and advances the moment you nail the next one — no timer required, no "start session" ritual. Just open it and play.

## Modes

- **practice** — pair of chords; auto-advances on detection. Optional timer.
- **listen** — free-form chord recognizer. Plays your mic OR an audio file you load. Shows what it hears.

## Run it

```sh
./start.sh
```

Opens `http://localhost:8732/` in your browser. Click the mic chip (top right) the first time to grant mic permission; from then on it auto-prompts on page load.

`getUserMedia` requires `localhost` or HTTPS — `file://` won't work, hence the tiny server.

## How detection works

Pipeline (see `src/detect.js`):

1. `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl` all **off** (those eat guitar transients and pump the chroma).
2. `AnalyserNode`, `fftSize=8192`. At 48 kHz that's a ~170 ms window with ~5.9 Hz/bin — fine resolution down to E2.
3. Each ~50 ms tick: get spectrum, fold every bin into one of 12 pitch-class buckets (chroma).
4. Cosine similarity against binary chord templates built from `data/chords.json`.
5. Median-of-5 smoothing, RMS gate (silences "—"), min-hold timer before declaring a stable match.

It's the simple-but-actually-works baseline from MIR papers since Fujishima '99. Good enough for a personal practice tool — flickers occasionally on muted strums, sometimes confuses subset chords (C major vs Am7 with no A in the bass).

## Tuning

Settings → **detection** has two knobs:

- **sensitivity** — minimum cosine score to trust a frame. Higher = stricter.
- **min hold (ms)** — how long the same chord must be detected before counting as "matched".

If detection is flickery → raise sensitivity. If it feels laggy → lower min-hold.

## File layout

```
index.html / styles.css        UI shell, dark theme
start.sh                       python -m http.server, opens browser
data/chords.json               21 open-position chords with fingerings
src/
  main.js       app bootstrap, mic lifecycle, settings UI
  settings.js   localStorage persistence
  diagrams.js   SVG chord-chart renderer
  detect.js     mic / audio → chroma → templates → smoothing
  practice.js   chord-bunny game loop
  listen.js     free-form recognizer (mic OR file)
```

## Future ideas (not built)

- Chord audio playback via Tone.js `PluckSynth` (research showed this beats hunting per-chord recordings).
- Validate detection against [GuitarSet](https://github.com/marl/GuitarSet) (CC-BY 4.0, audio + chord-time annotations).
- Bass-note tracker (Pitchy on a low-passed copy) to disambiguate inversions.
- BPM-creep mode: speed up as you nail transitions.
- Strum-tightness trainer: metronome + onset detection.

# Friction log

Running notes on confusion, tool friction, and places where the architecture
fought back. Newest at the bottom.

## 2026-09-05 — resuming after 4 months

- Project was not under git. Initialised it before touching anything.
- No numpy/scipy on this box, so all offline analysis + evaluation must be
  Node. That's fine (the DSP has to be JS for the browser anyway) but it
  means writing our own FFT and WAV reader.
- Existing detector uses `AnalyserNode` polled on a 50 ms `setInterval`.
  That gives no control over hop size or frame alignment, which is useless
  for onset timing / strum direction. Needs raw sample access (AudioWorklet).
- Nodriver browser MCP failed to connect (502) — use WebFetch/curl for
  data hunting.
- zsh `noclobber` is set: `cat > existing-file` silently fails with
  "file exists" and the *old* file keeps running. Use `>|` when overwriting.
- Headless Chrome for end-to-end tests: (1) it can't run inside the Bash
  tool sandbox at all (child processes never connect); (2) even outside the
  sandbox it only works with a *clean environment* (`env -i HOME PATH`) —
  some inherited variable breaks the browser↔child IPC ("Terminating current
  process after 15 seconds with no connection"); (3) `--headless=old` no
  longer exposes the DevTools port on Chrome 148. `--use-file-for-fake-audio-capture`
  + `--use-fake-ui-for-media-stream` is a great way to feed a WAV through the
  real getUserMedia → worklet path.
- zsh `$ta[g]` is an array subscript, so the "pkill -f 'patter[n]'" trick
  must not follow a variable name. Killed my own shell (exit 144) twice.
  Use setsid + `kill -- -PGID` from a bash script instead.

## What the data taught me (so I don't re-learn it)

- GuitarSet's players are jazz-trained: Jazz/Funk takes use rootless
  voicings, triads up the neck, dyads. Only SS3 / Rock3 / Rock1 are
  open-position — that's the app's use case and the honest benchmark.
- GuitarSet note events come from pitch-contour segmentation, so a
  re-strike of a still-ringing string doesn't always start a new note.
  Evaluate onsets against clustered note onsets, not "strums".
- Chord ID: NNLS activations → chroma → geometric-mean template beats
  cosine. Sparsity / NMS / octave weighting / reconstruction-error
  scoring all looked promising and did nothing. The learned partial
  profiles gave the last +1–2%.
- Per-string: octave-doubled strings are a physics wall (σ≈1 log-amp
  variance per pluck). Timing floor ~8–10 ms. Don't spend more time
  there without a hex pickup or a stereo/close-mic setup.

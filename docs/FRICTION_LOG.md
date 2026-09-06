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

## 2026-09-05 (evening) — 53 chords, while the user kept practising

- The user practises on the served app while it's being edited, so edits
  went into a git worktree (`../chord-bunny-next`, own server on :8733)
  and reached the live tree by `git merge --ff-only`. Firefox **F5 did not
  refetch cached ES modules** after that — it re-fetched index.html only,
  leaving new HTML on old JS. `ctrl+shift+r` (bypass cache) does the job;
  `python -m http.server` sends no Cache-Control, so heuristic freshness
  applies to every module.
- The audio symlink bit back: `.gitignore` had `testdata/audio/` (trailing
  slash = directories only), so a `testdata/audio -> ../../chord-bunny/…`
  symlink in the worktree got committed, and the ff-merge then replaced the
  live *directory* of 42 WAVs with a symlink to itself (ELOOP). Git happily
  deletes ignored files that are in the way of a checkout. Rule is now
  `testdata/audio` (no slash); the WAVs had to be re-fetched (~3 min).
- `rm` is aliased to `-i` too (like `cp`/`mv`): a chained `&&` command
  stalled on its prompt in the background. `command rm -f` in scripts.
- Chord-scoring lessons, all measured on GuitarSet (`tools/eval_chords.mjs
  --dump=app`, `--chords=`, `--gt=performed`):
  - Every extra candidate template is a chance to be wrong: the nine basic
    chords alone score 87% on the open subset, all 53 score 76%. Practice
    mode therefore scores only the ticked chords plus the basic nine.
  - An "unexplained mass" penalty (LAM) is *needed* for 4-note chords — the
    geometric mean is biased toward the triad, so a 7th one string loud can
    never win — but it **backfires when sus chords are candidates** (they
    absorb leakage: G→Dsus4, G→Gadd9). Net: LAM 0.5 only helps once the
    candidate set is scoped.
  - Any prior against non-basic templates (even 0.1) drives 7th / maj7 /
    min7 recall to ~0 — the extra note's chroma mass is that small. A prior
    on sus templates only (0.15) fixes the sus-vs-weak-third ties (basic
    79% → 87% with basic+sus candidates) at no cost to sus recall.
  - Sus2/sus4 twins (Asus2 = Esus4, Dsus2 = Asus4, Csus2 = Gsus4, Fsus2 =
    Csus4) and slash chords are pitch-class identical — templates must be
    deduped or the confidence margin is 0 by construction.
  - The confidence runner-up must skip templates nested with the winner
    (C inside Cmaj7); otherwise every verdict looks uncertain once richer
    chords are candidates.
  - GuitarSet has ~10 s of sus chords total (brief ornaments), so sus recall
    numbers (15%) are not a real measurement of a held Dsus4.
- Confidence recalibrated for the bigger template set (`tools/calibrate.mjs`
  now runs the app's own `scoreTemplates`/`confidenceOf`): margin scale 0.5 →
  0.3. Basic candidates at the default threshold: 69% → 79% coverage at 94%
  precision; all 53: 68% → 78% at 84%. Browser e2e (`tools/browser_test.mjs`,
  heard == lead-sheet chord): practice 00_Rock3 81% / 02_SS3 46% (old build
  79% / 46%), listen 71% / 40% (old build 82% / 46%). Listen mode's 53
  candidates cost ~6–11 points on these takes; practice mode is at parity.
- Comparing against "the live build" is only meaningful if the live tree
  hasn't been fast-forwarded yet; `git archive <old-sha> | tar -x` into the
  scratchpad + `python -m http.server 8734` gives a stable baseline.
- `?open=chord` (main.js dev hook) opens a settings panel so a plain
  `--headless=old --screenshot --virtual-time-budget=4000` capture shows the
  picker without driving CDP.

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

## 2026-09-05 late — "the audio doesn't work"

- **Firefox had pinned the HDMI output *monitor* as the microphone** for
  localhost:8732 (`pactl list source-outputs` → `target.object = alsa_output…hdmi-stereo`).
  `pactl move-source-output` is reverted because the client asked for that
  device explicitly; the fix is in Firefox's mic permission for the site. The
  app now logs the selected track label in the `mic` telemetry event so this
  is visible without pactl.
- **60 dB of input gain**: ALSA `Capture` +30 dB and `Front Mic Boost` +30 dB
  on the ALC897 front jack → 10% of samples clipped flat while strumming.
  `amixer -c 2 sset 'Front Mic Boost' 0` → rms ≈0.025, peak ≈0.15, clean.
  Frame telemetry now carries `peak`/`clip` so clipping shows up in the report.
- Recording uploads on `pagehide` are lost when the segment is over ~60 KB
  (fetch keepalive limit); the last take of a session can be missing. Segments
  end on 2 s of silence, so in normal practice this rarely matters.
- `rm` is aliased `-i` too (as `mv`/`cp`): `command rm -f` in scripts.
- Listen mode flickered through unrelated chords at note onsets (user
  report); now shows a chord only after it has held 160 ms and keeps the last
  one through gaps < 400 ms. Costs ~6 points on the e2e "heard == GT" metric
  (65% vs 71%) because display lags the verdict; the telemetry `verdict` gaps
  measure the flicker directly.
- The practice meter showed raw confidence (typically 0.4–0.6 → half a bar).
  It now puts the sensitivity threshold at the midpoint and threshold + 0.25
  at full, green while the heard chord is the target.

## 2026-09-06 early — first real telemetry

- **The mic was being initialised twice per click** (mic-chip handler +
  first-gesture document handler, both before `micStream` is set). Two
  detectors on two streams: frame events duplicated, practice UI driven by
  both (one with all 53 candidates), and both streams tapped into the *last*
  recorder → every 512-sample chunk written twice, WAV time-stretched and
  unusable (`ts1 - ts0` = 30 s for 60 s of samples was the tell). Guarded
  `enableMic`; each tap now binds its own recorder. Only visible thanks to
  the telemetry; the app "worked".
- **0 of 6 practice targets matched** in the first session although C was
  heard at 0.5–0.85 confidence over and over. The old stable rule needed one
  verdict uninterrupted for 350 ms and every strum onset produced blank
  frames that reset it. Measured on GuitarSet (tools/eval_hold.mjs, basic
  candidates, chord segments ≥ 2 s): strict 350 ms matched 83%, a windowed
  rule (≥ 60% of frames in 1.4 × minHold) 93%, wrong-chord fires 4% → 7%.
  Now `StableRule` in src/detect.js, shared with the eval.
- `run` telemetry events (verdict run lengths) are the right lens for this;
  5 Hz frame samples can't see 350 ms holds.
- Sanity check for recordings: `ts1 - ts0` must equal `bytes / (2 · sr)`.

## 2026-09-06 night — config, profile

- Constants were spread over detect.js / listen.js / practice.js / recorder.js
  / main.js; the eval tools carried copies of some. Now `src/config.js` with
  the evidence per value, `?cfg=` / `--cfg=` overrides, and the effective
  config in the telemetry `session` event.
- Tools resolved `telemetry/` relative to their own checkout, so running a
  worktree's tool against the live repo's sessions silently picked the
  staging sessions ("latest" was a fake-mic test). `--tel-dir` / `--rec-dir`
  on session_labels and learn_profile; session_labels exports `buildLabels()`.
- First profile evaluation showed identical numbers for every alpha: the tool
  passed the raw chord map where buildTemplates expects `{ chords }`. Cheap
  to catch with a unit test; the tests agent has one.
## 2026-09-06 — coach / monitoring (ui branch)

- The string tracker's onset detector fires on keyboard clicks: 131 "strums"
  during a typing stretch, activation peaks ≈0.9 vs ≈5.5 for real strums.
  Anything consuming strum events needs a peak floor (`CONFIG.coach.strumPeakMin`).
- Telemetry frame samples are 5/s (and 1/s below the gate) while the live
  detector runs at 47/s, so any rule counting frames behaves differently in
  replay vs live. Rules now measure windows in seconds (span of playing
  frames); the replay tool is then a faithful-enough oracle.
- A "quiet input" rule is hard to make sound from level alone for a player
  whose median level (0.010) sits close to the gate (0.006); kept as an
  extreme-case hint with a 60 s repeat interval rather than tuned to fire.
- The G→Em confusion needed an exception to the "you're playing another
  chord, stay quiet" guard: when the other chord is explained by the target
  plus the stray note, the stray-note hint IS the explanation.
- `getUserMedia` device switching: keep the AudioContext, create a new
  MediaStreamSource and re-attach; stopping the old tracks first avoids two
  live captures.
## 2026-09-06 — tests / bench / docs pass

- `node --test tests/` fails on Node 22 ("Cannot find module …/tests"): a bare
  directory is not a pattern; `node --test tests/*.test.mjs` works.
- `Recorder` marked a segment `continues: true` when the tail and maxLen
  conditions coincided, then opened an empty follow-on segment that was
  later dropped (no chord-like frame). Tail now takes priority; a
  `continues` flag can still dangle when the follow-on held only the tail —
  consumers must check `seg+1` exists with `ts0 == ts1` before joining.
- `session_labels.mjs` documented `--rec-dir DIR` but its parser only takes
  `--rec-dir=DIR` (a bare value becomes `true` and `path.join` throws).
  Comment fixed; the parser is shared across tools and worth unifying.
- The "old chroma detector" column in eval_chords always scores all 53
  chords regardless of `--chords=` (it builds from APP_CHORDS) — labelled as
  such in BENCH.md rather than changed.
- Tests write a fixture session into the repo's `telemetry/` because
  session_labels resolves that directory relative to itself; they clean up.
  A `--telemetry-dir` flag would be cleaner.
- bench.mjs runs the seven eval processes in parallel: 36 s wall on the
  7800X3D instead of ~3 min.
## 2026-09-06 — real-note chord bench (bench branch)

- GuitarSet's `audio_hex-pickup_debleeded.zip` (3.6 GB) is fine over HTTP
  range requests: 12 takes = 119 MB, ~2 min. Files are 6-channel 44.1 kHz,
  channel order = string order (low E first), matching the JAMS
  `data_source` index.
- The JAMS note annotations miss re-plucks: cutting a note "until the next
  annotated onset on that string" ran straight through the next chord on
  ~half the notes (an A2 appearing 0.4 s into a C chord). Truncating at the
  first energy rise (> +6 dB over the running 60 ms minimum) fixed it.
- Bank notes differ in loudness by > 20 dB; without per-note RMS
  normalisation the open G string vanished from every chord.
- Pickup vs mic timbre is huge (low E: 2nd partial 2.2× the fundamental on
  the mic, 0.37× on the pickup; some partials nulled by pickup position) —
  but the NNLS dictionary learned on mic recordings scores the pickup clips
  within 2 points of a pickup-learned one. Template logic, not timbre, was
  the problem for extended chords.
- Scoring insight: the geo-mean has a hidden log(4/3) bias toward triads
  (`sizeBonus` in config.js). The full likelihood normalisation flips the
  bias the other way (triads collapse to 3%); the useful range is 0.2–0.4 and
  it must not leak into the confidence calibration (first attempt subtracted
  the bonus from the winner only, which halved the margin and every fire
  rate — check `conf` columns after touching scoring).
- `--listen` on the tools was a no-op in eval_synth for one run because the
  sed pattern anchored on a comment that file didn't have; the "listen all"
  table was identical to "all" — a tell worth remembering.

## 2026-09-06 night — integration

- **The symlink/ignore pitfall bit a second time.** `git add -A` in a
  worktree picked up `testdata/{hex,notebank,synth}` symlinks because the
  bench branch's ignore rules had trailing slashes (directories only). The
  fast-forward into the live checkout then replaced the real directories with
  self-referential links, and a careless restore step deleted the 380 MB of
  generated data (all regenerable: `fetch_guitarset.py --hex`, `note_bank`,
  `synth_chords`, ~5 min). Rules now have no trailing slash and
  `tests/repo.test.mjs` fails on any tracked symlink under testdata/ — the
  lesson is mechanised, not remembered.
- `ln` is aliased `-i` as well as rm/mv/cp on this box.
- Merging four branches: append-style conflicts in config.js / styles.css /
  README / FRICTION_LOG resolved by keeping both sides; one merge seam dropped
  a closing brace in config.js which `node --check` accepted (the object just
  nested) but the browser rejected — the browser smoke test caught it.
- browser_test.mjs gave one 0/103 practice run between two 80%+ runs with an
  identical tree; the timeline looked right, so the comparison itself failed
  transiently. Not reproduced; treat a single 0% as a flake and rerun.
- bench.mjs's "all 53 (listen mode)" row ran with practice-mode scoring after
  the size bonus landed (62.5% vs 74.4%); rows now say which scoring they use.

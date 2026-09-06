# chord-bunny architecture

Vanilla ES modules in the browser, the same modules re-used from Node by the
evaluation tools, and a 200-line Python server that also stores telemetry and
recordings locally. No build step, no dependencies.

```
 mic ─► AudioWorklet (capture-processor.js, 512-sample chunks)
        │
        ▼
     FrameStream (audio/stream.js)  ── taps ──► Recorder (audio/recorder.js) ─► serve.py /api/audio
        │ consumers: overlapping frames, each with its own (size, hop)
        ├─► ChordDetector._frame  (detect.js, 8192 / 1024 @ 48 kHz ≈ 186 ms window, 21 ms hop)
        │      PitchAnalyzer.analyze  (dsp/analyzer.js: |FFT| → NNLS onto harmonic templates, one per MIDI pitch)
        │      → EMA over frames → chroma (octave-weighted fold to 12 classes)
        │      → scoreTemplates (geometric mean − λ·outside mass − prior)   ┐ config.js
        │      → confidenceOf (fit + margin vs nearest non-nested rival)    ┘
        │      → threshold (sensitivity) → majority-of-5 → "smoothed" verdict
        │      → StableRule (practice: ≥60% of a 490 ms window) → onStable
        │      callbacks: onUpdate (every frame), onStable, onRun, onFrame (raw numbers for telemetry / debug)
        └─► StringTracker.process (dsp/strings.js, 4096 / 256 ≈ 6 ms hop)
               six templates = the strings of the shape the player should be holding
               → per-string activation, spectral-flux onsets, strum sets, direction, sustain
               → StringsView (strings-ui.js) and telemetry `strum` events
```

`main.js` wires it: loads `data/chords.json` and the learned partial profiles
(`data/partials*.json`), owns the AudioContext / mic stream / one detector, and
switches between `PracticeMode` (practice.js) and `ListenMode` (listen.js).
`telemetry.js` batches events to the server; `settings.js` is localStorage.

## Two clocks

- **page time `t`** — `telemetry.now()`, seconds since page load. Every telemetry event has it.
- **stream time `ts`** — `FrameStream.written / sampleRate`, seconds of audio since the detector was (re)attached. Frame times, `run`, `strum`, `pair`/`match`/`miss` (`ts` field) and recording segments (`ts0`/`ts1`) are on it, so an event maps to a sample offset in a WAV: `offset = (ev.ts − seg.ts0) · sr`.

`ChordDetector.attach()` calls `_reset()`, which resets the stream clock to 0.
That happens on mic start and on every mode switch back to practice. The
recorder notices a backwards jump and closes its open segment;
`tools/session_labels.mjs` maps `t → ts` with the nearest frame event when an
older event lacks `ts`.

## Candidates: what the detector is allowed to say

Every extra template is a chance to be wrong (GuitarSet: 87% with the nine
basic chords as candidates, 76% with all 53). So:

- **practice** scores only the ticked chords **plus the basic nine**
  (`PracticeMode._syncCandidates`). A basic chord that is not ticked counts
  for a richer target on the same root that contains it (`_isMatch`: Am
  heard while the target is Am7 and Am is not ticked → match).
- **listen** scores all 53 (`ListenMode._wireDetector` → `setCandidates(null)`).

## Twins and nested templates

`buildTemplates` keys templates by pitch-class set. Chords with the same notes
share one template and report the first id in `chords.json` order, with all
ids in `ids` (callbacks receive them): C = C/G = C/E, D = D/F#, G = G/B,
A = A/C#, Am7 = Am/G, and the sus pairs Asus2 = Esus4, Dsus2 = Asus4,
Csus2 = Gsus4, Fsus2 = Csus4. A mono mic cannot separate these; practice
accepts either, listen shows "same notes as …".

Templates nested inside one another (C ⊂ Cmaj7 ⊂ …, G ⊂ Gadd9) differ by a
single note and always score close. `scoreTemplates` excludes them from the
confidence runner-up, and `CONFIG.detect.lam` (mass outside the template)
lets the richer chord win when its extra note is really there.

## Personal profile (calibration)

A template scores a chroma q as Σ w·log(q+ε) with w uniform on the chord
tones. `tools/learn_profile.mjs` learns, per chord, the median chroma over the
settled part of the player's matched practice intervals (recordings +
labels.jsonl) and `buildTemplates(chords, { profile, alpha })` blends it in:
w = (1−α)·uniform + α·profile for chords that have one (`CONFIG.profile.alpha`
0.5). Chords without a profile stay canonical, and the "perfect" score used by
the confidence fit is recomputed as Σ w·log(w+ε). The file lives at
`data/user/profile.json` (per install, gitignored); the app loads it at start
and `POST /api/profile/learn` (the "learn from my recordings" button) reruns
the tool and hot-swaps it via `detector.setProfile()`. Leave-one-out on the
first session (77 intervals, basic chords): settled-frame accuracy 56→59%,
wrong fires 18→14, median delay 2.21→2.05 s.

## Progressions

`data/progressions.json` holds named chord sequences (My Song's sections,
I–V–vi–IV, the royal road, sus colour loops, ii–V–I, Canon in D). With
`settings.sequence` set to one of them, practice follows the sequence
instead of drawing related pairs; its chords are always detection candidates;
"new pair" restarts it; `pair` events carry `sequence` and `index`.

## Configuration

`src/config.js` is the only place a tunable lives, each with the evidence for
its value. Override without editing: `?cfg=detect.lam:0.4,listen.showMs:100`
in the page URL, or `--cfg=` on any tool. The effective config and the
overrides are in the telemetry `session` event.

## Telemetry

Batched every 2 s to `POST /api/telemetry?session=<id>` and appended to
`telemetry/<session>.jsonl`; one JSON object per line, always with `t` and
`type`. The session id is `<ISO time with - for : .>-<4 random chars>`.

| type | fields | when |
|---|---|---|
| `session` | `session, ua, chords, settings, config, overrides` | page load |
| `setting` | `key, value` | any settings change except `micEverEnabled` |
| `mode` | `mode` | practice / listen switch |
| `mic` | `state` (`on`/`error`), `sampleRate, label` or `error` | mic start attempt |
| `frame` | `ts, level, peak, clip` (+ while playing: `id` smoothed verdict, `best` raw argmax, `conf`, `top` [[id, score]×3], `chroma[12]`) | every 10th frame while playing (~5/s), every 50th in silence |
| `run` | `id, ts0, dur` | the smoothed verdict changed; how long the previous one held (≥ 0.1 s only) |
| `strum` | `ts, strings[{string, t, peak, muted, doubled, inferred, pitch}], direction, spreadMs, timed, frets` | string tracker detected a strum |
| `pair` | `ts, cur, next, reason` (`fresh`/`reroll`/`advance`/`timer`), `enabled` or `sequence, index` | practice screen changed (random pair or progression step) |
| `match` | `ts, target, heard[], sinceShown, advanced` | StableRule fired the target (advanced=false when auto-advance is off) |
| `miss` | `ts, target, heard[], conf, sinceShown` | StableRule fired something else (first of each id per target) |
| `verdict` | `id, ids, conf` (or `id: null`) | listen display changed |
| `rec` | `seg, ts0, ts1, dur, continues` | a recording segment was uploaded |
| `hint` | `ts, target, kind, text` | coach showed a hint (src/coach.js) |
| `perf` | `msPerFrame, maxMs, budgetMs` | every ~10 s: detector cost vs the hop budget (0.3 of 21 ms in headless Chrome) |
| `profile` | `chords{id: n}, sessions[]` | the personal profile was relearned from the app |

`tools/telemetry_report.mjs` turns a file into a session summary;
`tools/session_labels.mjs` joins it with the recordings.

## Recordings

`Recorder` taps the raw stream and keeps every stretch whose 100 ms RMS reaches
`CONFIG.recorder.gate`, with 0.5 s pre-roll and a 2 s tail, cut at 60 s. A
finished segment is uploaded only if the detector saw a chord-like frame in it
(`noteMusic`; bumps and keyboard clicks are dropped). Layout:

```
recordings/<session>/seg-NNNN.wav      16-bit mono PCM at the AudioContext rate
recordings/<session>/segments.jsonl    {seg, sr, ts0, ts1, bytes, wall}
recordings/<session>/labels.jsonl      written by session_labels: {seg, file, ts0, ts1, offset0, offset1,
                                        target, next, shownBecause, matched, matchedAt, heardInstead[]}
```

`continues: true` means the file was cut by the 60 s limit and the take goes
on in `seg+1` (check it exists with `ts0 == ts1` before joining; a follow-on
that held only the tail is dropped). `start.sh` puts recordings on
`/mnt/aegis/chord-bunny/recordings` when that drive exists; the server prunes
oldest-first past `--max-rec-mb` (3000).

## serve.py

| | |
|---|---|
| `GET /…` | static files from the repo, `Cache-Control: no-cache` (a deploy must not leave a stale module under a fresh index.html) |
| `GET /api/status` | `{telemetryDir, recDir, recBytes, maxRecBytes, sessions[]}` |
| `POST /api/telemetry?session=ID` | body = JSON lines, appended |
| `POST /api/audio?session=ID&seg=N&sr=&ts0=&ts1=` | body = int16 PCM → WAV + segments.jsonl, then prune |
| `POST /api/profile/learn` | runs `tools/learn_profile.mjs --all --write data/user/profile.json`, returns the summary |

Session ids must match `[A-Za-z0-9_.-]{1,80}` (400 otherwise). Nothing
leaves the machine; `python -m http.server` would just drop the POSTs.

## Tools — which question each answers

| tool | question | data |
|---|---|---|
| `eval_chords.mjs` | frame accuracy per candidate set / GT family, confusions (`--dump=app`) | GuitarSet |
| `eval_hold.mjs` | does practice matching fire the right chord per segment, how fast, wrong fires | GuitarSet |
| `eval_listen.mjs` | listen display accuracy vs flicker for show/gap holds | GuitarSet |
| `calibrate.mjs` | confidence threshold → coverage / precision | GuitarSet |
| `eval_strings.mjs` | per-string presence / onsets / direction vs hex-pickup GT | GuitarSet |
| `bench.mjs` | all of the above → `docs/BENCH.md` | GuitarSet |
| `telemetry_report.mjs` | what happened in a session (signal, verdicts, per-target matches, confusions) | telemetry |
| `session_labels.mjs` | line recordings up with the screen; `--replay` re-runs the detector on each labelled interval | telemetry + recordings |
| `replay.mjs` | chord timeline of one WAV through the app's detector | any WAV |
| `browser_test.mjs` | end to end in headless Chrome with a WAV as the fake mic | GuitarSet |
| `learn_profiles.mjs` | re-learn `data/partials*.json` | GuitarSet hex |
| `learn_profile.mjs` | learn the player's per-chord chroma (`data/user/profile.json`) and evaluate it leave-one-out | telemetry + recordings |
| `coach_replay.mjs` | which hints the coach would have given in a session | telemetry |
| `trace.mjs`, `probe.mjs`, `diag.mjs` | per-frame dumps for one strum | any WAV |

`npm test` runs the unit tests (`tests/`, < 1 s, no audio).

## How to …

- **add a chord**: one object in `data/chords.json` (`id, name, fullName, category, root, quality, notes, fingering{frets, fingers, baseFret}`, `bass` for slash chords). `notes` must be the chord tones; the fretted notes must be a subset (the fifth may be omitted) — `npm test` checks this. Everything else (templates, twins, diagrams, picker groups, transitions) is derived. A new `category` needs a label in `main.js` `groupLabel` / `groupOrder` and, if it should get a prior, an entry in `CONFIG.detect.prior`.
- **add a preset**: `PRESETS` in `main.js` (a function returning ids) plus a `<button data-pick=…>` in `index.html`.
- **try a scorer variant**: add a function to `SCORERS` in `tools/eval_chords.mjs` (it receives the analyzer, activations, voicings, chroma, bass pitch class and the magnitude spectrum) and compare against `app`; when it wins, move the logic into `scoreTemplates` so the app and the bench stay one code path.
- **add a config knob**: a leaf in `src/config.js` with a comment stating the evidence; read it through `CONFIG.x.y` at use time (not copied into a module constant) so `?cfg=` overrides apply.
- **add a telemetry event**: `telemetry.log('name', {…})` with `ts` from `detector.streamTime()` when it relates to audio; document it in the table above; teach `tools/telemetry_report.mjs` to summarise it.
- **add a coach rule**: `src/coach.js` keeps a table of pure rules `(target chord, recent frames, recent strums) → hint | null`; add a row and a case to `tools/coach_replay.mjs`'s expectations.

## Physical limits (measured, don't re-tune around them)

- Two strings an octave apart (the G2/G3/G4 in an open G, C3/C4 in C) are spectrally nested; pluck-to-pluck partial variance (σ ≈ 1 in log domain on GuitarSet) swamps the difference. The tracker marks such strings `doubled` and only infers them from strum contiguity.
- Onset timing floor ≈ 8 ms per string (time-frequency uncertainty), so strum direction is reported only when strings are further apart than that.
- A mono chroma cannot separate the sus twins or a slash chord from its parent; that is why they share templates.
- A 7th or 9th is one string among five or six: without `CONFIG.detect.lam` the triad always wins; with it, plain triads lose a few points only when richer chords are candidates.

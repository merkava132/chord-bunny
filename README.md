# chord-bunny

A guitar chord transition trainer that listens, inspired by [dkthehuman.com/chord-bunny](https://www.dkthehuman.com/chord-bunny/).

Two random chords on screen. Play them. The mic picks up what you played and advances the moment you nail the next one — no timer required, no "start session" ritual. Just open it and play.

It also watches the **strings**: which ones rang, which one you missed, whether you hit a string that should be muted, how long each keeps ringing, and (when the timing is clear) whether that was a down- or upstrum.

## Modes

- **practice** — pair of chords; auto-advances on detection. Optional timer. Per-string feedback against the chord you're supposed to be holding. The next chord is always one that makes musical sense after the current one (same key, or same root — C → Csus4, Am → Am7, G → Em), never a random jump.
- **tempo** (a checkbox in practice) — a metronome; the pair advances every bar instead of on detection. BPM (78 = My Song), 2/4/8 beats per chord, one count-in bar, a strip of the last 8 bars (green = the chord was detected in time). With **creep** on, 4 clean bars in a row raise the tempo by 2, 2 missed bars lower it. With a progression selected, the next four chords show under the pair.
- **drill weak spots** (a checkbox in practice) — random pairs lean toward the transitions you match slowly or miss, from your own telemetry (Settings → **progress** shows the numbers: practice minutes per day, per-chord match rate, your slowest transitions).
- **listen** — free-form chord recognizer. Plays your mic OR an audio file you load. Shows what it hears, with per-string activity for the detected shape.

## Chords

62 chords in `data/chords.json`, picked in Settings → **chord set** (presets: basic, pop set, my song, all):

| group | chords |
|---|---|
| basic | C D E F G A · Dm Em Am |
| barre | Bm B F#m C#m Bb Gm F#m7 Eb |
| sus2 / sus4 | Asus2 Asus4 A7sus4 Dsus2 Dsus4 Esus4 Csus2 Csus4 Gsus4 Fsus2 Fsus4 Bsus4 |
| add9 | Cadd9 Gadd9 Eadd9 Aadd9 |
| maj7 | Cmaj7 Fmaj7 Gmaj7 Amaj7 Dmaj7 Emaj7 · Cmaj7 hi (x35500) |
| min7 | Am7 Dm7 Em7 Bm7 |
| 7th | C7 D7 E7 G7 A7 B7 |
| 6 · 9 · add11 · #11 | G6 Em9 Fmaj7#11 Gadd11 D6sus2 |
| slash (bass note) | G/B D/F# C/G C/E Am/G A/C# Dsus2/F# |

Every voicing was checked against its chord tones by the generator that wrote the file (a 7th chord may drop its fifth, nothing else).

Two things to know about what a mono-mic chroma detector can and can't tell apart:

- **Sus twins share notes.** Asus2 and Esus4 are both {A, B, E}; likewise Dsus2 = Asus4, Csus2 = Gsus4, Fsus2 = Csus4. Slash chords have the same notes as their parent. Such chords share one detection template, so in practice mode either one counts for the other, and listen mode says "same notes as …". The string tracker still checks the actual voicing.
- **Practice mode only listens for the chords you ticked, plus the basic nine.** Every extra candidate is a chance to be wrong (see the numbers below). A basic chord you did *not* tick also counts for a richer target on the same root that contains it — practising Am7 without Am ticked, an Am is accepted, because you didn't ask to tell them apart.

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
4. Activations are folded to 12 pitch classes and scored against each chord with a **geometric-mean template** (a missing chord tone is catastrophic), **minus half the chroma mass the template doesn't explain** (otherwise a plain triad beats its own maj7 / add9 unless the extra note is as loud as the average chord tone — one high string rarely is), **minus a small prior on sus templates** (a major chord with a weak third ties with a sus chord otherwise). Cosine similarity against binary templates, the classic approach, can't tell C from Am7 when a little noise lands on A.
5. Confidence = fit of the winner + its margin over the nearest rival that is *not* nested with it (C inside Cmaj7 differ by one note, so their scores are close by construction). EMA + majority-of-5 smoothing, RMS gate, calibrated confidence gate, min-hold before a chord counts as "stable".

Per-string tracking (`src/dsp/strings.js`) runs every 6 ms with exactly six templates (one per string of the shape being held, using per-string learned profiles) plus a flat noise basis. Spectral flux finds strums; each string is "struck" if its activation rises *and* survives the attack transient; each string's onset is timed from the steepest rise of its activation (amplitude-independent under a Hann window); Kendall's tau over the reliably-timed strings gives the direction; sustain is tracked until the activation decays.

### What it measures, honestly

Benchmarked against [GuitarSet](https://github.com/marl/GuitarSet) (CC-BY 4.0) room-mic recordings, the six players' takes of the open-position progressions, frames where ≥3 strings are ringing:

| chord frame accuracy, open subset, instructed labels | |
|---|---|
| old chroma+cosine, 21 chords | 71.3% |
| v2 scorer, 21 chords (previous build) | 81.6% |
| **now, candidates = the basic nine** (practice with "basic only") | **87.1%** |
| now, candidates = "my song" preset + basic | 77.6% |
| now, all 53 candidates (listen mode, open-world scoring) | 74.4% |

The full, regenerable table is `docs/BENCH.md` (`npm run bench`), including the
real-note synthetic bench for all 53 open-position voicings. Extended chords,
all 36 comping takes, performed labels, candidates = basic + maj7 + min7 +
7th: 7th chords 51%, maj7 37%, min7 42%, plain triads 71% (before the size
bonus: 41 / 27 / 28 / 83; before the unexplained-mass penalty: 23 / 10 / 15 /
88). The size bonus is a deliberate trade: when rich chords are ticked, they
are recognised far more often and plain triads a little less; with only the
basic nine ticked nothing changes. GuitarSet's 7ths are mostly jazz voicings up the neck, not the open shapes in this app, so treat those as lower bounds. GuitarSet contains only ~10 s of sus chords in total (brief ornaments), so the 15% sus recall is not a measurement of a held Dsus4.

End-to-end in headless Chrome (a WAV as the fake mic, `tools/browser_test.mjs`, share of UI samples whose "heard" equals the lead-sheet chord): practice mode with the default five chords ticked, 00_Rock3 81% / 02_SS3 46% (previous 21-chord build: 79% / 46%); listen mode with all 53 candidates, 71% / 40% (previous build: 82% / 46%). Listen mode pays for its 53 candidates in "—" frames and the odd G→Gmaj7; practice mode does not.

Per string (hex-pickup ground truth): presence F1 77%, onsets 66% recall / 93% precision, strum string-set Jaccard 0.57, direction 57% overall (≈68% when the tracker commits), per-string onset timing ≈10 ms median error.

Two limits are physics, not code:

- **Octave-doubled strings can't be separated from a mono mic.** In an open G the G string (G3) and high e (G4) are spectrally nested — every partial of G4 is a partial of G3. Separating them means reading partial-amplitude ratios, and those vary 2–5× from pluck to pluck (σ≈1 in the log domain, measured). The UI shows those strings hollow ("inferred" from strum contiguity) and says "can't tell (octave)" instead of "missing".
- **Per-string timing floors out around 8 ms.** Telling a string's fundamental apart from a neighbour's harmonic 10–20 Hz away needs ~10 Hz of frequency resolution, and time-frequency uncertainty makes that ≳8 ms of timing uncertainty. Strings in a strum are ~8 ms apart, so direction is only shown when the spread is wide enough to be sure.

## Tuning

Settings → **detection**:

- **sensitivity** — confidence a frame needs before it counts. Calibrated on GuitarSet (`tools/calibrate.mjs`); raise it if you see wrong chords, lower it if it says "—" too much. Fewer ticked chords = fewer ways to be wrong = more verdicts.
- **min hold (ms)** — how long the same chord must be detected before counting as "matched".

## Development

`npm test` — unit tests (`tests/`, no audio, < 1 s). `npm run bench` — every benchmark number into `docs/BENCH.md`. `docs/ARCHITECTURE.md` — pipeline, clocks, telemetry schema, how to add a chord / preset / knob / event.

```
tools/eval_chords.mjs      chord accuracy vs GuitarSet (old detector side by side, the app scorer, variants; --chords= restricts candidates, --dump=app for confusions, --gt=performed)
tools/eval_strings.mjs     per-string presence / onsets / strum sets / direction / sustain vs hex-pickup GT
tools/learn_profiles.mjs   re-learn data/partials*.json from single-string frames
tools/calibrate.mjs        confidence threshold → coverage / precision table for a candidate set (uses the app's scorer)
tools/browser_test.mjs     headless Chrome end-to-end: a WAV as the fake mic, samples the live UI
tools/trace.mjs, probe.mjs per-frame dumps for staring at one strum
testdata/fetch_guitarset.py  pulls the subset out of the Zenodo zip by HTTP range requests (no 3 GB download)
```

`node tools/eval_chords.mjs --verbose` after fetching test data. The browser test needs Chrome and a clean environment (see `docs/FRICTION_LOG.md`).

## File layout

```
index.html / styles.css        UI shell, dark theme
serve.py / start.sh            static server + local telemetry / recording sink (start.sh opens the browser)
package.json                   npm test / npm run bench / eval wrappers (no dependencies)
data/chords.json               53 chords with fingerings (open shapes + a few barre shapes)
data/partials*.json            learned partial-amplitude profiles (per pitch, per string×pitch)
src/
  config.js     every tunable, with the evidence; ?cfg= / --cfg= overrides
  main.js       app bootstrap, mic lifecycle, settings UI, presets, telemetry wiring, dev hooks (?autostart&mode&chord&open&recmax&cfg)
  settings.js   localStorage persistence (+ change listeners)
  telemetry.js  event batching to serve.py
  diagrams.js   SVG chord-chart renderer (strings carry data-string for live colouring)
  detect.js     chord detector: frames → NNLS activations → chroma → template scores, confidence, StableRule (+ candidate scoping, twins)
  theory.js     which chords belong together (shared key / root) — drives the next-chord pick
  practice.js   chord-bunny game loop
  listen.js     free-form recognizer (mic OR file) with display hold
  strings-ui.js per-string bars, sustain timers, strum readout, diagram lighting
  audio/        AudioWorklet capture, FrameStream (consumers + taps), Recorder (segments → WAV upload)
  dsp/          fft, wav decoder, PitchAnalyzer (NNLS), StringTracker
tools/          evaluation and session tools (see docs/ARCHITECTURE.md for which question each answers)
tests/          node:test unit tests + a telemetry fixture
docs/           ARCHITECTURE.md, BENCH.md (generated), FRICTION_LOG.md
telemetry/      per-session event logs (gitignored)
recordings/     per-session WAV segments (gitignored; start.sh points at /mnt/aegis when present)
```

## Future ideas

- Strum-tightness trainer: metronome + the onset detector we already have.
- Chord audio playback via Tone.js `PluckSynth`.

## Progressions

The "play" selector in practice switches from random related pairs to a
progression from `data/progressions.json` (Girls Dead Monster's *My Song*
in eight sections, numbered in learning order — intro riff, both verse
lines, pre-chorus, chorus, chorus tail, interlude, outro — plus the whole
song in order; I–V–vi–IV, the royal road, sus colour loops, ii–V–I, Canon in
D). The progression's chords are always detection candidates, whether or not
they are ticked, so the surest way to learn a section is to clear the chord
set and pick the section; "new pair" restarts it. Add a song by appending
`{ id, name, chords: [ids] }` — every id must exist in chords.json.

## Non-guitar audio

A guitar-likeness gate (`src/dsp/gate.js`, `CONFIG.gate`) turns a frame
into "no verdict" when the harmonic dictionary cannot explain its spectrum
(NNLS residual > 0.4): speech and TV pass 27% of the time, guitar 97%, and it
costs one target in 420 on the personal benchmark. Ambient audio also gets
recorded when the mic is left on; annotate non-guitar stretches in
`data/user/sessions.json` so the benchmark and the stats skip them.

## Telemetry & recordings (local only)

`serve.py` (what `./start.sh` runs) is the static server plus a sink for two
things the page posts to it, both switchable off with the "log & record
locally" toggle under *detection*:

- **Events** → `telemetry/<session>.jsonl`: session/settings, mic state, a
  frame sample ~5×/s while playing (level, peak, clipping, best chord,
  confidence, top-3 template scores, chroma), strums, practice `pair` /
  `match` / `miss` (what it heard instead of the target), listen verdicts.
- **Audio** → `recordings/<session>/seg-NNNN.wav` (or `$CB_REC_DIR`, which
  `start.sh` points at `/mnt/aegis/chord-bunny/recordings` when that drive
  exists): every stretch of non-silence with 0.5 s pre-roll and a 2 s tail,
  16-bit mono at the AudioContext rate, capped at 60 s per file and 20 GB
  total (oldest WAVs pruned; the segment index and tool caches stay). The
  mic chip toggles the mic off, and it switches itself off after 15 minutes
  without a confident verdict at playing level (`CONFIG.idle`) — a tab left
  open with the mic on records the room. Segment times are on the audio-stream clock (`ts`),
  the same clock as the frame events.

Nothing is sent anywhere; `python -m http.server` would just drop the POSTs.

- `node tools/telemetry_report.mjs [latest|file]` — session summary: signal
  level and clipping, confidence distribution, what was heard, per-target
  match rate and confusions, listen-mode flicker, strum stats.
- `node tools/replay.mjs recordings/<session>/seg-0003.wav [--chords=basic,sus]`
  — run a take through the detector offline and print the chord timeline.

## Tell it when it was wrong

After every advance a caption offers one key: **N** if the chord it heard
was wrong, **Y** if it timed out while you were playing the chord. Settings →
**calibrate** walks you through each ticked chord (4 strums) and the six open
strings (2 plucks) while the app knows exactly what you are playing. Both
become labelled takes in the telemetry (`label`, `enroll`) that the learning
tools use — see docs/ARCHITECTURE.md "Ground truth from the player".

`node tools/personal_bench.mjs` replays your own recordings against what the
screen asked for, with the live configuration; `npm run bench:personal`
writes docs/PERSONAL.md.

## Calibration to your guitar and mic

Settings → **calibrate** records each ticked chord (4 strums) and the six
open strings (2 plucks). "learn from my recordings" (detection panel, `POST
/api/profile/learn`) then runs two tools:

- `tools/learn_response.mjs` measures the partial amplitudes of each open
  string on *your* guitar and mic (`data/user/partials.json`, the same shape
  as `data/partials.json`) and fits a frequency-response correction that the
  analyzer applies to every pitch (`CONFIG.profile.userPartials`). It also
  reports whether the low E's fundamental (82 Hz) is present at all on your
  input — on a front-panel mic jack it is usually not, and then the string
  tracker cannot see the low E directly (it is only reported struck when its
  fundamental is really there, so the "you're hitting the low E" hint stays
  quiet rather than guessing).
- `tools/learn_profile.mjs` learns a per-chord chroma profile from the
  calibration takes (gold, weight ×3) and matched practice takes. It is
  blended with `CONFIG.profile.alpha`, **0 by default**: two leave-one-out
  runs on 408 intervals put the canonical templates ahead. The tool prints
  the evaluation so a clean calibration run can change that.

## Personal profile (chroma, off by default)

Templates score a chroma with uniform weights on the chord tones. Your guitar,
mic and strumming produce a characteristic chroma per chord (the analyzer's
semitone leakage, a strong open A on your D, a quiet top string…).
`tools/learn_profile.mjs` learns the median chroma of each chord from your
matched practice takes (recordings + labels) and the detector blends it into
the template weights (`CONFIG.profile.alpha`, default 0.5). The file
`data/user/profile.json` is per install and gitignored; without it nothing
changes. Learn or relearn from the app ("learn from my recordings" in the
detection panel → `POST /api/profile/learn`) or by hand:

    node tools/learn_profile.mjs --all --alpha=0.5 --write data/user/profile.json

The tool prints a leave-one-interval-out evaluation first (first session, 77
intervals: settled-frame accuracy 56→59%, wrong fires 18→14, median delay
2.21→2.05 s), so you can see whether more data helped.
## Coach, input monitoring, debug panel

- **Coach** (`src/coach.js`): while a practice target stays unmatched for a
  few seconds, one hint at a time derived from the last 3 s of detector frames
  and strum events. Rules, in priority order (each a few lines in `RULES`):
  `clipping`, `quiet`, a silent `other-chord` guard (no string hints while the
  verdict is plainly a different chord, unless that chord is the target plus
  the stray note — G + open E = Em), `muted-hit` (strums keep hitting a string
  that is muted in the shape), `open-string` (a strong non-chord pitch class
  that is an open string's note; names the finger when one string is
  responsible, both strings when two could be), `missing-string` (a chord tone
  that lives on one string in the shape is neither struck nor heard). Knobs in
  `CONFIG.coach`. Hints are logged as telemetry `hint` events.
  `node tools/coach_replay.mjs telemetry/<session>.jsonl` replays a session
  and prints the hints it would have given.
- **Input monitoring** in the header: level meter with a clip dot on the mic
  chip, an input-device picker (saved; switching re-attaches the detector),
  and a "not a mic?" warning when the selected device label looks like a
  playback monitor / loopback (`CONFIG.input.loopbackPattern`).
- **Debug panel** (`?debug=1` or the toggle under *detection*): live chroma
  (target notes in green), verdict / best, confidence vs threshold, the
  stable-window fill practice matching waits for, top-3 template scores,
  candidate count, detector cost per frame, session id, effective config.

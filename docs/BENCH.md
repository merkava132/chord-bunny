# Detection benchmarks

Two data sources, both run through the app's own scoring code
(`buildTemplates` / `scoreTemplates` / `confidenceOf` / `StableRule` in
`src/detect.js`, EMA 0.5, majority-of-5, threshold 0.35), so the numbers
describe what ships. Regenerate with the commands under each table.

**Scoring modes.** Practice mode scores only the enabled chords plus the
basic nine with `CONFIG.detect.sizeBonus` 0.25 (closed world: the user said
which chords are in play). Listen mode scores all 53 with
`CONFIG.listen.sizeBonus` 0 (open world: the simpler chord is the better
guess). Tools default to practice scoring; `--listen` switches.

## GuitarSet (real room-mic recordings)

Frame accuracy on the open-voicing subset (SS3 / Rock3 / Rock1 comps, 18
files, lead-sheet labels, frames with ≥3 strings ringing, 15 696 frames).
GuitarSet's lead sheets are majors and minors only, so this measures how
much the extra candidates *cost* on plain chords.

| candidates | scoring | before | now |
|---|---|---|---|
| basic 9 | practice | 87.1% | 87.1% |
| basic + sus | practice | 84.4% | 82.0% |
| my-song set + basic | practice | 83.8% | 77.6% |
| all 53 | practice (sizeBonus 0.25) | 75.6% | 62.5% |
| all 53 | listen (sizeBonus 0) | 75.6% | 74.4% |
| 21-chord build of 2026-09-05 | — | 81.6% | — |

```
node tools/eval_chords.mjs --chords=basic
node tools/eval_chords.mjs --chords=basic,sus
node tools/eval_chords.mjs --chords=basic,Asus4,Asus2,Am7,Gsus4,Dsus2,Fsus4,Fmaj7,Cmaj7,Em7
node tools/eval_chords.mjs            # all 53, practice scoring
node tools/eval_chords.mjs --listen   # all 53, listen scoring
```

All 36 comp files, *performed* labels (the annotators' voicing, so 7ths
appear; jazz voicings are rootless inner-string shapes, not our open ones):

| candidates | family | before | now |
|---|---|---|---|
| basic + maj7/min7/7th | basic | 83% | 71% |
| | 7th | 41% | 51% |
| | maj7 | 27% | 37% |
| | min7 | 28% | 42% |
| all 53, listen | basic | 79% | 78% |
| | 7th / maj7 / min7 / sus | 40 / 24 / 20 / 0% | 40 / 24 / 20 / 4% |

```
node tools/eval_chords.mjs --subset=all --gt=performed --chords=basic,maj7,minor7,seventh --dump=app
node tools/eval_chords.mjs --subset=all --gt=performed --listen --dump=app
```

Practice matching (`StableRule`, basic candidates, lead-sheet chord segments
≥ 2 s): 93% of segments fire the right chord, 7% fire a wrong one first,
median 0.56 s after the segment starts — `node tools/eval_hold.mjs --minseg=2`.
Confidence calibration at threshold 0.35: basic 79% of chord frames get a
verdict, 94% right; all 53 listen 78% / 81% — `node tools/calibrate.mjs
--chords=basic`, `node tools/calibrate.mjs --listen`.

## Real-note chord bench (all 53 voicings)

GuitarSet's hexaphonic pickup takes give one channel per string, aligned
with note annotations. `tools/note_bank.mjs` cuts every annotated note (269
with ≥ 0.8 s ring-out from 12 takes; cut at the next energy rise because the
annotations miss some re-plucks), `tools/synth_chords.mjs` mixes them into
650 clips: for each voicing 6 clean strums (down/up, 5–25 ms between strings,
±4 dB per string), 2 double strums, and mistake variants — every muted
string struck open, top string missing, top string −12 dB, one inner string
missing. Notes for 13 uncovered (string, fret) pairs are borrowed from a
neighbouring fret and resampled. Timbre is the pickup's, not a mic's (the
partial balance differs a lot — see `tools/learn_profiles_bank.mjs`), but the
shipped mic-learned dictionary scores these clips within 2 points of a
dictionary learned on the pickup, so the numbers transfer.

Metric: does `StableRule` fire the target (or a same-notes twin) within 1 s
of the strum ("fire"), or something else first ("wrong"). Clean + double
strums, before → now:

| candidates | family | fire before | fire now | wrong before | wrong now |
|---|---|---|---|---|---|
| basic | basic | 89% | 89% | 7% | 7% |
| basic + sus | sus | 68% | **76%** | 17% | 16% |
| basic + 7ths | basic | 86% | 79% | 10% | 8% |
| | maj7 | 40% | **71%** | 50% | 25% |
| | min7 | 41% | **63%** | 50% | 25% |
| | 7th | 65% | **77%** | 21% | 8% |
| basic + add9 | add9 | 44% | **63%** | 44% | 38% |
| basic + slash | slash | 69% | 75% | 21% | 17% |
| basic + barre | barre | 59% | 63% | 21% | 16% |
| my-song set | basic | 88% | 85% | 8% | 8% |
| | sus | 65% | 70% | 25% | 23% |
| | maj7 | 44% | **69%** | 50% | 31% |
| | min7 | 25% | **56%** | 69% | 38% |
| all 53, listen | basic | 78% | 78% | 11% | 11% |
| | sus | 57% | **72%** | 23% | 18% |
| | maj7 / min7 / 7th | 38 / 41 / 58% | 38 / 41 / 56% | | |

Mistake variants (now): basic candidates, basic chords fire 82% / wrong
10%; my-song set: basic 77%, sus 57%, maj7 60%, min7 63%. The dominant
confusions are what they should be — Am7 with the A string missing is C,
Cmaj7 with the B string missing is C, Asus4 with a weak D is Am.

```
python3 testdata/fetch_guitarset.py --hex     # ~120 MB, once
node tools/note_bank.mjs && node tools/synth_chords.mjs
node tools/eval_synth.mjs --sets=basic,basic+sus,basic+7ths,basic+add9,basic+slash,basic+barre,mysong --variants=clean,restrum --confusions
node tools/eval_synth.mjs --sets=all --listen --variants=clean,restrum
node tools/eval_synth.mjs --sets=basic,mysong --variants=openMuted,missingTop,weakTop,missingInner
node tools/eval_synth.mjs --profiles=hex ...    # dictionary learned on the pickup (tools/learn_profiles_bank.mjs)
```

## What changed and why (2026-09-06)

- **`CONFIG.detect.sizeBonus` 0 → 0.25 (practice)**. The geometric-mean
  score compares each chord tone with an absolute floor (`eps`), so a
  4-note template only beats its triad when the 7th is as loud as the
  average chord tone — one string among five rarely is. A full likelihood
  compares each tone with its expected share 1/|T| (`+log|T|`), but that
  overshoots: with sizeBonus 1 every triad is heard as a 7th (GuitarSet
  all-53 3%). 0.25 is the compromise above; sweep in the parent session's
  scratch log (0.25 / 0.4 / 0.55, power-mean β 0.25 / 0.5 — β was worse
  everywhere). Only matters when richer chords are candidates: basic-only
  detection is identical.
- **`CONFIG.listen.sizeBonus` 0**: listen mode is open-world; 0.25 there
  costs 12 points on plain chords for no user-visible gain.
- **`CONFIG.detect.prior.sus` 0.15 → 0.10**: sus fires +8 points on the
  bench, −2 points on GuitarSet basic+sus.
- Confidence is computed without the size bonus in the fit term (the bonus
  is an argmax prior, not evidence) and with the actual competition in the
  margin term.
- Not changed: `lam` 0.5 (re-checked 0.25 — worse for 7ths, no gain on
  triads), the nested-runner-up rule, the "un-enabled basic chord counts for a
  same-root richer target" rule.

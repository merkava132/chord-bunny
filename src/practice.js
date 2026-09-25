// Practice mode: chord-bunny game.
//   - shows current + next chord (next is always a musically related chord,
//     see theory.js)
//   - advances when detector confirms, OR on timer (if enabled), OR manually
//   - the detector only scores the chords you enabled plus the basic nine,
//     and a basic chord you did NOT enable counts for a richer target on the
//     same root that contains it (Am heard while practising Am7 alone is
//     fine — you didn't ask to tell them apart)
//   - after each advance, one keypress can say the detector was wrong (N after
//     a match, Y after a timer advance) → telemetry `label`; "calibrate my
//     chords" (src/enroll.js) records each chord, then each open string, while
//     it is known for certain → telemetry `enroll`. Both feed
//     tools/learn_profile.mjs.

import { renderInto } from './diagrams.js';
import { pcSubset, PC_INDEX } from './detect.js';
import { pickNext } from './theory.js';
import * as settings from './settings.js';
import * as telemetry from './telemetry.js';
import { CONFIG } from './config.js';
import { Coach } from './coach.js';
import { Enrollment, buildSteps, OnsetDetector } from './enroll.js';

export class PracticeMode {
  constructor({ root, allChords, getEnabled, getDetector, onCurrent = null, progressions = [], onCalibStatus = null }) {
    this.root = root;
    this.onCurrent = onCurrent;
    this.onCalibStatus = onCalibStatus;   // (text) → the status line in the settings "calibrate" panel
    this.allChords = allChords;
    this.getEnabled = getEnabled;
    this.getDetector = getDetector;
    this.progressions = progressions;   // data/progressions.json; settings.sequence picks one (or 'random')
    this.seqIndex = 0;                  // position in the selected progression
    this.seqPosEl = root.querySelector('#seq-pos');

    this.curEl       = root.querySelector('.chord-card.current');
    this.nextEl      = root.querySelector('.chord-card.next');
    this.curName     = root.querySelector('#cur-name');
    this.nextName    = root.querySelector('#next-name');
    this.curDiagram  = root.querySelector('#cur-diagram');
    this.nextDiagram = root.querySelector('#next-diagram');
    this.curMeta     = root.querySelector('#cur-meta');
    this.nextMeta    = root.querySelector('#next-meta');
    this.heardEl     = root.querySelector('#heard-chord');
    this.confFill    = root.querySelector('#conf-fill');
    this.hintEl      = root.querySelector('#detection-hint');
    this.coachEl     = root.querySelector('#coach-hint');
    this.timerEl     = root.querySelector('#timer-display');
    this.feedbackEl  = root.querySelector('#feedback');
    this.calibBar    = root.querySelector('#calib-bar');
    this.calibText   = root.querySelector('#calib-text');

    this.current = null;
    this.next = null;
    this.lastSeed = 0;
    this.shownAt = 0;                 // telemetry: when the current target appeared
    this.shownTs = 0;                 // … on the audio-stream clock (labels refer to recordings)
    this.lastMissId = null;
    this.lastMatchIds = null;         // the match that is about to advance the pair
    this.matchedThisTarget = false;
    this.pending = null;              // feedback offer after an advance: { target, kind, heard, ts0, ts1 }
    this.feedbackTimer = null;
    this.calib = null;                // Enrollment while calibrating

    // controls
    root.querySelector('#reroll-btn').addEventListener('click', () => this.rerollPair());
    root.querySelector('#autoadvance-cb').addEventListener('change', (e) => {
      settings.set('autoAdvance', e.target.checked);
    });
    root.querySelector('#timer-cb').addEventListener('change', (e) => {
      settings.set('timerEnabled', e.target.checked);
      this._restartTimer();
    });
    root.querySelector('#timer-secs').addEventListener('change', (e) => {
      settings.set('timerSecs', Number(e.target.value));
      this._restartTimer();
    });
    this.feedbackEl.addEventListener('click', () => this._label());
    document.addEventListener('keydown', (e) => this._onKey(e));
    root.querySelector('#calib-skip').addEventListener('click', () => this.calib?.skip());
    root.querySelector('#calib-stop').addEventListener('click', () => this.calib?.stop());

    // initial UI state from settings
    root.querySelector('#autoadvance-cb').checked = settings.get('autoAdvance');
    root.querySelector('#timer-cb').checked = settings.get('timerEnabled');
    root.querySelector('#timer-secs').value = settings.get('timerSecs');

    this.timerHandle = null;
    this.timerEnd = 0;

    // coach: one hint at a time about the chord you're holding (src/coach.js)
    this.coach = new Coach({
      chords: allChords,
      onHint: (h, t) => {
        this.coachEl.hidden = !h;
        this.coachEl.textContent = h ? h.text : '';
        if (h) telemetry.log('hint', { ts: this._ts(), target: this.current?.id, kind: h.kind, text: h.text });
      },
    });
    this.coachTimer = null;
  }

  // fed by main.js from the detector / string tracker (every frame, every strum)
  observeFrame(f) { if (this.coachTimer) this.coach.pushFrame(f, telemetry.now()); }
  observeStrum(ev) {
    if (this.calib) return;   // calibration counts energy onsets (see _wireDetector); the tracker re-triggers on a ringing chord
    if (this.coachTimer) this.coach.pushStrum(ev, telemetry.now());
  }

  enable() {
    this.rerollPair(/*fresh*/ true);
    this._restartTimer();
    this._wireDetector();
    this._showDiagramsToggle();
    if (!this.coachTimer) this.coachTimer = setInterval(() => this.coach.tick(telemetry.now()), 250);
  }

  // Enabled set changed (chord picker): re-scope the detector, fix the pair.
  onEnabledChanged() {
    this._syncCandidates();
    if (this._sequence()) return;   // a progression doesn't depend on the ticked set
    const ids = new Set(this.getEnabled());
    if (!this.current || !ids.has(this.current.id) || !this.next || !ids.has(this.next.id)) this.rerollPair(true);
  }

  _syncCandidates() {
    const det = this.getDetector();
    if (!det) return;
    const enabled = new Set(this.getEnabled());
    for (const c of this._sequence() || []) enabled.add(c.id);   // a progression's chords are always in play
    const ids = new Set(enabled);
    for (const c of this.allChords) if (c.category === 'basic') ids.add(c.id);
    // un-ticked basic chords stay in play as decoys, docked CONFIG.detect.prior.decoy
    det.setCandidates([...ids], { decoys: new Set([...ids].filter(id => !enabled.has(id))) });
  }

  // settings.sequence changed (select): restart with the new mode
  onSequenceChanged() { this._syncCandidates(); this.rerollPair(true); }

  disable() {
    this._clearFeedback();
    if (this.calib) { this.calib.abort(); this._endCalibration(null); }
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = null;
    if (this.coachTimer) clearInterval(this.coachTimer);
    this.coachTimer = null;
    this.coach.setTarget(null, telemetry.now());
    this.timerEl.hidden = true;
    const det = this.getDetector();
    if (det) { det.onUpdate = null; det.onStable = null; }
  }

  _wireDetector() {
    const det = this.getDetector();
    if (!det) return;
    this._syncCandidates();
    det.onUpdate = (id, conf, level, ids, t) => {
      if (this.calib && this.calibOnsets.push(t, level)) this.calib.onset(t);   // strums / plucks while calibrating
      const match = id ? this._isMatch(ids) : false;
      this.heardEl.textContent = id ? this._heardName(ids) : '—';
      // Meter (CONFIG.meter): the detection threshold sits at the midpoint,
      // threshold + span fills it. Green while what it hears is the target.
      const thr = det.sensitivity, M = CONFIG.meter;
      const fill = id ? Math.max(0, Math.min(1, 0.5 + (conf - thr) / (2 * M.span))) : Math.max(0, Math.min(M.idleMax, conf / thr * M.idleMax));
      this.confFill.style.width = `${Math.round(fill * 100)}%`;
      this.confFill.dataset.state = !id ? 'none' : match ? 'match' : 'other';
    };
    det.onStable = (id, conf, ids) => {
      if (this.calib) return;   // calibrating: the chord is known, nothing to match
      this._onStableChord(ids);
      if (this.current && !this._isMatch(ids) && ids[0] !== this.lastMissId) {
        this.lastMissId = ids[0];
        telemetry.log('miss', { ts: this._ts(), target: this.current.id, heard: ids, conf: +conf.toFixed(2), sinceShown: +(telemetry.now() - this.shownAt).toFixed(1) });
      }
    };
  }

  // Does a detected template (all chord ids that share its notes) satisfy the
  // current target?
  _ts() { return +(this.getDetector()?.streamTime() ?? 0).toFixed(3); }

  _isMatch(ids) {
    const cur = this.current;
    if (!cur || !ids?.length) return false;
    if (ids.includes(cur.id)) return true;
    const enabled = new Set(this.getEnabled());
    for (const c of this._sequence() || []) enabled.add(c.id);
    const heard = this.allChords.find(c => c.id === ids[0]);
    return !!heard && !ids.some(id => enabled.has(id))
      && PC_INDEX[heard.root] === PC_INDEX[cur.root] && pcSubset(heard, cur);
  }

  // Name to show for a detected template: the target if it matches, else the
  // first enabled chord with those notes, else the first one.
  _heardName(ids) {
    if (this._isMatch(ids)) return this.current.name;
    const enabled = new Set(this.getEnabled());
    const id = ids.find(x => enabled.has(x)) || ids[0];
    return this.allChords.find(c => c.id === id)?.name || id;
  }

  _onStableChord(ids) {
    if (!this._isMatch(ids)) return;
    const auto = !!settings.get('autoAdvance');
    telemetry.log('match', { ts: this._ts(), target: this.current.id, heard: ids, sinceShown: +(telemetry.now() - this.shownAt).toFixed(1), advanced: auto });
    this.coach.setMatched(telemetry.now());
    this.matchedThisTarget = true;
    if (auto) { this.lastMatchIds = ids; this._matched(); }
  }

  _matched() {
    this.curEl.classList.remove('matched');
    void this.curEl.offsetWidth;       // restart anim
    this.curEl.classList.add('matched');
    setTimeout(() => this.advance(), 240);
  }

  // The selected progression's chord objects, or null for random pairs.
  _sequence() {
    const id = settings.get('sequence');
    const p = id && id !== 'random' ? this.progressions.find(x => x.id === id) : null;
    if (!p) return null;
    const byId = new Map(this.allChords.map(c => [c.id, c]));
    const chords = p.chords.map(c => byId.get(c)).filter(Boolean);
    return chords.length >= 2 ? chords : null;
  }

  _seqAt(i) { const seq = this._sequence(); return seq ? seq[((i % seq.length) + seq.length) % seq.length] : null; }

  rerollPair(fresh = false) {
    const seq = this._sequence();
    if (seq) {   // restart the progression from the top
      this.seqIndex = 0;
      this.current = this._seqAt(0);
      this.next = this._seqAt(1);
      this._render(this.current, this.next);
      this._restartTimer();
      this.hintEl.textContent = settings.get('autoAdvance') ? 'play the progression — it advances when each chord is detected' : 'play the progression — manual advance only';
      telemetry.log('pair', { ts: this._ts(), cur: this.current.id, next: this.next?.id, reason: fresh ? 'fresh' : 'reroll', sequence: settings.get('sequence'), index: 0 });
      return;
    }
    const enabled = this._enabledList();
    if (enabled.length < 2) {
      this._render(null, null);
      this.hintEl.textContent = 'pick at least 2 chords below';
      return;
    }
    const a = (fresh || !this.current) ? enabled[Math.floor(Math.random() * enabled.length)] : this.current;
    this.current = a;
    this.next = pickNext(a, enabled);
    this._render(this.current, this.next);
    telemetry.log('pair', { ts: this._ts(), cur: this.current.id, next: this.next?.id, reason: fresh ? 'fresh' : 'reroll', enabled: enabled.length });
    this._restartTimer();
    this.hintEl.textContent = settings.get('autoAdvance')
      ? 'play the highlighted chord — it advances when detected'
      : 'play freely — manual advance only';
  }

  advance() {
    const timedOut = settings.get('timerEnabled') && performance.now() >= this.timerEnd;
    const reason = timedOut ? 'timer' : 'advance';
    const prev = this.current, prevTs = this.shownTs, heard = this.lastMatchIds, wasMatched = this.matchedThisTarget;
    this.lastMatchIds = null;
    if (this._sequence()) {
      this.seqIndex++;
      this.current = this._seqAt(this.seqIndex);
      this.next = this._seqAt(this.seqIndex + 1);
      this._render(this.current, this.next);
      telemetry.log('pair', { ts: this._ts(), cur: this.current.id, next: this.next?.id, reason, sequence: settings.get('sequence'), index: this.seqIndex });
    } else {
      const enabled = this._enabledList();
      if (enabled.length < 2) return;
      this.current = this.next;
      this.next = pickNext(this.current, enabled);
      this._render(this.current, this.next);
      telemetry.log('pair', { ts: this._ts(), cur: this.current.id, next: this.next?.id, reason });
    }
    this._restartTimer();
    // one keypress of ground truth: a match may have been wrong, a timer
    // advance may have missed a chord that was being played
    if (prev && !timedOut && heard) this._offerFeedback(prev, 'fp', heard, prevTs);
    else if (prev && timedOut && !wasMatched && this.getDetector()?.running) this._offerFeedback(prev, 'fn', null, prevTs);   // nothing to report with the mic off
  }

  // ---- ground truth from the player: one keypress after an advance ----
  // fp: the detector matched and advanced — "press N if that was wrong";
  // fn: the timer advanced without a match — "press Y if you were playing it".
  // Nothing is logged when the player does nothing (the default reading
  // stays: match = correct, timer = not played). Telemetry `label`:
  // { ts, target, kind, heard, ts0, ts1 } — ts0/ts1 = the target's on-screen
  // range on the stream clock, so the interval can be found in the recording.
  _offerFeedback(chord, kind, heard, ts0) {
    this._clearFeedback();
    this.pending = { target: chord.id, kind, heard: heard || [], ts0, ts1: this._ts() };
    this.feedbackEl.textContent = kind === 'fp'
      ? `heard ${chord.name} ✓ — press N if that was wrong`
      : `${chord.name} not heard — press Y if you were playing it`;
    this.feedbackEl.dataset.kind = kind;
    this.feedbackEl.hidden = false;
    this.feedbackTimer = setTimeout(() => this._clearFeedback(), 5000);
  }

  _clearFeedback() {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
    this.pending = null;
    this.feedbackEl.hidden = true;
  }

  _label() {
    const p = this.pending;
    if (!p) return;
    telemetry.log('label', { ts: this._ts(), ...p });
    this._clearFeedback();
    this.feedbackEl.textContent = 'noted ✓';
    this.feedbackEl.dataset.kind = 'noted';
    this.feedbackEl.hidden = false;
    this.feedbackTimer = setTimeout(() => this._clearFeedback(), 1500);
  }

  _onKey(e) {
    if (!this.pending || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(input|select|textarea)$/i.test(e.target?.tagName || '')) return;
    const k = e.key.toLowerCase();
    if ((this.pending.kind === 'fp' && k === 'n') || (this.pending.kind === 'fn' && k === 'y')) { e.preventDefault(); this._label(); }
  }

  // ---- calibration: strum each enabled chord, then pluck each open string,
  // while the app knows which ----
  // Telemetry `enroll`: { ts, kind: 'chord', chord, ts0, ts1, strums } per
  // chord and { ts, kind: 'string', string: 0..5 (0 = low E), ts0, ts1, plucks }
  // per open string.
  startCalibration() {
    if (this.calib) return;
    if (!this.getDetector()) { this._calibStatus('turn the mic on first (the mic chip, top right)'); return; }
    const chords = this._enabledList();
    if (!chords.length) { this._calibStatus('tick some chords under "chord set" first'); return; }
    this._clearFeedback();
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = null;
    this.timerEl.hidden = true;
    this.root.classList.add('calibrating');
    this.calibBar.hidden = false;
    this.calibOnsets = new OnsetDetector();
    this.calib = new Enrollment({
      steps: buildSteps(chords),
      now: () => this._ts(),
      onShow: (step, i, n) => {
        this.current = step.chord; this.next = null;   // an open string is a pseudo-chord: one open, five muted
        this._render(step.chord, null);
        this.coach.setTarget(null, telemetry.now());   // no hints while calibrating
        this.hintEl.textContent = `calibrating · ${step.kind === 'chord' ? 'chord' : 'open string'} ${i + 1} of ${n}`;
      },
      onProgress: (step, count, need) => {
        this.calibText.textContent = step.kind === 'chord'
          ? `strum ${step.chord.name} ${need} times, slowly, let it ring · ${count} / ${need}`
          : `pluck the open ${step.name} string ${need === 2 ? 'twice' : need + ' times'}, let it ring · ${count} / ${need}`;
      },
      onCapture: (c) => {
        const range = { ts0: +c.ts0.toFixed(3), ts1: +c.ts1.toFixed(3) };
        if (c.step.kind === 'chord') telemetry.log('enroll', { ts: this._ts(), kind: 'chord', chord: c.step.chord.id, ...range, strums: c.count });
        else telemetry.log('enroll', { ts: this._ts(), kind: 'string', string: c.step.string, ...range, plucks: c.count });
      },
      onDone: (n) => this._endCalibration(n),
    });
    this._calibStatus('calibrating — follow the chord card above');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.calib.start();
  }

  // n = { chords, strings } captured; null when the mode was left mid-way (no status, no reroll)
  _endCalibration(n) {
    this.calib = null;
    this.root.classList.remove('calibrating');
    this.calibBar.hidden = true;
    if (n === null) return;
    const parts = [];
    if (n.chords) parts.push(`${n.chords} chord${n.chords === 1 ? '' : 's'}`);
    if (n.strings) parts.push(`${n.strings} open string${n.strings === 1 ? '' : 's'}`);
    this._calibStatus(parts.length ? `calibrated ${parts.join(' + ')} — the next "learn from my recordings" uses them` : 'calibration stopped — nothing captured');
    this.rerollPair(true);
  }

  _calibStatus(text) { if (this.onCalibStatus) this.onCalibStatus(text); }

  _enabledList() {
    const ids = new Set(this.getEnabled());
    return this.allChords.filter(c => ids.has(c.id));
  }

  _render(cur, next) {
    if (this.onCurrent) this.onCurrent(cur);
    this.shownAt = telemetry.now();
    this.shownTs = this._ts();
    this.lastMissId = null;
    this.matchedThisTarget = false;
    this.coach.setTarget(cur, this.shownAt);
    const seq = this._sequence();
    if (this.seqPosEl) {
      this.seqPosEl.hidden = !seq;
      if (seq) this.seqPosEl.textContent = `${(this.seqIndex % seq.length) + 1} / ${seq.length}`;
    }
    this.curName.textContent  = cur  ? cur.name  : '—';
    this.nextName.textContent = next ? next.name : '—';
    this.curMeta.textContent  = cur  ? cur.fullName : '';
    this.nextMeta.textContent = next ? next.fullName : '';
    if (settings.get('showDiagrams')) {
      renderInto(this.curDiagram,  cur);
      renderInto(this.nextDiagram, next);
    } else {
      this.curDiagram.innerHTML = '';
      this.nextDiagram.innerHTML = '';
    }
  }

  _showDiagramsToggle() {
    // re-render in case the toggle changed externally
    this._render(this.current, this.next);
  }

  _restartTimer() {
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = null;
    if (!settings.get('timerEnabled')) {
      this.timerEl.hidden = true;
      return;
    }
    this.timerEl.hidden = false;
    const secs = Math.max(5, settings.get('timerSecs') | 0);
    this.timerEnd = performance.now() + secs * 1000;
    const tick = () => {
      const remain = Math.max(0, Math.ceil((this.timerEnd - performance.now()) / 1000));
      const m = Math.floor(remain / 60), s = remain % 60;
      this.timerEl.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      if (remain <= 0) this.advance();
    };
    tick();
    this.timerHandle = setInterval(tick, 250);
  }
}

// Practice mode: chord-bunny game.
//   - shows current + next chord (next is always a musically related chord,
//     see theory.js)
//   - advances when detector confirms, OR on timer (if enabled), OR manually
//   - the detector only scores the chords you enabled plus the basic nine,
//     and a basic chord you did NOT enable counts for a richer target on the
//     same root that contains it (Am heard while practising Am7 alone is
//     fine — you didn't ask to tell them apart)

import { renderInto } from './diagrams.js';
import { pcSubset, PC_INDEX } from './detect.js';
import { pickNext } from './theory.js';
import * as settings from './settings.js';
import * as telemetry from './telemetry.js';
import { CONFIG } from './config.js';

export class PracticeMode {
  constructor({ root, allChords, getEnabled, getDetector, onCurrent = null, progressions = [] }) {
    this.root = root;
    this.onCurrent = onCurrent;
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
    this.timerEl     = root.querySelector('#timer-display');

    this.current = null;
    this.next = null;
    this.lastSeed = 0;
    this.shownAt = 0;                 // telemetry: when the current target appeared
    this.lastMissId = null;

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

    // initial UI state from settings
    root.querySelector('#autoadvance-cb').checked = settings.get('autoAdvance');
    root.querySelector('#timer-cb').checked = settings.get('timerEnabled');
    root.querySelector('#timer-secs').value = settings.get('timerSecs');

    this.timerHandle = null;
    this.timerEnd = 0;
  }

  enable() {
    this.rerollPair(/*fresh*/ true);
    this._restartTimer();
    this._wireDetector();
    this._showDiagramsToggle();
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
    const ids = new Set(this.getEnabled());
    for (const c of this.allChords) if (c.category === 'basic') ids.add(c.id);
    for (const c of this._sequence() || []) ids.add(c.id);   // a progression's chords are always in play
    det.setCandidates([...ids]);
  }

  // settings.sequence changed (select): restart with the new mode
  onSequenceChanged() { this._syncCandidates(); this.rerollPair(true); }

  disable() {
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = null;
    this.timerEl.hidden = true;
    const det = this.getDetector();
    if (det) { det.onUpdate = null; det.onStable = null; }
  }

  _wireDetector() {
    const det = this.getDetector();
    if (!det) return;
    this._syncCandidates();
    det.onUpdate = (id, conf, level, ids) => {
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
    if (auto) this._matched();
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
    if (this._sequence()) {
      this.seqIndex++;
      this.current = this._seqAt(this.seqIndex);
      this.next = this._seqAt(this.seqIndex + 1);
      this._render(this.current, this.next);
      this._restartTimer();
      telemetry.log('pair', { ts: this._ts(), cur: this.current.id, next: this.next?.id, reason: timedOut ? 'timer' : 'advance', sequence: settings.get('sequence'), index: this.seqIndex });
      return;
    }
    const enabled = this._enabledList();
    if (enabled.length < 2) return;
    this.current = this.next;
    this.next = pickNext(this.current, enabled);
    this._render(this.current, this.next);
    telemetry.log('pair', { ts: this._ts(), cur: this.current.id, next: this.next?.id, reason: timedOut ? 'timer' : 'advance' });
    this._restartTimer();
  }

  _enabledList() {
    const ids = new Set(this.getEnabled());
    return this.allChords.filter(c => ids.has(c.id));
  }

  _render(cur, next) {
    if (this.onCurrent) this.onCurrent(cur);
    this.shownAt = telemetry.now();
    this.lastMissId = null;
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

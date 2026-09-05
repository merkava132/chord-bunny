// Practice mode: chord-bunny game.
//   - shows current + next chord
//   - advances when detector confirms, OR on timer (if enabled), OR manually

import { renderInto } from './diagrams.js';
import * as settings from './settings.js';

export class PracticeMode {
  constructor({ root, allChords, getEnabled, getDetector }) {
    this.root = root;
    this.allChords = allChords;
    this.getEnabled = getEnabled;
    this.getDetector = getDetector;

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
    det.onUpdate = (id, conf) => {
      this.heardEl.textContent = id || '—';
      this.confFill.style.width = `${Math.round(conf * 100)}%`;
    };
    det.onStable = (id) => this._onStableChord(id);
  }

  _onStableChord(id) {
    if (!settings.get('autoAdvance')) return;
    if (!this.current || id !== this.current.id) return;
    this._matched();
  }

  _matched() {
    this.curEl.classList.remove('matched');
    void this.curEl.offsetWidth;       // restart anim
    this.curEl.classList.add('matched');
    setTimeout(() => this.advance(), 240);
  }

  rerollPair(fresh = false) {
    const enabled = this._enabledList();
    if (enabled.length < 2) {
      this._render(null, null);
      this.hintEl.textContent = 'pick at least 2 chords below';
      return;
    }
    let a, b;
    if (fresh || !this.current) {
      a = enabled[Math.floor(Math.random() * enabled.length)];
    } else {
      a = this.current;
    }
    do { b = enabled[Math.floor(Math.random() * enabled.length)]; }
    while (b.id === a.id);
    this.current = a;
    this.next = b;
    this._render(this.current, this.next);
    this._restartTimer();
    this.hintEl.textContent = settings.get('autoAdvance')
      ? 'play the highlighted chord — it advances when detected'
      : 'play freely — manual advance only';
  }

  advance() {
    const enabled = this._enabledList();
    if (enabled.length < 2) return;
    this.current = this.next;
    let b;
    do { b = enabled[Math.floor(Math.random() * enabled.length)]; }
    while (b.id === this.current.id);
    this.next = b;
    this._render(this.current, this.next);
    this._restartTimer();
  }

  _enabledList() {
    const ids = new Set(this.getEnabled());
    return this.allChords.filter(c => ids.has(c.id));
  }

  _render(cur, next) {
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

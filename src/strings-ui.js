// Per-string activity view. Reads a StringTracker's live state and paints:
//   - the strings of a chord diagram (ringing / inferred / silent / wrong)
//   - six activation bars with sustain timers
//   - the last strum: direction, string count, spread, what's missing/extra
//
// Honesty rules: strings whose pitch is an octave of another string in the
// shape can't be measured from a mono mic (see src/dsp/strings.js), so they
// are shown hollow ("inferred") rather than solid, and direction is only
// shown when the tracker is reasonably sure.

const NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];

export class StringsView {
  constructor(root) {
    this.root = root;
    root.classList.add('strings');
    root.innerHTML = `
      <div class="string-bars">${NAMES.map((n, s) => `
        <div class="sbar" data-string="${s}">
          <div class="track"><div class="fill"></div></div>
          <span class="name">${n}</span>
          <span class="sus"></span>
        </div>`).join('')}
      </div>
      <div class="strum-line"><span class="dir"></span><span class="desc">strum to see which strings ring</span></div>
      <div class="strum-fb"></div>`;
    this.bars = [...root.querySelectorAll('.sbar')];
    this.fills = this.bars.map(b => b.querySelector('.fill'));
    this.sus = this.bars.map(b => b.querySelector('.sus'));
    this.dirEl = root.querySelector('.dir');
    this.descEl = root.querySelector('.desc');
    this.fbEl = root.querySelector('.strum-fb');
    this.tracker = null;
    this.diagram = null;
    this.lastStrum = null;
    this.lastStrumAt = 0;
    this.peak = 1;
    this._raf = null;
  }

  setTracker(tracker) {
    if (this.tracker) this.tracker.onEvent = null;
    this.tracker = tracker;
    tracker.onEvent = (ev) => this._onEvent(ev);
    this.lastStrum = null;
    this._render();
  }

  setDiagram(container) { this.diagram = container; }

  start() { if (!this._raf) this._loop(); }
  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }

  _onEvent(ev) {
    if (ev.type !== 'strum') return;
    this.lastStrum = ev;
    this.lastStrumAt = performance.now();
    this._renderStrum(ev);
  }

  _loop() {
    this._render();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  _render() {
    const tr = this.tracker;
    if (!tr || !tr.h) { for (const f of this.fills) f.style.height = '0%'; return; }
    const h = tr.h;
    let mx = 0; for (let s = 0; s < 6; s++) mx = Math.max(mx, h[s]);
    this.peak = Math.max(mx, this.peak * 0.98, 1e-3);
    const now = tr.lastT ?? 0;
    for (let s = 0; s < 6; s++) {
      const bar = this.bars[s];
      const rel = Math.sqrt(Math.min(1, h[s] / this.peak));
      this.fills[s].style.height = `${Math.round(rel * 100)}%`;
      const ringing = tr.ringing[s] > 0;
      const state = !ringing ? 'silent' : tr.muted[s] ? 'wrong' : (tr.lastInferred && tr.lastInferred[s]) ? 'inferred' : 'ring';
      bar.dataset.state = state;
      bar.classList.toggle('doubled', !!tr.doubled[s]);
      this.sus[s].textContent = ringing && tr.ringSince[s] >= 0 ? `${(now - tr.ringSince[s]).toFixed(1)}s` : '';
      if (this.diagram) {
        for (const el of this.diagram.querySelectorAll(`[data-string="${s}"]`)) el.dataset.state = state;
      }
    }
    // fade the strum line after a while
    this.root.classList.toggle('stale', performance.now() - this.lastStrumAt > 4000);
  }

  _renderStrum(ev) {
    const tr = this.tracker;
    const struck = ev.strings;
    const measured = struck.filter(s => !s.inferred);
    const inferred = struck.filter(s => s.inferred);
    tr.lastInferred = new Uint8Array(6); for (const s of inferred) tr.lastInferred[s.string] = 1;
    const sure = Math.abs(ev.tau) >= 0.5 && ev.spreadMs >= 12 && ev.timed >= 2;
    const arrow = ev.direction === 'down' ? '↓' : ev.direction === 'up' ? '↑' : '·';
    this.dirEl.textContent = sure ? arrow : '·';
    this.dirEl.dataset.dir = sure ? ev.direction : 'unsure';
    const parts = [];
    parts.push(`${struck.length} string${struck.length === 1 ? '' : 's'}`);
    if (sure) parts.push(`${ev.direction}strum`);
    if (ev.spreadMs > 0 && ev.timed >= 2) parts.push(`${ev.spreadMs.toFixed(0)} ms`);
    this.descEl.textContent = parts.join(' · ');
    // feedback vs the shape
    const expected = []; for (let s = 0; s < 6; s++) if (!tr.muted[s]) expected.push(s);
    const struckSet = new Set(struck.map(s => s.string));
    const notHeard = expected.filter(s => !struckSet.has(s));
    // an octave-doubled string that wasn't heard is "can't tell", not "missing"
    const missing = notHeard.filter(s => !tr.doubled[s]);
    const unsure = notHeard.filter(s => tr.doubled[s]);
    const extra = struck.filter(s => s.muted).map(s => s.string);
    const fb = [];
    if (extra.length) fb.push(`<span class="bad">hit muted ${extra.map(s => NAMES[s]).join(', ')}</span>`);
    if (missing.length && notHeard.length < expected.length) fb.push(`<span class="warn">missing ${missing.map(s => NAMES[s]).join(', ')}</span>`);
    if (!notHeard.length && !extra.length && expected.length) fb.push(`<span class="good">all ${expected.length} strings ✓</span>`);
    else if (!missing.length && !extra.length && struck.length >= 2) fb.push(`<span class="good">${struck.length} heard ✓</span>`);
    if (inferred.length) fb.push(`<span class="dim">${inferred.map(s => NAMES[s.string]).join(', ')} inferred</span>`);
    if (unsure.length && notHeard.length < expected.length) fb.push(`<span class="dim">${unsure.map(s => NAMES[s]).join(', ')}: can't tell (octave)</span>`);
    this.fbEl.innerHTML = fb.join(' &nbsp; ');
  }
}

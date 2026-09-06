// Listen mode: free-form chord recognizer. Source is mic OR an audio file.

import { renderInto } from './diagrams.js';
import * as telemetry from './telemetry.js';

import { CONFIG } from './config.js';
// Note onsets smear the chroma for a few frames and the argmax wanders through
// unrelated chords: show a chord only once it has held (CONFIG.listen.showMs)
// and keep the last one through short gaps (gapMs) instead of flashing "—".

export class ListenMode {
  constructor({ root, allChords, getDetector, getAudioContext, getMicSource, onChord = null }) {
    this.root = root;
    this.onChord = onChord;
    this.shownId = null;
    this.allChords = allChords;
    this.getDetector = getDetector;
    this.getAudioContext = getAudioContext;
    this.getMicSource = getMicSource;

    this.bigChord  = root.querySelector('#listen-chord');
    this.subEl     = root.querySelector('#listen-sub');
    this.diagEl    = root.querySelector('#listen-diagram');
    this.fileInput = root.querySelector('#audio-file');
    this.fileName  = root.querySelector('#file-name');
    this.player    = root.querySelector('#audio-player');
    this.playBtn   = root.querySelector('#play-btn');
    this.seek      = root.querySelector('#play-seek');
    this.timeEl    = root.querySelector('#play-time');

    this.fileInput.addEventListener('change', (e) => this._loadFile(e.target.files[0]));
    this.playBtn.addEventListener('click', () => this._togglePlay());
    this.seek.addEventListener('input', () => this._seek());

    this.audioEl = null;
    this.fileSource = null;
    this.candidate = null;            // { id, since }
    this.lastSeen = 0;
  }

  enable() {
    this._wireDetector();
    if (!this.audioEl) this._useMicSource();
  }

  disable() {
    const det = this.getDetector();
    if (det) { det.onUpdate = null; det.onStable = null; }
    this._stopPlayback();
  }

  _useMicSource() {
    const det = this.getDetector();
    const mic = this.getMicSource();
    if (det && mic) det.attach(mic);
  }

  _wireDetector() {
    const det = this.getDetector();
    if (!det) return;
    det.setCandidates(null);          // free listening: every chord is a candidate
    const idToChord = new Map(this.allChords.map(c => [c.id, c]));
    det.onUpdate = (id, conf, level, ids) => {
      const now = performance.now();
      if (id) {
        if (id === this.shownId) { this.lastSeen = now; this.candidate = null; return; }
        if (!this.candidate || this.candidate.id !== id) { this.candidate = { id, since: now, ids, conf }; return; }
        if (now - this.candidate.since < CONFIG.listen.showMs) return;
        const c = idToChord.get(id);
        const twins = (ids || []).filter(x => x !== id).map(x => idToChord.get(x)?.name || x);
        this.bigChord.textContent = c ? c.name : '—';
        this.subEl.textContent = c ? (twins.length ? `${c.fullName} · same notes as ${twins.join(', ')}` : c.fullName) : '';
        renderInto(this.diagEl, c);
        this.shownId = id; this.lastSeen = now; this.candidate = null;
        if (this.onChord && c) this.onChord(c);
        telemetry.log('verdict', { id, ids, conf: +conf.toFixed(2) });
      } else {
        this.candidate = null;
        if (this.shownId && now - this.lastSeen < CONFIG.listen.gapMs) return;
        if (this.shownId) telemetry.log('verdict', { id: null });
        this.shownId = null;
        this.bigChord.textContent = '—';
        this.subEl.textContent = 'listening…';
        this.diagEl.innerHTML = '';
      }
    };
    det.onStable = null;
  }

  async _loadFile(file) {
    if (!file) return;
    this.fileName.textContent = file.name;
    if (this.audioEl) this._stopPlayback();
    const url = URL.createObjectURL(file);
    const a = new Audio(url);
    a.crossOrigin = 'anonymous';
    a.addEventListener('timeupdate', () => this._onTimeUpdate());
    a.addEventListener('ended', () => { this.playBtn.textContent = '▶'; });
    this.audioEl = a;

    const ctx = await this.getAudioContext();
    this.fileSource = ctx.createMediaElementSource(a);
    this.fileSource.connect(ctx.destination);
    const det = this.getDetector();
    if (det) det.attach(this.fileSource);

    this.player.hidden = false;
    a.play();
    this.playBtn.textContent = '⏸';
  }

  _togglePlay() {
    if (!this.audioEl) return;
    if (this.audioEl.paused) { this.audioEl.play(); this.playBtn.textContent = '⏸'; }
    else { this.audioEl.pause(); this.playBtn.textContent = '▶'; }
  }

  _seek() {
    if (!this.audioEl || !this.audioEl.duration) return;
    this.audioEl.currentTime = (this.seek.value / 1000) * this.audioEl.duration;
  }

  _onTimeUpdate() {
    const a = this.audioEl;
    if (!a || !a.duration) return;
    this.seek.value = String(Math.round((a.currentTime / a.duration) * 1000));
    const m = Math.floor(a.currentTime / 60);
    const s = Math.floor(a.currentTime % 60);
    this.timeEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  _stopPlayback() {
    if (this.audioEl) {
      try { this.audioEl.pause(); } catch {}
      this.audioEl.src = '';
      this.audioEl = null;
    }
    if (this.fileSource) {
      try { this.fileSource.disconnect(); } catch {}
      this.fileSource = null;
    }
    this.player.hidden = true;
    this.playBtn.textContent = '▶';
  }
}

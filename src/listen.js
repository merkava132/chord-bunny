// Listen mode: free-form chord recognizer. Source is mic OR an audio file.

import { renderInto } from './diagrams.js';

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
      if (id) {
        const c = idToChord.get(id);
        const twins = (ids || []).filter(x => x !== id).map(x => idToChord.get(x)?.name || x);
        this.bigChord.textContent = c ? c.name : '—';
        this.subEl.textContent = c ? (twins.length ? `${c.fullName} · same notes as ${twins.join(', ')}` : c.fullName) : '';
        if (id !== this.shownId) { renderInto(this.diagEl, c); this.shownId = id; if (this.onChord && c) this.onChord(c); }
      } else {
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

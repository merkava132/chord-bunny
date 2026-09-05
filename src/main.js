// chord-bunny entry point.
// Wires everything: load chord data, build modes, manage mic/audio context.

import * as settings from './settings.js';
import { ChordDetector } from './detect.js';
import { PracticeMode } from './practice.js';
import { ListenMode } from './listen.js';

const ALL_CHORDS = await fetch('data/chords.json').then(r => r.json());

let audioCtx = null;
let micStream = null;
let micSource = null;
let detector = null;
let practice = null;
let listen = null;

const micStatusEl = document.getElementById('mic-status');
const micLabelEl  = micStatusEl.querySelector('.label');

// ---------- chord picker UI ----------
function renderChordPicker() {
  const container = document.getElementById('chord-picker');
  container.innerHTML = '';
  const enabled = new Set(settings.get('enabledChords'));
  const groups = {};
  for (const c of ALL_CHORDS) {
    (groups[c.category] ||= []).push(c);
  }
  const groupOrder = ['basic', 'seventh', 'minor7', 'sus'];
  const groupLabel = { basic:'basic', seventh:'7th', minor7:'min7', sus:'sus' };
  for (const cat of groupOrder) {
    if (!groups[cat]) continue;
    const heading = document.createElement('div');
    heading.className = 'picker-group-label';
    heading.textContent = groupLabel[cat];
    heading.style.cssText = 'grid-column:1/-1;color:var(--fg-dim);font-size:0.75rem;margin-top:6px;text-transform:uppercase;letter-spacing:0.08em;';
    container.appendChild(heading);
    for (const c of groups[cat]) {
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = c.id;
      cb.checked = enabled.has(c.id);
      lbl.append(cb, document.createTextNode(c.name));
      if (cb.checked) lbl.classList.add('on');
      cb.addEventListener('change', () => {
        const cur = new Set(settings.get('enabledChords'));
        if (cb.checked) cur.add(c.id); else cur.delete(c.id);
        settings.set('enabledChords', [...cur]);
        lbl.classList.toggle('on', cb.checked);
      });
      container.appendChild(lbl);
    }
  }
}

document.querySelectorAll('.picker-actions button').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.pick;
    let next;
    if (action === 'basic') next = ALL_CHORDS.filter(c => c.category === 'basic').map(c => c.id);
    else if (action === 'all') next = ALL_CHORDS.map(c => c.id);
    else if (action === 'none') next = [];
    settings.set('enabledChords', next);
    renderChordPicker();
  });
});

// ---------- detection settings sliders ----------
const sensSlider = document.getElementById('sensitivity');
const minHoldInput = document.getElementById('min-hold');
sensSlider.value = settings.get('sensitivity');
minHoldInput.value = settings.get('minHoldMs');
sensSlider.addEventListener('input', () => {
  settings.set('sensitivity', Number(sensSlider.value));
  if (detector) detector.setSensitivity(0.20 + (Number(sensSlider.value) / 100) * 0.55);
});
minHoldInput.addEventListener('change', () => {
  settings.set('minHoldMs', Number(minHoldInput.value));
  if (detector) detector.setMinHold(Number(minHoldInput.value));
});

const showDiagCb = document.getElementById('show-diagrams-cb');
showDiagCb.checked = settings.get('showDiagrams');
showDiagCb.addEventListener('change', () => {
  settings.set('showDiagrams', showDiagCb.checked);
  if (practice) practice._showDiagramsToggle();
});

// ---------- mode tabs ----------
function setMode(mode) {
  settings.set('mode', mode);
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  document.querySelectorAll('.mode-pane').forEach(p => {
    p.classList.toggle('active', p.id === mode);
  });
  if (mode === 'practice') { listen?.disable(); practice?.enable(); _attachMicToDetector(); }
  else                     { practice?.disable(); listen?.enable(); }
}
document.querySelectorAll('.mode-btn').forEach(b => {
  b.addEventListener('click', () => setMode(b.dataset.mode));
});

// ---------- mic / audio context lifecycle ----------
function setMicStatus(state, label) {
  micStatusEl.classList.remove('on', 'error');
  if (state) micStatusEl.classList.add(state);
  micLabelEl.textContent = label;
}

async function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  return audioCtx;
}

async function enableMic() {
  try {
    setMicStatus(null, 'starting…');
    await ensureAudioCtx();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      }
    });
    micSource = audioCtx.createMediaStreamSource(micStream);
    if (!detector) detector = makeDetector();
    _attachMicToDetector();
    detector.start({});
    setMicStatus('on', 'mic on');
    settings.set('micEverEnabled', true);

    // re-wire active mode now that detector is live
    if (settings.get('mode') === 'practice') practice?.enable();
    else listen?.enable();
  } catch (err) {
    console.error(err);
    setMicStatus('error', 'mic blocked');
  }
}

function makeDetector() {
  const d = new ChordDetector({ audioContext: audioCtx, chords: ALL_CHORDS });
  d.setSensitivity(0.20 + (settings.get('sensitivity') / 100) * 0.55);
  d.setMinHold(settings.get('minHoldMs'));
  return d;
}

function _attachMicToDetector() {
  if (!detector || !micSource) return;
  // only attach if we're in practice mode or listen-without-file
  if (settings.get('mode') === 'practice') {
    detector.attach(micSource);
  } else if (settings.get('mode') === 'listen' && !listen?.audioEl) {
    detector.attach(micSource);
  }
}

micStatusEl.addEventListener('click', () => {
  if (!micStream) enableMic();
});

// First user gesture anywhere = enable mic if user previously had it on
function firstGestureMicAuto() {
  if (settings.get('micEverEnabled') && !micStream) enableMic();
  document.removeEventListener('click', firstGestureMicAuto);
  document.removeEventListener('keydown', firstGestureMicAuto);
}
document.addEventListener('click', firstGestureMicAuto);
document.addEventListener('keydown', firstGestureMicAuto);

// ---------- bootstrap ----------
renderChordPicker();
practice = new PracticeMode({
  root: document.getElementById('practice'),
  allChords: ALL_CHORDS,
  getEnabled: () => settings.get('enabledChords'),
  getDetector: () => detector,
});
listen = new ListenMode({
  root: document.getElementById('listen'),
  allChords: ALL_CHORDS,
  getDetector: () => detector,
  getAudioContext: ensureAudioCtx,
  getMicSource: () => micSource,
});

setMode(settings.get('mode'));

// hint update
const hintEl = document.getElementById('detection-hint');
if (!micStream) hintEl.textContent = 'click the mic chip (top right) or anywhere to enable mic';

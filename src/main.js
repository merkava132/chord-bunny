// chord-bunny entry point.
// Wires everything: load chord data, build modes, manage mic/audio context.

import * as settings from './settings.js';
import { CONFIG, applyOverrides, sensitivityFromSlider } from './config.js';
import { ChordDetector } from './detect.js';
import { PracticeMode } from './practice.js';
import { ListenMode } from './listen.js';
import { StringTracker } from './dsp/strings.js';
import { StringsView } from './strings-ui.js';
import { Recorder } from './audio/recorder.js';
import * as telemetry from './telemetry.js';

// ?cfg=detect.lam:0.4,listen.showMs:100 — experiment without editing (logged below)
const CFG_OVERRIDES = applyOverrides(new URLSearchParams(location.search).get('cfg'));

const [ALL_CHORDS, PROFILES, PROFILES_BY_STRING, USER_PROFILE] = await Promise.all([
  fetch('data/chords.json').then(r => r.json()),
  fetch('data/partials.json').then(r => r.json()).catch(() => null),
  fetch('data/partials_by_string.json').then(r => r.json()).catch(() => null),
  fetch(CONFIG.profile.path).then(r => r.ok ? r.json() : null).catch(() => null),   // personal profile, optional
]);

let audioCtx = null;
let micStream = null;
let micSource = null;
let detector = null;
let stringTracker = null;
let practice = null;
let listen = null;
let curView = null, listenView = null;   // StringsView per mode
let recorder = null;
const recStatusEl = document.getElementById('rec-status');

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
  const groupOrder = ['basic', 'barre', 'sus', 'add9', 'maj7', 'minor7', 'seventh', 'slash'];
  const groupLabel = { basic:'basic', barre:'barre', sus:'sus2 / sus4', add9:'add9', maj7:'maj7', minor7:'min7', seventh:'7th', slash:'slash (bass note)' };
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
        practice?.onEnabledChanged();
      });
      container.appendChild(lbl);
    }
  }
}

// Presets. "pop" is what strummed pop / singer-songwriter tunes lean on
// beyond plain triads; "my song" is Girls Dead Monster's My Song (Angel
// Beats!) — Am / Asus4 / Asus2 riff, C Em Am7 G F Gsus4 verse, Dsus2 and
// the Fmaj7 / Cmaj7 / Em7 tail.
const PRESETS = {
  basic: () => ALL_CHORDS.filter(c => c.category === 'basic').map(c => c.id),
  pop: () => ['C', 'G', 'D', 'A', 'E', 'Am', 'Em', 'Dm', 'F', 'Bm', 'F#m',
              'Cadd9', 'Dsus4', 'Dsus2', 'Asus2', 'Asus4', 'A7sus4',
              'Cmaj7', 'Fmaj7', 'Am7', 'Em7', 'G/B', 'D/F#', 'C/G'],
  mysong: () => ['Am', 'Asus4', 'Asus2', 'Em', 'C', 'Am7', 'G', 'F', 'Gsus4',
                 'D', 'Dsus2', 'Fsus4', 'Fmaj7', 'Cmaj7', 'Em7'],
  all: () => ALL_CHORDS.map(c => c.id),
  none: () => [],
};
document.querySelectorAll('.picker-actions button').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.pick];
    if (!preset) return;
    const known = new Set(ALL_CHORDS.map(c => c.id));
    settings.set('enabledChords', preset().filter(id => known.has(id)));
    renderChordPicker();
    practice?.onEnabledChanged();
  });
});

// ---------- detection settings sliders ----------
// slider 0–100 → confidence threshold (CONFIG.sensitivity; calibration in config.js)
const sensFromSlider = sensitivityFromSlider;
const sensSlider = document.getElementById('sensitivity');
const minHoldInput = document.getElementById('min-hold');
sensSlider.value = settings.get('sensitivity');
minHoldInput.value = settings.get('minHoldMs');
sensSlider.addEventListener('input', () => {
  settings.set('sensitivity', Number(sensSlider.value));
  if (detector) detector.setSensitivity(sensFromSlider(Number(sensSlider.value)));
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

// ---------- telemetry / recording toggle ----------
const telemetryCb = document.getElementById('telemetry-cb');
telemetryCb.checked = settings.get('telemetry') !== false;
telemetryCb.addEventListener('change', () => settings.set('telemetry', telemetryCb.checked));
settings.onChange((key, value) => {
  if (key === 'telemetry') { telemetry.setEnabled(value); if (recorder) recorder.enabled = value; recStatusEl.hidden = !value; }
  if (key !== 'micEverEnabled') telemetry.log('setting', { key, value });
});
telemetry.log('session', { session: telemetry.session, ua: navigator.userAgent, chords: ALL_CHORDS.length, settings: settings.all(), config: CONFIG, overrides: CFG_OVERRIDES,
  profile: USER_PROFILE ? { learnedAt: USER_PROFILE.learnedAt, chords: Object.keys(USER_PROFILE.chords || {}) } : null });

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
  _activateStringView(mode);
  telemetry.log('mode', { mode });
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

let micStarting = false;
async function enableMic() {
  // One click reaches both the mic chip handler and the first-gesture
  // handler; without this guard two getUserMedia calls raced and built two
  // detectors on two streams (seen in telemetry as duplicated frames and a
  // recording with every chunk written twice).
  if (micStream || micStarting) return;
  micStarting = true;
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
    if (!detector) detector = await makeDetector();
    _attachMicToDetector();
    detector.start({});
    setMicStatus('on', 'mic on');
    settings.set('micEverEnabled', true);
    telemetry.log('mic', { state: 'on', sampleRate: audioCtx.sampleRate, label: micStream.getAudioTracks()[0]?.label || '' });

    // re-wire active mode now that detector is live
    if (settings.get('mode') === 'practice') practice?.enable();
    else listen?.enable();
  } catch (err) {
    console.error(err);
    setMicStatus('error', 'mic blocked');
    telemetry.log('mic', { state: 'error', error: String(err) });
  } finally {
    micStarting = false;
  }
}

async function makeDetector() {
  const d = new ChordDetector({ audioContext: audioCtx, chords: ALL_CHORDS, profiles: PROFILES, profile: USER_PROFILE });
  d.setSensitivity(sensFromSlider(settings.get('sensitivity')));
  d.setMinHold(settings.get('minHoldMs'));
  stringTracker = new StringTracker({ sampleRate: audioCtx.sampleRate, profiles: PROFILES, profilesByString: PROFILES_BY_STRING });
  d.addConsumer({ size: stringTracker.o.fftSize, hop: stringTracker.o.hop, fn: (frame, t) => stringTracker.process(frame, t) });
  await d.init();
  _wireStringViews();
  _wireTelemetry(d);
  return d;
}

// Frame samples (~5/s while playing, ~1/s in silence), strum events, and the
// segment recorder on the raw stream. All local: see serve.py.
function _wireTelemetry(d) {
  let n = 0;
  d.onFrame = (f) => {
    n++;
    const playing = f.scores !== null;
    if (playing && f.confidence >= CONFIG.recorder.musicConf && recorder) recorder.noteMusic(f.t);
    if (playing ? n % CONFIG.telemetry.frameEvery !== 0 : n % CONFIG.telemetry.silentEvery !== 0) return;
    const ev = { ts: +f.t.toFixed(3), level: +f.level.toFixed(4), peak: +f.peak.toFixed(3), clip: +f.clip.toFixed(3) };
    if (playing) {
      const order = f.scores.map((sc, i) => i).sort((a, b) => f.scores[b] - f.scores[a]).slice(0, 3);
      ev.id = f.smoothed; ev.best = f.bestId; ev.conf = +f.confidence.toFixed(2);
      ev.top = order.map(i => [f.templates[i].id, +f.scores[i].toFixed(2)]);
      ev.chroma = Array.from(f.chroma, v => +v.toFixed(2));
    }
    telemetry.log('frame', ev);
  };
  if (stringTracker) stringTracker.onAnyEvent = (ev) => {
    if (ev.type !== 'strum') return;
    telemetry.log('strum', { ts: +ev.t.toFixed(3), strings: ev.strings, direction: ev.direction, spreadMs: +ev.spreadMs.toFixed(1), timed: ev.timed, frets: Array.from(stringTracker.frets || []) });
  };
  const recMax = Number(new URLSearchParams(location.search).get('recmax')) || 60;   // ?recmax=5 for tests
  const rec = recorder = new Recorder({ sampleRate: audioCtx.sampleRate, session: telemetry.session, maxSec: recMax, onSegment: (meta) => telemetry.log('rec', meta) });
  rec.enabled = settings.get('telemetry') !== false;
  d.capture.stream.addTap((chunk, ts) => rec.push(chunk, ts));   // bind this stream to its own recorder
  d.onRun = (run) => { if (run.dur >= 0.1) telemetry.log('run', run); };
  recStatusEl.hidden = !recorder.enabled;
  setInterval(() => recStatusEl.classList.toggle('on', recorder.recording), 250);
  addEventListener('pagehide', () => recorder.stop());
}

// The string tracker follows the target chord (practice) or the detected
// chord (listen). One tracker, one view active at a time.
let pendingVoicing = null;
function setVoicing(chord) {
  if (!chord) return;
  pendingVoicing = chord.fingering.frets;
  if (stringTracker) stringTracker.setVoicing(pendingVoicing);
}
function _wireStringViews() {
  if (!stringTracker) return;
  if (pendingVoicing) stringTracker.setVoicing(pendingVoicing);
  _activateStringView(settings.get('mode'));
}
function _activateStringView(mode) {
  if (!stringTracker) return;
  const active = mode === 'practice' ? curView : listenView;
  const other = mode === 'practice' ? listenView : curView;
  other?.stop();
  active?.setTracker(stringTracker);
  active?.start();
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
curView = new StringsView(document.getElementById('cur-strings'));
curView.setDiagram(document.getElementById('cur-diagram'));
listenView = new StringsView(document.getElementById('listen-strings'));
listenView.setDiagram(document.getElementById('listen-diagram'));

practice = new PracticeMode({
  root: document.getElementById('practice'),
  allChords: ALL_CHORDS,
  getEnabled: () => settings.get('enabledChords'),
  getDetector: () => detector,
  onCurrent: (chord) => setVoicing(chord),
});
listen = new ListenMode({
  root: document.getElementById('listen'),
  allChords: ALL_CHORDS,
  getDetector: () => detector,
  getAudioContext: ensureAudioCtx,
  getMicSource: () => micSource,
  onChord: (chord) => setVoicing(chord),
});

setMode(settings.get('mode'));

// hint update
const hintEl = document.getElementById('detection-hint');
if (!micStream) hintEl.textContent = 'click the mic chip (top right) or anywhere to enable mic';

// ---------- dev/test hooks (URL params) ----------
//   ?autostart=1        enable mic without a gesture (headless testing with a fake mic)
//   ?mode=listen        force a mode
//   ?chord=G            force the practice target chord
//   ?open=chord,detect  open settings panels (see below)
//   ?recmax=5           cap recording segments at N seconds (default 60)
//   ?open=chord,detect  open the settings panels whose summary starts with these
const params = new URLSearchParams(location.search);
if (params.get('open')) {
  const wants = params.get('open').split(',').map(s => s.trim().toLowerCase());
  document.querySelectorAll('#settings details').forEach(d => {
    const t = d.querySelector('summary')?.textContent.trim().toLowerCase() || '';
    if (wants.some(w => t.startsWith(w))) d.open = true;
  });
}
if (params.get('mode')) setMode(params.get('mode'));
if (params.get('chord')) {
  const c = ALL_CHORDS.find(x => x.id === params.get('chord'));
  if (c && practice) { practice.current = c; practice.next = ALL_CHORDS.find(x => x.id !== c.id); practice._render(practice.current, practice.next); }
}
if (params.get('autostart')) enableMic().then(() => { window.__micStartedAt = performance.now(); });
window.__cb = { get detector() { return detector; }, get tracker() { return stringTracker; }, settings };

// Real-time chord detector.
//   chroma vector (12 pitch classes, folded from FFT spectrum)
//   → cosine similarity vs binary chord templates
//   → median-of-N smoothing + RMS gate + min-hold
//
// Input-agnostic: caller builds an AudioNode (mic or file) and passes it in.

const FFT_SIZE = 8192;
const SMOOTHING_LEN = 5;       // median-of-5 raw classifications
const POLL_MS = 50;
const MIN_HZ = 70;             // below: subsonic / mic rolloff garbage
const MAX_HZ = 2000;           // above: harmonics dominate, add noise
const RMS_GATE = 0.006;        // below this RMS, treat as silence

// Build a binary template (12-vector) from a list of pitch-class names.
const PC_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const PC_ALIAS = { 'Db':'C#','Eb':'D#','Gb':'F#','Ab':'G#','Bb':'A#' };

function pcIndex(name) {
  const n = PC_ALIAS[name] ?? name;
  return PC_NAMES.indexOf(n);
}

function buildTemplate(notes) {
  const v = new Float32Array(12);
  for (const n of notes) {
    const i = pcIndex(n);
    if (i >= 0) v[i] = 1;
  }
  // L2-normalize so cosine is just a dot product
  let s = 0;
  for (let i = 0; i < 12; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < 12; i++) v[i] /= s;
  return v;
}

function buildTemplates(chords) {
  return chords.map(c => ({
    chord: c,
    template: buildTemplate(c.notes),
  }));
}

// Convert dB-scaled magnitudes to linear power.
function dbToPower(db) { return Math.pow(10, db / 10); }

// Fold spectrum to 12 chroma bins. binFreq[k] = k * sampleRate / fftSize.
// pc(freq) = ((round(69 + 12*log2(freq/440))) % 12 + 12) % 12  (0 = C).
function foldChroma(specDb, sampleRate, fftSize, out) {
  out.fill(0);
  const minBin = Math.max(1, Math.floor(MIN_HZ * fftSize / sampleRate));
  const maxBin = Math.min(specDb.length - 1, Math.ceil(MAX_HZ * fftSize / sampleRate));
  for (let k = minBin; k <= maxBin; k++) {
    const freq = k * sampleRate / fftSize;
    const midi = 69 + 12 * Math.log2(freq / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    out[pc] += dbToPower(specDb[k]);
  }
  // L1 then L2 normalize: emphasize relative shape, then unit length for cosine
  let s1 = 0;
  for (let i = 0; i < 12; i++) s1 += out[i];
  if (s1 > 0) for (let i = 0; i < 12; i++) out[i] /= s1;
  let s2 = 0;
  for (let i = 0; i < 12; i++) s2 += out[i] * out[i];
  s2 = Math.sqrt(s2) || 1;
  for (let i = 0; i < 12; i++) out[i] /= s2;
}

function rms(timeData) {
  let s = 0;
  for (let i = 0; i < timeData.length; i++) s += timeData[i] * timeData[i];
  return Math.sqrt(s / timeData.length);
}

function mode(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { best = k; bestCount = c; }
  return { value: best, count: bestCount, total: arr.length };
}

export class ChordDetector {
  constructor({ audioContext, chords }) {
    this.ctx = audioContext;
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.3;

    this.specDb   = new Float32Array(this.analyser.frequencyBinCount);
    this.timeBuf  = new Float32Array(this.analyser.fftSize);
    this.chroma   = new Float32Array(12);

    this.templates = buildTemplates(chords);
    this.history   = [];          // ring buffer of last raw classifications
    this.lastStable = null;       // last emitted "stable" chord id
    this.stableSince = 0;
    this.minHoldMs = 350;
    this.sensitivity = 0.55;      // min cosine score to trust at all

    this.timer = null;
    this.onUpdate = null;
    this.onStable = null;
    this.attached = null;
  }

  attach(sourceNode) {
    if (this.attached) try { this.attached.disconnect(this.analyser); } catch {}
    sourceNode.connect(this.analyser);
    this.attached = sourceNode;
  }

  detach() {
    if (this.attached) try { this.attached.disconnect(this.analyser); } catch {}
    this.attached = null;
    this.history.length = 0;
    this.lastStable = null;
  }

  setSensitivity(v) { this.sensitivity = v; }
  setMinHold(ms)    { this.minHoldMs = ms; }

  start({ onUpdate, onStable }) {
    this.onUpdate = onUpdate;
    this.onStable = onStable;
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _tick() {
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    const level = rms(this.timeBuf);

    if (level < RMS_GATE) {
      this._emitUpdate(null, 0, level);
      this.history.length = 0;
      this.lastStable = null;
      return;
    }

    this.analyser.getFloatFrequencyData(this.specDb);
    foldChroma(this.specDb, this.ctx.sampleRate, this.analyser.fftSize, this.chroma);

    let bestId = null, bestScore = -Infinity, secondScore = -Infinity;
    for (const { chord, template } of this.templates) {
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += this.chroma[i] * template[i];
      if (dot > bestScore) { secondScore = bestScore; bestScore = dot; bestId = chord.id; }
      else if (dot > secondScore) { secondScore = dot; }
    }

    // confidence: top score scaled, plus margin over runner-up
    const margin = Math.max(0, bestScore - secondScore);
    const confidence = Math.max(0, Math.min(1, bestScore * 0.6 + margin * 4));

    // raw classification gate: ignore if score below sensitivity
    const rawId = bestScore >= this.sensitivity ? bestId : null;

    this.history.push(rawId);
    if (this.history.length > SMOOTHING_LEN) this.history.shift();

    const m = mode(this.history);
    const smoothed = m.count >= Math.ceil(SMOOTHING_LEN * 0.6) ? m.value : null;

    this._emitUpdate(smoothed, confidence, level);

    // stable-hold tracking
    const now = performance.now();
    if (smoothed && smoothed === this.lastStable) {
      if (now - this.stableSince >= this.minHoldMs) {
        if (this.onStable) this.onStable(smoothed, confidence);
        // reset clock so we don't fire repeatedly
        this.stableSince = now + 1e9;
      }
    } else {
      this.lastStable = smoothed;
      this.stableSince = now;
    }
  }

  _emitUpdate(chordId, confidence, level) {
    if (this.onUpdate) this.onUpdate(chordId, confidence, level);
  }
}

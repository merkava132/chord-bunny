// Pitch-level analysis core. Pure JS, no DOM — shared by the browser app and
// the Node evaluation harness (tools/).
//
// One frame of audio → magnitude spectrum → non-negative least squares
// decomposition onto a dictionary of harmonic templates (one per MIDI pitch
// in guitar range) → per-pitch activation vector.
//
// Why NNLS instead of chroma: the guitar's open-position chords are full of
// octave doublings (open C has C3 *and* C4) and shared harmonics. Folding the
// spectrum to 12 pitch classes throws away exactly the information that
// separates C major from Am7 (bass note) or tells you which strings are
// sounding. Decomposing onto harmonic templates keeps it.

import { FFT, hann } from './fft.js';

export const TUNING = [40, 45, 50, 55, 59, 64];   // E2 A2 D3 G3 B3 E4 (MIDI)
export const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiName = (m) => `${PC_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

// frets: 6 ints, low E first, -1 = muted. Returns MIDI per string (or -1).
export function voicingPitches(frets) {
  return frets.map((f, s) => (f < 0 ? -1 : TUNING[s] + f));
}

export const DEFAULTS = {
  fftSize: 8192,
  minMidi: 40,        // E2
  maxMidi: 81,        // A5 — solos go above open-chord range
  minHz: 60,
  maxHz: 3200,
  partials: 10,
  alpha: 1.0,         // partial amplitude ∝ 1 / k^alpha
  inharm: 1.5e-4,     // string inharmonicity coefficient B
  compress: 1.0,      // magnitude^compress before NNLS
  iters: 30,          // coordinate-descent sweeps
  profiles: null,     // { midi: [a1, a2, ...] } learned partial amplitudes; null → 1/k^alpha
  profileSmooth: 2,   // ± semitones to average learned profiles over (log domain)
  // chroma folding: full weight up to `chromaKnee` (MIDI), then linear
  // rolloff to `chromaFloor` at maxMidi — high activations are mostly
  // harmonic residue, not played notes.
  chromaKnee: 64,
  chromaFloor: 0.25,
  sparsity: 0,        // L1 penalty on activations, as a fraction of max(Wᵀv)
  nms: 0,             // 1 → suppress a pitch if a semitone neighbour is stronger
};

export class PitchAnalyzer {
  constructor(opts) {
    const o = this.opts = { ...DEFAULTS, ...opts };
    if (!o.sampleRate) throw new Error('sampleRate required');
    const N = o.fftSize;
    this.sampleRate = o.sampleRate;
    this.fft = new FFT(N);
    this.window = hann(N);
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.kMin = Math.max(1, Math.floor(o.minHz * N / o.sampleRate));
    this.kMax = Math.min(N / 2, Math.ceil(o.maxHz * N / o.sampleRate));
    this.nBins = this.kMax - this.kMin + 1;
    this.mag = new Float32Array(this.nBins);      // compressed magnitude, bins kMin..kMax

    this.pitches = [];
    for (let m = o.minMidi; m <= o.maxMidi; m++) this.pitches.push(m);
    this.nP = this.pitches.length;
    this._buildDictionary();
    this.act = new Float32Array(this.nP);
    this.b = new Float32Array(this.nP);
  }

  pitchIndex(midi) { return midi - this.opts.minMidi; }

  // Learned partial profile for a pitch: geometric mean over neighbouring
  // pitches (±profileSmooth semitones) that have data, weighted by 1/(1+d).
  _profile(midi) {
    const P = this.opts.profiles;
    if (!P) return null;
    const K = this.opts.partials;
    const sum = new Float64Array(K), wsum = new Float64Array(K);
    for (let d = -this.opts.profileSmooth; d <= this.opts.profileSmooth; d++) {
      const p = P[midi + d];
      if (!p) continue;
      const w = 1 / (1 + Math.abs(d));
      for (let k = 0; k < K && k < p.length; k++) if (p[k] > 0) { sum[k] += w * Math.log(p[k]); wsum[k] += w; }
    }
    if (wsum[0] === 0) {
      // no data nearby: fall back to nearest pitch with data
      const keys = Object.keys(P).map(Number);
      if (!keys.length) return null;
      const near = keys.reduce((a, b) => Math.abs(b - midi) < Math.abs(a - midi) ? b : a);
      return P[near];
    }
    return Array.from(sum, (v, k) => wsum[k] ? Math.exp(v / wsum[k]) : 0);
  }

  // Sparse harmonic templates: for each pitch, a list of (bin, weight).
  // Partials are spread over ±2 bins with the Hann main-lobe shape.
  _buildDictionary() {
    const { fftSize: N, sampleRate: sr, partials, alpha, inharm } = this.opts;
    this.tplBins = [];
    this.tplW = [];
    for (const m of this.pitches) {
      const f0 = midiToHz(m);
      const acc = new Map();
      const prof = this._profile(m);
      for (let k = 1; k <= partials; k++) {
        const f = k * f0 * Math.sqrt(1 + inharm * k * k);
        if (f > this.opts.maxHz) break;
        const bc = f * N / sr;
        const a = prof ? (prof[k - 1] ?? 0) : 1 / Math.pow(k, alpha);
        if (a <= 0) continue;
        for (let bin = Math.floor(bc) - 2; bin <= Math.ceil(bc) + 2; bin++) {
          const d = Math.abs(bin - bc);
          if (d >= 2 || bin < this.kMin || bin > this.kMax) continue;
          const w = a * 0.5 * (1 + Math.cos(Math.PI * d / 2));
          acc.set(bin, (acc.get(bin) || 0) + w);
        }
      }
      const bins = Int32Array.from(acc.keys());
      const ws = Float32Array.from(acc.values());
      let n2 = 0; for (const w of ws) n2 += w * w;
      n2 = Math.sqrt(n2) || 1;
      for (let i = 0; i < ws.length; i++) ws[i] /= n2;
      this.tplBins.push(bins);
      this.tplW.push(ws);
    }
    // Gram matrix G = WᵀW (dense, nP×nP), computed via sparse overlap
    const nP = this.nP;
    this.G = new Float32Array(nP * nP);
    const dense = new Float32Array(this.kMax + 1);
    for (let i = 0; i < nP; i++) {
      dense.fill(0);
      for (let t = 0; t < this.tplBins[i].length; t++) dense[this.tplBins[i][t]] = this.tplW[i][t];
      for (let j = i; j < nP; j++) {
        let s = 0;
        const bj = this.tplBins[j], wj = this.tplW[j];
        for (let t = 0; t < bj.length; t++) s += dense[bj[t]] * wj[t];
        this.G[i * nP + j] = s;
        this.G[j * nP + i] = s;
      }
    }
  }

  // Compute the compressed magnitude spectrum of a frame (length fftSize).
  spectrum(frame) {
    const N = this.opts.fftSize, w = this.window, re = this.re, im = this.im;
    for (let i = 0; i < N; i++) re[i] = frame[i] * w[i];
    im.fill(0);
    this.fft.transform(re, im);
    const c = this.opts.compress;
    for (let k = this.kMin; k <= this.kMax; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      this.mag[k - this.kMin] = Math.pow(p, c * 0.5);
    }
    return this.mag;
  }

  // NNLS via coordinate descent on ½‖v − W h‖². Warm-started from the
  // previous frame's activations (out) when provided.
  solve(mag, out, iters = this.opts.iters) {
    const nP = this.nP, G = this.G, b = this.b;
    for (let j = 0; j < nP; j++) {
      const bins = this.tplBins[j], ws = this.tplW[j];
      let s = 0;
      for (let t = 0; t < bins.length; t++) s += mag[bins[t] - this.kMin] * ws[t];
      b[j] = s;
    }
    const h = out || new Float32Array(nP);
    let lam = 0;
    if (this.opts.sparsity > 0) { let mb = 0; for (let j = 0; j < nP; j++) mb = Math.max(mb, b[j]); lam = this.opts.sparsity * mb; }
    for (let it = 0; it < iters; it++) {
      let delta = 0;
      for (let j = 0; j < nP; j++) {
        const gjj = G[j * nP + j];
        if (gjj <= 0) continue;
        let s = 0;
        const row = j * nP;
        for (let k = 0; k < nP; k++) s += G[row + k] * h[k];
        const nv = Math.max(0, h[j] + (b[j] - s - lam) / gjj);
        delta += Math.abs(nv - h[j]);
        h[j] = nv;
      }
      if (delta < 1e-6) break;
    }
    if (this.opts.nms) {
      // non-maximum suppression across semitone neighbours: a peak split
      // between adjacent templates collapses onto the stronger one
      const tmp = this._nmsTmp || (this._nmsTmp = new Float32Array(nP));
      tmp.set(h);
      for (let j = 0; j < nP; j++) {
        const l = j > 0 ? tmp[j - 1] : 0, r = j < nP - 1 ? tmp[j + 1] : 0;
        if (tmp[j] < l || tmp[j] < r) { h[j] = 0; }
        else h[j] = tmp[j] + (l < tmp[j] ? l : 0) + (r < tmp[j] ? r : 0);  // fold neighbours' mass in
      }
    }
    return h;
  }

  // NNLS restricted to a subset of pitch templates (e.g. one chord voicing).
  // `idx` = template indices; returns { h: Float32Array(idx.length), explained }
  // where explained = 1 − ‖v − W_s h‖² / ‖v‖²  (fraction of spectral energy
  // the voicing accounts for). Uses this.b (must be current for `mag`).
  solveSubset(mag, idx, out, iters = this.opts.iters) {
    const n = idx.length, nP = this.nP, G = this.G, b = this.b;
    const h = out || new Float32Array(n);
    for (let it = 0; it < iters; it++) {
      let delta = 0;
      for (let a = 0; a < n; a++) {
        const j = idx[a], gjj = G[j * nP + j];
        if (gjj <= 0) continue;
        let s = 0;
        for (let c = 0; c < n; c++) s += G[j * nP + idx[c]] * h[c];
        const nv = Math.max(0, h[a] + (b[j] - s) / gjj);
        delta += Math.abs(nv - h[a]);
        h[a] = nv;
      }
      if (delta < 1e-6) break;
    }
    // residual: ‖v‖² − 2 hᵀb + hᵀGh
    let vv = 0; for (let k = 0; k < mag.length; k++) vv += mag[k] * mag[k];
    let hb = 0, hGh = 0;
    for (let a = 0; a < n; a++) {
      hb += h[a] * b[idx[a]];
      for (let c = 0; c < n; c++) hGh += h[a] * G[idx[a] * nP + idx[c]] * h[c];
    }
    const resid = Math.max(0, vv - 2 * hb + hGh);
    return { h, explained: vv > 0 ? 1 - resid / vv : 0 };
  }

  // Compute this.b = Wᵀ mag (needed before solveSubset if solve() wasn't called).
  project(mag) {
    for (let j = 0; j < this.nP; j++) {
      const bins = this.tplBins[j], ws = this.tplW[j];
      let s = 0;
      for (let t = 0; t < bins.length; t++) s += mag[bins[t] - this.kMin] * ws[t];
      this.b[j] = s;
    }
    return this.b;
  }

  // Convenience: frame → activations (reuses this.act; copy if you keep it).
  analyze(frame) {
    this.spectrum(frame);
    return this.solve(this.mag, this.act);
  }

  // Fold activations to 12 pitch classes (L1-normalised), octave-weighted.
  chroma(act, out = new Float32Array(12)) {
    if (!this.chromaW) {
      const { chromaKnee: knee, chromaFloor: floor, maxMidi } = this.opts;
      this.chromaW = Float32Array.from(this.pitches, m => m <= knee ? 1 : Math.max(floor, 1 - (1 - floor) * (m - knee) / Math.max(1, maxMidi - knee)));
    }
    out.fill(0);
    let s = 0;
    for (let i = 0; i < this.nP; i++) { const v = act[i] * this.chromaW[i]; out[this.pitches[i] % 12] += v; s += v; }
    if (s > 0) for (let i = 0; i < 12; i++) out[i] /= s;
    return out;
  }
}

export function rms(x, start = 0, end = x.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

// Iterate frames of `size` with `hop` over a sample buffer. Yields
// { index, start, frame } with frame a view (zero-padded copy at the tail).
export function* frames(samples, size, hop) {
  const pad = new Float32Array(size);
  for (let start = 0, i = 0; start < samples.length; start += hop, i++) {
    if (start + size <= samples.length) {
      yield { index: i, start, frame: samples.subarray(start, start + size) };
    } else {
      pad.fill(0);
      pad.set(samples.subarray(start));
      yield { index: i, start, frame: pad };
    }
  }
}

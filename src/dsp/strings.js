// Per-string tracking for a known (hypothesised) chord voicing.
//
// Given the shape the player is supposed to be holding, each string has one
// expected pitch. A short-window analyzer with exactly six templates (one per
// string, using per-string learned partial profiles) plus a flat noise basis
// gives a per-string activation every hop (~6 ms). On top of that:
//   - spectral-flux onset detection (strums / plucks)
//   - per-strum string set, per-string onset times → strum direction
//   - per-string sustain tracking (how long each string keeps ringing)
//
// Muted strings in the shape ("x") are tracked at their OPEN pitch so that an
// accidentally-hit string shows up as an error rather than vanishing.
//
// Known limit: two strings an octave apart (open G3 vs G4 in a G chord) are
// spectrally nested — the upper string's partials are a subset of the lower
// one's. Pluck-to-pluck variation of partial amplitudes (σ ≈ 1 in log domain,
// measured on GuitarSet) swamps the difference, so such strings cannot be
// separated reliably from a mono mic. They are reported as `inferred` from
// strum contiguity rather than measured.

import { PitchAnalyzer, TUNING, rms, midiToHz } from './analyzer.js';
import { FFT, hann } from './fft.js';

export const STRING_DEFAULTS = {
  fftSize: 4096,
  hop: 256,
  onsetThresh: 1.6,     // spectral flux must exceed local median × this
  onsetMinGapMs: 60,    // refractory period between onsets
  onsetWindowMs: 100,   // look-ahead after an onset for per-string rises
  timing: 'slope',      // 'slope' = time of steepest rise (amplitude-independent); 'cross' = riseFrac crossing
  riseFrac: 0.5,        // 'cross' mode: onset = when activation reaches base + this × rise
  riseMin: 0.10,        // struck only if its peak ≥ this × strongest string's peak
  riseOver: 0.30,       // …and peak − pre-onset level ≥ this × peak (re-strikes of ringing strings count)
  sustainMin: 0.30,     // …and its late-window mean ≥ this × its own peak (survives the transient)
  sustainFrac: 0.12,    // string "still ringing" while activation > this × its peak
  presentFrac: 0.06,    // per-frame presence: activation > this × Σ string activations
  presentAbs: 0.4,      // …and above this absolute level (template-normalised units)
  f0Support: 0.25,      // string is a ghost if its fundamental bin carries < this × what its activation predicts
  fluxLog: 0,           // 1 → spectral flux on log-compressed magnitudes (noise-dominated in practice; off)
  onsetLookahead: 3,    // frames: onset must be a local flux maximum over ±this many frames
  contiguity: 1,        // fill strums to a contiguous string range (inferred strings)
  // A string that is muted in the shape counts as struck only if its open-pitch
  // fundamental actually stands out of an f0CheckN-point spectrum of the
  // f0CheckN/sr seconds after the onset (peak over ±1 bin ≥ mutedF0Prom × the
  // mean of the ±6 neighbouring bins). The tracker's own 4096-point frames
  // cannot see this: E2 (82 Hz) and A2 (110 Hz) are 2.4 bins apart and the
  // E2 template's learned profile puts 2.2× more weight on its 2nd partial
  // than on the fundamental, so a chord's E3/E4 partials alone make "low E
  // struck" — 63% of C strums and 66% of Am strums in the 2026-09-24 session,
  // hence the false "you're hitting the low E" hints. Applied to muted
  // strings only: on a rig with no 82 Hz (the player's mic-jack input — their
  // open-E calibration pluck has its fundamental 23 dB under its 4th partial
  // and below the noise floor) a played low E would otherwise never light up.
  // At 3 (tools/eval_ghosts.mjs): player's session, string-0 strikes on
  // C/Am/D 613 → 32, on Em/G unchanged (487); GuitarSet open subset, string-0
  // ghosts (reported while the string is silent) 303 → 196, true strikes
  // unchanged (306), per-frame F1 unchanged (77.0%), strum recall 82.6 →
  // 82.2% (strums whose only "strings" were ghosts no longer emit). 0 = off.
  mutedF0Prom: 3,
  f0CheckN: 8192,
};

// Prominence of a spectral line: max magnitude over bins [b−near, b+near] over
// the mean of bins within ±far excluding those. mag is indexed from bin kMin.
export function lineProminence(mag, kMin, b, { near = 1, far = 6 } = {}) {
  let peak = 0, floor = 0, n = 0;
  for (let k = b - far; k <= b + far; k++) {
    const i = k - kMin; if (i < 0 || i >= mag.length) continue;
    if (Math.abs(k - b) <= near) peak = Math.max(peak, mag[i]); else { floor += mag[i]; n++; }
  }
  return n ? peak / (floor / n + 1e-12) : 0;
}

export class StringTracker {
  constructor({ sampleRate, profiles = null, profilesByString = null, ...opts }) {
    this.o = { ...STRING_DEFAULTS, ...opts };
    this.sampleRate = sampleRate;
    this.profiles = profiles;
    this.profilesByString = profilesByString;
    this.pitches = new Int32Array(6);
    this.muted = new Uint8Array(6);
    this.doubled = new Uint8Array(6);   // shares a pitch class ± octaves with another string
    this.h = null;
    this.prevMag = null;
    this.flux = [];
    this.frameIndex = 0;
    this.lastOnsetFrame = -1e9;
    this.pending = null;
    this.history = [];
    // strums resolve onsetWindowMs after the onset (a later onset replaces a
    // pending one, so this must not grow: at 24 frames the player's session
    // lost 25% of its strums on played shapes)
    this.resolveFrames = Math.ceil((this.o.onsetWindowMs / 1000 * sampleRate) / this.o.hop);
    this.historyLen = this.resolveFrames + 12;
    // raw sample ring (absolute sample index = frameIndex × hop … + fftSize) for the fundamental check
    this.rawLen = 2 * this.o.f0CheckN + this.o.fftSize;
    this.raw = new Float32Array(this.rawLen);
    this.rawEnd = 0;
    this.f0fft = null; this.f0win = null; this.f0re = null; this.f0im = null;
    this.ringing = new Float32Array(6);
    this.ringSince = new Float64Array(6).fill(-1);
    this.onEvent = null;
    this.lastT = 0;
    this.lastInferred = null;
    this.setVoicing([0, 0, 0, 0, 0, 0]);
  }

  hopSeconds() { return this.o.hop / this.sampleRate; }

  // frets: 6 ints (low E first), -1 = muted.
  setVoicing(frets) {
    for (let s = 0; s < 6; s++) {
      const f = frets[s];
      this.muted[s] = f < 0 ? 1 : 0;
      this.pitches[s] = TUNING[s] + Math.max(0, f);
    }
    for (let s = 0; s < 6; s++) {
      this.doubled[s] = 0;
      for (let u = 0; u < 6; u++) if (u !== s && !this.muted[u] && !this.muted[s] && (this.pitches[s] - this.pitches[u]) % 12 === 0) this.doubled[s] = 1;
    }
    const pb = this.profilesByString, pp = this.profiles;
    this.an = new PitchAnalyzer({
      sampleRate: this.sampleRate, fftSize: this.o.fftSize, partials: 8,
      pitchList: Array.from(this.pitches), noiseBasis: true,
      profiles: pp,
      profileFor: (midi, i) => (pb && pb[`${i}:${midi}`]) || null,
    });
    this.frets = Array.from(frets);
    this.h = new Float32Array(this.an.nP);
    // fundamental bin (fractional) and template weight at that bin, per string
    const N = this.o.fftSize, sr = this.sampleRate;
    this.f0Bin = new Int32Array(6); this.f0W = new Float32Array(6);
    for (let s = 0; s < 6; s++) {
      const bc = Math.round(440 * Math.pow(2, (this.pitches[s] - 69) / 12) * N / sr);
      this.f0Bin[s] = bc;
      const bins = this.an.tplBins[s], ws = this.an.tplW[s];
      for (let i = 0; i < bins.length; i++) if (bins[i] === bc) this.f0W[s] = ws[i];
    }
    this.support = new Float32Array(6);
    this.ringing.fill(0);
    this.ringSince.fill(-1);
    this.pending = null;
  }

  // Feed one frame of fftSize samples whose centre is at time `t` (seconds).
  process(frame, t) {
    const an = this.an;
    // ring: frames are contiguous with hop `hop`; the first frame is written whole, then the new tail of each
    { const N = frame.length, HOP = this.o.hop, fresh = this.rawEnd === 0 ? N : HOP, from = N - fresh;
      for (let i = from; i < N; i++) this.raw[(this.rawEnd + i - from) % this.rawLen] = frame[i];
      this.rawEnd += fresh; }
    const mag = an.spectrum(frame);
    let flux = 0;
    if (!this.prevMag) this.prevMag = new Float32Array(mag.length);
    if (this.o.fluxLog) {
      for (let k = 0; k < mag.length; k++) { const v = Math.log1p(mag[k] * 20); const d = v - this.prevMag[k]; if (d > 0) flux += d; this.prevMag[k] = v; }
    } else {
      for (let k = 0; k < mag.length; k++) { const d = mag[k] - this.prevMag[k]; if (d > 0) flux += d; }
      this.prevMag.set(mag);
    }
    const hAll = an.solve(mag, this.h, 20);
    const h = hAll.subarray(0, 6);
    const noise = hAll[an.noiseIndex];
    // fundamental support: observed magnitude near f0 vs what the activation predicts
    for (let s = 0; s < 6; s++) {
      const b = this.f0Bin[s]; let obs = 0;
      for (let k = b - 1; k <= b + 1; k++) if (k >= an.kMin && k <= an.kMax) obs = Math.max(obs, mag[k - an.kMin]);
      const expct = h[s] * this.f0W[s];
      this.support[s] = expct > 0 ? Math.min(1, obs / expct) : 0;
      if (this.support[s] < this.o.f0Support) h[s] *= this.support[s] / this.o.f0Support;   // soft-suppress ghosts
    }
    const level = rms(frame);
    const state = { t, h: Float32Array.from(h), noise, level, flux, index: this.frameIndex };
    this.history.push(state);
    if (this.history.length > this.historyLen) this.history.shift();

    // ---- onset detection: local flux maximum above adaptive threshold ----
    // Decided with `onsetLookahead` frames of delay so we can confirm a peak.
    this.flux.push(flux); if (this.flux.length > 48) this.flux.shift();
    let onset = false;
    const L = this.o.onsetLookahead, F = this.flux, n = F.length;
    if (n >= 2 * L + 8) {
      const c = n - 1 - L;                        // candidate index (L frames ago)
      let isMax = true;
      for (let i = c - L; i <= c + L; i++) if (i !== c && F[i] > F[c]) { isMax = false; break; }
      if (isMax) {
        const hist = F.slice(0, c);
        const sorted = [...hist].sort((a, b) => a - b);
        const med = sorted[sorted.length >> 1], mean = hist.reduce((a, b) => a + b, 0) / hist.length;
        const thr = Math.max(med * this.o.onsetThresh, mean * 1.05, 1e-6);
        const candFrame = this.frameIndex - L;
        const gapMs = (candFrame - this.lastOnsetFrame) * this.hopSeconds() * 1000;
        if (F[c] > thr && gapMs >= this.o.onsetMinGapMs) {
          onset = true;
          this.lastOnsetFrame = candFrame;
          this.pending = { frame: candFrame, t: t - L * this.hopSeconds() };
        }
      }
    }

    // ---- per-string sustain bookkeeping ----
    for (let s = 0; s < 6; s++) {
      if (this.ringing[s] > 0) {
        if (h[s] > this.ringing[s]) this.ringing[s] = h[s];
        else if (h[s] < this.o.sustainFrac * this.ringing[s]) {
          this._emit({ type: 'note-off', string: s, t, duration: t - this.ringSince[s] });
          this.ringing[s] = 0; this.ringSince[s] = -1;
        }
      }
    }

    if (this.pending && this.frameIndex - this.pending.frame >= this.resolveFrames) {
      this._resolveStrum(this.pending);
      this.pending = null;
    }
    this.frameIndex++;
    this.lastT = t;
    return { t, h, noise, level, flux, onset, present: this.present(h) };
  }

  _resolveStrum(p) {
    const hopS = this.hopSeconds();
    const pre = 4;
    const winLen = Math.round(this.o.onsetWindowMs / 1000 / hopS);
    const win = this.history.filter(s => s.index >= p.frame - pre && s.index <= p.frame + winLen);
    if (win.length < 6) return;
    const base = new Float32Array(6), peak = new Float32Array(6), late = new Float32Array(6);
    let lateN = 0, baseN = 0;
    for (const st of win) {
      const isLate = st.index >= p.frame + Math.round(winLen * 0.6);
      if (isLate) lateN++;
      if (st.index < p.frame) baseN++;
      for (let s = 0; s < 6; s++) {
        if (st.index < p.frame) base[s] += st.h[s];          // mean level just before the onset
        peak[s] = Math.max(peak[s], st.h[s]);
        if (isLate) late[s] += st.h[s];
      }
    }
    if (baseN) for (let s = 0; s < 6; s++) base[s] /= baseN;
    let gmax = 0; for (let s = 0; s < 6; s++) gmax = Math.max(gmax, peak[s]);
    if (gmax <= 0 || !lateN) return;
    const struck = [];
    for (let s = 0; s < 6; s++) {
      const rise = peak[s] - base[s];
      const sustained = late[s] / lateN;
      const evidence = peak[s] >= this.o.riseMin * gmax && rise >= this.o.riseOver * peak[s] && sustained >= this.o.sustainMin * peak[s];
      if (!evidence) continue;
      let tOn = null;
      if (this.o.timing === 'slope') {
        // time of steepest rise (3-point smoothed derivative), parabolic sub-hop refinement
        let bi = -1, bd = 0;
        const d = new Float32Array(win.length);
        for (let i = 1; i < win.length - 1; i++) d[i] = (win[i + 1].h[s] - win[i - 1].h[s]) * 0.5;
        for (let i = 2; i < win.length - 2; i++) { const v = (d[i - 1] + d[i] + d[i + 1]) / 3; if (v > bd && win[i].index >= p.frame - 3) { bd = v; bi = i; } }
        if (bi > 0) {
          const a = d[bi - 1], b = d[bi], c = d[bi + 1], den = a - 2 * b + c;
          const off = den !== 0 ? Math.max(-1, Math.min(1, 0.5 * (a - c) / den)) : 0;
          tOn = win[bi].t + off * hopS;
        }
      } else {
        const target = base[s] + this.o.riseFrac * rise;
        for (let i = 0; i < win.length; i++) {
          const st = win[i];
          if (st.index < p.frame - 2 || st.h[s] < target) continue;
          const prev = win[i - 1];
          if (prev && st.h[s] > prev.h[s]) { const f = (target - prev.h[s]) / (st.h[s] - prev.h[s]); tOn = prev.t + Math.max(0, Math.min(1, f)) * (st.t - prev.t); }
          else tOn = st.t;
          break;
        }
      }
      if (tOn == null) continue;
      let f0 = null;
      if (this.muted[s] && this.o.mutedF0Prom > 0) {
        f0 = this._f0Prominence(p, s);
        if (f0 < this.o.mutedF0Prom) continue;   // no vibration at the open pitch: the chord's upper partials, not this string
      }
      struck.push({ string: s, t: tOn, peak: peak[s], muted: !!this.muted[s], doubled: !!this.doubled[s], pitch: this.pitches[s], inferred: false, ...(f0 !== null ? { f0: +f0.toFixed(2) } : {}) });
    }
    if (!struck.length) return;
    // contiguity: a strum sweeps a contiguous range of strings; fill gaps as inferred
    if (this.o.contiguity && struck.length >= 2) {
      const lo = Math.min(...struck.map(s => s.string)), hi = Math.max(...struck.map(s => s.string));
      for (let s = lo + 1; s < hi; s++) if (!struck.some(x => x.string === s)) {
        struck.push({ string: s, t: null, peak: peak[s], muted: !!this.muted[s], doubled: !!this.doubled[s], pitch: this.pitches[s], inferred: true });
      }
      struck.sort((a, b) => a.string - b.string);
    }
    for (const s of struck) { this.ringing[s.string] = Math.max(peak[s.string], 1e-3); this.ringSince[s.string] = s.t ?? p.t; }
    // direction: Kendall's tau between string index and onset time over the
    // reliably-timed strings (unique pitch, not muted-in-shape); outliers more
    // than 40 ms from the median onset are transients, not strings.
    let timed = struck.filter(s => s.t != null);
    if (timed.length >= 3) {
      const med = [...timed.map(s => s.t)].sort((a, b) => a - b)[timed.length >> 1];
      timed = timed.filter(s => Math.abs(s.t - med) <= 0.04);
    }
    const reliable = timed.filter(s => !s.doubled && !s.muted);
    if (reliable.length >= 2) timed = reliable;
    let dir = 'single', slope = 0, spread = 0, tau = 0;
    if (timed.length >= 2) {
      let conc = 0, disc = 0;
      for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
        const ds = Math.sign(timed[j].string - timed[i].string), dt = Math.sign(timed[j].t - timed[i].t);
        if (ds * dt > 0) conc++; else if (ds * dt < 0) disc++;
      }
      tau = (conc + disc) ? (conc - disc) / (conc + disc) : 0;
      const ts = timed.map(s => s.t); spread = Math.max(...ts) - Math.min(...ts);
      const n = timed.length, mx = timed.reduce((a, b) => a + b.string, 0) / n, mt = timed.reduce((a, b) => a + b.t, 0) / n;
      let num = 0, den = 0; for (const s of timed) { num += (s.string - mx) * (s.t - mt); den += (s.string - mx) ** 2; }
      slope = den > 0 ? num / den : 0;
      dir = spread < 0.8 * hopS ? 'flat' : tau > 0 ? 'down' : tau < 0 ? 'up' : (slope > 0 ? 'down' : 'up');
    }
    this._emit({ type: 'strum', t: p.t, strings: struck, direction: dir, tau, slopeMs: slope * 1000, spreadMs: spread * 1000, timed: timed.length });
  }

  _emit(ev) { if (this.onEvent) this.onEvent(ev); if (this.onAnyEvent) this.onAnyEvent(ev); }

  // Fundamental prominence (lineProminence) of string s at its voicing pitch in
  // the last f0CheckN samples at resolution time — about 30 ms before the
  // onset frame's centre to 145 ms after it, so the strum's own ring
  // dominates. The spectrum is computed once per strum.
  _f0Prominence(p, s) {
    const N = this.o.f0CheckN, sr = this.sampleRate;
    if (!this.f0fft) { this.f0fft = new FFT(N); this.f0win = hann(N); this.f0re = new Float32Array(N); this.f0im = new Float32Array(N); this.f0mag = new Float32Array(N / 2); }
    if (this.f0For !== p) {
      const start = this.rawEnd - N;
      if (start < 0) { this.f0For = p; this.f0ok = false; return Infinity; }   // not enough audio yet: don't veto
      const re = this.f0re, im = this.f0im, w = this.f0win;
      for (let i = 0; i < N; i++) re[i] = this.raw[(start + i) % this.rawLen] * w[i];
      im.fill(0); this.f0fft.transform(re, im);
      for (let k = 0; k < N / 2; k++) this.f0mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      this.f0For = p; this.f0ok = true;
    }
    if (!this.f0ok) return Infinity;
    return lineProminence(this.f0mag, 0, Math.round(midiToHz(this.pitches[s]) * N / sr));
  }

  // Per-frame presence decision.
  present(h) {
    let sum = 0; for (let s = 0; s < 6; s++) sum += h[s];
    const out = new Uint8Array(6);
    for (let s = 0; s < 6; s++) out[s] = (h[s] > this.o.presentFrac * sum && h[s] > this.o.presentAbs) ? 1 : 0;
    return out;
  }
}

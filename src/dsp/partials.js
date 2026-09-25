// Partial-amplitude profiles: measuring them from a pluck, fitting a
// frequency response that explains how this player's mic + guitar differ
// from the GuitarSet profiles (data/partials.json), and applying it.
//
// A profile is [a1, a2, …, aK]: partial amplitudes relative to the
// fundamental (a1 = 1), partial k at k·f0·√(1 + B·k²) (string
// inharmonicity B). The analyzer builds its harmonic dictionary from them,
// so a profile learned on GuitarSet's room mic is only right for this
// player's setup up to a frequency response — which the six open-string
// plucks of the calibration measure (tools/learn_response.mjs).

import { midiToHz } from './analyzer.js';

export const INHARM = 1.5e-4;      // same B as PitchAnalyzer DEFAULTS.inharm
export const MAX_HZ = 3200;
export const OPEN_MIDI = [40, 45, 50, 55, 59, 64];   // string 0 (low E) … 5 (high e)

export const partialHz = (f0, k, inharm = INHARM) => k * f0 * Math.sqrt(1 + inharm * k * k);

// Partial amplitudes from a magnitude spectrum (bins 0..N/2 of an N-point
// FFT at sampleRate). Peak-picks within ±2 bins of each expected partial;
// snr[k] is the peak over the median magnitude of the surrounding ±30 bins
// (a partial that is not there still gets a "peak" — the noise floor).
export function measurePartials(mag, { sampleRate, fftSize, f0, partials = 10, inharm = INHARM, maxHz = MAX_HZ }) {
  const amps = [], snr = [], hz = [];
  for (let k = 1; k <= partials; k++) {
    const f = partialHz(f0, k, inharm);
    if (f > maxHz) break;
    const bc = f * fftSize / sampleRate, lo = Math.max(1, Math.floor(bc) - 2), hi = Math.min(mag.length - 1, Math.ceil(bc) + 2);
    let peak = 0, pb = lo;
    for (let b = lo; b <= hi; b++) if (mag[b] > peak) { peak = mag[b]; pb = b; }
    // parabolic interpolation on log magnitude: Hann scalloping loss is up to 15% between bin centres
    if (pb > 0 && pb < mag.length - 1 && mag[pb - 1] > 0 && mag[pb + 1] > 0) {
      const a = Math.log(mag[pb - 1]), b = Math.log(mag[pb]), c = Math.log(mag[pb + 1]), den = a - 2 * b + c;
      if (den < 0) { const d = 0.5 * (a - c) / den; if (Math.abs(d) <= 1) peak = Math.exp(b - 0.25 * (a - c) * d); }
    }
    const around = [];
    for (let b = Math.max(1, pb - 30); b <= Math.min(mag.length - 1, pb + 30); b++) if (Math.abs(b - pb) > 3) around.push(mag[b]);
    around.sort((a, b) => a - b);
    const floor = around.length ? around[around.length >> 1] : 0;
    amps.push(peak); snr.push(floor > 0 ? peak / floor : (peak > 0 ? Infinity : 0)); hz.push(f);
  }
  const a1 = amps[0] || 1;
  return { amps: amps.map(a => a / a1), snr, hz };
}

// Linear-interpolation weights of frequency f over log-spaced knots.
function knotWeights(knots, f) {
  const x = Math.log(f), w = new Float64Array(knots.length);
  if (x <= Math.log(knots[0])) { w[0] = 1; return w; }
  if (x >= Math.log(knots[knots.length - 1])) { w[knots.length - 1] = 1; return w; }
  for (let i = 0; i < knots.length - 1; i++) {
    const a = Math.log(knots[i]), b = Math.log(knots[i + 1]);
    if (x >= a && x <= b) { const t = (x - a) / (b - a); w[i] = 1 - t; w[i + 1] = t; return w; }
  }
  return w;
}

export function interpGain(response, f) {
  if (!response?.hz?.length) return 1;
  const w = knotWeights(response.hz, f);
  let g = 0; for (let i = 0; i < w.length; i++) if (w[i]) g += w[i] * Math.log(response.gain[i]);
  return Math.exp(g);
}

export const DEFAULT_KNOTS = [60, 90, 135, 200, 300, 450, 675, 1000, 1500, 2250, 3400];

// Fit a smooth gain curve G(f) such that measured_k / base_k ≈ G(f_k) / G(f_1)
// for every string and partial (the per-string level is unknown, so only
// ratios to the fundamental carry information). Least squares over log G at
// the knots with a second-difference smoothness penalty and a small ridge
// toward 0 dB (which also pins the unobservable constant). measured / base:
// { midi: amps[] }; snr (optional): { midi: snr[] } — partials under minSnr
// are skipped, those under goodSnr down-weighted.
export function fitResponse(measured, base, { knots = DEFAULT_KNOTS, smooth = 2.0, ridge = 0.02, minSnr = 1.5, goodSnr = 4, snr = null, inharm = INHARM } = {}) {
  const J = knots.length, rows = [];
  for (const key of Object.keys(measured)) {
    const m = Number(key); if (!Number.isFinite(m)) continue;
    const u = measured[key], g = base[m] || base[String(m)];
    if (!u || !g) continue;
    const f0 = midiToHz(m), w1 = knotWeights(knots, partialHz(f0, 1, inharm));
    for (let k = 2; k <= Math.min(u.length, g.length); k++) {
      if (!(u[k - 1] > 0) || !(g[k - 1] > 0)) continue;
      const s = snr?.[key] ? Math.min(snr[key][k - 1], snr[key][0]) : undefined; let wt = 1;   // the ratio needs both partials
      if (s !== undefined) { if (s < minSnr) continue; if (s < goodSnr) wt = 0.3; }
      const wk = knotWeights(knots, partialHz(f0, k, inharm));
      const row = new Float64Array(J); for (let j = 0; j < J; j++) row[j] = wk[j] - w1[j];
      rows.push({ row, y: Math.log(u[k - 1] / g[k - 1]), wt });
    }
  }
  // normal equations: (AᵀWA + smooth·DᵀD + ridge·I) x = AᵀWy
  const M = Array.from({ length: J }, () => new Float64Array(J)), rhs = new Float64Array(J);
  for (const { row, y, wt } of rows) for (let i = 0; i < J; i++) if (row[i]) { rhs[i] += wt * row[i] * y; for (let j = 0; j < J; j++) if (row[j]) M[i][j] += wt * row[i] * row[j]; }
  for (let i = 1; i < J - 1; i++) { const d = [[i - 1, 1], [i, -2], [i + 1, 1]]; for (const [a, va] of d) for (const [b, vb] of d) M[a][b] += smooth * va * vb; }
  for (let i = 0; i < J; i++) M[i][i] += ridge;
  const x = solve(M, rhs);
  const mean = x.reduce((s, v) => s + v, 0) / J;
  const gain = Array.from(x, v => +Math.exp(v - mean).toFixed(4));
  let res = 0; for (const { row, y } of rows) { let p = 0; for (let j = 0; j < J; j++) p += row[j] * x[j]; res += (y - p) ** 2; }
  return { hz: knots, gain, n: rows.length, rmsLogResidual: rows.length ? +Math.sqrt(res / rows.length).toFixed(3) : null };
}

function solve(M, b) {   // Gaussian elimination with partial pivoting (small dense system)
  const n = b.length, A = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / d; if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return Float64Array.from(A, (r, i) => r[n] / (r[i] || 1e-12));
}

// A profile table with G applied: a_k → a_k · G(f_k) / G(f_1). midiOf maps a
// table key to its MIDI pitch ("48" → 48; "1:52" → 52 for the by-string table).
export function applyResponse(table, response, midiOf = (k) => Number(k), inharm = INHARM) {
  const out = {};
  for (const key of Object.keys(table)) {
    const m = midiOf(key), a = table[key];
    if (!Number.isFinite(m) || !Array.isArray(a)) { out[key] = a; continue; }
    const f0 = midiToHz(m), g1 = interpGain(response, partialHz(f0, 1, inharm));
    out[key] = a.map((v, i) => +(v * interpGain(response, partialHz(f0, i + 1, inharm)) / g1).toFixed(4));
  }
  return out;
}

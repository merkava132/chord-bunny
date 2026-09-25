// Guitar-likeness gate: is this frame a guitar, or the TV / talking / the
// room? The chord scorer always names a best chord, and with the hold rule
// on top the app matched 12 practice targets on a comedy show (2026-09-25
// session, stream ts ≥ 1083). Of the per-frame features tried
// (tools/gate_features.mjs → gate_fit.mjs: NNLS residual, spectral
// flatness, chroma entropy / max share, activation crest, top-4 mass,
// template fit, level dynamics) the NNLS residual alone separates the
// frames that produce verdicts: on the player's own recordings, verdict
// frames (conf ≥ 0.35) with residual ≤ 0.4 are 97% of guitar frames
// (95% in the noisier 2026-09-25 session, 98% on GuitarSet) and 27% of TV
// frames — and the TV survivors are one 0.8 s run of music on the show.
// Flatness added nothing once the residual was in; the level dynamics did
// not separate at all (speech and strums both pulse). CONFIG.gate.
import { CONFIG } from '../config.js';

export class GuitarGate {
  constructor(opts = CONFIG.gate) { this.o = opts; this.g = null; }
  reset() { this.g = null; }
  silent() { this.g = null; }   // the next sounding frame starts fresh (attack frames must not wait for the EMA)

  // Frame score from the residual, then EMA across sounding frames. 0..1.
  push(resid) {
    const raw = GuitarGate.score(resid, this.o);
    this.g = this.g === null ? raw : this.o.ema * this.g + (1 - this.o.ema) * raw;
    return this.g;
  }
  // 0.5 at resid = residMax; `steep` sets how fast it falls off either side.
  static score(resid, o = CONFIG.gate) { return 1 / (1 + Math.exp(o.steep * (resid - o.residMax))); }

  // Per-frame features for the offline tools, from the analyzer state after
  // analyze(): resid = unexplained spectral energy, flat = spectral flatness,
  // cmax / cent = chroma max share / normalised entropy, top4 = share of
  // activation mass on the four strongest pitches, crest = max / mean.
  static features({ an, act, chroma, level, fit = 0, conf = 0 }) {
    const nP = act.length;
    let tot = 0, mx = 0; const top = [0, 0, 0, 0];
    for (let i = 0; i < nP; i++) {
      const v = act[i]; tot += v; if (v > mx) mx = v;
      if (v > top[3]) { top[3] = v; top.sort((a, b) => b - a); }
    }
    let cmax = 0, cent = 0;
    for (let i = 0; i < 12; i++) { const c = chroma[i]; if (c > cmax) cmax = c; if (c > 0) cent -= c * Math.log(c); }
    return {
      resid: an.residual(act), flat: an.flatness(),
      cmax, cent: cent / Math.log(12),
      top4: tot > 0 ? (top[0] + top[1] + top[2] + top[3]) / tot : 0,
      crest: tot > 0 ? mx / (tot / nP) : 0,
      fit, conf, level,
    };
  }
}

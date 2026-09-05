// Radix-2 real FFT, in-place, precomputed twiddles. No deps, runs in the
// browser and in Node. Sizes must be powers of two.
//
//   const fft = new FFT(4096);
//   fft.forward(realIn /* Float32Array(n) */, re, im /* Float32Array(n) */);
//   // spectrum bins 0..n/2 are meaningful.

export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.n = n;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      const a = -2 * Math.PI * i / n;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
    // bit-reversal permutation table
    this.rev = new Uint32Array(n);
    let bits = 0;
    while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
  }

  // Complex in-place transform of (re, im).
  transform(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k], wi = this.sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr;        im[a] += ti;
        }
      }
    }
  }

  // Real input → complex spectrum in (re, im).
  forward(input, re, im) {
    re.set(input);
    im.fill(0);
    this.transform(re, im);
  }
}

// Periodic Hann window (matches what analysis code usually wants).
export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

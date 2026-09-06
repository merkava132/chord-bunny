// Minimal RIFF/WAVE reader: PCM 16/24/32-bit int and 32-bit float,
// any channel count (mixed down to mono). Returns { sampleRate, samples }.
// Works on ArrayBuffer (browser) or Node Buffer.

// decodeWav(buf) → { sampleRate, samples } (channels averaged to mono).
// decodeWav(buf, { split: true }) also returns `channels: Float32Array[]`
// (hexaphonic pickup files: one channel per string, low E first).
export function decodeWav(buf, { split = false } = {}) {
  const dv = buf instanceof ArrayBuffer
    ? new DataView(buf)
    : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');

  let p = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (p + 8 <= dv.byteLength) {
    const id = tag(p), len = dv.getUint32(p + 4, true);
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(p + 8, true),
        channels: dv.getUint16(p + 10, true),
        sampleRate: dv.getUint32(p + 12, true),
        bits: dv.getUint16(p + 22, true),
      };
      if (fmt.format === 0xFFFE && len >= 26) fmt.format = dv.getUint16(p + 8 + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      dataOff = p + 8; dataLen = Math.min(len, dv.byteLength - dataOff);
      break;
    }
    p += 8 + len + (len & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV missing fmt or data chunk');

  const { channels, bits, sampleRate, format } = fmt;
  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = new Float32Array(frames);
  const chans = split ? Array.from({ length: channels }, () => new Float32Array(frames)) : null;
  const inv = 1 / channels;
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * bytesPer;
      let v;
      if (format === 3 && bits === 32) v = dv.getFloat32(o, true);
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) {
        v = (dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608;
      } else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else if (bits === 8) v = (dv.getUint8(o) - 128) / 128;
      else throw new Error(`unsupported bit depth ${bits}`);
      acc += v;
      if (chans) chans[c][i] = v;
    }
    out[i] = acc * inv;
  }
  return chans ? { sampleRate, samples: out, channels: chans } : { sampleRate, samples: out };
}

// 16-bit PCM mono WAV from Float32 samples (clipped to ±1).
export function encodeWav(samples, sampleRate) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  return Buffer.from(buf);
}

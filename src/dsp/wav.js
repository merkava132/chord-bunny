// Minimal RIFF/WAVE reader: PCM 16/24/32-bit int and 32-bit float,
// any channel count (mixed down to mono). Returns { sampleRate, samples }.
// Works on ArrayBuffer (browser) or Node Buffer.

export function decodeWav(buf) {
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
    }
    out[i] = acc * inv;
  }
  return { sampleRate, samples: out };
}

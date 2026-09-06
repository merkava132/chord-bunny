// Segment recorder: taps the raw mic stream and uploads every stretch of
// non-silence (with a little pre-roll and a 2 s tail) as 16-bit mono WAV to
// serve.py → recordings/<session>/seg-NNNN.wav. Segment times are on the
// stream clock (`ts`, seconds since the stream started), the same clock the
// detector's frame events use, so a telemetry event maps to a sample offset:
//   offset = (ev.ts - seg.ts0) * sampleRate

export class Recorder {
  constructor({ sampleRate, session, gate = 0.004, preRollSec = 0.5, tailSec = 2, maxSec = 60, onSegment = null }) {
    this.sr = sampleRate;
    this.session = session;
    this.gate = gate;
    this.tail = tailSec;
    this.maxLen = Math.round(maxSec * sampleRate);
    this.pre = [];                    // recent quiet chunks (pre-roll)
    this.preLen = Math.round(preRollSec * sampleRate);
    this.active = null;               // { chunks, len, ts0, lastLoud }
    this.seg = 0;
    this.onSegment = onSegment;
    this.enabled = true;
    this.uploaded = 0;
    this.lastTs = 0;
  }

  // chunk: Float32Array of raw samples; tsEnd: stream time at the chunk's end
  push(chunk, tsEnd) {
    if (!this.enabled) return;
    if (tsEnd < this.lastTs) { this.stop(this.lastTs); this.pre = []; }   // stream clock reset (re-attach)
    this.lastTs = tsEnd;
    let ss = 0; for (let i = 0; i < chunk.length; i++) ss += chunk[i] * chunk[i];
    const loud = Math.sqrt(ss / chunk.length) >= this.gate;
    const ts0 = tsEnd - chunk.length / this.sr;
    if (!this.active) {
      if (!loud) {
        this.pre.push({ data: Float32Array.from(chunk), ts0 });
        let total = 0; for (const c of this.pre) total += c.data.length;
        while (total > this.preLen && this.pre.length > 1) total -= this.pre.shift().data.length;
        return;
      }
      const chunks = this.pre.map(c => c.data);
      let len = 0; for (const c of chunks) len += c.length;
      this.active = { chunks, len, ts0: this.pre.length ? this.pre[0].ts0 : ts0, lastLoud: tsEnd };
      this.pre = [];
    }
    const a = this.active;
    a.chunks.push(Float32Array.from(chunk));
    a.len += chunk.length;
    if (loud) a.lastLoud = tsEnd;
    if (tsEnd - a.lastLoud >= this.tail || a.len >= this.maxLen) this._finish(tsEnd, a.len >= this.maxLen);
  }

  _finish(tsEnd, continues) {
    const a = this.active;
    this.active = null;
    if (!a || a.len < this.sr * 0.3) return;                 // ignore blips
    const pcm = new Int16Array(a.len);
    let o = 0;
    for (const c of a.chunks) for (let i = 0; i < c.length; i++, o++) pcm[o] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
    const seg = this.seg++;
    const meta = { seg, ts0: +a.ts0.toFixed(4), ts1: +tsEnd.toFixed(4), dur: +(a.len / this.sr).toFixed(2), continues };
    if (this.onSegment) this.onSegment(meta);
    const url = `api/audio?session=${this.session}&seg=${seg}&sr=${this.sr}&ts0=${meta.ts0}&ts1=${meta.ts1}`;
    fetch(url, { method: 'POST', body: pcm.buffer, keepalive: pcm.length < 30000, headers: { 'Content-Type': 'application/octet-stream' } })
      .then(r => { if (r.ok) this.uploaded++; })
      .catch(() => {});
    if (continues) this.active = { chunks: [], len: 0, ts0: tsEnd, lastLoud: tsEnd };   // long take: keep going seamlessly
  }

  // flush whatever is in progress (page hide)
  stop(tsEnd) { if (this.active) this._finish(tsEnd ?? (this.active.ts0 + this.active.len / this.sr), false); }
  get recording() { return !!this.active; }
}

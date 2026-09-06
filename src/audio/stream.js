// FrameStream: append sample chunks, hand out overlapping analysis frames to
// any number of consumers, each with its own (size, hop). Frame times are
// seconds since the stream started, measured at the frame centre.

export class FrameStream {
  constructor(sampleRate, ringSize = 1 << 17) {
    this.sr = sampleRate;
    this.ring = new Float32Array(ringSize);
    this.written = 0;              // absolute sample count
    this.consumers = [];
    this.taps = [];                // fn(chunk, tsEnd): every raw chunk, unframed (recorder)
  }

  addTap(fn) { this.taps.push(fn); return fn; }
  removeTap(fn) { this.taps = this.taps.filter(x => x !== fn); }

  addConsumer({ size, hop, fn }) {
    const c = { size, hop, fn, next: size, frame: new Float32Array(size) };
    this.consumers.push(c);
    return c;
  }

  removeConsumer(c) { this.consumers = this.consumers.filter(x => x !== c); }

  reset() { this.written = 0; for (const c of this.consumers) c.next = c.size; }

  push(chunk) {
    const R = this.ring.length;
    let pos = this.written % R;
    const first = Math.min(chunk.length, R - pos);
    this.ring.set(chunk.subarray(0, first), pos);
    if (first < chunk.length) this.ring.set(chunk.subarray(first), 0);
    this.written += chunk.length;
    for (const tap of this.taps) tap(chunk, this.written / this.sr);
    for (const c of this.consumers) {
      while (this.written >= c.next) {
        if (this.written - c.next > R - c.size) { c.next = this.written; break; }   // fell behind; skip ahead
        const start = (c.next - c.size) % R;
        const f1 = Math.min(c.size, R - start);
        c.frame.set(this.ring.subarray(start, start + f1), 0);
        if (f1 < c.size) c.frame.set(this.ring.subarray(0, c.size - f1), f1);
        c.fn(c.frame, (c.next - c.size / 2) / this.sr);
        c.next += c.hop;
      }
    }
  }
}

// Wire an AudioContext source into a FrameStream through the capture worklet.
// Returns { node, stream, dispose }.
export async function captureFrom(audioContext, moduleUrl = new URL('./capture-processor.js', import.meta.url)) {
  if (!audioContext._chordBunnyWorklet) {
    await audioContext.audioWorklet.addModule(moduleUrl);
    audioContext._chordBunnyWorklet = true;
  }
  const node = new AudioWorkletNode(audioContext, 'chord-bunny-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
  const stream = new FrameStream(audioContext.sampleRate);
  node.port.onmessage = (e) => stream.push(e.data);
  return { node, stream, dispose() { node.port.onmessage = null; try { node.disconnect(); } catch {} } };
}

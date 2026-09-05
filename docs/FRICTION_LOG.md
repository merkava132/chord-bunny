# Friction log

Running notes on confusion, tool friction, and places where the architecture
fought back. Newest at the bottom.

## 2026-09-05 — resuming after 4 months

- Project was not under git. Initialised it before touching anything.
- No numpy/scipy on this box, so all offline analysis + evaluation must be
  Node. That's fine (the DSP has to be JS for the browser anyway) but it
  means writing our own FFT and WAV reader.
- Existing detector uses `AnalyserNode` polled on a 50 ms `setInterval`.
  That gives no control over hop size or frame alignment, which is useless
  for onset timing / strum direction. Needs raw sample access (AudioWorklet).
- Nodriver browser MCP failed to connect (502) — use WebFetch/curl for
  data hunting.
- zsh `noclobber` is set: `cat > existing-file` silently fails with
  "file exists" and the *old* file keeps running. Use `>|` when overwriting.

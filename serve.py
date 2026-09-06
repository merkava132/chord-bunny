#!/usr/bin/env python3
"""chord-bunny dev server: static files + a local sink for telemetry and
mic recordings. Nothing leaves the machine.

  python3 serve.py [--port 8732] [--rec-dir DIR] [--max-rec-mb 3000]

  POST /api/telemetry?session=ID        body: JSON lines → telemetry/ID.jsonl (appended)
  POST /api/audio?session=ID&seg=N&sr=48000&ts0=..&ts1=..
                                        body: int16 LE mono PCM → REC_DIR/ID/seg-N.wav
  GET  /api/status                      what is stored where
Recordings are pruned oldest-first when REC_DIR exceeds --max-rec-mb.
"""
import argparse, json, os, re, struct, sys, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
TELEMETRY_DIR = os.path.join(ROOT, 'telemetry')
SAFE = re.compile(r'^[A-Za-z0-9_.-]{1,80}$')
lock = threading.Lock()


def wav_header(n_bytes, sr, channels=1, bits=16):
    byte_rate = sr * channels * bits // 8
    return (b'RIFF' + struct.pack('<I', 36 + n_bytes) + b'WAVE'
            + b'fmt ' + struct.pack('<IHHIIHH', 16, 1, channels, sr, byte_rate, channels * bits // 8, bits)
            + b'data' + struct.pack('<I', n_bytes))


def prune(rec_dir, max_bytes):
    files = []
    for d, _, names in os.walk(rec_dir):
        for n in names:
            p = os.path.join(d, n)
            try: st = os.stat(p)
            except OSError: continue
            files.append((st.st_mtime, st.st_size, p))
    total = sum(s for _, s, _ in files)
    files.sort()
    removed = 0
    while total > max_bytes and files:
        _, size, p = files.pop(0)
        try: os.remove(p); total -= size; removed += 1
        except OSError: pass
    return removed, total


class Handler(SimpleHTTPRequestHandler):
    rec_dir = os.path.join(ROOT, 'recordings')
    max_rec_bytes = 3000 * 10**6

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        # ES modules: make the browser revalidate on every reload so a deploy
        # never leaves a stale module under a fresh index.html
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path.startswith('/api/'):   # keep the access log readable
            return
        super().log_message(fmt, *args)

    def _reply(self, code, obj=None):
        body = json.dumps(obj).encode() if obj is not None else b''
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body: self.wfile.write(body)

    def do_GET(self):
        if urlsplit(self.path).path == '/api/status':
            sessions = sorted(f[:-6] for f in os.listdir(TELEMETRY_DIR)) if os.path.isdir(TELEMETRY_DIR) else []
            _, total = prune(self.rec_dir, float('inf')) if os.path.isdir(self.rec_dir) else (0, 0)
            return self._reply(200, {'telemetryDir': TELEMETRY_DIR, 'recDir': self.rec_dir, 'recBytes': total,
                                     'maxRecBytes': self.max_rec_bytes, 'sessions': sessions[-20:]})
        return super().do_GET()

    def do_POST(self):
        url = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else b''
        session = q.get('session', '')
        if not SAFE.match(session):
            return self._reply(400, {'error': 'bad session id'})
        try:
            if url.path == '/api/telemetry':
                os.makedirs(TELEMETRY_DIR, exist_ok=True)
                text = body.decode('utf-8', 'replace')
                if text and not text.endswith('\n'): text += '\n'
                with lock, open(os.path.join(TELEMETRY_DIR, session + '.jsonl'), 'a') as f:
                    f.write(text)
                return self._reply(204)
            if url.path == '/api/audio':
                seg = int(q.get('seg', 0)); sr = int(q.get('sr', 48000))
                d = os.path.join(self.rec_dir, session)
                os.makedirs(d, exist_ok=True)
                path = os.path.join(d, f'seg-{seg:04d}.wav')
                with open(path, 'wb') as f:
                    f.write(wav_header(len(body), sr)); f.write(body)
                meta = {'seg': seg, 'sr': sr, 'ts0': float(q.get('ts0', 0)), 'ts1': float(q.get('ts1', 0)),
                        'bytes': len(body), 'wall': time.time()}
                with lock, open(os.path.join(d, 'segments.jsonl'), 'a') as f:
                    f.write(json.dumps(meta) + '\n')
                removed, total = prune(self.rec_dir, self.max_rec_bytes)
                if removed: print(f'pruned {removed} old recording(s); {total / 1e6:.0f} MB kept', file=sys.stderr)
                return self._reply(204)
        except Exception as e:      # noqa: BLE001 — report, don't kill the server
            print(f'api error {url.path}: {e!r}', file=sys.stderr)
            return self._reply(500, {'error': str(e)})
        return self._reply(404, {'error': 'unknown endpoint'})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8732)))
    ap.add_argument('--rec-dir', default=os.environ.get('CB_REC_DIR') or Handler.rec_dir)
    ap.add_argument('--max-rec-mb', type=int, default=int(os.environ.get('CB_MAX_REC_MB', 3000)))
    a = ap.parse_args()
    Handler.rec_dir = os.path.abspath(a.rec_dir)
    Handler.max_rec_bytes = a.max_rec_mb * 10**6
    os.makedirs(Handler.rec_dir, exist_ok=True)
    os.makedirs(TELEMETRY_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), Handler)
    print(f'chord-bunny → http://localhost:{a.port}/   telemetry: {TELEMETRY_DIR}   recordings: {Handler.rec_dir} (cap {a.max_rec_mb} MB)', flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass


if __name__ == '__main__':
    main()

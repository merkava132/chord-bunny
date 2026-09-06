#!/usr/bin/env bash
# chord-bunny: serve + open in a browser. getUserMedia needs http(s) or localhost.
# serve.py also stores telemetry (./telemetry) and mic recordings (CB_REC_DIR,
# default /mnt/aegis/chord-bunny/recordings when that drive is present).
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8732}"
URL="http://localhost:${PORT}/"
if [ -z "${CB_REC_DIR:-}" ] && [ -d /mnt/aegis ] && [ -w /mnt/aegis ]; then
  export CB_REC_DIR=/mnt/aegis/chord-bunny/recordings
fi

if command -v xdg-open >/dev/null 2>&1; then OPENER=xdg-open
elif command -v open >/dev/null 2>&1; then OPENER=open
else OPENER=""; fi

(sleep 0.6 && [ -n "$OPENER" ] && "$OPENER" "$URL") &

echo "chord-bunny → ${URL}   (Ctrl-C to stop)"
exec python3 serve.py --port "$PORT"

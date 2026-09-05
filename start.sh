#!/usr/bin/env bash
# chord-bunny: open in a browser. getUserMedia needs http(s) or localhost.
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8732}"
URL="http://localhost:${PORT}/"

if command -v xdg-open >/dev/null 2>&1; then OPENER=xdg-open
elif command -v open >/dev/null 2>&1; then OPENER=open
else OPENER=""; fi

(sleep 0.6 && [ -n "$OPENER" ] && "$OPENER" "$URL") &

echo "chord-bunny → ${URL}   (Ctrl-C to stop)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1

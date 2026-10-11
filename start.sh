#!/usr/bin/env bash
# Starts Moonfang (dev server on http://localhost:5178) and opens it in the browser.
# Usage: ./start.sh, or "./start.sh --no-browser" to only start the server.
set -u
cd "$(dirname "$(readlink -f "$0")")" || exit 1
PORT=5178
URL="http://localhost:$PORT"
LOG="${TMPDIR:-/tmp}/moonfang-server.log"

listening() {
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]
  else
    (exec 3<>"/dev/tcp/localhost/$PORT") 2>/dev/null # localhost: IPv4 or IPv6
  fi
}

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (or your package manager) and try again." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies, this takes a minute the first time..."
  npm install || { echo "npm install failed." >&2; exit 1; }
fi

if listening; then
  echo "Moonfang is already running at $URL"
else
  echo "Starting Moonfang..."
  # Detached from this terminal; ./stop.sh stops it. Output goes to $LOG.
  nohup npx vite --port "$PORT" --strictPort >"$LOG" 2>&1 </dev/null &
  for _ in $(seq 1 60); do
    listening && break
    sleep 0.5
  done
  if ! listening; then
    echo "The server did not start. See $LOG for details." >&2
    exit 1
  fi
  echo "Moonfang is running at $URL"
fi

[ "${1:-}" = "--no-browser" ] && exit 0
xdg-open "$URL" >/dev/null 2>&1 &
exit 0

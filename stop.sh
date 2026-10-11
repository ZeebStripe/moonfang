#!/usr/bin/env bash
# Stops the Moonfang dev server (whatever is listening on port 5178).
set -u
PORT=5178

pids=""
if command -v ss >/dev/null 2>&1; then
  pids=$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
fi
if [ -z "$pids" ] && command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | sort -u)
fi
if [ -z "$pids" ] && command -v fuser >/dev/null 2>&1; then
  pids=$(fuser "$PORT/tcp" 2>/dev/null)
fi

if [ -z "$pids" ]; then
  echo "Moonfang was not running."
  exit 0
fi
# shellcheck disable=SC2086 # one pid per word
kill $pids 2>/dev/null
for _ in $(seq 1 20); do
  # shellcheck disable=SC2086
  kill -0 $pids 2>/dev/null || break
  sleep 0.25
done
# shellcheck disable=SC2086
kill -9 $pids 2>/dev/null
echo "Moonfang stopped."

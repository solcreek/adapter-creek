#!/usr/bin/env bash
# Next.js adapter test suite — cleanup script
# Stops the local wrangler dev server started by e2e-deploy.sh.
set -euo pipefail

if [ -f ".adapter-server.pid" ]; then
  PID=$(cat .adapter-server.pid)
  if [ "${ADAPTER_KEEP_SERVER:-}" = "1" ]; then
    echo "[adapter-creek] Keeping server alive (PID ${PID}) because ADAPTER_KEEP_SERVER=1" >&2
    exit 0
  fi
  if kill -0 "${PID}" 2>/dev/null; then
    echo "[adapter-creek] Stopping server (PID ${PID})..." >&2
    kill "${PID}" 2>/dev/null || true
    for i in $(seq 1 10); do
      kill -0 "${PID}" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "${PID}" 2>/dev/null || true
  fi
  rm -f .adapter-server.pid
fi

echo "[adapter-creek] Cleanup complete" >&2

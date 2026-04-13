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

# Truncate /tmp/creek-worker.log if it grows past 100MB. The dev server
# (worker-dev-server.mjs) appends every run's worker stdout/stderr to a
# fixed log file under /tmp so the harness can't nuke it; without
# rotation it grows unbounded across hundreds of test runs (saw 33GB in
# one session). Keep the latest 10MB tail in case it's needed for
# post-mortem, drop the rest.
WORKER_LOG="${CREEK_WORKER_LOG:-/tmp/creek-worker.log}"
if [ -f "${WORKER_LOG}" ]; then
  size=$(stat -f%z "${WORKER_LOG}" 2>/dev/null || stat -c%s "${WORKER_LOG}" 2>/dev/null || echo 0)
  if [ "${size}" -gt 104857600 ]; then
    tail -c 10485760 "${WORKER_LOG}" > "${WORKER_LOG}.tmp" && mv "${WORKER_LOG}.tmp" "${WORKER_LOG}"
    echo "[adapter-creek] Rotated ${WORKER_LOG} (was ~$((size / 1048576))MB → 10MB)" >&2
  fi
fi

echo "[adapter-creek] Cleanup complete" >&2

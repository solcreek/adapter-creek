#!/usr/bin/env bash
# Next.js adapter test suite — cleanup script with zombie prevention
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
    
    # Kill entire process group (including wrangler and workerd children)
    # The node process spawned worker-dev-server-sub.mjs as a new process group
    # Use negative PID to kill the entire group
    kill -- -"${PID}" 2>/dev/null || true
    
    # Wait for process group to exit
    for i in $(seq 1 10); do
      if ! kill -0 "${PID}" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    
    # Force kill if still alive
    if kill -0 "${PID}" 2>/dev/null; then
      kill -9 -- -"${PID}" 2>/dev/null || true
    fi
  fi
  rm -f .adapter-server.pid
fi

# Also clean up any orphaned wrangler or workerd processes that might have been
# left behind by SIGKILL (prevents the zombie army)
if command -v pkill >/dev/null 2>&1; then
  # Use pgrep to check if there are matching processes before pkill to avoid noise
  if pgrep -f "wrangler.*dev.*${PORT:-}" >/dev/null 2>&1; then
    echo "[adapter-creek] Cleaning up orphaned wrangler processes..." >&2
    pkill -f "wrangler.*dev.*${PORT:-}" 2>/dev/null || true
  fi
  if pgrep -f "workerd" >/dev/null 2>&1; then
    # Only kill workerd processes that are children of our test (check parent)
    echo "[adapter-creek] Note: some workerd processes may need manual cleanup" >&2
  fi
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

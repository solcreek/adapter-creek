#!/usr/bin/env bash
# Next.js adapter test suite — deploy script
#
# Contract:
# - cwd is an isolated test app created by the Next.js harness
# - Exit non-zero on failure
# - Print ONLY the deployment URL to stdout
# - All diagnostics to stderr or files
set -euo pipefail

ADAPTER_PATH="${ADAPTER_DIR}/dist/index.js"
NPM_CACHE_DIR="${TMPDIR:-/tmp}/adapter-creek-npm-cache"
PNPM_STORE_DIR="${TMPDIR:-/tmp}/adapter-creek-pnpm-store-$$-${RANDOM}"
mkdir -p "${NPM_CACHE_DIR}"
mkdir -p "${PNPM_STORE_DIR}"

log() {
  printf '[adapter-creek] %s %s\n' "$(date '+%H:%M:%S')" "$*" >&2
}

# Install the adapter — use tarball if available (faster, avoids symlink issues),
# otherwise fall back to file: dependency.
log "pwd=${PWD}"
log "Installing adapter..."
if [ -n "${ADAPTER_TARBALL:-}" ] && [ -f "${ADAPTER_TARBALL}" ]; then
  node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['@solcreek/adapter-creek'] = '${ADAPTER_TARBALL}';
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
" >&2
else
  node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['@solcreek/adapter-creek'] = 'file:${ADAPTER_DIR}';
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
" >&2
fi
log "Running pnpm install..."
pnpm install --force --store-dir "${PNPM_STORE_DIR}" --no-frozen-lockfile >&2 2>&1
log "pnpm install complete"

# Patch Next.js: fix invariant error for dynamic metadata routes in handleBuildComplete.
# Static metadata files (e.g., icon.png) inside dynamic route segments cause a
# "failed to find source route" invariant because the prerender entry's srcRoute
# points to a path not in appOutputMap. Allow missing parent and try parent dir.
# Upstream issue: https://github.com/vercel/next.js/issues/XXXXX
log "Patching build-complete.js if needed..."
node -e "
const fs = require('fs');
const p = require.resolve('next/dist/build/adapter/build-complete.js');
let code = fs.readFileSync(p, 'utf8');
if (code.includes('failed to find source route') && !code.includes('const _pr = srcRoute.replace')) {
  // Replace the getParentOutput function to try parent directory as fallback
  // for metadata routes inside dynamic segments (Next.js bug).
  const old = 'if (!parentOutput && !allowMissing) {';
  const replacement = 'if (!parentOutput && !allowMissing) { ' +
    'const _pr = srcRoute.replace(/\\\\/[^\\\\/]+\$/, \"\") || \"/\"; ' +
    'const _fb = pageOutputMap[_pr] || appOutputMap[_pr]; ' +
    'if (_fb) return _fb; ';
  code = code.replace(old, replacement);
  fs.writeFileSync(p, code);
  console.error('[adapter-creek] Patched build-complete.js for dynamic metadata routes');
}
" >&2 2>&1 || true

# Build with adapter
export NEXT_ADAPTER_PATH="${ADAPTER_PATH}"
log "Running next build..."
npx next build --experimental-next-config-strip-types >&2 2>&1
log "next build complete"

# Save build metadata
BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || echo "unknown")

# Local test server runs the generated worker directly in Node to avoid
# wrangler/miniflare buffering streamed action responses.
ADAPTER_OUTPUT=".creek/adapter-output"
WORKER_SERVER="${ADAPTER_DIR}/scripts/worker-dev-server.mjs"

# Start local worker server in background on a random port
PORT=$((3000 + RANDOM % 10000))
log "Starting local server on port ${PORT}..."
node "${WORKER_SERVER}" \
  --worker "${ADAPTER_OUTPUT}/server/worker.js" \
  --assets "${ADAPTER_OUTPUT}/assets" \
  --port "${PORT}" > .adapter-server.log 2>&1 &
SERVER_PID=$!

# Save PID for cleanup
echo "${SERVER_PID}" > .adapter-server.pid
{
  echo "PORT=${PORT}"
  echo "SERVER_PID=${SERVER_PID}"
  echo "APP_DIR=${PWD}"
} > .adapter-runtime.env

# Wait for server to be ready (poll health)
for i in $(seq 1 60); do
  if curl -s "http://127.0.0.1:${PORT}/" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    log "Server process died"
    cat .adapter-server.log >&2
    exit 1
  fi
  sleep 1
done

# Verify server is responding
if ! curl -s "http://127.0.0.1:${PORT}/" > /dev/null 2>&1; then
  log "Server failed to start within 60s"
  cat .adapter-server.log >&2
  kill "${SERVER_PID}" 2>/dev/null || true
  exit 1
fi

# Save metadata for logs script
{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: local-${PORT}"
  echo "IMMUTABLE_ASSET_TOKEN: undefined"
} > .adapter-build.log

log "Ready at http://127.0.0.1:${PORT}"

# Print URL to stdout (test harness reads this)
echo "http://127.0.0.1:${PORT}"

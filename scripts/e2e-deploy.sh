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

# Install the adapter — use tarball if available (faster, avoids symlink issues),
# otherwise fall back to file: dependency.
echo "[adapter-creek] Installing adapter..." >&2
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
npm install --no-audit --no-fund --legacy-peer-deps >&2 2>&1

# Patch Next.js: fix invariant error for dynamic metadata routes in handleBuildComplete.
# Static metadata files (e.g., icon.png) inside dynamic route segments cause a
# "failed to find source route" invariant because the prerender entry's srcRoute
# points to a path not in appOutputMap. Allow missing parent and try parent dir.
# Upstream issue: https://github.com/vercel/next.js/issues/XXXXX
node -e "
const fs = require('fs');
const p = require.resolve('next/dist/build/adapter/build-complete.js');
let code = fs.readFileSync(p, 'utf8');
if (code.includes('failed to find source route')) {
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
echo "[adapter-creek] Building..." >&2
npx next build >&2 2>&1

# Save build metadata
BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || echo "unknown")

# Generate wrangler config for miniflare
ADAPTER_OUTPUT=".creek/adapter-output"
cat > wrangler.json <<WRANGLER_EOF
{
  "name": "test-app",
  "main": "${ADAPTER_OUTPUT}/server/worker.js",
  "compatibility_date": "2026-03-28",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "${ADAPTER_OUTPUT}/assets",
    "binding": "ASSETS",
    "html_handling": "none",
    "not_found_handling": "none"
  }
}
WRANGLER_EOF

# Resolve wrangler from the adapter's node_modules
WRANGLER="${ADAPTER_DIR}/node_modules/.bin/wrangler"

# Start miniflare/wrangler dev in background on a random port
PORT=$((3000 + RANDOM % 10000))
echo "[adapter-creek] Starting local server on port ${PORT}..." >&2
"${WRANGLER}" dev --port "${PORT}" --local > .adapter-server.log 2>&1 &
SERVER_PID=$!

# Save PID for cleanup
echo "${SERVER_PID}" > .adapter-server.pid

# Wait for server to be ready (poll health)
for i in $(seq 1 60); do
  if curl -s "http://127.0.0.1:${PORT}/" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[adapter-creek] Server process died" >&2
    cat .adapter-server.log >&2
    exit 1
  fi
  sleep 1
done

# Verify server is responding
if ! curl -s "http://127.0.0.1:${PORT}/" > /dev/null 2>&1; then
  echo "[adapter-creek] Server failed to start within 60s" >&2
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

echo "[adapter-creek] Ready at http://127.0.0.1:${PORT}" >&2

# Print URL to stdout (test harness reads this)
echo "http://127.0.0.1:${PORT}"

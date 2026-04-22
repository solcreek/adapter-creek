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
# Shared pnpm store across all test runs. pnpm handles concurrent access
# to the store via per-package file locks, so multiple tests can install
# in parallel without corruption. Keeping the store across runs means
# we only pay the download cost for each package once — subsequent
# installs become a near-instant link operation. The earlier per-run
# random store (\$\$-\${RANDOM}) blew the 240s hook timeout because every
# beforeAll() re-downloaded esbuild/sharp binaries from npm.
PNPM_STORE_DIR="${TMPDIR:-/tmp}/adapter-creek-pnpm-store-shared"
mkdir -p "${NPM_CACHE_DIR}"
mkdir -p "${PNPM_STORE_DIR}"

# The deploy harness is exercising a preview-style deployment. Several metadata
# behaviors in Next.js key off Vercel preview env vars rather than next.config.
export VERCEL_ENV="${VERCEL_ENV:-preview}"
export VERCEL="${VERCEL:-1}"

# Mirror what \`vercel deploy --build-env NEXT_PRIVATE_TEST_MODE=e2e\` does for
# upstream Vercel adapter tests. The test harness writes a shim at the top of
# each fixture's \`next.config.js\` that aliases NEXT_PRIVATE_TEST_MODE →
# __NEXT_TEST_MODE so the Next.js client bundle's test-only instrumentation
# (e.g. \`window.__NEXT_HYDRATED_AT\`, perf.measure('Next.js-hydration'))
# actually ships in the build. Without this, tests asserting on those globals
# receive \`undefined\`.
export NEXT_PRIVATE_TEST_MODE="${NEXT_PRIVATE_TEST_MODE:-e2e}"

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
# --prefer-offline: use the store whenever possible, only hit the network
# for packages that aren't already cached. This is what turns a ~3min
# install into a ~5s link operation once the store is warm.
# Dropping --force so pnpm can actually use the cached store. --force
# would re-download every package.
pnpm install --store-dir "${PNPM_STORE_DIR}" --no-frozen-lockfile --prefer-offline --ignore-scripts >&2 2>&1
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
# The test harness writes a custom \`build\` script into package.json when the
# test fixture configures a setup step (e.g. middleware-general copies a mock
# workspace package into ./node_modules via a \`setup\` script before calling
# \`next build\`). Running \`npx next build\` directly here would skip that
# setup and the build would fail to resolve the mock package. Patch the
# existing build script to carry our \`--experimental-next-config-strip-types\`
# flag and delegate to it via \`pnpm run build\`.
# Pre-allocate port and deployment ID BEFORE build. Real Vercel-style
# deploys set NEXT_DEPLOYMENT_ID at build time so Next.js can bake
# \`?dpl=<id>\` into static asset URLs (skew protection). Tests like
# \`app-dir/worker\` observe browser network requests and assert that
# every \`/_next/\` URL carries the right \`dpl\` query value matching
# \`next.assetToken = next.deploymentId\`. Setting the env after build
# means asset URLs lack the param and the test fails.
# Chromium refuses to load URLs on its unsafe-ports list (ERR_UNSAFE_PORT)
# — these are pre-defined ports associated with legacy services (IRC, SIP,
# NFS, etc.). Random port allocation in a 10k range hits ~8 unsafe ports
# per 10,000 runs, which surfaces as flaky "net::ERR_UNSAFE_PORT at
# http://localhost:${PORT}/" Playwright errors that go green only on retry.
# Reroll until we pick one outside Chromium's blocklist. List from
# https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/net/base/port_util.cc
UNSAFE_PORTS=" 1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723 2049 3659 4045 5060 5061 6000 6566 6665 6666 6667 6668 6669 6697 10080 "
for _ in 1 2 3 4 5 6 7 8 9 10; do
  PORT=$((3000 + RANDOM % 10000))
  case "${UNSAFE_PORTS}" in
    *" ${PORT} "*) continue ;;
    *) break ;;
  esac
done
export NEXT_DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-local-${PORT}}"
log "Pre-allocated PORT=${PORT}, NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}"

log "Running next build via pnpm..."
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const script = pkg.scripts && pkg.scripts.build;
if (script && !script.includes('--experimental-next-config-strip-types')) {
  pkg.scripts.build = script.replace(
    /\\bnext build\\b/,
    'next build --experimental-next-config-strip-types'
  );
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
}
" >&2 2>&1
if node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));process.exit(p.scripts&&p.scripts.build?0:1);" 2>/dev/null; then
  # Tee build output both to stderr (for live debugging) and to
  # \`.adapter-build-cli.log\` so the logs script can later replay it
  # into \`cliOutput\`. Tests like
  # \`app-dir/app-middleware.should warn when deprecated middleware file\`
  # and \`cache-components-unstable-deprecations\` assert on warnings
  # Next.js emits during \`next build\`; without capturing the build
  # output those assertions see only the empty worker-dev-server log.
  pnpm run build 2>&1 | tee .adapter-build-cli.log >&2
else
  npx next build --experimental-next-config-strip-types 2>&1 | tee .adapter-build-cli.log >&2
fi
log "next build complete"

# Save build metadata
BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || echo "unknown")
# Detect basePath from the build output so the health check URL is correct.
# Apps with basePath (e.g. "/docs") serve static assets at /docs/_next/...
# instead of /_next/...; without this, the health check 404s and the deploy
# script exits with "Server failed to start within 60s".
# Read from required-server-files.json (already built) which is more reliable
# than parsing next.config.js directly (handles TS, ESM, functions, etc.).
BASE_PATH=$(node -e "
  try {
    const f = require('fs').readFileSync('.next/required-server-files.json','utf8');
    console.log(JSON.parse(f).config.basePath || '');
  } catch { console.log(''); }
" 2>/dev/null || echo "")
HEALTHCHECK_PATH="${BASE_PATH}/_next/static/${BUILD_ID}/_buildManifest.js"

# Local test server runs the generated worker in workerd (via wrangler dev),
# the same runtime CF Workers prod uses. We previously ran in Node.js for
# speed, but that hid streaming/HTTP-edge-case bugs that surface under
# workerd — swapping here keeps dev/prod behavior consistent.
ADAPTER_OUTPUT=".creek/adapter-output"

# CREEK_MULTI_WORKER=1 switches to the 3-worker topology emitted when the
# build ran with the same flag. The launcher hosts dispatcher +
# node-runtime + edge-runtime in one miniflare process and wires service
# bindings between them. Same --worker/--assets/--port CLI as the
# single-worker launcher — we just point --worker at dispatcher/worker.js
# and the launcher derives the sibling runtimes.
if [ "${CREEK_MULTI_WORKER:-}" = "1" ]; then
  WORKER_SERVER="${ADAPTER_DIR}/scripts/multi-worker-dev.mjs"
  WORKER_SCRIPT="${ADAPTER_OUTPUT}/dispatcher/worker.js"
  log "Multi-worker mode: launching dispatcher + node-runtime + edge-runtime"
else
  WORKER_SERVER="${ADAPTER_DIR}/scripts/worker-dev-server-miniflare.mjs"
  WORKER_SCRIPT="${ADAPTER_OUTPUT}/server/worker.js"
fi

# PORT was pre-allocated before build (see top of script).
log "Starting local server on port ${PORT}..."

# Use setsid to create a new process group. This allows the cleanup script
# to kill the entire group (including wrangler and workerd children) by
# sending signals to the negative PID. Prevents zombie processes when
# the test watchdog SIGKILLs the test runner.
if command -v setsid >/dev/null 2>&1; then
  # setsid creates new process group, leader is the node process
  setsid node "${WORKER_SERVER}" \
    --worker "${WORKER_SCRIPT}" \
    --assets "${ADAPTER_OUTPUT}/assets" \
    --port "${PORT}" > .adapter-server.log 2>&1 &
  SERVER_PID=$!
else
  # Fallback for macOS which doesn't have setsid - use bash to create process group
  (exec node "${WORKER_SERVER}" \
    --worker "${WORKER_SCRIPT}" \
    --assets "${ADAPTER_OUTPUT}/assets" \
    --port "${PORT}" > .adapter-server.log 2>&1) &
  SERVER_PID=$!
fi

# Save PID for cleanup (this is the process group leader PID)
echo "${SERVER_PID}" > .adapter-server.pid
{
  echo "PORT=${PORT}"
  echo "SERVER_PID=${SERVER_PID}"
  echo "APP_DIR=${PWD}"
} > .adapter-runtime.env

# Wait for server to be ready. Poll a static asset instead of `/`, because some
# fixtures intentionally have no root route and hitting `/` can trigger an app
# render invariant before the real test even starts.
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${PORT}${HEALTHCHECK_PATH}" > /dev/null 2>&1; then
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
if ! curl -fsS "http://localhost:${PORT}${HEALTHCHECK_PATH}" > /dev/null 2>&1; then
  log "Server failed to start within 60s"
  cat .adapter-server.log >&2
  kill "${SERVER_PID}" 2>/dev/null || true
  exit 1
fi

# Save metadata for logs script. DEPLOYMENT_ID matches NEXT_DEPLOYMENT_ID
# baked into the build so \`?dpl=\` query in asset URLs lines up with
# what the test harness reads from \`next.deploymentId\`.
{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${NEXT_DEPLOYMENT_ID}"
  echo "IMMUTABLE_ASSET_TOKEN: undefined"
} > .adapter-build.log

log "Ready at http://localhost:${PORT}"

# Print URL to stdout (test harness reads this). Use \`localhost\` rather than
# \`127.0.0.1\` so that \`next.url\` matches what Next.js normalizes internally
# via NextURL.parseURL() — that function rewrites any loopback hostname to
# "localhost", which means middleware code like
# \`new URL('/dest', request.url)\` always produces localhost URLs. Tests that
# compare against \`next.url + '/dest'\` would otherwise see a hostname mismatch.
echo "http://localhost:${PORT}"

#!/usr/bin/env bash
#
# E2E: build an Edge-runtime Next.js fixture with webpack — what `creek deploy`
# runs — through the Creek lazy-install layout, then RUN the emitted worker in
# workerd and hit every edge route.
#
# The gate for the bug where every Edge-runtime route of a webpack build
# returned 500 ("No handler function found on module"): edge pages API routes,
# app route handlers and edge pages, with or without middleware. Two causes:
# - the shared `server/edge-chunks/*.js` an edge entry depends on were never
#   bundled, so the entry never evaluated into `_ENTRIES`;
# - a webpack edge page/API entry exports only `default`, Next's edge
#   `adapter()`, which takes request data rather than a Request.
# A build-only check cannot catch either; only running the worker can. Runs
# twice: with middleware, then without it (the edge runtime used to come only
# from the middleware's files, so edge routes alone had none).
#
# Also covers a webpack-only render bug: a page under a route group rendered
# without its client chunk.
#
# Usage: e2e/edge-webpack/run.sh   (from the repo root; needs network + wrangler)
#        E2E_BUNDLER=turbopack e2e/edge-webpack/run.sh   (same checks, Turbopack)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/e2e/edge-webpack/fixture"
PORT="${E2E_PORT:-8798}"
export WRANGLER_SEND_METRICS=false

log() { printf '\n\033[1m[e2e:edge-webpack] %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m[e2e:edge-webpack] FAIL: %s\033[0m\n' "$*" >&2; exit 1; }

case "${E2E_BUNDLER:-webpack}" in
  webpack) BUILD_FLAG="--webpack" ;;
  turbopack) BUILD_FLAG="" ;;
  *) fail "E2E_BUNDLER must be webpack or turbopack (got '${E2E_BUNDLER}')" ;;
esac

log "Building adapter and packing tarball (the EXACT bytes npm would publish)"
cd "$REPO_ROOT"
pnpm build
TARBALL="$REPO_ROOT/$(npm pack --silent | tail -1)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/adapter-creek-edge-webpack-e2e.XXXXXX")"
WRANGLER_PID=""
cleanup() {
  [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null || true
  rm -f "$TARBALL"
  rm -rf "$WORK"
}
trap cleanup EXIT

APP="$WORK/app"
log "Fixture project: $APP"
cp -R "$FIXTURE_DIR/." "$APP"
cd "$APP"

log "Installing fixture deps"
npm install --no-audit --no-fund --silent

log "Lazy-installing the adapter into .creek/node_modules (mirrors creek installCreekDep)"
mkdir -p .creek
node -e "require('node:fs').writeFileSync('.creek/package.json', JSON.stringify({ private: true, dependencies: { '@solcreek/adapter-creek': 'file:' + process.argv[1] } }, null, 2))" "$TARBALL"
(cd .creek && npm install --no-audit --no-fund --ignore-scripts)

ADAPTER_PATH="$(node -e "
  const { createRequire } = require('node:module');
  const { join } = require('node:path');
  console.log(createRequire(join(process.cwd(), '.creek', 'package.json')).resolve('@solcreek/adapter-creek'));
")"
# wrangler is the adapter's own dependency, resolved through its tree (see
# e2e/prisma-d1/run.sh for why not a .bin path).
WRANGLER_ENTRY="$(node -e "
  const { createRequire } = require('node:module');
  const path = require('node:path');
  const fs = require('node:fs');
  let dir = path.dirname(process.argv[1]);
  while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  const req = createRequire(path.join(dir, 'package.json'));
  const pkg = req.resolve('wrangler/package.json');
  const bin = JSON.parse(fs.readFileSync(pkg, 'utf8')).bin;
  console.log(path.join(path.dirname(pkg), typeof bin === 'string' ? bin : bin.wrangler));
" "$ADAPTER_PATH")"
test -f "$WRANGLER_ENTRY" || fail "wrangler entry not found at $WRANGLER_ENTRY"

FAILED=0
# check <label> <expected: JSON subset, or a substring of the HTML> <curl args…>
check() {
  local label="$1" expect="$2"; shift 2
  local out code body
  out="$(curl -sS -D "$WORK/headers.txt" -w $'\n%{http_code}' "$@" || true)"
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$code" = "200" ] && node -e '
      const [expect, body] = process.argv.slice(1);
      if (!expect.startsWith("{")) process.exit(body.includes(expect) ? 0 : 1);
      const want = JSON.parse(expect), got = JSON.parse(body);
      process.exit(Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v)) ? 0 : 1);
    ' "$expect" "$body" 2>/dev/null; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s -> HTTP %s: %s\n' "$label" "$code" "${body:0:300}"
    FAILED=$((FAILED + 1))
  fi
}

# run_variant <name> <x-from-mw value expected from middleware, as JSON>
run_variant() {
  local name="$1" mw="$2"
  cd "$APP"
  rm -rf .next .creek/adapter-output
  log "[$name] Building the fixture: next build ${BUILD_FLAG:-(Turbopack)}"
  # shellcheck disable=SC2086
  NEXT_ADAPTER_PATH="$ADAPTER_PATH" npx next build $BUILD_FLAG
  local server_dir="$APP/.creek/adapter-output/server"
  test -f "$server_dir/worker.js" || fail "[$name] adapter did not emit worker.js"

  log "[$name] Starting workerd via wrangler dev on :$PORT"
  # --no-bundle: serve the EMITTED worker.js as the upload does, not a re-bundle.
  (cd "$server_dir" && exec node "$WRANGLER_ENTRY" dev --port "$PORT" --no-bundle) >"$WORK/wrangler.log" 2>&1 &
  WRANGLER_PID=$!
  local code
  for _ in $(seq 1 60); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/node" 2>/dev/null || true)"
    [ -n "$code" ] && [ "$code" != "000" ] && break
    kill -0 "$WRANGLER_PID" 2>/dev/null || { cat "$WORK/wrangler.log" >&2; fail "[$name] wrangler dev exited before serving"; }
    sleep 2
  done

  log "[$name] Checking routes (bundler: ${E2E_BUNDLER:-webpack})"
  check "pages API, edge"                 "{\"route\":\"pages-edge\",\"header\":$mw,\"url\":\"/api/edge\"}" "$BASE/api/edge"
  check "pages API, edge, query"          "{\"method\":\"GET\",\"q\":\"hi\",\"header\":$mw}" "$BASE/api/edge-echo?q=hi"
  check "pages API, edge, POST body"      '{"method":"POST","body":"hello-body"}' -X POST -H 'content-type: text/plain' --data 'hello-body' "$BASE/api/edge-echo"
  check "pages API, edge, dynamic"        '{"id":"42"}' "$BASE/api/edge-dyn/42"
  check "app route, edge"                 "{\"route\":\"app-edge\",\"header\":$mw}" "$BASE/edge-route"
  check "app route, edge, dynamic"        '{"slug":"abc"}' "$BASE/edge-dyn/abc"
  check "app route, edge, POST json"      '{"echoed":{"a":1}}' -X POST -H 'content-type: application/json' --data '{"a":1}' "$BASE/edge-dyn/abc"
  check "app page, edge"                  'edge app page, runtime <!-- -->edge' "$BASE/edge-page"
  check "pages SSR, edge"                 'edge pages ssr q=<!-- -->zz' "$BASE/edge-ssr?q=zz"
  check "pages SSR, edge, dynamic"        'slug=<!-- -->hello<!-- --> q=<!-- -->1' "$BASE/edge-ssr-dyn/hello?q=1"
  if [ "$mw" != "null" ]; then
    # Middleware rewrites: the URL keeps the original path, so the route
    # params reach the edge entry only through the rewrite.
    check "rewrite -> pages SSR, edge"    'slug=<!-- -->world<!-- --> q=<!-- -->2' "$BASE/rw/world?q=2"
    check "rewrite -> pages API, edge"    '{"id":"77"}' "$BASE/rwapi/77"
  fi
  # Under a route group the page's manifest is keyed "/(shop)/grouped/[id]";
  # the render must still find it, or the page's client chunk is left out.
  check "RSC payload, route group"        'static/chunks/app/(shop)/grouped/%5Bid%5D/page-' -H 'RSC: 1' "$BASE/grouped/1"
  check "pages API, node (control)"       "{\"route\":\"pages-node\",\"header\":$mw}" "$BASE/api/node"
  check "app route, node (control)"       "{\"route\":\"app-node\",\"header\":$mw}" "$BASE/node-route"

  kill "$WRANGLER_PID" 2>/dev/null || true
  wait "$WRANGLER_PID" 2>/dev/null || true
  WRANGLER_PID=""
  if [ "$FAILED" -gt 0 ]; then
    echo; tail -40 "$WORK/wrangler.log" >&2
    fail "[$name] $FAILED route check(s) failed"
  fi
}

BASE="http://127.0.0.1:$PORT"
run_variant "with middleware" '"yes"'
rm "$APP/middleware.js"
run_variant "without middleware" 'null'

log "PASS — every edge route served 200 in workerd, with and without middleware"

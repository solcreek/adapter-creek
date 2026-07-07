#!/usr/bin/env bash
#
# E2E: build a Prisma-on-D1 Next.js fixture through the Creek lazy-install
# layout, then RUN the emitted worker in workerd and hit the D1 route.
#
# This is the publish gate for the class of bug that shipped in 0.2.13: the
# build produced a valid-looking worker.js, but at runtime `new n.PrismaD1(...)`
# threw "PrismaD1 is not a constructor" (the default-on minify pass corrupted
# the @prisma/adapter-d1 interop), 500-ing every D1-backed page. A build-only
# check (does worker.js exist?) cannot catch a runtime-only break — only
# executing the worker in the real runtime does. That is the whole point of
# this script: it does not stop at "built", it asserts the route returns 200.
#
# The build steps mirror creek's packages/cli/src/utils/nextjs.ts
# (installCreekDep + buildWithAdapter) — same manifest shape, npm flags, and
# build invocation as a real deploy. The run step mirrors what workerd does on
# Cloudflare: `wrangler dev` serves the emitted worker.js + wrangler.toml.
#
# Usage: e2e/prisma-d1/run.sh   (from the repo root; needs network + wrangler)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/e2e/prisma-d1/fixture"
PORT="${E2E_PORT:-8799}"
ROUTE="/api/prisma-d1"

# CI robustness: no interactive metrics prompt from wrangler (would hang a
# non-TTY run). The wrangler binary itself is resolved from the adapter's .creek
# dependency tree below, not a floating `npx` download.
export WRANGLER_SEND_METRICS=false

# Minify mode. Default OFF (the safe default shipped since 0.2.14). Set
# E2E_MINIFY=1 to exercise the opt-in minify pass (CREEK_ADAPTER_MINIFY) so the
# gate proves minify-ON *also* serves Prisma-D1 — i.e. it does not reproduce the
# 0.2.13 "PrismaD1 is not a constructor" runtime break. Same 200 assertion both
# ways; the adapter logs the size reduction.
if [ "${E2E_MINIFY:-0}" = "1" ]; then
  export CREEK_ADAPTER_MINIFY=1
  MINIFY_MODE="ON (CREEK_ADAPTER_MINIFY=1)"
else
  MINIFY_MODE="off (default)"
fi

log() { printf '\n\033[1m[e2e:prisma-d1] %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m[e2e:prisma-d1] FAIL: %s\033[0m\n' "$*" >&2; exit 1; }

log "Building adapter and packing tarball (the EXACT bytes npm would publish)"
cd "$REPO_ROOT"
pnpm build
TARBALL="$REPO_ROOT/$(npm pack --silent | tail -1)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/adapter-creek-prisma-d1-e2e.XXXXXX")"
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

log "Installing fixture deps (next, react, prisma client + adapters, runtime)"
npm install --no-audit --no-fund --silent

log "Generating the Prisma client (mirrors creek ensurePrismaClient)"
npx --no-install prisma generate

log "Lazy-installing adapter into .creek/node_modules (mirrors creek installCreekDep)"
mkdir -p .creek
node -e "
  const { writeFileSync } = require('node:fs');
  writeFileSync('.creek/package.json', JSON.stringify({
    private: true,
    dependencies: { '@solcreek/adapter-creek': 'file:' + process.argv[1] },
  }, null, 2));
" "$TARBALL"
(cd .creek && npm install --no-audit --no-fund --ignore-scripts)

# wrangler is a runtime dependency of the adapter, so it's resolved from the
# adapter's own .creek dependency tree — use that binary rather than a floating
# `npx wrangler` download so the gate exercises the same wrangler a real deploy
# would, not whatever npx fetches.
WRANGLER="$APP/.creek/node_modules/.bin/wrangler"
test -x "$WRANGLER" || fail "wrangler not found in the adapter's .creek dependency tree at $WRANGLER"

ADAPTER_PATH="$(node -e "
  const { createRequire } = require('node:module');
  const { join } = require('node:path');
  console.log(createRequire(join(process.cwd(), '.creek', 'package.json'))
    .resolve('@solcreek/adapter-creek'));
")"

# The gate asserts the built worker serves the D1 route, so any future change
# that breaks the Prisma-D1 path (minify off OR on) is caught before publish.
log "Building fixture with the adapter — minify $MINIFY_MODE"
NEXT_ADAPTER_PATH="$ADAPTER_PATH" npx next build --webpack

SERVER_DIR="$APP/.creek/adapter-output/server"
test -f "$SERVER_DIR/worker.js" || fail "adapter did not emit worker.js"
test -f "$SERVER_DIR/wrangler.toml" || fail "adapter did not emit wrangler.toml"

# Bind a local D1 named DB — the Prisma-on-D1 swap shim resolves the request's
# binding as `env.DB`. In `wrangler dev`'s default local mode this is backed by
# a throwaway sqlite under .wrangler/state.
log "Adding a local D1 binding (env.DB) for the run"
cat >> "$SERVER_DIR/wrangler.toml" <<'TOML'

[[d1_databases]]
binding = "DB"
database_name = "e2e-prisma-d1"
database_id = "e2e-local"
TOML

log "Seeding the Note table into the local D1 (model queries need it)"
cd "$SERVER_DIR"
"$WRANGLER" d1 execute e2e-prisma-d1 --local \
  --command "CREATE TABLE IF NOT EXISTS Note (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)" \
  >"$WORK/seed.log" 2>&1 || { cat "$WORK/seed.log" >&2; fail "could not seed local D1"; }

log "Starting workerd via wrangler dev on :$PORT"
# --no-bundle: serve the adapter's EMITTED worker.js as-is (matching the
# WfP upload path, which does not re-bundle), so the gate tests the real
# artifact rather than a wrangler re-bundle that could mask emitted-bundle bugs.
"$WRANGLER" dev --port "$PORT" --no-bundle >"$WORK/wrangler.log" 2>&1 &
WRANGLER_PID=$!

log "Waiting for the worker to come up"
URL="http://127.0.0.1:$PORT$ROUTE"
ready=""
for _ in $(seq 1 60); do
  # Any HTTP response (even 500) means the worker is up — don't use -f, or a
  # 500 from a broken build would look like "not ready" and mask the failure.
  CODE="$(curl -sS -o "$WORK/body.txt" -w '%{http_code}' "$URL" 2>/dev/null || true)"
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
    echo "$CODE" >"$WORK/code.txt"; ready="1"; break
  fi
  # Bail early if wrangler died.
  kill -0 "$WRANGLER_PID" 2>/dev/null || { cat "$WORK/wrangler.log" >&2; fail "wrangler dev exited before serving"; }
  sleep 2
done
[ -n "$ready" ] || { cat "$WORK/wrangler.log" >&2; fail "worker did not become ready within ~120s"; }

CODE="$(cat "$WORK/code.txt")"
BODY="$(cat "$WORK/body.txt")"
log "GET $ROUTE -> HTTP $CODE"
echo "  body: $BODY"

# The regression signature: a 500 whose body carries the Prisma-D1 failure
# (e.g. "PrismaD1 is not a constructor" from 0.2.13's minify).
if echo "$BODY" | grep -q "PRISMA_D1_FAIL"; then
  fail "Prisma-D1 query broke at runtime (the 0.2.13-class regression): $BODY"
fi
[ "$CODE" = "200" ] || fail "expected HTTP 200 from $ROUTE, got $CODE"
# Parse the JSON and assert ok === true — robust to whitespace / key ordering,
# unlike a substring grep for `"ok":true`.
node -e 'process.exit(JSON.parse(process.argv[1]).ok === true ? 0 : 1)' "$BODY" \
  || fail "route did not report ok:true — body: $BODY"

log "PASS — Prisma-D1 route constructed and served 200 in workerd"

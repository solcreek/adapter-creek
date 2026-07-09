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

log() { printf '\n\033[1m[e2e:prisma-d1] %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m[e2e:prisma-d1] FAIL: %s\033[0m\n' "$*" >&2; exit 1; }

# Minify mode. Default OFF (the safe default shipped since 0.2.14). E2E_MINIFY,
# when set, is the AUTHORITATIVE control: it forces CREEK_ADAPTER_MINIFY on/off
# so neither gate leg can be corrupted by an inherited env (a leaked
# CREEK_ADAPTER_MINIFY=1 must not silently minify the "off" run), and an invalid
# value fails fast rather than quietly defaulting to off. When E2E_MINIFY is
# unset, a directly-set CREEK_ADAPTER_MINIFY is honored (matches the docs'
# `CREEK_ADAPTER_MINIFY=1 run.sh` invocation). The log reflects the resolved mode.
# minify-ON proves the pass also serves Prisma-D1 — it does not reproduce the
# 0.2.13 "PrismaD1 is not a constructor" break. Same 200 assertion both ways.
if [ -n "${E2E_MINIFY:-}" ]; then
  case "$E2E_MINIFY" in
    0) export CREEK_ADAPTER_MINIFY=0 ;;
    1) export CREEK_ADAPTER_MINIFY=1 ;;
    *) fail "E2E_MINIFY must be 0 or 1 (got '$E2E_MINIFY')" ;;
  esac
fi
if [ "${CREEK_ADAPTER_MINIFY:-0}" = "1" ]; then
  MINIFY_MODE="ON (CREEK_ADAPTER_MINIFY=1)"
elif [ "${E2E_MINIFY:-}" = "0" ]; then
  MINIFY_MODE="off (forced by E2E_MINIFY=0)"
else
  MINIFY_MODE="off (default)"
fi

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

log "Lazy-installing adapter + @prisma/adapter-d1 into .creek/node_modules (mirrors creek installCreekDep + ensurePrismaD1)"
# @prisma/adapter-d1 lives ONLY in .creek here, NOT as a fixture direct dep —
# that's exactly how the Creek CLI provides it (users don't list it; the
# zero-change promise). Listing it as a direct dep, as this fixture used to,
# made webpack bundle it and silently masked the real-world bug: with it in
# .creek only, Next's server build externalizes it to an empty module and every
# D1-backed request 500s with "PrismaD1 is not a constructor". The adapter's
# resolvePrismaD1Alias() forces it to bundle regardless; this gate now proves it.
mkdir -p .creek
node -e "
  const { writeFileSync, readFileSync } = require('node:fs');
  // Derive @prisma/adapter-d1's version from the fixture's @prisma/client, the
  // same way the CLI's ensurePrismaD1 does — so it can't drift from the rest of
  // the Prisma stack when the fixture is bumped.
  const prismaVersion = JSON.parse(readFileSync('package.json', 'utf8')).dependencies['@prisma/client'];
  writeFileSync('.creek/package.json', JSON.stringify({
    private: true,
    dependencies: {
      '@solcreek/adapter-creek': 'file:' + process.argv[1],
      '@prisma/adapter-d1': prismaVersion,
    },
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

# @prisma/adapter-d1 bundled-not-externalized gate. When the package sits only
# in .creek (the real CLI flow, as set up above), Next's server build
# externalizes the bare import to an empty module and `new PrismaD1(...)` throws
# "PrismaD1 is not a constructor" at runtime. resolvePrismaD1Alias() forces it
# to bundle. `PrismaD1Http` is a sibling export that appears ONLY when the
# package's real code is bundled — the shim's own `new n.PrismaD1(...)` refs
# don't include it — and it survives minify as a string label. Its absence
# means the externalize-to-empty regression is back. The runtime 200 below is
# the ultimate proof, but this fails fast with a precise message.
log "Asserting @prisma/adapter-d1 is bundled (not externalized to an empty module)"
grep -q "PrismaD1Http" "$SERVER_DIR/worker.js" || fail "@prisma/adapter-d1 was externalized to an empty module — PrismaD1 is not bundled (the sign-in 'PrismaD1 is not a constructor' regression)"

# B11 regression gate: no two emitted wasm siblings may carry identical bytes.
# The shipped-twice Prisma query compiler (a dynamic wasm-worker-loader import
# AND our staged CompiledWasm static import, same content, ~3.5MB each) is the
# exact duplicate `dedupeEmittedWasm` collapses — assert it stayed collapsed.
# md5 each wasm; a repeated digest means a duplicate slipped back in.
log "Asserting no byte-identical wasm siblings (B11 duplicate gate)"
DUP_DIGESTS="$(
  for w in "$SERVER_DIR"/*.wasm; do
    [ -e "$w" ] || continue
    md5 -q "$w" 2>/dev/null || md5sum "$w" | awk '{print $1}'
  done | sort | uniq -d
)"
if [ -n "$DUP_DIGESTS" ]; then
  log "emitted wasm:"; ls -la "$SERVER_DIR"/*.wasm >&2 || true
  fail "byte-identical wasm siblings emitted (B11 duplicate regressed): digest(s) $DUP_DIGESTS"
fi

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

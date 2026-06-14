#!/usr/bin/env bash
#
# E2E: build a Next.js fixture through the Creek CLI's lazy-install layout.
#
# This is the publish gate for the class of bug that shipped in 0.2.0
# (cache-handler path) and 0.2.1 (wrangler bin path): adapter code that
# resolves its own dependencies by guessing paths instead of using Node
# module resolution. Those guesses happen to work in this repo's checkout
# and break only in the layout real users get — the Creek CLI installs the
# adapter into <project>/.creek/node_modules with npm, which HOISTS the
# adapter's dependencies to the top of that tree.
#
# The install steps below mirror creek's packages/cli/src/utils/nextjs.ts
# (installCreekDep + buildWithAdapter) — same manifest shape, same npm
# flags, same build invocation. If the CLI changes those, update this
# script to match (and vice versa).
#
# Note: the .creek install must NOT pass --no-optional. wrangler's bundler
# (workerd) ships its platform binary (@cloudflare/workerd-<plat>) as an
# optionalDependency; omitting optionals makes the worker bundle step fail
# with "package could not be found, and is needed by workerd".
#
# Usage: e2e/lazy-install/run.sh   (from the repo root; needs network)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/e2e/lazy-install/fixture"

log() { printf '\n\033[1m[e2e] %s\033[0m\n' "$*"; }

log "Building adapter and packing tarball (tests the EXACT bytes npm would publish)"
cd "$REPO_ROOT"
pnpm build
TARBALL="$REPO_ROOT/$(npm pack --silent | tail -1)"
trap 'rm -f "$TARBALL"; rm -rf "${WORK:-}"' EXIT

WORK="$(mktemp -d "${TMPDIR:-/tmp}/adapter-creek-e2e.XXXXXX")"
APP="$WORK/app"
log "Fixture project: $APP"
cp -R "$FIXTURE_DIR/." "$APP"

log "Installing fixture deps (the user's own project install)"
cd "$APP"
npm install --no-audit --no-fund --silent

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

log "Verifying npm hoisted wrangler to the top of .creek/node_modules"
test -e .creek/node_modules/.bin/wrangler \
  || { echo "FAIL: expected hoisted .creek/node_modules/.bin/wrangler"; exit 1; }
test ! -e .creek/node_modules/@solcreek/adapter-creek/node_modules/.bin/wrangler \
  || echo "WARN: nested .bin/wrangler exists — hoisting didn't happen; test is weaker than intended"

log "Resolving adapter entry from .creek (mirrors creek resolveAdapterPath)"
ADAPTER_PATH="$(node -e "
  const { createRequire } = require('node:module');
  const { join } = require('node:path');
  console.log(createRequire(join(process.cwd(), '.creek', 'package.json'))
    .resolve('@solcreek/adapter-creek'));
")"
echo "  NEXT_ADAPTER_PATH=$ADAPTER_PATH"

log "Building fixture with the adapter (mirrors creek buildWithAdapter)"
NEXT_ADAPTER_PATH="$ADAPTER_PATH" npx next build --webpack

log "Asserting adapter outputs"
for f in .creek/adapter-output/manifest.json .creek/adapter-output/server/worker.js; do
  test -f "$f" || { echo "FAIL: missing $f"; exit 1; }
  echo "  ok: $f"
done

log "PASS — lazy-install build produced a complete worker bundle"

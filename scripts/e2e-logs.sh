#!/usr/bin/env bash
# Next.js adapter test suite — logs script
# Contract: output must include BUILD_ID:, DEPLOYMENT_ID:, IMMUTABLE_ASSET_TOKEN: lines.
set -euo pipefail

if [ -f ".adapter-build.log" ]; then
  cat ".adapter-build.log"
fi

# Replay the captured \`next build\` output so deprecation warnings and
# other build-phase diagnostics appear in \`cliOutput\`. Tests like
# app-middleware "should warn when deprecated middleware file is used"
# and cache-components-unstable-deprecations assert on these strings.
if [ -f ".adapter-build-cli.log" ]; then
  echo "=== build log ==="
  cat ".adapter-build-cli.log"
fi

if [ -f ".adapter-server.log" ]; then
  echo "=== server log ==="
  tail -100 ".adapter-server.log"
fi

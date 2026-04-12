#!/usr/bin/env bash
# Local test runner for adapter-creek e2e tests.
#
# Usage:
#   ./scripts/local-test.sh                           # Run all e2e tests (2 concurrent)
#   ./scripts/local-test.sh test/e2e/app-dir/app      # Run a single test
#   ./scripts/local-test.sh -g 1/4                    # Run test group 1 of 4
#
# Prerequisites:
#   1. Next.js repo cloned at ./nextjs (git clone --depth 25 --branch canary https://github.com/vercel/next.js nextjs)
#   2. Next.js built: cd nextjs && pnpm install && pnpm build && pnpm install
#   3. Playwright installed: cd nextjs && pnpm playwright install chromium
#   4. Adapter built: pnpm build
#
# Environment variables:
#   CONCURRENCY  — parallel test workers (default: 2)
#   NEXT_REF     — Next.js branch/tag to use (default: canary)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
NEXTJS_DIR="${ADAPTER_DIR}/nextjs"

# Check prerequisites
if [ ! -d "${NEXTJS_DIR}" ]; then
  echo "Error: Next.js repo not found at ${NEXTJS_DIR}"
  echo ""
  echo "Setup:"
  echo "  cd ${ADAPTER_DIR}"
  echo "  git clone --depth 25 --branch canary https://github.com/vercel/next.js nextjs"
  echo "  cd nextjs && pnpm install && pnpm build && pnpm install"
  echo "  pnpm playwright install chromium"
  exit 1
fi

if [ ! -f "${NEXTJS_DIR}/node_modules/.package-lock.json" ] && [ ! -d "${NEXTJS_DIR}/node_modules/.pnpm" ]; then
  echo "Error: Next.js dependencies not installed. Run:"
  echo "  cd ${NEXTJS_DIR} && pnpm install && pnpm build && pnpm install"
  exit 1
fi

# Rebuild adapter if source changed
echo "[local-test] Building adapter..."
(cd "${ADAPTER_DIR}" && pnpm build) 2>&1

# Make scripts executable
chmod +x "${ADAPTER_DIR}/scripts/e2e-deploy.sh"
chmod +x "${ADAPTER_DIR}/scripts/e2e-logs.sh"
chmod +x "${ADAPTER_DIR}/scripts/e2e-cleanup.sh"

CONCURRENCY="${CONCURRENCY:-2}"

# Build test runner args
TEST_ARGS=()
if [ $# -gt 0 ]; then
  # If first arg is -g, pass group argument
  if [ "$1" = "-g" ]; then
    TEST_ARGS+=("-g" "$2")
    shift 2
  else
    # Treat as test file path
    TEST_ARGS+=("$@")
  fi
fi

echo "[local-test] Running e2e tests (concurrency: ${CONCURRENCY})..."
echo ""

cd "${NEXTJS_DIR}"

export NEXT_TEST_MODE=deploy
export NEXT_E2E_TEST_TIMEOUT=240000
export ADAPTER_DIR="${ADAPTER_DIR}"
export IS_TURBOPACK_TEST=1
export NEXT_TEST_JOB=1
export NEXT_TELEMETRY_DISABLED=1
export NEXT_EXTERNAL_TESTS_FILTERS=test/deploy-tests-manifest.json
export NEXT_TEST_DEPLOY_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-deploy.sh"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-logs.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-cleanup.sh"

node run-tests.js --type e2e -c "${CONCURRENCY}" "${TEST_ARGS[@]}"

#!/usr/bin/env bash
# Apply upstream test patches to the checked-out Next.js tree.
#
# Patches live in scripts/patches/*.patch. Each one cherry-picks a
# specific commit from vercel/next.js canary that landed after the tag
# we pin to. See scripts/patches/README.md for the full list and why.
#
# Idempotent: patches already applied are skipped (detected via `git
# apply --reverse --check`), not treated as errors.
#
# Usage:
#   scripts/apply-nextjs-patches.sh <path-to-nextjs>
set -euo pipefail

NEXTJS_DIR="${1:-}"
if [ -z "${NEXTJS_DIR}" ] || [ ! -d "${NEXTJS_DIR}" ]; then
  echo "[apply-nextjs-patches] usage: $0 <path-to-nextjs-checkout>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCHES_DIR="${SCRIPT_DIR}/patches"

if [ ! -d "${PATCHES_DIR}" ] || ! ls "${PATCHES_DIR}"/*.patch >/dev/null 2>&1; then
  echo "[apply-nextjs-patches] no patches to apply"
  exit 0
fi

cd "${NEXTJS_DIR}"

for patch in "${PATCHES_DIR}"/*.patch; do
  name="$(basename "${patch}")"
  # Already applied? `--reverse --check` succeeds when the patch can be
  # undone — i.e. it's already in the tree.
  if git apply --reverse --check "${patch}" >/dev/null 2>&1; then
    echo "[apply-nextjs-patches] skip ${name} (already applied)"
    continue
  fi
  # Can the patch apply cleanly?
  if ! git apply --check "${patch}" >/dev/null 2>&1; then
    echo "[apply-nextjs-patches] SKIP ${name}: does not apply cleanly" >&2
    echo "  (tree may have moved past the patch's target — check scripts/patches/README.md)" >&2
    continue
  fi
  git apply "${patch}"
  echo "[apply-nextjs-patches] applied ${name}"
done

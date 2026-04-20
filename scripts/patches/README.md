# nextjs/ upstream test patches

Patches applied to the checked-out Next.js tree before running e2e tests.

Per Next.js's official adapter-testing docs, CI tracks the `canary`
branch (that's the default in
`.github/workflows/test-e2e-deploy.yml`). Most upstream test fixes are
already in canary, so these patches are primarily safety nets for when
a local checkout is behind canary (e.g. running against a stable tag
like `v16.2.4`, which does NOT receive test-only back-ports). The apply
script is idempotent — patches already in the target tree are detected
via `git apply --reverse --check` and skipped.

## How they're applied

`scripts/apply-nextjs-patches.sh` runs `git apply` on every `.patch` file
in this directory. Called from:

- `scripts/local-test.sh` (after the adapter build, before running tests)
- `.github/workflows/test-e2e-deploy.yml` (in the build job, after
  checking out `vercel/next.js`)

The script is idempotent — patches that are already applied are skipped
with a warning rather than failing.

## Patches

### `0001-unflake-prefetching-uri-encoded.patch`

- **Upstream commit**: `c53f5863e3` — [vercel/next.js#91734](https://github.com/vercel/next.js/pull/91734)
- **Date**: 2026-03-23
- **What**: wraps the accordion-present assertion in
  `prefetching.test.ts` with `retry()`. The original test does a
  synchronous DOM query right after `page.click()`, which races React 19's
  `startTransition()` commit (~15 ms). Vercel's own CI also flaked here
  ([Datadog metric linked in the PR](https://github.com/vercel/next.js/pull/91734)) —
  unflaking is a test-only change.
- **When to drop**: once our pinned Next.js ref includes `c53f5863e3`.

# nextjs/ upstream test patches

Patches applied to the checked-out Next.js tree before running e2e tests.
Each patch cherry-picks a specific upstream fix that landed after the
Next.js tag we pin to (`v16.2.1` in CI, `v16.2.3` locally) but is
relevant to tests this adapter runs.

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

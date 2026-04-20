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

### `0002-revert-react-441-test-expectations.patch`

- **Upstream commit this reverts**: `4fc3664eed` — [vercel/next.js#92945](https://github.com/vercel/next.js/pull/92945)
  ("Upgrade React from `fef12a01-20260413` to `da9325b5-20260417`")
- **Date of upstream**: 2026-04-20
- **What**: reverts the test expectation from `Minified React error #441`
  back to `An error occurred in the Server Components render. The
  specific message is omitted...`. The React upgrade that produces the
  `#441` format landed on canary branch on Apr 20 but hasn't been
  published as a `next@canary` npm tag yet — the current published tag
  (`next@16.3.0-canary.2`, cut Apr 18) still bundles the older React.
  The test harness installs `next` from npm (`pnpm install`), so even
  when our local `nextjs/` checkout is canary HEAD, the fixture ends up
  with the older compiled React and produces the older error text.
- **When to drop**: once `npm view next@canary` returns a version
  that includes commit `4fc3664eed`. Verify with:
  ```
  npm pack next@canary --pack-destination /tmp
  tar -xzf /tmp/next-*.tgz -C /tmp/next-check --strip-components=1
  grep -l "Minified React error #441" /tmp/next-check/dist/compiled/react-server-dom-webpack*/cjs/*.browser.production.js
  ```
  If that grep finds a match, the patch is no longer needed.

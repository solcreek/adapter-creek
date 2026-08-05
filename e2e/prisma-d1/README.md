# e2e/prisma-d1 — Prisma-on-D1 runtime gate

Builds a Next.js fixture that mirrors the flagship Creek stack — Prisma 7
driver-adapter (`@prisma/adapter-better-sqlite3`, swapped to D1 at build) +
Better Auth + a real model query — through the CLI's lazy-install layout, then
**runs the emitted worker in workerd (`wrangler dev`) and asserts the route
returns 200**. Unlike `e2e/lazy-install` (which only checks that `worker.js`
was produced), this executes the worker, so it catches runtime-only breakage
in the Prisma-on-D1 path.

Run: `e2e/prisma-d1/run.sh` (needs network; wrangler is resolved from the
adapter's own dependency tree via the `.creek` lazy-install, not `npx`). Minify
is on by default; opt out with `CREEK_ADAPTER_MINIFY=0`.

**CI:** this gate runs in `checks.yml` (every PR + push to `main`) and again in
`publish.yml` right before `npm publish`, so a runtime regression blocks the
release instead of shipping. It serves the emitted `worker.js` via
`wrangler dev --no-bundle`, so it tests the exact artifact WfP uploads (not a
wrangler re-bundle).

## Minify modes

The gate runs **both** ways (CI matrix + both steps in `publish.yml`):

- **minify on** — the default. `E2E_MINIFY=1` forces it explicitly for the CI
  leg. On this fixture minify shrinks worker.js ~5.2MB → 3.3MB (−36%).
- **minify off** — `E2E_MINIFY=0` forces `CREEK_ADAPTER_MINIFY=0`, keeping the
  escape hatch honest (an unminified build must serve identically).

Why the default is on: 0.2.13 shipped minify on and was blamed for the
"PrismaD1 is not a constructor" break; 0.2.14 turned it off. The 0.2.17
root-cause analysis (commit 0dfa03e) overturned that blame — the break was
`@prisma/adapter-d1` being externalized to an empty module, present since
0.2.10 and identical with minify off ("minify was a red herring"). With the
misattribution cleared and this gate running both legs on every PR and every
publish, minify is on by default; `CREEK_ADAPTER_MINIFY=0` remains for
debugging the emitted worker.

## B11 duplicate-wasm gate

After the build, `run.sh` md5s every `*.wasm` in the server output and fails if
any two are byte-identical. The B11 bug shipped the ~3.5MB Prisma query compiler
**twice** — once as our staged `CompiledWasm` static import
(`…query_compiler_fast_bg.sqlite.wasm`) and once as Next's wasm worker-loader
dynamic `import("./…query_compiler_fast_bg.wasm")`, same content, same wrangler
hash prefix, different basename. The pre-bundle map dedup (`dedupeWasmByContent`)
never saw the worker-loader copy; `dedupeEmittedWasm` collapses it on the final
artifacts and repoints the loader to the kept file.

**Honest coverage note:** this fixture emits only ONE wasm — it does *not*
naturally reproduce the two-emit-path duplicate (that needs a real app's fuller
Prisma client graph). So this assertion is a belt-and-suspenders regression
guard; the actual collapse-and-repoint logic is verified deterministically in
`src/bundler.test.ts` against a fixture built from a customer's real `worker.js`
`.wasm` reference lines, plus an end-to-end run that injects the duplicate into
a real build output and confirms the deduped worker still serves 200 in workerd.

## Status / known limitation

This gate does NOT reproduce the *specific* 0.2.13 failure
("PrismaD1 is not a constructor") — that break was minifier-input-dependent
and did not manifest here even with the customer's exact package versions,
Better Auth in the bundle, the model-query path, and 0.2.13's byte-identical
minify pass; it appears to need the fuller module graph of a real production
app. So this is a general Prisma-D1-on-workerd runtime gate (now covering both
minify modes), not a reproduction of that one bug.

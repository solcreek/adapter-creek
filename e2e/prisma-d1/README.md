# e2e/prisma-d1 — Prisma-on-D1 runtime gate

Builds a Next.js fixture that mirrors the flagship Creek stack — Prisma 7
driver-adapter (`@prisma/adapter-better-sqlite3`, swapped to D1 at build) +
Better Auth + a real model query — through the CLI's lazy-install layout, then
**runs the emitted worker in workerd (`wrangler dev`) and asserts the route
returns 200**. Unlike `e2e/lazy-install` (which only checks that `worker.js`
was produced), this executes the worker, so it catches runtime-only breakage
in the Prisma-on-D1 path.

Run: `e2e/prisma-d1/run.sh` (needs network + wrangler). Opt into the minify
pass with `CREEK_ADAPTER_MINIFY=1`.

## Status / known limitation

This gate does NOT currently reproduce the specific 0.2.13 regression
("PrismaD1 is not a constructor"). That break was minifier-input-dependent:
it did not manifest here even with the customer's exact package versions,
Better Auth in the bundle, the model-query path, and 0.2.13's byte-identical
minify pass. It appears to require the fuller module graph of a real
production app. This fixture is therefore a general Prisma-D1-on-workerd smoke
test and a foundation to extend, not yet a reproduction of that bug.

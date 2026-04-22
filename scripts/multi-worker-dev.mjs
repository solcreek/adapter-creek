#!/usr/bin/env node
// Creek adapter — local multi-worker launcher.
//
// Starts the dispatcher + node-runtime + edge-runtime bundles produced by
// `CREEK_MULTI_WORKER=1 pnpm build` in a single miniflare process, wires up
// service bindings between them, and listens on a single port.
//
// Run AFTER a fixture has been built with CREEK_MULTI_WORKER=1:
//   CREEK_MULTI_WORKER=1 pnpm build                  (in a fixture dir)
//   node scripts/multi-worker-dev.mjs <fixture-dir> [--port=8899]
//
// The URL written to stdout is what the test harness sends requests to.
// All diagnostics go to stderr.
import { Miniflare } from "miniflare";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const fixtureArg = args.find((a) => !a.startsWith("-"));
if (!fixtureArg) {
  console.error("usage: multi-worker-dev.mjs <fixture-dir> [--port=N]");
  process.exit(2);
}

const fixtureDir = resolve(fixtureArg);
const outputRoot = join(fixtureDir, ".creek/adapter-output");
const dispatcherScript = join(outputRoot, "dispatcher/worker.js");
const nodeScript = join(outputRoot, "node-runtime/worker.js");
const edgeScript = join(outputRoot, "edge-runtime/worker.js");

for (const [label, p] of [
  ["dispatcher", dispatcherScript],
  ["node-runtime", nodeScript],
  ["edge-runtime", edgeScript],
]) {
  if (!existsSync(p)) {
    console.error(`[multi-worker-dev] missing ${label} bundle at ${p}`);
    console.error(
      `[multi-worker-dev] did you run \`CREEK_MULTI_WORKER=1 pnpm build\` in ${fixtureDir}?`,
    );
    process.exit(1);
  }
}

const portArg = args.find((a) => a.startsWith("--port="));
const port = portArg ? parseInt(portArg.split("=")[1], 10) : 8899;

// The node-runtime worker contains the full single-worker bundle, so it
// needs every binding that bundle normally consumes — ASSETS, Durable
// Objects, env vars. The dispatcher's only job right now is to forward,
// so it only needs the service bindings to reach the runtime workers.
//
// Phase 2b will move ASSETS onto the dispatcher (for static fast path)
// once middleware + routing live there. Until then, placing ASSETS on
// the node-runtime keeps the existing worker-entry code working
// unchanged on its \`env.ASSETS.fetch()\` call sites.
const nodeAssetsDir = join(outputRoot, "assets");
const mf = new Miniflare({
  port,
  workers: [
    {
      name: "dispatcher",
      modules: true,
      scriptPath: dispatcherScript,
      serviceBindings: {
        NODE_WORKER: "node-runtime",
        EDGE_WORKER: "edge-runtime",
      },
    },
    {
      name: "node-runtime",
      // Pass the bundled worker.js as an explicit single ESModule. Using
      // \`modules: true\` + \`scriptPath\` triggers miniflare's acorn-based
      // import walker which throws on the \`import(varName)\` pattern our
      // adapter bundle uses for lazy handler loading. Providing the
      // module list manually bypasses the walker and lets workerd itself
      // resolve dynamic specifiers at runtime (which it does fine).
      modules: [{ type: "ESModule", path: nodeScript }],
      compatibilityDate: "2026-03-23",
      compatibilityFlags: ["nodejs_compat"],
      assets: {
        directory: nodeAssetsDir,
        binding: "ASSETS",
        // Match the single-worker wrangler.toml's \`run_worker_first = true\`
        // — the adapter's worker.js owns routing for every URL (including
        // ones that look like assets), then explicitly delegates to
        // \`env.ASSETS.fetch()\` where appropriate. Miniflare's SDK nests
        // this under \`routerConfig.invoke_user_worker_ahead_of_assets\`.
        // Without it, miniflare serves matched files directly and 404s
        // unknowns, bypassing middleware and routing entirely.
        routerConfig: {
          invoke_user_worker_ahead_of_assets: true,
          has_user_worker: true,
        },
      },
      // Declare + bind the same DO classes the single-worker wrangler.toml
      // uses. Miniflare auto-provisions these locally — SQLite-backed per
      // our \`new_sqlite_classes\` migration.
      durableObjects: {
        NEXT_CACHE_DO_QUEUE: { className: "DOQueueHandler", useSQLite: true },
        NEXT_TAG_CACHE_DO_SHARDED: { className: "DOShardedTagCache", useSQLite: true },
        NEXT_CACHE_DO_BUCKET_PURGE: { className: "BucketCachePurge", useSQLite: true },
      },
    },
    {
      name: "edge-runtime",
      // Phase 2b step 2: edge-runtime carries the full adapter bundle
      // (same file as node-runtime), so it needs the same module
      // loading workaround and the same bindings. Phase 2c will emit a
      // trimmed edge-only bundle here.
      modules: [{ type: "ESModule", path: edgeScript }],
      compatibilityDate: "2026-03-23",
      compatibilityFlags: ["nodejs_compat"],
      assets: {
        directory: nodeAssetsDir,
        binding: "ASSETS",
        routerConfig: {
          invoke_user_worker_ahead_of_assets: true,
          has_user_worker: true,
        },
      },
      durableObjects: {
        NEXT_CACHE_DO_QUEUE: { className: "DOQueueHandler", useSQLite: true },
        NEXT_TAG_CACHE_DO_SHARDED: { className: "DOShardedTagCache", useSQLite: true },
        NEXT_CACHE_DO_BUCKET_PURGE: { className: "BucketCachePurge", useSQLite: true },
      },
    },
  ],
});

await mf.ready;
console.log(`http://127.0.0.1:${port}`);
console.error(
  `[multi-worker-dev] dispatcher + node-runtime + edge-runtime ready on :${port}`,
);

function shutdown() {
  mf.dispose()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

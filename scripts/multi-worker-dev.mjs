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
      // Phase 1: omit the assets binding — miniflare's default is to
      // answer from assets BEFORE calling the worker (equivalent to CF's
      // \`not_found_handling\`), which intercepts every unprefixed path
      // in the scaffold. Phase 2 wires \`run_worker_first\` semantics so
      // the dispatcher runs first and only falls back to assets.
    },
    {
      name: "node-runtime",
      modules: true,
      scriptPath: nodeScript,
    },
    {
      name: "edge-runtime",
      modules: true,
      scriptPath: edgeScript,
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

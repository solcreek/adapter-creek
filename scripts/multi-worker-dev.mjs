#!/usr/bin/env node
// Creek adapter — multi-worker local launcher (Phase 2c).
//
// Drop-in replacement for worker-dev-server-miniflare.mjs when the
// adapter was built with CREEK_MULTI_WORKER=1. Hosts dispatcher +
// node-runtime + edge-runtime in a single miniflare process and wires
// the service bindings between them.
//
// CLI is identical to the single-worker launcher — pass the dispatcher's
// worker.js as --worker and the launcher derives node-runtime/worker.js
// and edge-runtime/worker.js from its sibling directories:
//
//   node multi-worker-dev.mjs \
//     --worker .creek/adapter-output/dispatcher/worker.js \
//     --assets .creek/adapter-output/assets \
//     --port 8899
//
// The URL written to stdout is what the test harness sends requests to.
// All diagnostics go to stderr (mirrored into $CREEK_WORKER_LOG).

import { existsSync, readdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Miniflare } from "miniflare";

// --- stdout/stderr mirror (matches worker-dev-server-miniflare.mjs) ---
{
  const logPath = process.env.CREEK_WORKER_LOG || "/tmp/creek-worker.log";
  let logFd;
  try {
    logFd = openSync(logPath, "a");
  } catch {
    logFd = null;
  }
  if (logFd !== null) {
    const installMirror = (stream) => {
      const origWrite = stream.write.bind(stream);
      stream.write = (chunk, encoding, cb) => {
        try {
          if (typeof chunk === "string") writeSync(logFd, chunk);
          else if (chunk instanceof Uint8Array) writeSync(logFd, chunk);
        } catch {}
        return origWrite(chunk, encoding, cb);
      };
    };
    installMirror(process.stdout);
    installMirror(process.stderr);
    writeSync(
      logFd,
      `\n=== creek-multi-worker session ${new Date().toISOString()} pid=${process.pid} ===\n`,
    );
  }
}

// --- CLI args ---
const { values: args } = parseArgs({
  options: {
    worker: { type: "string" },
    assets: { type: "string" },
    port: { type: "string" },
  },
});

if (!args.worker || !args.assets || !args.port) {
  console.error(
    "Usage: multi-worker-dev.mjs --worker <dispatcher/worker.js> --assets <dir> --port <port>",
  );
  process.exit(1);
}

const dispatcherScript = path.resolve(args.worker);
// .../adapter-output/dispatcher/worker.js → .../adapter-output
const outputRoot = path.dirname(path.dirname(dispatcherScript));
const nodeScript = path.join(outputRoot, "node-runtime", "worker.js");
const edgeScript = path.join(outputRoot, "edge-runtime", "worker.js");
const assetsAbs = path.resolve(args.assets);
const port = parseInt(args.port, 10);

for (const [label, p] of [
  ["dispatcher", dispatcherScript],
  ["node-runtime", nodeScript],
  ["edge-runtime", edgeScript],
]) {
  if (!existsSync(p)) {
    console.error(`[multi-worker-dev] missing ${label} bundle at ${p}`);
    console.error(
      `[multi-worker-dev] did the build run with CREEK_MULTI_WORKER=1?`,
    );
    process.exit(1);
  }
}

// --- Discover wasm siblings next to each runtime bundle ---
// Both runtime workers may bundle @vercel/og-style .wasm modules.
// Miniflare's AST walker can't follow dynamic import() specifiers, so we
// declare every module up front (see single-worker launcher rationale).
function collectModules(workerAbs) {
  const workerDir = path.dirname(workerAbs);
  const mods = [{ type: "ESModule", path: workerAbs }];
  try {
    for (const entry of readdirSync(workerDir)) {
      if (entry.endsWith(".wasm") || entry.startsWith("wasm_")) {
        mods.push({ type: "CompiledWasm", path: path.join(workerDir, entry) });
      }
    }
  } catch {}
  return mods;
}

const nodeModules = collectModules(nodeScript);
const edgeModules = collectModules(edgeScript);

// --- Forward host env vars (same filter as single-worker launcher) ---
const FORWARD_PREFIXES = ["NEXT_", "NEXT_PUBLIC_", "VERCEL_"];
const FORWARD_EXACT = new Set(["NODE_ENV"]);
const SKIP_PATTERNS = [
  /^_/,
  /^(PATH|HOME|USER|SHELL|TERM|LANG|LC_|TMPDIR|DYLD_|LD_LIBRARY_)/,
  /^(NPM_|PNPM_|YARN_|VOLTA_|NVM_)/,
  /^(GIT_|SSH_|GPG_)/,
];
const forwardedBindings = {};
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v !== "string") continue;
  if (SKIP_PATTERNS.some((re) => re.test(k))) continue;
  const looksLikeUserVar =
    FORWARD_EXACT.has(k) ||
    FORWARD_PREFIXES.some((p) => k.startsWith(p)) ||
    /^[A-Z][A-Z0-9_]{1,40}$/.test(k);
  if (!looksLikeUserVar) continue;
  forwardedBindings[k] = v;
}

// The dispatcher doesn't need ASSETS or DOs — it only forwards. Putting
// ASSETS on each runtime worker keeps the existing env.ASSETS.fetch()
// call sites working unchanged. `invoke_user_worker_ahead_of_assets`
// matches single-worker wrangler.toml's `run_worker_first = true`.
const runtimeAssets = {
  directory: assetsAbs,
  binding: "ASSETS",
  routerConfig: {
    has_user_worker: true,
    invoke_user_worker_ahead_of_assets: true,
  },
};
const runtimeDurableObjects = {
  NEXT_CACHE_DO_QUEUE: { className: "DOQueueHandler", useSQLite: true },
  NEXT_TAG_CACHE_DO_SHARDED: { className: "DOShardedTagCache", useSQLite: true },
  NEXT_CACHE_DO_BUCKET_PURGE: { className: "BucketCachePurge", useSQLite: true },
};
const runtimeKvNamespaces = { KV: "creek-dev-kv" };

const t0 = Date.now();
console.error("[multi-worker-dev] starting...");

const mf = new Miniflare({
  port,
  workers: [
    {
      name: "dispatcher",
      modules: [{ type: "ESModule", path: dispatcherScript }],
      modulesRoot: path.dirname(dispatcherScript),
      compatibilityDate: "2026-03-23",
      compatibilityFlags: ["nodejs_compat"],
      bindings: forwardedBindings,
      serviceBindings: {
        NODE_WORKER: "node-runtime",
        EDGE_WORKER: "edge-runtime",
      },
    },
    {
      name: "node-runtime",
      // Explicit module list bypasses miniflare's acorn-based import
      // walker which throws on the `import(varName)` pattern the
      // adapter bundle uses for lazy handler loading.
      modules: nodeModules,
      modulesRoot: path.dirname(nodeScript),
      compatibilityDate: "2026-03-23",
      compatibilityFlags: ["nodejs_compat"],
      bindings: forwardedBindings,
      kvNamespaces: runtimeKvNamespaces,
      assets: runtimeAssets,
      durableObjects: runtimeDurableObjects,
    },
    {
      name: "edge-runtime",
      // Phase 2b step 2: edge-runtime carries the full adapter bundle.
      // Phase 2c (future) will emit a trimmed edge-only bundle.
      modules: edgeModules,
      modulesRoot: path.dirname(edgeScript),
      compatibilityDate: "2026-03-23",
      compatibilityFlags: ["nodejs_compat"],
      bindings: forwardedBindings,
      kvNamespaces: runtimeKvNamespaces,
      assets: runtimeAssets,
      durableObjects: runtimeDurableObjects,
    },
  ],
});

try {
  const url = await mf.ready;
  const readyMs = Date.now() - t0;
  console.error(
    `[multi-worker-dev] ready in ${(readyMs / 1000).toFixed(1)}s on ${url}`,
  );
  // Match single-worker launcher: stdout carries just the URL so simple
  // callers that pipe `node multi-worker-dev.mjs ... | read` still work.
  console.log(`http://127.0.0.1:${port}`);
} catch (err) {
  console.error("[multi-worker-dev]", err.message);
  try { await mf.dispose(); } catch {}
  process.exit(1);
}

const shutdown = async (sig) => {
  console.error(`[multi-worker-dev] received ${sig}, disposing...`);
  try { await mf.dispose(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

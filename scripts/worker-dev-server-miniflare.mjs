#!/usr/bin/env node
//
// Miniflare-based local dev server for adapter-creek. Drop-in replacement
// for worker-dev-server-sub.mjs that runs workerd IN-PROCESS instead of
// spawning a wrangler subprocess. Benefits:
//
//   - No subprocess overhead (~100ms startup vs ~800ms)
//   - No zombie workerd processes — .dispose() guarantees cleanup
//   - CONCURRENCY=2 safe: two Miniflare instances share the Node process
//     without port/CPU contention at the process level
//   - Same workerd runtime as production (Miniflare wraps workerd)
//
// CLI is identical to worker-dev-server-sub.mjs:
//   node worker-dev-server-miniflare.mjs --worker <path> --assets <dir> --port <port>
//

import { existsSync, readdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Miniflare } from "miniflare";

// --- stdout/stderr mirror (matches worker-dev-server-sub.mjs semantics) ---
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
      `\n=== creek-worker-miniflare session ${new Date().toISOString()} pid=${process.pid} ===\n`,
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
    "Usage: worker-dev-server-miniflare.mjs --worker <path> --assets <dir> --port <port>",
  );
  process.exit(1);
}

const workerAbs = path.resolve(args.worker);
const workerDir = path.dirname(workerAbs);
const assetsAbs = path.resolve(args.assets);
const port = parseInt(args.port, 10);

// --- Discover wasm modules alongside worker.js ---
// Miniflare needs explicit module definitions for CompiledWasm files.
// Scan the worker directory for any .wasm files or wasm_* files.
const modules = [];
try {
  for (const entry of readdirSync(workerDir)) {
    if (entry.endsWith(".wasm") || entry.startsWith("wasm_")) {
      modules.push({
        type: "CompiledWasm",
        path: path.join(workerDir, entry),
      });
    }
  }
} catch {}

// --- Build Miniflare options ---
const t0 = Date.now();
console.error("[worker-dev-server-miniflare] starting...");

// Build explicit module list: main ESModule + all wasm siblings.
// Miniflare doesn't support dynamic module specifiers in the bundle,
// so we must declare every module up front.
const workerModules = [
  { type: "ESModule", path: workerAbs },
];
try {
  for (const entry of readdirSync(workerDir)) {
    if (entry.endsWith(".wasm") || entry.startsWith("wasm_")) {
      workerModules.push({
        type: "CompiledWasm",
        path: path.join(workerDir, entry),
      });
    }
  }
} catch {}

const mf = new Miniflare({
  // Worker script — use explicit modules array instead of scriptPath
  // because the bundle contains dynamic import() expressions that
  // Miniflare's auto-resolver can't follow.
  modules: workerModules,
  modulesRoot: workerDir,

  // Runtime
  compatibilityDate: "2026-03-23",
  compatibilityFlags: ["nodejs_compat"],

  // KV namespace for Next.js IncrementalCache (CreekCacheHandler).
  // In production, Creek auto-provisions env.KV per-project. For local
  // dev, Miniflare provides a local KV backed by filesystem persistence.
  kvNamespaces: { KV: "creek-dev-kv" },

  // Assets binding (equivalent to wrangler.toml [assets] with run_worker_first)
  assets: {
    directory: assetsAbs,
    binding: "ASSETS",
    routerConfig: {
      has_user_worker: true,
      invoke_user_worker_ahead_of_assets: true,
    },
  },

  // Durable Objects (SQLite-backed, matching our wrangler.toml)
  durableObjects: {
    NEXT_CACHE_DO_QUEUE: { className: "DOQueueHandler", useSQLite: true },
    NEXT_TAG_CACHE_DO_SHARDED: { className: "DOShardedTagCache", useSQLite: true },
    NEXT_CACHE_DO_BUCKET_PURGE: { className: "BucketCachePurge", useSQLite: true },
  },

  // Network
  port,
});

// --- Wait for ready ---
try {
  const url = await mf.ready;
  const readyMs = Date.now() - t0;
  console.error(
    `[worker-dev-server-miniflare] ready in ${(readyMs / 1000).toFixed(1)}s on ${url}`,
  );
} catch (err) {
  console.error("[worker-dev-server-miniflare]", err.message);
  try { await mf.dispose(); } catch {}
  process.exit(1);
}

// --- Signal handling ---
const shutdown = async (sig) => {
  console.error(`[worker-dev-server-miniflare] received ${sig}, disposing...`);
  try { await mf.dispose(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

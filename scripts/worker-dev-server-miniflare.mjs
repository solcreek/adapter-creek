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

// Forward user-facing env vars from the host process into the worker.
// Tests like middleware-general "allows to access env variables" set
// arbitrary vars (`MIDDLEWARE_TEST=asdf`, etc.) via the deploy script's
// environment and expect `process.env.MIDDLEWARE_TEST` to be readable
// from middleware at request time. workerd's `process.env` is populated
// from the `bindings` option (plain string-to-string map) when
// `nodejs_compat` is enabled. Filter out vars that would break the worker
// or leak host internals — we only pass through what looks like user
// application env, plus a few Next.js-specific test vars.
const FORWARD_PREFIXES = ["NEXT_", "NEXT_PUBLIC_", "VERCEL_"];
const FORWARD_EXACT = new Set([
  "NODE_ENV",
]);
const SKIP_PATTERNS = [
  /^_/,                      // underscore-prefixed internal
  /^(PATH|HOME|USER|SHELL|TERM|LANG|LC_|TMPDIR|DYLD_|LD_LIBRARY_)/,
  /^(NPM_|PNPM_|YARN_|VOLTA_|NVM_)/,
  /^(GIT_|SSH_|GPG_)/,
];
const forwardedBindings = {};
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v !== "string") continue;
  if (SKIP_PATTERNS.some((re) => re.test(k))) continue;
  // Pass through if it looks like a Next.js / Vercel / app env var, or
  // if it's a short all-caps identifier that looks like user-set config.
  const looksLikeUserVar =
    FORWARD_EXACT.has(k) ||
    FORWARD_PREFIXES.some((p) => k.startsWith(p)) ||
    /^[A-Z][A-Z0-9_]{1,40}$/.test(k);
  if (!looksLikeUserVar) continue;
  forwardedBindings[k] = v;
}

const mf = new Miniflare({
  // Worker script — use explicit modules array instead of scriptPath
  // because the bundle contains dynamic import() expressions that
  // Miniflare's auto-resolver can't follow.
  modules: workerModules,
  modulesRoot: workerDir,

  // Runtime
  compatibilityDate: "2026-03-23",
  compatibilityFlags: ["nodejs_compat"],

  // Forward host env vars so middleware / route handlers can read
  // `process.env.MIDDLEWARE_TEST` etc. (nodejs_compat populates
  // `process.env` from bindings automatically).
  bindings: forwardedBindings,

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

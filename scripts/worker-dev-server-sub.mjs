#!/usr/bin/env node
//
// Wrangler-subprocess local dev server for adapter-creek. Drop-in replacement
// for worker-dev-server.mjs, using `wrangler dev` directly (the same path
// `wrangler deploy` production users take). Simpler than driving
// unstable_dev programmatically because we don't own a proxy bridge; wrangler
// owns the listen port.
//
//   node worker-dev-server-sub.mjs --worker <path> --assets <dir> --port <port>
//
// Flow:
//   1. Synthesize wrangler.toml alongside worker.js if absent (Phase 2 will
//      have bundler.ts emit it at build time)
//   2. Spawn `wrangler dev --port <port>`
//   3. Wait for "Ready on http://localhost:<port>" on stdout
//   4. Exit when the parent sends SIGINT/SIGTERM (forward to wrangler)

import { spawn } from "node:child_process";
import { openSync, writeSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// --- stdout/stderr mirror (matches worker-dev-server.mjs semantics) --------
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
      `\n=== creek-worker-sub session ${new Date().toISOString()} pid=${process.pid} ===\n`,
    );
  }
}

// --- CLI args ---------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    worker: { type: "string" },
    assets: { type: "string" },
    port: { type: "string" },
    config: { type: "string" },
  },
});

if (!args.worker || !args.assets || !args.port) {
  console.error(
    "Usage: worker-dev-server-sub.mjs --worker <path> --assets <dir> --port <port>",
  );
  process.exit(1);
}

const workerAbs = path.resolve(args.worker);
const workerDir = path.dirname(workerAbs);
const assetsAbs = path.resolve(args.assets);
const port = args.port;
const configPath = args.config || path.join(workerDir, "wrangler.toml");

// --- wrangler.toml presence check -----------------------------------------
// The adapter's bundler (src/bundler.ts -> emitWranglerConfig) writes
// wrangler.toml next to worker.js at build time. If it's missing, the build
// didn't run to completion — refuse to start rather than silently diverge
// from prod config.
if (!existsSync(configPath)) {
  console.error(
    `[worker-dev-server-sub] missing wrangler.toml at ${configPath}. ` +
      `Run \`next build\` (which invokes the adapter's bundler) first.`,
  );
  process.exit(1);
}

// --- resolve the wrangler binary -------------------------------------------
// Prefer the wrangler installed alongside our adapter (dependency pinned in
// package.json). Fallback to PATH if not resolvable.
const __filename = fileURLToPath(import.meta.url);
const adapterDir = path.resolve(path.dirname(__filename), "..");
let wranglerBin;
try {
  wranglerBin = path.join(adapterDir, "node_modules", ".bin", "wrangler");
  if (!existsSync(wranglerBin)) wranglerBin = "wrangler";
} catch {
  wranglerBin = "wrangler";
}

// --- spawn wrangler dev -----------------------------------------------------
console.error("[worker-dev-server-sub] spawning wrangler dev...");
const t0 = Date.now();

// `--show-interactive-dev-session=false` drops the [b]rowser / [x]ey-to-quit
// banner so we don't need to handle TTY. `--port` binds to the external port
// directly — no proxy layer.
const wrangler = spawn(
  wranglerBin,
  [
    "dev",
    "--config",
    configPath,
    "--port",
    port,
    "--show-interactive-dev-session=false",
    // Our \`worker.js\` is already a single-file workerd-ready bundle
    // emitted by the adapter (via \`wrangler deploy --dry-run --outdir\`
    // during \`bundleForWorkers()\`). Tell wrangler dev to skip its
    // internal esbuild/bundling pass — re-bundling can mangle the
    // carefully-preserved Turbopack runtime plumbing and adds startup
    // latency. Fixes soft-navigation tests that otherwise time out
    // because client-side prefetch/refresh state drifts from the
    // original bundle shape.
    "--no-bundle",
    "--log-level",
    "info",
  ],
  {
    cwd: workerDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Disable telemetry prompts
      WRANGLER_SEND_METRICS: "false",
      // Keep CI-like output
      FORCE_COLOR: "0",
    },
  },
);

// Track readiness. Wrangler prints "Ready on http://..." once workerd is up.
let readyResolved = false;
const readyPromise = new Promise((resolve, reject) => {
  const onOutput = (chunk) => {
    const text = chunk.toString();
    // Forward to stderr so test harness logs see it
    process.stderr.write(text);
    if (!readyResolved && /\bReady on http:\/\//.test(text)) {
      readyResolved = true;
      resolve();
    }
  };
  wrangler.stdout.on("data", onOutput);
  wrangler.stderr.on("data", onOutput);
  wrangler.on("exit", (code) => {
    if (!readyResolved) {
      reject(new Error(`wrangler exited before ready (code=${code})`));
    }
  });
  // Safety timeout
  setTimeout(() => {
    if (!readyResolved) {
      reject(new Error("wrangler did not become ready within 60s"));
    }
  }, 60000);
});

try {
  await readyPromise;
} catch (err) {
  console.error("[worker-dev-server-sub]", err.message);
  try {
    wrangler.kill("SIGTERM");
  } catch {}
  process.exit(1);
}

const readyMs = Date.now() - t0;
console.error(
  `[worker-dev-server-sub] ready in ${(readyMs / 1000).toFixed(1)}s on port ${port}`,
);

// --- forward signals -------------------------------------------------------
const shutdown = (sig) => {
  console.error(`[worker-dev-server-sub] Received ${sig || "SIGTERM"}, shutting down...`);
  // Forward signal to wrangler and all its children
  try {
    // Kill the process group to ensure workerd also dies
    process.kill(-wrangler.pid, sig || "SIGTERM");
  } catch {
    // If killing the group fails, try just the process
    try {
      wrangler.kill(sig || "SIGTERM");
    } catch {}
  }
  // Give wrangler a moment to clean up workerd then force-exit
  setTimeout(() => {
    // Final force-kill if still running
    try {
      process.kill(-wrangler.pid, "SIGKILL");
    } catch {}
    process.exit(0);
  }, 2000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Handle uncaught errors to ensure cleanup
process.on("uncaughtException", (err) => {
  console.error("[worker-dev-server-sub] Uncaught exception:", err.message);
  shutdown("SIGTERM");
});

wrangler.on("exit", (code) => {
  console.error(`[worker-dev-server-sub] wrangler exited code=${code}`);
  process.exit(code ?? 0);
});

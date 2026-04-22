/**
 * Bundler for Cloudflare Workers.
 *
 * Uses wrangler (which internally uses esbuild + Turbopack-aware resolution)
 * to bundle the generated worker entry into CF Workers-compatible output.
 *
 * This works with both webpack and Turbopack output — wrangler handles
 * the custom chunk format that plain esbuild cannot follow.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";

export interface BundleOptions {
  workerSource: string;
  outputDir: string;
  serverAssets: Map<string, string>;
  wasmFiles: Map<string, string>;
  distDir: string;
  repoRoot: string;
  standaloneDir: string;
}

/**
 * Patch Turbopack runtime to inline chunk loading.
 *
 * Turbopack generates a runtime that loads chunks via R.c("path").
 * These dynamic loads fail in CF Workers (no filesystem).
 *
 * Solution (same as @opennextjs/cloudflare):
 * 1. Find [turbopack]_runtime.js
 * 2. Collect all chunk file paths
 * 3. Replace the loadRuntimeChunkPath function's require(resolved) with requireChunk(chunkPath)
 * 4. Append a requireChunk() switch that maps paths to static require()
 */
async function patchTurbopackRuntime(distDir: string): Promise<void> {
  // Find ALL Turbopack runtime files — there can be multiple:
  // .next/server/chunks/ssr/[turbopack]_runtime.js
  // .next/server/chunks/[turbopack]_runtime.js
  const runtimePaths: string[] = [];
  const searchDirs = [
    path.join(distDir, "server", "chunks", "ssr"),
    path.join(distDir, "server", "chunks"),
    path.join(distDir, "server", "edge", "chunks"),
  ];

  for (const dir of searchDirs) {
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (f.endsWith(".js") && (
          f.includes("[turbopack]_runtime") ||
          // Edge Turbopack runtimes are in turbopack-..._edge-wrapper files
          (f.startsWith("turbopack-") && f.includes("edge-wrapper"))
        )) {
          runtimePaths.push(path.join(dir, f));
        }
      }
    } catch {}
  }

  if (runtimePaths.length === 0) return; // Not Turbopack

  // Collect all chunk files from .next/server/chunks/ AND .next/server/edge/chunks/
  const allChunks: string[] = [];
  async function walkChunks(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkChunks(full);
      } else if (entry.name.endsWith(".js") && !entry.name.includes("[turbopack]_runtime")) {
        allChunks.push(full);
      }
    }
  }
  await walkChunks(path.join(distDir, "server", "chunks"));
  // Include edge chunks — required for middleware and edge runtime pages
  await walkChunks(path.join(distDir, "server", "edge", "chunks"));

  if (allChunks.length === 0) return;

  // Generate the requireChunk switch statement
  const cases: string[] = [];
  for (const chunk of allChunks) {
    // Extract the relative path after .next/ for the case label
    const relFromDotNext = chunk.replace(/.*\/\.next\//, "");
    cases.push(`      case "${relFromDotNext}": return require("${chunk}");`);
    // For edge chunks, also add a short form (relative to server/edge/)
    // because the edge Turbopack runtime resolves chunks relative to itself.
    if (relFromDotNext.startsWith("server/edge/")) {
      const shortRel = relFromDotNext.replace("server/edge/", "");
      cases.push(`      case "${shortRel}": return require("${chunk}");`);
    }
  }

  const requireChunkFn = `
function requireChunk(chunkPath) {
  // Decode URL-encoded paths (edge runtime encodes [, ] as %5B, %5D)
  var decoded = decodeURIComponent(chunkPath);
  switch(decoded) {
${cases.join("\n")}
    default:
      // Try with original (encoded) path
      switch(chunkPath) {
${cases.join("\n")}
        default:
          throw new Error("Chunk not found: " + chunkPath);
      }
  }
}
`;

  // Patch each Turbopack runtime file
  for (const runtimePath of runtimePaths) {
    const runtimeCode = await fs.readFile(runtimePath, "utf-8");

    let patched = runtimeCode;
    let modified = false;

    // Standard SSR runtime: replace require(resolved) with requireChunk(chunkPath)
    if (runtimeCode.includes("loadRuntimeChunkPath") && runtimeCode.includes("require(resolved)")) {
      patched = patched.replace(
        /require\(resolved\)/g,
        "requireChunk(chunkPath)",
      );
      patched = patched + "\n" + requireChunkFn;
      modified = true;
    }

    // Edge runtime: replace "chunk loading is not supported" with actual chunk loading.
    // The edge Turbopack runtime has loadChunkCached that throws — we replace it
    // to return a resolved promise after loading the chunk via requireChunk.
    if (runtimeCode.includes("chunk loading is not supported")) {
      patched = patched.replace(
        /loadChunkCached\([^)]*\)\s*\{[^}]*throw\s+Error\s*\(\s*"chunk loading is not supported"\s*\)[^}]*\}/,
        `loadChunkCached(e2, t2) {
          try {
            var decoded = decodeURIComponent(t2);
            requireChunk(decoded);
          } catch (err) {
            console.error("[creek-chunk] Failed to load chunk:", t2, "decoded:", decodeURIComponent(t2), "error:", err.message);
          }
          return Promise.resolve();
        }`,
      );
      // Also add requireChunk if not already appended
      if (!modified) {
        patched = patched + "\n" + requireChunkFn;
      }
      modified = true;
    }

    if (modified) {
      await fs.writeFile(runtimePath, patched);
    }
  }
}

export async function bundleForWorkers(opts: BundleOptions): Promise<string[]> {
  // Patch Turbopack runtime BEFORE wrangler bundles.
  // Turbopack's R.c() dynamically loads chunks from the filesystem.
  // CF Workers has no filesystem, so we replace R.c() with a switch
  // statement that maps chunk paths to static require() calls.
  await patchTurbopackRuntime(opts.distDir);

  // Write the generated worker entry
  const entryPath = path.join(opts.outputDir, "__entry.mjs");
  await fs.writeFile(entryPath, opts.workerSource);

  if (process.env.CREEK_DEBUG) {
    await fs.writeFile(path.join(opts.outputDir, "__entry_debug.mjs"), opts.workerSource);
  }

  // Resolve adapter paths
  const adapterDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));

  // Generate wrangler config for the bundle step
  const wranglerConfig = {
    name: "creek-adapter-build",
    main: entryPath,
    compatibility_date: "2026-03-28",
    compatibility_flags: ["nodejs_compat"],
    define: {
      __dirname: '""',
      __filename: '""',
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_RUNTIME": '"nodejs"',
    },
    // Mark optional/unavailable deps as external to prevent build errors.
    // These are caught at runtime and handled gracefully.
    alias: {
      "@opentelemetry/api": path.join(adapterDir, "src", "shims", "opentelemetry.js"),
      // fs shim — intercept both bare and node: prefixed imports.
      // Turbopack runtime uses require("fs") which wrangler must redirect
      // to our shim that reads from embedded __MANIFESTS.
      "fs": path.join(adapterDir, "src", "shims", "fs.js"),
      "node:fs": path.join(adapterDir, "src", "shims", "fs.js"),
      "vm": path.join(adapterDir, "src", "shims", "vm.js"),
      "node:vm": path.join(adapterDir, "src", "shims", "vm.js"),
      // critters is bundled by Next.js for CSS inlining — not needed on Workers.
      "critters": path.join(adapterDir, "src", "shims", "critters.js"),
      // sharp has native .node bindings that workerd can't load.
      "sharp": path.join(adapterDir, "src", "shims", "sharp.js"),
      // Dead-branch dynamic imports.
      "fail": path.join(adapterDir, "src", "shims", "empty.js"),
      // track-module-loading: per-request AsyncLocalStorage to avoid IoContext leak.
      "next/dist/server/app-render/module-loading/track-module-loading.external":
        path.join(adapterDir, "src", "shims", "track-module-loading.js"),
      "next/dist/server/app-render/module-loading/track-module-loading.external.js":
        path.join(adapterDir, "src", "shims", "track-module-loading.js"),
      "next/dist/server/app-render/module-loading/track-module-loading.instance":
        path.join(adapterDir, "src", "shims", "track-module-loading.js"),
      "next/dist/server/app-render/module-loading/track-module-loading.instance.js":
        path.join(adapterDir, "src", "shims", "track-module-loading.js"),
      // fast-set-immediate: workerd's frozen ESM namespace + scheduling order.
      "next/dist/server/node-environment-extensions/fast-set-immediate.external":
        path.join(adapterDir, "src", "shims", "fast-set-immediate.js"),
      "next/dist/server/node-environment-extensions/fast-set-immediate.external.js":
        path.join(adapterDir, "src", "shims", "fast-set-immediate.js"),
      // CF Workers does NOT provide node:http / node:https even with
      // nodejs_compat. TCP-server-shaped APIs have no Workers equivalent.
      // Our shim provides IncomingMessage + ServerResponse stubs.
      "http": path.join(adapterDir, "src", "shims", "http.js"),
      "node:http": path.join(adapterDir, "src", "shims", "http.js"),
      "https": path.join(adapterDir, "src", "shims", "http.js"),
      "node:https": path.join(adapterDir, "src", "shims", "http.js"),
      // net: Socket class needed by Next.js http bridge.
      "net": path.join(adapterDir, "src", "shims", "net.js"),
      "node:net": path.join(adapterDir, "src", "shims", "net.js"),
      // Modules with no meaningful Workers runtime — empty stubs.
      "inspector": path.join(adapterDir, "src", "shims", "empty.js"),
      "node:inspector": path.join(adapterDir, "src", "shims", "empty.js"),
      "tls": path.join(adapterDir, "src", "shims", "empty.js"),
      "node:tls": path.join(adapterDir, "src", "shims", "empty.js"),
      "dns": path.join(adapterDir, "src", "shims", "empty.js"),
      "node:dns": path.join(adapterDir, "src", "shims", "empty.js"),
      "child_process": path.join(adapterDir, "src", "shims", "empty.js"),
      "node:child_process": path.join(adapterDir, "src", "shims", "empty.js"),
    },
  };
  const configPath = path.join(opts.outputDir, "__wrangler.json");
  await fs.writeFile(configPath, JSON.stringify(wranglerConfig));

  // Bundle with wrangler --dry-run
  // Wrangler internally uses esbuild but with Turbopack-aware resolution
  // and proper CJS/ESM interop for CF Workers.
  // Ensure @next/routing is resolvable from the project directory.
  // It's a dependency of the adapter, not the user's project.
  // Symlink it into the project's node_modules if missing.
  const projectNodeModules = path.join(path.dirname(opts.distDir), "node_modules");
  const routingDest = path.join(projectNodeModules, "@next", "routing");
  const routingSrc = path.join(adapterDir, "node_modules", "@next", "routing");
  try {
    await fs.access(routingDest);
  } catch {
    await fs.mkdir(path.join(projectNodeModules, "@next"), { recursive: true });
    await fs.symlink(routingSrc, routingDest, "junction");
  }

  const bundleDir = path.join(opts.outputDir, "__bundle");
  // Resolve wrangler binary from the adapter's own node_modules
  const wranglerBin = path.join(adapterDir, "node_modules", ".bin", "wrangler");

  try {
    execSync(
      `"${wranglerBin}" deploy --dry-run --outdir "${bundleDir}" --config "${configPath}"`,
      {
        cwd: path.dirname(opts.distDir),
        stdio: "pipe",
        env: process.env,
      },
    );
  } catch (err: unknown) {
    const stderr = err instanceof Error && "stderr" in err
      ? (err as { stderr: Buffer }).stderr?.toString() ?? ""
      : "";
    const stdout = err instanceof Error && "stdout" in err
      ? (err as { stdout: Buffer }).stdout?.toString() ?? ""
      : "";
    // Try to read wrangler log for details
    let logContent = "";
    try {
      const { readdirSync, readFileSync } = await import("node:fs");
      const logDir = path.join(process.env.HOME || "/tmp", ".wrangler/logs");
      const logs = readdirSync(logDir).sort().reverse();
      if (logs[0]) logContent = readFileSync(path.join(logDir, logs[0]), "utf-8").slice(-1000);
    } catch {}
    throw new Error(`Wrangler bundle failed:\nSTDERR: ${stderr.slice(-2000)}\nSTDOUT: ${stdout.slice(-500)}\nLOG: ${logContent}`);
  }

  // Move bundled files to output directory
  const bundledFiles = await fs.readdir(bundleDir);
  for (const f of bundledFiles) {
    if (f.endsWith(".map") || f === "README.md") continue;
    await fs.rename(path.join(bundleDir, f), path.join(opts.outputDir, f));
  }

  // Rename the main entry to worker.js
  const mainFile = bundledFiles.find(f => f.endsWith(".mjs") || f.endsWith(".js"));
  if (mainFile && mainFile !== "worker.js") {
    const src = path.join(opts.outputDir, mainFile);
    const dest = path.join(opts.outputDir, "worker.js");
    if (await fs.access(src).then(() => true).catch(() => false)) {
      await fs.rename(src, dest);
    }
  }

  // Post-process bundled worker to fix CF Workers compatibility issues.
  const workerPath = path.join(opts.outputDir, "worker.js");
  try {
    let workerCode = await fs.readFile(workerPath, "utf-8");

    // Fix instrumentation module loading — Next.js's catch only handles
    // ENOENT/MODULE_NOT_FOUND error codes, but CF Workers __require throws
    // "Dynamic require of ... is not supported" without those codes.
    // Patch the catch to also handle "is not supported" errors.
    workerCode = workerCode.replace(
      /err\.code !== "ENOENT" && err\.code !== "MODULE_NOT_FOUND" && err\.code !== "ERR_MODULE_NOT_FOUND"/g,
      'err.code !== "ENOENT" && err.code !== "MODULE_NOT_FOUND" && err.code !== "ERR_MODULE_NOT_FOUND" && !err.message?.includes("is not supported")',
    );

    await fs.writeFile(workerPath, workerCode);
  } catch {}

  // Copy WASM files alongside the bundle
  for (const [name, absPath] of opts.wasmFiles) {
    await fs.copyFile(absPath, path.join(opts.outputDir, name));
  }

  // Clean up temp files
  await fs.rm(entryPath, { force: true });
  await fs.rm(configPath, { force: true });
  await fs.rm(bundleDir, { recursive: true, force: true });

  // List output files
  const files = await fs.readdir(opts.outputDir);
  return files.filter(f => !f.startsWith("__"));
}

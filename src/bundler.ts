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
  const chunksDir = path.join(distDir, "server", "chunks", "ssr");

  // Find the Turbopack runtime file
  let runtimePath: string | null = null;
  try {
    const files = await fs.readdir(chunksDir);
    const runtimeFile = files.find((f) => f.includes("[turbopack]_runtime"));
    if (runtimeFile) {
      runtimePath = path.join(chunksDir, runtimeFile);
    }
  } catch {
    return; // No chunks dir = webpack build, skip
  }

  if (!runtimePath) return; // Not Turbopack

  const runtimeCode = await fs.readFile(runtimePath, "utf-8");
  if (!runtimeCode.includes("loadRuntimeChunkPath")) return; // Not the right file

  // Collect all chunk files from .next/server/chunks/
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

  if (allChunks.length === 0) return;

  // Generate the requireChunk switch statement
  const cases = allChunks.map((chunk) => {
    // Extract the relative path after .next/ for the case label
    const relFromDotNext = chunk.replace(/.*\/\.next\//, "");
    return `      case "${relFromDotNext}": return require("${chunk}");`;
  });

  const requireChunkFn = `
function requireChunk(chunkPath) {
  switch(chunkPath) {
${cases.join("\n")}
    default:
      throw new Error("Chunk not found: " + chunkPath);
  }
}
`;

  // Patch: replace require(resolved) in loadRuntimeChunkPath with requireChunk(chunkPath)
  let patched = runtimeCode;

  // The Turbopack runtime has a function like:
  //   function loadRuntimeChunkPath(chunkPath) { ... require(resolved) ... }
  // We replace the require(resolved) call with requireChunk(chunkPath)
  patched = patched.replace(
    /require\(resolved\)/g,
    "requireChunk(chunkPath)",
  );

  // Append the requireChunk function
  patched = patched + "\n" + requireChunkFn;

  await fs.writeFile(runtimePath, patched);
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
    define: { __dirname: '""', __filename: '""' },
    // Mark optional/unavailable deps as external to prevent build errors.
    // These are caught at runtime and handled gracefully.
    alias: {
      "@opentelemetry/api": path.join(adapterDir, "src", "shims", "empty.js"),
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
    throw new Error(`Wrangler bundle failed:\nSTDERR: ${stderr.slice(-500)}\nSTDOUT: ${stdout.slice(-500)}\nLOG: ${logContent}`);
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

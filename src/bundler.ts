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

export async function bundleForWorkers(opts: BundleOptions): Promise<string[]> {
  // Write the generated worker entry
  const entryPath = path.join(opts.outputDir, "__entry.mjs");
  await fs.writeFile(entryPath, opts.workerSource);

  if (process.env.CREEK_DEBUG) {
    await fs.writeFile(path.join(opts.outputDir, "__entry_debug.mjs"), opts.workerSource);
  }

  // Generate wrangler config for the bundle step
  const wranglerConfig = {
    name: "creek-adapter-build",
    main: entryPath,
    compatibility_date: "2026-03-28",
    compatibility_flags: ["nodejs_compat"],
  };
  const configPath = path.join(opts.outputDir, "__wrangler.json");
  await fs.writeFile(configPath, JSON.stringify(wranglerConfig));

  // Bundle with wrangler --dry-run
  // Wrangler internally uses esbuild but with Turbopack-aware resolution
  // and proper CJS/ESM interop for CF Workers.
  // Ensure @next/routing is resolvable from the project directory.
  // It's a dependency of the adapter, not the user's project.
  // Symlink it into the project's node_modules if missing.
  const adapterDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
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
  try {
    execSync(
      `npx wrangler deploy --dry-run --outdir "${bundleDir}" --config "${configPath}"`,
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

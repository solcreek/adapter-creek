/**
 * Core build handler for Creek's Next.js adapter.
 *
 * Called by Next.js after build completes via onBuildComplete().
 * With --webpack, .next/server/ contains standard CJS that esbuild
 * can bundle directly (unlike Turbopack's custom chunked format).
 *
 * Note: onBuildComplete runs BEFORE standalone output is generated
 * (Next.js source: build/index.js:2544-2581), so we cannot rely on
 * .next/standalone/. Instead we import directly from .next/server/.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NextAdapter } from "next";
import { generateWorkerEntry } from "./worker-entry.js";
import { bundleForWorkers } from "./bundler.js";
import { writeManifest } from "./manifest.js";

type BuildContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

const OUTPUT_DIR = ".creek/adapter-output";

export async function handleBuild(ctx: BuildContext): Promise<void> {
  const outputDir = path.join(ctx.projectDir, OUTPUT_DIR);
  const assetsDir = path.join(outputDir, "assets");
  const serverDir = path.join(outputDir, "server");

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.mkdir(serverDir, { recursive: true });

  console.log(`\n  [Creek Adapter] Preparing deployment output...`);

  // Step 1: Collect static files
  const assetCount = await collectStaticFiles(ctx.outputs, assetsDir);
  console.log(`  [Creek Adapter] ${assetCount} static files collected`);

  // Step 2: Collect WASM files from all outputs
  const wasmFiles = new Map<string, string>();
  for (const outputs of [ctx.outputs.appPages, ctx.outputs.appRoutes, ctx.outputs.pages, ctx.outputs.pagesApi]) {
    for (const output of outputs) {
      if (output.wasmAssets) {
        for (const [name, absPath] of Object.entries(output.wasmAssets)) {
          wasmFiles.set(name, absPath);
        }
      }
    }
  }

  // Step 3: Collect manifests from .next/ for embedding in the worker.
  // Next.js route modules call loadManifest() which uses fs.readFileSync().
  // CF Workers doesn't have fs, so we embed all manifests and shim the loader.
  const manifests = await collectManifests(ctx.distDir);
  console.log(`  [Creek Adapter] ${Object.keys(manifests).length} manifests embedded`);

  // Step 3b: Collect prerender entries for ISR cache seeding.
  // Each prerender with a fallback file gets seeded into the cache at startup.
  const prerenderEntries = await collectPrerenderEntries(ctx.outputs);
  if (prerenderEntries.length > 0) {
    console.log(`  [Creek Adapter] ${prerenderEntries.length} prerender entries for cache seeding`);
  }

  // Find Turbopack runtime for static import (triggers chunk bundling)
  let turbopackRuntimePath: string | undefined;
  try {
    const ssrChunksDir = path.join(ctx.distDir, "server", "chunks", "ssr");
    const files = await fs.readdir(ssrChunksDir);
    const runtimeFile = files.find((f) => f.includes("[turbopack]_runtime"));
    if (runtimeFile) {
      turbopackRuntimePath = path.join(ssrChunksDir, runtimeFile);
    }
  } catch {}

  // Create no-op instrumentation.js if missing — Next.js tries to require()
  // this at runtime, and CF Workers throws a generic error for dynamic require
  // of missing modules. The error code doesn't match ENOENT/MODULE_NOT_FOUND
  // that Next.js expects, causing an unhandled rejection.
  const instrumentationPath = path.join(ctx.distDir, "server", "instrumentation.js");
  try {
    await fs.access(instrumentationPath);
  } catch {
    await fs.writeFile(instrumentationPath, "module.exports = {};");
  }


  // Step 3c: Find edge middleware registration chunk.
  // Turbopack generates TWO edge-wrapper files:
  // 1. turbopack-..._edge-wrapper (modulePath — Turbopack runtime, imported by worker)
  // 2. node_modules_..._edge-wrapper (contains _ENTRIES registration + module loader)
  // File 2 is NOT referenced by modulePath, so we need to import it explicitly.
  let edgeRegistrationChunkPath: string | undefined;
  let edgeRuntimeModuleIds: number[] = [];
  let edgeOtherChunkPaths: string[] = [];
  if (ctx.outputs.middleware?.edgeRuntime) {
    try {
      const edgeChunksDir = path.join(ctx.distDir, "server", "edge", "chunks");
      const files = await fs.readdir(edgeChunksDir);
      for (const f of files) {
        if (f.includes("edge-wrapper") && !f.endsWith(".map") && !f.startsWith("turbopack-")) {
          const content = await fs.readFile(path.join(edgeChunksDir, f), "utf-8");
          if (content.includes("_ENTRIES")) {
            edgeRegistrationChunkPath = path.join(edgeChunksDir, f);
            break;
          }
        }
      }
      // Extract runtimeModuleIds and otherChunks from the Turbopack runtime chunk.
      for (const f of files) {
        if (f.startsWith("turbopack-") && f.includes("edge-wrapper") && !f.endsWith(".map")) {
          const content = await fs.readFile(path.join(edgeChunksDir, f), "utf-8");
          const idsMatch = content.match(/runtimeModuleIds:\s*\[([0-9,\s]+)\]/);
          if (idsMatch) {
            edgeRuntimeModuleIds = idsMatch[1].split(",").map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n));
          }
          // Extract otherChunks paths — these need to be imported so their
          // module factories are registered in the Turbopack module registry.
          // Note: can't use [^\]] because chunk paths contain literal ] (e.g., [root-of-the-server])
          const chunksMatch = content.match(/otherChunks:\s*\[((?:"[^"]*"(?:,\s*)?)*)\]/);
          if (chunksMatch) {
            const chunkPaths = chunksMatch[1].match(/"([^"]+)"/g);
            if (chunkPaths) {
              for (const raw of chunkPaths) {
                const rel = raw.replace(/"/g, "");
                let absPath = path.join(ctx.distDir, "server", "edge", rel);
                // Copy files with brackets to safe names — esbuild can't import paths with [].
                if (absPath.includes("[") || absPath.includes("]")) {
                  const dir = path.dirname(absPath);
                  const base = path.basename(absPath).replace(/\[/g, "_").replace(/\]/g, "_");
                  const safePath = path.join(dir, base);
                  try {
                    const content2 = await fs.readFile(absPath, "utf-8");
                    await fs.writeFile(safePath, content2);
                    absPath = safePath;
                  } catch {}
                }
                edgeOtherChunkPaths.push(absPath);
                console.log(`  [Creek Adapter] Edge otherChunk: ${path.basename(absPath)}`);
              }
            }
          }
        }
      }

      // Extract middleware handler at build time using Node.js.
      // The edge-wrapper's factory calls e.i(handlerModuleId) which needs
      // the full Turbopack module graph. We run a Node.js script to evaluate
      // the chunk factories and serialize the middleware handler module.
      if (edgeRegistrationChunkPath) {
        const regContent = await fs.readFile(edgeRegistrationChunkPath, "utf-8");
        const handlerIdMatch = regContent.match(/\.i\((\d+)\)/);
        const rootChunkFile = files.find((f) =>
          f.includes("[root-of-the-server]") && f.endsWith(".js") && !f.endsWith(".map")
        );
        if (handlerIdMatch && rootChunkFile) {
          const handlerModuleId = handlerIdMatch[1];
          const rootChunkPath = path.join(edgeChunksDir, rootChunkFile);
          const bridgePath = path.join(edgeChunksDir, "__middleware_handler.js");

          // Run a Node.js script to evaluate Turbopack chunks and extract the handler
          const { execSync: exec } = await import("node:child_process");
          try {
            exec(`node -e '
              const _mods = {}, _facs = {};
              const items = [];
              globalThis.TURBOPACK = { push: function(a) { items.push(a); } };
              try { require(${JSON.stringify(JSON.stringify(rootChunkPath))}); } catch {}
              try { require(${JSON.stringify(JSON.stringify(edgeRegistrationChunkPath))}); } catch {}
              for (const item of items) {
                if (!Array.isArray(item)) continue;
                for (let i = 1; i < item.length; i += 2)
                  if (typeof item[i] === "number" && typeof item[i+1] === "function")
                    _facs[item[i]] = item[i+1];
              }
              function req(id) {
                if (_mods[id]) return _mods[id].exports;
                const f = _facs[id]; if (!f) return {};
                const m = {exports:{}}; _mods[id] = m;
                const ctx = {
                  i: req, r: (e)=>{Object.defineProperty(e,"__esModule",{value:true})},
                  s: (e,g)=>{Object.defineProperty(e,"__esModule",{value:true});for(let i=0;i<g.length;i+=2)Object.defineProperty(e,g[i],{get:g[i+1],enumerable:true})},
                  t: require, x: (n,g)=>g(), n: (e)=>{m.exports=e}, v: (e)=>{m.exports=e},
                  c: _mods, g: globalThis, M: _facs,
                };
                try { f(ctx, m, m.exports); } catch {}
                return m.exports;
              }
              const handler = req(${handlerModuleId});
              // Check if handler has the expected export
              const hasDefault = typeof handler?.default === "function";
              const hasHandler = typeof handler?.handler === "function";
              if (hasDefault || hasHandler) {
                require("fs").writeFileSync(${JSON.stringify(JSON.stringify(bridgePath))},
                  "// Pre-evaluated middleware handler\\n" +
                  "module.exports = require(" + ${JSON.stringify(JSON.stringify(rootChunkPath))} + ");\\n"
                );
                process.stdout.write("OK:" + (hasDefault ? "default" : "handler"));
              } else {
                process.stdout.write("FAIL:no-handler");
              }
            '`, { stdio: "pipe", timeout: 10000 }).toString();
          } catch {}

          // If bridge was created, point middleware to it
          try {
            await fs.access(bridgePath);
            (ctx.outputs.middleware as { filePath: string }).filePath = bridgePath;
          } catch {}
        }
      }
    } catch {}
  }

  // Step 4: Generate worker entry
  const workerSource = generateWorkerEntry({
    buildId: ctx.buildId,
    routing: ctx.routing,
    outputs: ctx.outputs,
    basePath: ctx.config.basePath || "",
    assetPrefix: ctx.config.assetPrefix || "",
    manifests,
    prerenderEntries,
    turbopackRuntimePath,
    edgeRegistrationChunkPath,
    edgeRuntimeModuleIds,
    edgeOtherChunkPaths,
  });

  // Step 4: Bundle with esbuild
  const serverFiles = await bundleForWorkers({
    workerSource,
    outputDir: serverDir,
    serverAssets: new Map(),
    wasmFiles,
    distDir: ctx.distDir,
    repoRoot: ctx.repoRoot,
    standaloneDir: ctx.distDir,
  });

  const totalSize = await getTotalSize(serverDir, serverFiles);
  console.log(`  [Creek Adapter] Worker bundled: ${serverFiles.length} files (${formatSize(totalSize)})`);

  // Step 5: Write deploy manifest
  await writeManifest(outputDir, {
    buildId: ctx.buildId,
    nextVersion: ctx.nextVersion,
    entrypoint: "worker.js",
    serverFiles,
    hasMiddleware: !!ctx.outputs.middleware,
    hasPrerender: ctx.outputs.prerenders.length > 0,
  });

  console.log(`  [Creek Adapter] Output ready: ${OUTPUT_DIR}/`);
}

async function collectStaticFiles(
  outputs: BuildContext["outputs"],
  assetsDir: string,
): Promise<number> {
  let count = 0;
  const allPathnames = new Set(outputs.staticFiles.map((f) => f.pathname));

  for (const file of outputs.staticFiles) {
    let destRelative = file.pathname;
    if (!path.extname(destRelative)) {
      // Extensionless static files are pre-rendered HTML pages (e.g. /, /about, /404).
      // Store as <pathname>/index.html so CF Workers Assets serves them correctly.
      destRelative = path.join(destRelative, "index.html");
    }
    const destPath = path.join(assetsDir, destRelative);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    try {
      await fs.copyFile(file.filePath, destPath);
      count++;
    } catch {}
  }

  for (const prerender of outputs.prerenders) {
    if (prerender.fallback?.filePath) {
      let destRelative = prerender.pathname;
      if (!path.extname(destRelative)) {
        destRelative = destRelative + "/index.html";
      }
      const destPath = path.join(assetsDir, destRelative);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      try {
        await fs.copyFile(prerender.fallback.filePath, destPath);
        count++;
      } catch {}
    }
  }

  return count;
}

async function getTotalSize(dir: string, files: string[]): Promise<number> {
  let total = 0;
  for (const f of files) {
    try {
      const stat = await fs.stat(path.join(dir, f));
      total += stat.size;
    } catch {}
  }
  return total;
}

/**
 * Collect all JSON manifests from .next/ for embedding in the worker.
 * Returns a map of absolute path → file content string.
 */
async function collectManifests(distDir: string): Promise<Record<string, string>> {
  const manifests: Record<string, string> = {};

  // Recursively find all .json files in .next/ and .next/server/
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip large directories that don't contain manifests
        if (entry.name === "static" || entry.name === "cache" || entry.name === "chunks") continue;
        await walk(fullPath);
      } else if (entry.name === "BUILD_ID" || entry.name === "package.json") {
        manifests[fullPath] = await fs.readFile(fullPath, "utf-8").catch(() => "");
      } else if (entry.name.endsWith(".json") || entry.name.endsWith(".js")) {
        // Skip non-essential files that bloat the worker entry:
        // - .nft.json (file tracing, not needed at runtime)
        // - .segments files
        // - page.js / route.js (handler code, imported separately)
        // - _client-reference-manifest.js (imported as static imports)
        if (entry.name.endsWith(".nft.json")) continue;
        if (entry.name.endsWith(".segments")) continue;
        if (entry.name === "page.js" || entry.name === "route.js") continue;
        if (entry.name.endsWith("_client-reference-manifest.js")) continue;
        try {
          const stat = await fs.stat(fullPath);
          // Skip files > 512KB (not manifests)
          if (stat.size < 512_000) {
            manifests[fullPath] = await fs.readFile(fullPath, "utf-8");
          }
        } catch {}
      }
    }
  }

  await walk(distDir);
  // Also collect the required-server-files manifest
  const reqServerFiles = path.join(distDir, "required-server-files.json");
  try {
    manifests[reqServerFiles] = await fs.readFile(reqServerFiles, "utf-8");
  } catch {}

  return manifests;
}

/** Prerender entry for ISR cache seeding */
export interface PrerenderEntry {
  pathname: string;
  html: string;
  postponedState?: string;
  initialRevalidate?: number | false;
  initialStatus?: number;
  initialHeaders?: Record<string, string | string[]>;
  initialExpiration?: number;
  pprHeaders?: Record<string, string>;
}

/**
 * Collect prerender entries from build outputs for cache seeding.
 * Reads fallback HTML files and extracts metadata for ISR.
 */
async function collectPrerenderEntries(outputs: BuildContext["outputs"]): Promise<PrerenderEntry[]> {
  const entries: PrerenderEntry[] = [];
  // Limit prerender entries to prevent oversized worker bundles.
  // Large apps can have hundreds of prerenders, each with full HTML.
  const MAX_PRERENDER_ENTRIES = 50;

  for (const prerender of outputs.prerenders) {
    if (!prerender.fallback?.filePath) continue;
    if (entries.length >= MAX_PRERENDER_ENTRIES) break;

    try {
      const html = await fs.readFile(prerender.fallback.filePath, "utf-8");
      entries.push({
        pathname: prerender.pathname,
        html,
        postponedState: prerender.fallback.postponedState,
        initialRevalidate: prerender.fallback.initialRevalidate,
        initialStatus: prerender.fallback.initialStatus,
        initialHeaders: prerender.fallback.initialHeaders,
        initialExpiration: prerender.fallback.initialExpiration,
        pprHeaders: prerender.pprChain?.headers,
      });
    } catch {
      // Skip prerenders whose fallback file can't be read
    }
  }

  return entries;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

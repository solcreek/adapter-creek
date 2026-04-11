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

  // Step 1: Collect static files (including public/* and edge-chunks/*)
  const assetCount = await collectStaticFiles(ctx.outputs, assetsDir, ctx.projectDir, ctx.distDir);
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
                const absPath = path.join(ctx.distDir, "server", "edge", rel);
                await addEdgeChunkImportPath(edgeOtherChunkPaths, absPath);
                console.log(`  [Creek Adapter] Edge otherChunk: ${path.basename(absPath)}`);
              }
            }
          }
        }
      }

      // Middleware handler extraction is handled by the Turbopack runtime
      // patching and otherChunks import above. The edge runtime's _ENTRIES
      // registration works via runtimeModuleIds push (see __initEdgeModules).
    } catch {}
  }

  // Step 3d: Extract runtimeModuleIds for edge handlers.
  // Log edge handler info for debugging
  for (const outputs2 of [ctx.outputs.appPages, ctx.outputs.appRoutes, ctx.outputs.pages, ctx.outputs.pagesApi]) {
    for (const output of outputs2) {
      if (output.runtime === "edge") {
      }
    }
  }
  // Each edge page/route has its own Turbopack edge-wrapper with runtimeModuleIds.
  // We read the wrapper files to extract the module IDs and attach them to outputs.
  for (const outputs of [ctx.outputs.appPages, ctx.outputs.appRoutes, ctx.outputs.pages, ctx.outputs.pagesApi]) {
    for (const output of outputs) {
      if (output.runtime === "edge" && output.edgeRuntime?.modulePath) {
        try {
          const content = await fs.readFile(output.edgeRuntime.modulePath, "utf-8");
          const idsMatch = content.match(/runtimeModuleIds:\s*\[([0-9,\s]+)\]/);
          if (idsMatch) {
            const ids = idsMatch[1].split(",").map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n));
            if (ids.length > 0) {
              (output.edgeRuntime as Record<string, unknown>).runtimeModuleId = ids[0];
            }
          }
          // Also find and import otherChunks for this edge handler
          const chunksMatch = content.match(/otherChunks:\s*\[((?:"[^"]*"(?:,\s*)?)*)\]/);
          if (chunksMatch) {
            const chunkPaths = chunksMatch[1].match(/"([^"]+)"/g);
            if (chunkPaths) {
              const edgeRootDir = path.join(ctx.distDir, "server", "edge");
              for (const raw of chunkPaths) {
                const rel = raw.replace(/"/g, "");
                // Turbopack edge wrapper otherChunks are emitted relative to
                // .next/server/edge/, e.g. "chunks/ssr/<file>.js".
                const absPath = path.join(edgeRootDir, rel);
                await addEdgeChunkImportPath(edgeOtherChunkPaths, absPath);
              }
            }
          }
        } catch {}
      }
    }
  }

  // Turbopack edge wrappers do not enumerate every transitive chunk in
  // otherChunks. Preload the full edge chunk directory so module factories
  // for builtins like global-error are always registered before execution.
  try {
    const edgeChunksDir = path.join(ctx.distDir, "server", "edge", "chunks");
    const chunkPaths = await collectJsFilesRecursive(edgeChunksDir);
    for (const chunkPath of chunkPaths) {
      await addEdgeChunkImportPath(edgeOtherChunkPaths, chunkPath);
    }
  } catch {}

  // Step 3e: Collect non-code user files (data.json, etc.) that route
  // handlers may read at runtime via fs.readFileSync. Next.js's adapter API
  // exposes these per-output as `output.assets` (the result of file tracing).
  // We embed them in __USER_FILES so the fs shim can serve them in workerd.
  const userFiles = await collectUserFiles(ctx.outputs);
  if (Object.keys(userFiles).length > 0) {
    console.log(`  [Creek Adapter] ${Object.keys(userFiles).length} user data files embedded`);
  }

  // Step 4: Generate worker entry
  const workerSource = generateWorkerEntry({
    buildId: ctx.buildId,
    routing: ctx.routing,
    outputs: ctx.outputs,
    basePath: ctx.config.basePath || "",
    assetPrefix: ctx.config.assetPrefix || "",
    i18n: ctx.config.i18n || null,
    manifests,
    userFiles,
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

// True for static-file entries that represent a pre-rendered HTML page
// (e.g. \`/about\`, \`/catch-all/[...slug]\`) rather than a real asset like
// \`/_next/static/foo.js\`. We can't just check `path.extname()`: a Next.js
// dynamic segment like `[...slug]` contains dots and `extname` returns
// `.slug]`, which would misclassify catch-all pages as assets and skip the
// `index.html` rewrite below — leaving the served file at \`/catch-all/[...slug]\`
// where the worker can't find it.
function isStaticHtmlPage(pathname: string): boolean {
  if (pathname.startsWith("/_next/")) return false;
  if (pathname.includes("[")) return true;
  return !path.extname(pathname);
}

async function collectStaticFiles(
  outputs: BuildContext["outputs"],
  assetsDir: string,
  projectDir?: string,
  distDir?: string,
): Promise<number> {
  let count = 0;
  const allPathnames = new Set(outputs.staticFiles.map((f) => f.pathname));

  for (const file of outputs.staticFiles) {
    let destRelative = file.pathname;
    if (isStaticHtmlPage(destRelative)) {
      // Pre-rendered HTML pages (e.g. /, /about, /404, /catch-all/[...slug]).
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
      if (isStaticHtmlPage(destRelative)) {
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

  // Edge asset bindings (\`.next/server/edge-chunks/asset_*\`). Edge routes
  // that do \`fetch(new URL('../../assets/foo', import.meta.url))\` get
  // rewritten by next's middleware-asset-loader to \`fetch('blob:foo')\` at
  // build time, with the actual bytes emitted to
  // \`.next/server/edge-chunks/asset_foo\`. The upstream edge sandbox has a
  // \`fetchInlineAsset\` shim that intercepts \`blob:\` URLs and reads the
  // file from disk; since CF Workers have no fs access, we copy the
  // chunks into the static assets binding under \`/_next/edge-chunks/\`
  // and the runtime fetch wrapper maps \`blob:NAME\` →
  // \`/_next/edge-chunks/asset_NAME\`.
  if (distDir) {
    const edgeChunksDir = path.join(distDir, "server", "edge-chunks");
    try {
      const entries = await fs.readdir(edgeChunksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const srcPath = path.join(edgeChunksDir, entry.name);
        const destPath = path.join(assetsDir, "_next", "edge-chunks", entry.name);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        try {
          await fs.copyFile(srcPath, destPath);
          count++;
        } catch {}
      }
    } catch {
      // No edge-chunks dir — no edge asset bindings in this build.
    }
  }

  // Turbopack edge assets (\`.next/server/edge/assets/*\`). These are files
  // referenced by edge route handlers via
  // \`fetch(new URL('./asset.ttf', import.meta.url))\`. Turbopack rewrites
  // the URL to \`blob:server/edge/assets/<hashed-filename>\` at build time;
  // Next.js's edge sandbox uses \`fetchInlineAsset\` to translate the blob URL
  // back to a filesystem read. CF Workers have no fs, so we mirror the
  // files into the static assets binding under \`/_next/edge-assets/<name>\`
  // and the runtime fetch wrapper in worker-entry.ts maps
  // \`blob:server/edge/assets/<name>\` → \`/_next/edge-assets/<name>\`.
  // \`next/og\` custom fonts (and any other \`new URL(..., import.meta.url)\`
  // edge asset) goes through this path.
  if (distDir) {
    const edgeAssetsDir = path.join(distDir, "server", "edge", "assets");
    try {
      const entries = await fs.readdir(edgeAssetsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const srcPath = path.join(edgeAssetsDir, entry.name);
        const destPath = path.join(assetsDir, "_next", "edge-assets", entry.name);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        try {
          await fs.copyFile(srcPath, destPath);
          count++;
        } catch {}
      }
    } catch {
      // No edge assets dir — no Turbopack edge assets in this build.
    }
  }

  // Public files (\`<projectDir>/public/*\`). Next.js's adapter API does not
  // expose these via outputs.staticFiles (only \`_next/static/*\` lands there),
  // so we walk the directory ourselves and copy each file to the deployment
  // assets root. Without this, root-level scripts like \`/test1.js\` and
  // \`/favicon.ico\` 404 because the worker has nothing to serve.
  if (projectDir) {
    const publicDir = path.join(projectDir, "public");
    try {
      await fs.access(publicDir);
      const walk = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(srcPath);
            continue;
          }
          if (!entry.isFile()) continue;
          const relativeFromPublic = path.relative(publicDir, srcPath);
          const destPath = path.join(assetsDir, relativeFromPublic);
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          try {
            await fs.copyFile(srcPath, destPath);
            count++;
          } catch {}
        }
      };
      await walk(publicDir);
    } catch {
      // No public dir — skip silently
    }
  }

  return count;
}

async function addEdgeChunkImportPath(paths: string[], absPath: string): Promise<void> {
  const importPath = await getSafeEdgeImportPath(absPath);
  if (!paths.includes(importPath)) {
    paths.push(importPath);
  }
}

async function getSafeEdgeImportPath(absPath: string): Promise<string> {
  if (!absPath.includes("[") && !absPath.includes("]")) {
    return absPath;
  }

  const dir = path.dirname(absPath);
  const base = path.basename(absPath).replace(/\[/g, "_").replace(/\]/g, "_");
  const safePath = path.join(dir, base);
  try {
    const content = await fs.readFile(absPath, "utf-8");
    await fs.writeFile(safePath, content);
    return safePath;
  } catch {
    return absPath;
  }
}

async function collectJsFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsFilesRecursive(absPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".js.map")) {
      files.push(absPath);
    }
  }
  return files;
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
        // - client/route handler code (imported separately)
        if (entry.name.endsWith(".nft.json")) continue;
        if (entry.name.endsWith(".segments")) continue;
        if (entry.name === "page.js" || entry.name === "route.js") continue;
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

/**
 * Collect non-code user files that route handlers may read via fs.readFileSync.
 *
 * Walks every output's `assets` map (Next.js file-trace results), filters out
 * node_modules and code files, and reads the remainder into two maps:
 *   - text files (.json, .txt, .yaml, etc.) are kept as utf-8 strings in the
 *     `text` map, indexed by fileOutputPath (relative to outputFileTracingRoot).
 *   - binary files (fonts, images, wasm, etc.) are base64-encoded into the
 *     `binary` map with a `__CREEK_B64__` prefix so the fs shim can detect
 *     them and decode to Uint8Array on read. This supports patterns like
 *     `next/og` Node-runtime route handlers that do
 *     `fs.readFile(join(cwd, 'assets/foo.ttf'))`.
 *
 * Size cap (2MB total across both maps) prevents accidentally bloating the
 * worker bundle when a project has large data assets — the user can hit it
 * explicitly to force a different deployment strategy.
 */
async function collectUserFiles(
  outputs: BuildContext["outputs"],
): Promise<Record<string, string>> {
  const TEXT_EXTENSIONS = new Set([
    ".json", ".txt", ".yaml", ".yml", ".md", ".csv", ".xml",
    ".html", ".htm", ".sql", ".graphql", ".gql", ".env",
  ]);
  const BINARY_EXTENSIONS = new Set([
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
    ".svg", ".wasm", ".pdf",
  ]);
  const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4MB cap (base64 inflates binary)

  const files: Record<string, string> = {};
  let totalBytes = 0;

  const allOutputs = [
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...outputs.pages,
    ...outputs.pagesApi,
  ];

  for (const output of allOutputs) {
    const assets = (output as { assets?: Record<string, string> }).assets;
    if (!assets) continue;

    for (const [fileOutputPath, sourceFile] of Object.entries(assets)) {
      // Skip already-collected (different outputs may share the same asset)
      if (files[fileOutputPath]) continue;

      // Skip dependencies — esbuild already bundles JS deps; we only need
      // user-side data files that get read at runtime via fs.
      if (fileOutputPath.includes("node_modules/")) continue;

      const ext = path.extname(fileOutputPath).toLowerCase();
      const isText = TEXT_EXTENSIONS.has(ext);
      const isBinary = BINARY_EXTENSIONS.has(ext);
      if (!isText && !isBinary) continue;

      try {
        if (isText) {
          const content = await fs.readFile(sourceFile, "utf-8");
          if (totalBytes + content.length > MAX_TOTAL_BYTES) {
            console.warn(
              `  [Creek Adapter] User-files size cap reached (${MAX_TOTAL_BYTES} bytes); skipping ${fileOutputPath}`,
            );
            continue;
          }
          files[fileOutputPath] = content;
          totalBytes += content.length;
        } else {
          // Binary path: base64-encode with a sentinel prefix so the fs
          // shim can detect and decode.
          const buffer = await fs.readFile(sourceFile);
          const encoded = "__CREEK_B64__" + buffer.toString("base64");
          if (totalBytes + encoded.length > MAX_TOTAL_BYTES) {
            console.warn(
              `  [Creek Adapter] User-files size cap reached (${MAX_TOTAL_BYTES} bytes); skipping ${fileOutputPath}`,
            );
            continue;
          }
          files[fileOutputPath] = encoded;
          totalBytes += encoded.length;
        }
      } catch {
        // Skip files we can't read — they may have been excluded by tracing
      }
    }
  }

  return files;
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

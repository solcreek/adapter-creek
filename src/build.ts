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
  const assetCount = await collectStaticFiles(ctx.outputs, assetsDir, ctx.projectDir, ctx.distDir, ctx.buildId);
  console.log(`  [Creek Adapter] ${assetCount} static files collected`);

  // Step 2: Collect WASM files from all outputs.
  // Middleware (both \`ctx.outputs.middleware\` and the \`edgeRuntime\` variant)
  // ships its own wasmAssets separate from the page/route outputs — tests
  // like \`edge-can-use-wasm-files\` import a user-provided \`.wasm\` from
  // middleware. Skipping middleware here produced a \`.creek/\` output
  // with zero wasm siblings and workerd threw at runtime:
  // \`dynamically loading WebAssembly is not supported ... chunk
  // 'chunks/src_add_0656eb_.wasm'\`.
  const wasmFiles = new Map<string, string>();
  for (const outputs of [
    ctx.outputs.appPages,
    ctx.outputs.appRoutes,
    ctx.outputs.pages,
    ctx.outputs.pagesApi,
  ]) {
    for (const output of outputs) {
      if (output.wasmAssets) {
        for (const [name, absPath] of Object.entries(output.wasmAssets)) {
          wasmFiles.set(name, absPath);
        }
      }
    }
  }
  // Middleware ships its own wasmAssets separate from the page/route
  // outputs. \`edge-can-use-wasm-files\` imports a user-provided \`.wasm\`
  // from middleware. Skipping this produced zero wasm siblings in the
  // \`.creek/\` output and workerd threw at runtime with
  // \`dynamically loading WebAssembly is not supported ...
  //  chunk 'chunks/src_add_0656eb_.wasm'\`.
  const mwOutput = ctx.outputs.middleware as
    | { wasmAssets?: Record<string, string> }
    | undefined;
  if (mwOutput?.wasmAssets) {
    for (const [name, absPath] of Object.entries(mwOutput.wasmAssets)) {
      wasmFiles.set(name, absPath);
    }
  }

  // Step 3: Collect manifests from .next/ for embedding in the worker.
  // Next.js route modules call loadManifest() which uses fs.readFileSync().
  // CF Workers doesn't have fs, so we embed all manifests and shim the loader.
  const manifests = await collectManifests(ctx.distDir);
  console.log(`  [Creek Adapter] ${Object.keys(manifests).length} manifests embedded`);

  // Step 3a-bis: Compute xxh3-128 hex for every wasm file. Turbopack's
  // edge bundles access each wasm via \`globalThis.wasm_<hex>\` where
  // \`<hex>\` is xxh3_128(wasm_content). At worker init we need to import
  // the wasm (as CompiledWasm via wrangler rules) and mirror it onto
  // globalThis under the expected name.
  const wasmHashToFilename = new Map<string, string>();
  try {
    const { xxh3 } = await import("@node-rs/xxhash");
    for (const [name, absPath] of wasmFiles) {
      try {
        const bytes = await fs.readFile(absPath);
        const hex = xxh3.xxh128(bytes).toString(16).padStart(32, "0");
        const destName = name.endsWith(".wasm") ? name : name + ".wasm";
        console.log(`    wasm: name=${name} dest=${destName} xxh3=${hex}`);
        wasmHashToFilename.set(hex, destName);
      } catch {}
    }
    if (wasmHashToFilename.size > 0) {
      console.log(`  [Creek Adapter] ${wasmHashToFilename.size} wasm edge var mappings computed`);
    }
  } catch {}

  // Step 3b: Collect prerender entries for ISR cache seeding.
  // Each prerender with a fallback file gets seeded into the cache at startup.
  const prerenderEntries = await collectPrerenderEntries(ctx.outputs);
  if (prerenderEntries.length > 0) {
    console.log(`  [Creek Adapter] ${prerenderEntries.length} prerender entries for cache seeding`);
  }

  // Step 3c: Extract \`'use cache'\` entries from every prerender's postponedState.
  // Keyed by bracket-form shell pathname so the worker can apply them ONLY to
  // requests matching that shell — mirrors Next.js's request-scoped RDC and
  // keeps e.g. /with-suspense/* build-time values out of /without-suspense/*
  // requests that expect fresh runtime renders.
  const composableCacheSeedsByShell = await collectComposableCacheSeeds(ctx.outputs);
  const composableCacheSeedEntries = Array.from(composableCacheSeedsByShell.entries());
  const composableCacheSeedCount = composableCacheSeedEntries.reduce(
    (n, [, seeds]) => n + seeds.length,
    0
  );
  if (composableCacheSeedCount > 0) {
    console.log(
      `  [Creek Adapter] ${composableCacheSeedCount} composable cache seeds across ${composableCacheSeedEntries.length} shells`
    );
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
    composableCacheSeedsByShell: composableCacheSeedEntries,
    wasmHashToFilename: Array.from(wasmHashToFilename.entries()),
    externalModules: await collectExternalizedModules(ctx.distDir),
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

// Inject `data-dpl-id="<buildId>"` into the `<html>` tag of static HTML
// files at build time. The Pages Router client reads this attribute on
// page load to populate `globalThis.NEXT_DEPLOYMENT_ID`, then sends
// `x-deployment-id: <buildId>` on subsequent /_next/data/* fetches. The
// worker runtime always responds with `x-nextjs-deployment-id: <buildId>`,
// so the client's skew-protection check matches and client-side
// navigation stays soft. Without this injection, static pages (/404,
// /error, /about) don't have the attribute — because nextConfig.deploymentId
// is usually unset in test fixtures — and client-transition tests in
// middleware-general hard-reload on every push, wiping `window.beforeNav`.
// Dynamically rendered pages get the attribute through Next.js's own
// `createHtmlDataDplIdTransformStream`, which we enable at runtime by
// patching `__SERVER_FILES_MANIFEST.config.deploymentId` in worker-entry.
async function copyHtmlWithDplId(src: string, dest: string, buildId: string): Promise<void> {
  const content = await fs.readFile(src, "utf8");
  // Skip if already has the attribute (e.g. upstream nextConfig.deploymentId
  // was set at build time), otherwise insert right after `<html`.
  let patched = content;
  if (!content.includes("data-dpl-id")) {
    patched = content.replace(/<html(?=[\s>])/, `<html data-dpl-id="${buildId}"`);
  }
  await fs.writeFile(dest, patched);
}

// \`fs.mkdir(..., {recursive:true})\` throws ENOTDIR if any parent of the
// target path exists as a file. Next.js's adapter API emits
// interception-route prerenders that collide with regular routes: e.g.
// \`/test-nested\` lands as an HTML file at \`assets/test-nested\`, then a
// subsequent \`/(.)test-nested/deeper\` wants to create
// \`assets/(.)test-nested/deeper/\` — but a prior loop iteration may have
// created \`assets/(.)test-nested\` as a FILE. Recover: return false so
// the caller skips this entry. Interception routes are dynamic and
// will be served via the worker, so skipping the prerender copy is safe.
// Fixes \`Build error: ENOTDIR: not a directory, mkdir '.../(.)foo/bar'\`
// on interception-dynamic-segment + parallel-routes fixtures.
async function safeMkdirForDest(destPath: string, label?: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    return true;
  } catch (err: any) {
    // ENOTDIR: a parent in the path exists as a file → cannot create dir
    //         beneath it. (Seen when \`(.)foo/bar\` is processed after
    //         \`(.)foo\` got written as a file — \`(.)foo\` then blocks
    //         \`(.)foo/bar\`.)
    // EEXIST: \`fs.mkdir({recursive:true})\` only silences EEXIST when the
    //         target is already a directory. If \`(.)foo\` was written as
    //         a file first and we later try to \`mkdir assets/(.)foo\` to
    //         host a sibling, node throws EEXIST instead of ENOTDIR
    //         depending on which parent the conflict lands on.
    if (err && (err.code === "ENOTDIR" || err.code === "EEXIST")) {
      if (label) {
        console.error(
          "[adapter-creek] skip (path conflicts with a file sibling):",
          label,
        );
      }
      return false;
    }
    throw err;
  }
}

async function collectStaticFiles(
  outputs: BuildContext["outputs"],
  assetsDir: string,
  projectDir?: string,
  distDir?: string,
  buildId?: string,
): Promise<number> {
  let count = 0;
  const allPathnames = new Set(outputs.staticFiles.map((f) => f.pathname));

  for (const file of outputs.staticFiles) {
    let destRelative = file.pathname;
    const isHtml = isStaticHtmlPage(destRelative);
    if (isHtml) {
      // Pre-rendered HTML pages (e.g. /, /about, /404, /catch-all/[...slug]).
      // Store as <pathname>/index.html so CF Workers Assets serves them correctly.
      destRelative = path.join(destRelative, "index.html");
    }
    const destPath = path.join(assetsDir, destRelative);
    if (!(await safeMkdirForDest(destPath, destRelative))) continue;
    try {
      if (isHtml && buildId) {
        await copyHtmlWithDplId(file.filePath, destPath, buildId);
      } else {
        await fs.copyFile(file.filePath, destPath);
      }
      count++;
    } catch {}
  }

  for (const prerender of outputs.prerenders) {
    if (prerender.fallback?.filePath) {
      let destRelative = prerender.pathname;
      const isHtml = isStaticHtmlPage(destRelative);
      if (isHtml) {
        destRelative = destRelative + "/index.html";
      }
      const destPath = path.join(assetsDir, destRelative);
      if (!(await safeMkdirForDest(destPath, destRelative))) continue;
      try {
        if (isHtml && buildId) {
          await copyHtmlWithDplId(prerender.fallback.filePath, destPath, buildId);
        } else {
          await fs.copyFile(prerender.fallback.filePath, destPath);
        }
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
        if (!(await safeMkdirForDest(destPath, entry.name))) continue;
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
        if (!(await safeMkdirForDest(destPath, entry.name))) continue;
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
          if (!(await safeMkdirForDest(destPath, relativeFromPublic))) continue;
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

      const ext = path.extname(fileOutputPath).toLowerCase();
      const isText = TEXT_EXTENSIONS.has(ext);
      const isBinary = BINARY_EXTENSIONS.has(ext);
      if (!isText && !isBinary) continue;

      // Skip JS/TS dependencies from node_modules — esbuild already bundles
      // those. But keep BINARY assets even when they live in node_modules:
      // \`next/og\` (node runtime) reads \`@vercel/og/resvg.wasm\` +
      // \`Geist-Regular.ttf\` via \`fs.readFileSync(fileURLToPath(...))\` at
      // request time — those bytes have to be available through our fs
      // shim or the route handler 500s. Same for other libs that ship
      // fonts/wasm as sibling assets.
      // Fixes og-api node-runtime (\`/og-node\`) and
      // use-cache-metadata-route-handler opengraph/icon image tests.
      if (fileOutputPath.includes("node_modules/") && !isBinary) continue;

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

/**
 * A single \`'use cache'\` entry extracted at build time from a prerender's
 * embedded renderResumeDataCache. Mirrors Next.js's UseCacheCacheStoreSerialized
 * shape (see packages/next/src/server/resume-data-cache/cache-store.ts) so the
 * worker can restore these straight into CreekComposableCacheHandler without
 * running Next.js's parse path (which allocates streams tied to a request's
 * IoContext).
 */
export interface ComposableCacheSeed {
  key: string;
  value: string;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

/**
 * Extract \`'use cache'\` entries from every prerender's postponedState.
 *
 * Next.js serializes postponedState as \`<len>:<postponedString><base64ZlibBlob>\`
 * where the tail is a zlib-compressed JSON containing the cache, fetch, and
 * encryptedBoundArgs stores. We decompress and pull out the cache entries so
 * the worker can hand them to CreekComposableCacheHandler at init — meaning
 * root-layout \`'use cache'\` values computed at build time ("buildtime"
 * sentinel) survive into runtime GETs without a full PPR resume.
 *
 * Duplicate cache keys (e.g. root layout shared across many shells) dedupe
 * naturally by Map key — the last seen wins, which is fine since they're
 * semantically identical.
 */
async function collectComposableCacheSeeds(
  outputs: BuildContext["outputs"]
): Promise<Map<string, ComposableCacheSeed[]>> {
  const zlib = await import("node:zlib");
  // Map bracket-form pathname → its cache entries. Gating by shell prevents
  // seeds from one prerender's request-scoped RDC from bleeding into
  // unrelated requests (e.g. \`/with-suspense/*\`'s build-time "buildtime"
  // leaking into \`/without-suspense/*\` where the test expects "runtime").
  const byShell = new Map<string, ComposableCacheSeed[]>();
  for (const prerender of outputs.prerenders) {
    const postponed = prerender.fallback?.postponedState;
    if (typeof postponed !== "string" || postponed.length === 0) continue;
    const m = postponed.match(/^(\d+):/);
    if (!m) continue;
    const prefixLen = m[0].length;
    const postponedLen = parseInt(m[1], 10);
    const cacheBlob = postponed.slice(prefixLen + postponedLen);
    if (!cacheBlob || cacheBlob === "null") continue;
    try {
      const buf = Buffer.from(cacheBlob, "base64");
      const inflated = zlib.inflateSync(buf, { maxOutputLength: 200 * 1024 * 1024 });
      const json = JSON.parse(inflated.toString("utf-8"));
      const cacheStore = json?.store?.cache;
      if (!cacheStore || typeof cacheStore !== "object") continue;
      const shellSeeds: ComposableCacheSeed[] = [];
      for (const [key, serialized] of Object.entries<any>(cacheStore)) {
        if (!serialized?.entry) continue;
        const e = serialized.entry;
        shellSeeds.push({
          key,
          value: e.value ?? "",
          tags: Array.isArray(e.tags) ? e.tags : [],
          stale: typeof e.stale === "number" ? e.stale : 0,
          timestamp: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
          expire: typeof e.expire === "number" ? e.expire : Number.MAX_SAFE_INTEGER,
          revalidate: typeof e.revalidate === "number" ? e.revalidate : Number.MAX_SAFE_INTEGER,
        });
      }
      if (shellSeeds.length > 0) byShell.set(prerender.pathname, shellSeeds);
    } catch {}
  }
  return byShell;
}

/**
 * Scan built Turbopack chunks for the \`await e.y("<specifier>")\`
 * externalImport calls Turbopack emits for modules it can't bundle
 * (Node-specific libs like \`@vercel/og/index.node.js\`). workerd refuses
 * to resolve those at runtime, so we collect the specifiers and
 * statically \`import\` them from our worker entry instead — wrangler
 * then bundles them, and our patched externalImport returns the cached
 * module from \`globalThis.__CREEK_EXT_MODS\`.
 */
async function collectExternalizedModules(distDir: string): Promise<string[]> {
  const found = new Set<string>();
  const scanDir = async (dir: string) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await scanDir(full);
        else if (e.name.startsWith("[externals]") && e.name.endsWith(".js")) {
          try {
            const content = await fs.readFile(full, "utf-8");
            const m = content.match(/e\.y\("([^"]+)"\)/);
            if (m) found.add(m[1]);
          } catch {}
        }
      }
    } catch {}
  };
  await scanDir(path.join(distDir, "server", "chunks"));
  await scanDir(path.join(distDir, "server", "edge", "chunks"));
  return Array.from(found);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

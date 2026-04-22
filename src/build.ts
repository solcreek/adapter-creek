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

interface ExternalModuleLoader {
  id: string;
  importSpecifier: string;
}

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

  // Scan \`output.assets\` for \`.wasm\` files too. Next.js's adapter API
  // puts Turbopack-known wasm in \`wasmAssets\` (above), but libraries
  // like \`@vercel/og\`'s node-runtime variant load \`resvg.wasm\` /
  // \`yoga.wasm\` via \`fs.readFileSync\` — those files show up in
  // \`output.assets\` only (file-tracing result). workerd rejects
  // \`WebAssembly.instantiate(bytes)\` — we need the bytes precompiled
  // into a \`WebAssembly.Module\` at bundle time. Feed these wasms
  // through the same CompiledWasm pipeline so the runtime instantiate
  // override can swap bytes → pre-compiled Module by length.
  // Fixes next/og node-runtime path (og-api \`/og-node\`,
  // use-cache-metadata-route-handler opengraph/icon tests).
  for (const outputs of [
    ctx.outputs.appPages,
    ctx.outputs.appRoutes,
    ctx.outputs.pages,
    ctx.outputs.pagesApi,
  ]) {
    for (const output of outputs) {
      const assets = (output as { assets?: Record<string, string> }).assets;
      if (!assets) continue;
      for (const [outPath, srcPath] of Object.entries(assets)) {
        if (!outPath.endsWith(".wasm")) continue;
        // Use basename as the wasm \`name\` so collisions across sources
        // don't produce colliding destination files. The
        // xxh3-content-hashing step below key by content anyway.
        const name = path.basename(outPath);
        if (!wasmFiles.has(name)) wasmFiles.set(name, srcPath);
      }
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
  // Byte length → bundled wasm filename. Used at runtime by the
  // \`WebAssembly.instantiate\` patch to swap byte-based calls
  // (which workerd rejects as "Wasm code generation disallowed")
  // for the pre-compiled CompiledWasm module wrangler bundled.
  const wasmLengthToFilename = new Map<number, string>();
  try {
    const { xxh3 } = await import("@node-rs/xxhash");
    for (const [name, absPath] of wasmFiles) {
      try {
        const bytes = await fs.readFile(absPath);
        const hex = xxh3.xxh128(bytes).toString(16).padStart(32, "0");
        const destName = name.endsWith(".wasm") ? name : name + ".wasm";
        console.log(`    wasm: name=${name} dest=${destName} xxh3=${hex} bytes=${bytes.byteLength}`);
        wasmHashToFilename.set(hex, destName);
        wasmLengthToFilename.set(bytes.byteLength, destName);
      } catch {}
    }
    if (wasmHashToFilename.size > 0) {
      console.log(`  [Creek Adapter] ${wasmHashToFilename.size} wasm edge var mappings computed`);
    }
  } catch {}

  // Step 3b: Collect prerender entries for ISR cache seeding.
  // Each prerender with a fallback file gets seeded into the cache at startup.
  const fallbackShellRoutes = await collectFallbackShellRoutes(ctx.distDir);
  const prerenderEntries = await collectPrerenderEntries(
    ctx.outputs,
    fallbackShellRoutes,
  );
  if (prerenderEntries.length > 0) {
    console.log(`  [Creek Adapter] ${prerenderEntries.length} prerender entries for cache seeding`);
  }

  // Step 3c: Extract \`'use cache'\` entries from every prerender's postponedState.
  // Keyed by bracket-form shell pathname so the worker can apply them ONLY to
  // requests matching that shell — mirrors Next.js's request-scoped RDC and
  // keeps e.g. /with-suspense/* build-time values out of /without-suspense/*
  // requests that expect fresh runtime renders.
  const composableCacheSeedsByShell = await collectComposableCacheSeeds(
    ctx.outputs,
    fallbackShellRoutes,
  );
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
  //
  // We also track whether the file represents a REAL user instrumentation
  // (not our no-op) so the worker entry can statically import it and invoke
  // \`register()\` at startup. Next.js's \`getInstrumentationModule\` uses
  // \`__require\` with a dynamic path — workerd rejects that with
  // "Dynamic require ... is not supported", the registration promise resolves
  // undefined, and no user instrumentation ever runs. Side effects like
  // \`experimental.clientTraceMetadata\` meta-tag injection silently disappear.
  // Static-importing here gets the user module into the bundle and gives us
  // a concrete handle to hand back to Next.js at runtime.
  const instrumentationPath = path.join(ctx.distDir, "server", "instrumentation.js");
  let userInstrumentationPath: string | undefined;
  try {
    const existing = await fs.readFile(instrumentationPath, "utf-8");
    if (existing.trim().length > 0 && !/^\s*module\.exports\s*=\s*\{\s*\}\s*;?\s*$/.test(existing)) {
      userInstrumentationPath = instrumentationPath;
    }
  } catch {
    await fs.writeFile(instrumentationPath, "module.exports = {};");
  }


  // Step 3c: Find edge middleware registration chunk.
  // Turbopack generates TWO edge-wrapper files:
  // 1. turbopack-..._edge-wrapper (modulePath — Turbopack runtime, imported by worker)
  // 2. node_modules_..._edge-wrapper (contains _ENTRIES registration + module loader)
  // File 2 is NOT referenced by modulePath, so we need to import it explicitly.
  //
  // Webpack builds take a different path: the middleware output's `assets`
  // include `server/edge-runtime-webpack.js`, a tiny IIFE that installs a
  // `webpackChunk_N_E.push` hook. Without importing it BEFORE `middleware.js`,
  // the chunk push becomes a plain Array.push and the entry chunk never
  // evaluates — `_ENTRIES["middleware_middleware"]` stays undefined and all
  // middleware rewrites silently no-op (reproduces as search-params 404s).
  let edgeRegistrationChunkPath: string | undefined;
  let edgeRuntimeModuleIds: number[] = [];
  let edgeOtherChunkPaths: string[] = [];
  let webpackEdgeRuntimePath: string | undefined;
  let webpackEdgeBootstrapPath: string | undefined;
  if (ctx.outputs.middleware?.edgeRuntime) {
    const mwAssets = ctx.outputs.middleware.assets || {};
    for (const [rel, abs] of Object.entries(mwAssets)) {
      if (/(^|\/)server\/edge-runtime-webpack\.js$/.test(rel)) {
        webpackEdgeRuntimePath = abs;
        console.log(`  [Creek Adapter] Webpack edge runtime: ${path.basename(abs)}`);
        break;
      }
    }
    // Webpack's middleware.js ends with `(_ENTRIES="u"<typeof _ENTRIES?{}:
    // _ENTRIES).middleware_middleware=b` — a bare assignment that needs
    // `_ENTRIES` to resolve to a writable global. esbuild bundles the file as
    // strict-mode ESM, so the bare identifier throws ReferenceError unless
    // `globalThis._ENTRIES` already exists. This bootstrap file ensures it
    // does; importing it before the runtime/middleware imports runs it first
    // (imports evaluate in declaration order).
    if (webpackEdgeRuntimePath) {
      const bootstrapPath = path.join(ctx.distDir, "server", "creek-edge-bootstrap.js");
      await fs.writeFile(
        bootstrapPath,
        "globalThis._ENTRIES = globalThis._ENTRIES || {};\n"
      );
      webpackEdgeBootstrapPath = bootstrapPath;
    }
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
                const absPath = await resolveEdgeOtherChunkPath(ctx.distDir, rel);
                if (!absPath) continue;
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
              for (const raw of chunkPaths) {
                const rel = raw.replace(/"/g, "");
                const absPath = await resolveEdgeOtherChunkPath(ctx.distDir, rel);
                if (!absPath) continue;
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

  // Also preload node-side SSR chunks. Turbopack emits the server actions
  // registry (module 3103 on a representative build — the one that maps
  // action hex → handler fn) into \`.next/server/chunks/ssr/\` regardless
  // of runtime, but edge-wrappers don't list those paths in their
  // \`otherChunks\`. Without this, edge routes that invoke a server action
  // throw \`Module N was instantiated because it was required from module M,
  // but the module factory is not available\` at request time. Factory
  // registration is side-effect free (just pushes onto globalThis.TURBOPACK),
  // so preloading is safe — any Node-only factory body only runs if
  // someone actually requires that specific module.
  try {
    const nodeChunksDir = path.join(ctx.distDir, "server", "chunks");
    const chunkPaths = await collectJsFilesRecursive(nodeChunksDir);
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
  console.log("  [Creek Adapter] Scanning external modules...");
  const externalModules = await collectExternalizedModules(ctx.distDir);
  if (externalModules.length > 0) {
    console.log(`  [Creek Adapter] ${externalModules.length} external modules preloaded`);
  }
  console.log("  [Creek Adapter] Generating worker entry...");
  const workerSource = generateWorkerEntry({
    buildId: ctx.buildId,
    routing: ctx.routing,
    outputs: ctx.outputs,
    basePath: ctx.config.basePath || "",
    assetPrefix: ctx.config.assetPrefix || "",
    i18n: ctx.config.i18n || null,
    config: { trailingSlash: !!ctx.config.trailingSlash },
    manifests,
    userFiles,
    prerenderEntries,
    composableCacheSeedsByShell: composableCacheSeedEntries,
    wasmHashToFilename: Array.from(wasmHashToFilename.entries()),
    wasmLengthToFilename: Array.from(wasmLengthToFilename.entries()),
    externalModules,
    turbopackRuntimePath,
    edgeRegistrationChunkPath,
    edgeRuntimeModuleIds,
    edgeOtherChunkPaths,
    webpackEdgeRuntimePath,
    webpackEdgeBootstrapPath,
    userInstrumentationPath,
  });

  // Step 4: Bundle with esbuild
  console.log("  [Creek Adapter] Bundling worker...");
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

  // Phase 2a (experimental, opt-in via \`CREEK_MULTI_WORKER=1\`): emit a
  // 3-worker output that reuses the single-worker bundle as the
  // node-runtime worker. The dispatcher forwards unconditionally to it
  // via a service binding. Phase 2b will carve middleware + routing
  // into the dispatcher and Phase 2c produces a proper edge-runtime
  // bundle. Staying opt-in means enterprise customers get multi-runtime
  // isolation + fluid-compute-ready topology, while hobbyist tiers keep
  // the lean single-worker path.
  if (process.env.CREEK_MULTI_WORKER === "1") {
    await emitMultiWorker(ctx, outputDir, serverDir);
  }

  console.log(`  [Creek Adapter] Output ready: ${OUTPUT_DIR}/`);
}

/**
 * Count handlers by runtime so we know whether multi-worker emit makes
 * sense. Returns \`{ nodejs, edge }\` populated from every handler-bearing
 * output bucket. Middleware is separate (dispatcher responsibility) and
 * isn't counted here.
 */
interface RuntimeHandlerCounts {
  nodejs: number;
  edge: number;
}

function classifyHandlersByRuntime(
  outputs: BuildContext["outputs"],
): RuntimeHandlerCounts {
  const counts: RuntimeHandlerCounts = { nodejs: 0, edge: 0 };
  for (const bucket of [outputs.appPages, outputs.appRoutes, outputs.pages, outputs.pagesApi]) {
    for (const h of bucket) {
      if (h.runtime === "edge") counts.edge += 1;
      else counts.nodejs += 1;
    }
  }
  return counts;
}

/**
 * Emit the 3-worker multi-runtime layout: a dispatcher + node-runtime +
 * edge-runtime. Phase 2a reuses the single-worker bundle as the
 * node-runtime worker's \`worker.js\` — the dispatcher just forwards
 * every request via a service binding. This validates the real
 * end-to-end plumbing (service binding preserves body + headers +
 * streaming for genuine Next.js responses) before Phase 2b moves
 * middleware/routing up into the dispatcher.
 *
 * Opt-in via \`CREEK_MULTI_WORKER=1\`. The single-worker bundle in
 * \`server/\` stays untouched so existing deploys are unaffected.
 */
async function emitMultiWorker(
  ctx: BuildContext,
  outputDir: string,
  serverDir: string,
): Promise<void> {
  const runtimes = classifyHandlersByRuntime(ctx.outputs);
  console.log(
    `  [Creek Adapter] Multi-worker build: nodejs=${runtimes.nodejs} edge=${runtimes.edge}`,
  );

  const dispatcherDir = path.join(outputDir, "dispatcher");
  const nodeDir = path.join(outputDir, "node-runtime");
  const edgeDir = path.join(outputDir, "edge-runtime");
  for (const d of [dispatcherDir, nodeDir, edgeDir]) {
    await fs.mkdir(d, { recursive: true });
  }

  // --- node-runtime worker = existing single-worker bundle (Phase 2a) ---
  //
  // Copy server/worker.js + server/wrangler.toml into node-runtime/ so
  // the real Next.js handler runs there. In Phase 2b this worker will
  // receive pre-routed, pre-middleware requests from the dispatcher via
  // x-creek-* headers and skip its own middleware/resolveRoutes.
  const singleWorkerJs = path.join(serverDir, "worker.js");
  const nodeWorkerJs = path.join(nodeDir, "worker.js");
  await fs.copyFile(singleWorkerJs, nodeWorkerJs);

  // Mirror the server/wrangler.toml into node-runtime/ but rename
  // \`name\` so the service binding target matches (\`creek-node-runtime\`)
  // and bump the \`assets.directory\` so it still resolves to the shared
  // \`../assets/\`.
  const singleWranglerToml = await fs.readFile(
    path.join(serverDir, "wrangler.toml"),
    "utf-8",
  );
  const nodeWranglerToml = singleWranglerToml.replace(
    /name = "creek"/,
    'name = "creek-node-runtime"',
  );
  await fs.writeFile(path.join(nodeDir, "wrangler.toml"), nodeWranglerToml);

  // --- dispatcher worker: thin forwarder (Phase 2a) ---
  //
  // Unconditional forward to NODE_WORKER until Phase 2b splits by
  // runtime label. The \`x-creek-from\` header gives us a probe for
  // ensuring every request passed through the dispatcher.
  const dispatcherSource = [
    "// Creek adapter — dispatcher worker (Phase 2a).",
    "// Forwards every request to NODE_WORKER via service binding. Phase",
    "// 2b replaces this with middleware execution + @next/routing resolve",
    "// + runtime-label dispatch (nodejs → NODE_WORKER, edge → EDGE_WORKER).",
    "export default {",
    "  async fetch(request, env, ctx) {",
    "    const resp = await env.NODE_WORKER.fetch(request);",
    "    // Tag the response so callers can verify the dispatcher was on path.",
    "    const headers = new Headers(resp.headers);",
    '    headers.set("x-creek-from", "dispatcher");',
    "    return new Response(resp.body, {",
    "      status: resp.status,",
    "      statusText: resp.statusText,",
    "      headers,",
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dispatcherDir, "worker.js"), dispatcherSource);

  await fs.writeFile(
    path.join(dispatcherDir, "wrangler.toml"),
    [
      "# Generated by adapter-creek (multi-worker, Phase 2a).",
      'name = "creek-dispatcher"',
      'main = "worker.js"',
      'compatibility_date = "2026-03-23"',
      'compatibility_flags = ["nodejs_compat"]',
      "",
      "[[services]]",
      'binding = "NODE_WORKER"',
      'service = "creek-node-runtime"',
      "",
      "[[services]]",
      'binding = "EDGE_WORKER"',
      'service = "creek-edge-runtime"',
      "",
    ].join("\n"),
  );

  // --- edge-runtime worker: scaffold until Phase 2c ---
  //
  // Currently returns 501 for anything forwarded to it. Since Phase 2a's
  // dispatcher always routes to NODE_WORKER, this path is never hit; it
  // exists so the service-binding topology is wired correctly for Phase
  // 2c to populate.
  const edgeScaffold = [
    "// Creek adapter — edge-runtime worker (Phase 2a placeholder).",
    "// Phase 2c populates this with edge-runtime handler bundles.",
    "export default {",
    "  async fetch(request, env, ctx) {",
    "    return new Response(JSON.stringify({",
    '      error: "edge-runtime-not-yet-implemented",',
    '      note: "Phase 2c will bundle edge handlers into this worker",',
    "    }), {",
    "      status: 501,",
    '      headers: { "content-type": "application/json" },',
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
  await fs.writeFile(path.join(edgeDir, "worker.js"), edgeScaffold);
  await fs.writeFile(
    path.join(edgeDir, "wrangler.toml"),
    [
      "# Generated by adapter-creek (multi-worker, Phase 2a placeholder).",
      'name = "creek-edge-runtime"',
      'main = "worker.js"',
      'compatibility_date = "2026-03-23"',
      "",
    ].join("\n"),
  );

  console.log(
    `  [Creek Adapter] Multi-worker emitted: dispatcher → node-runtime (forward), edge-runtime placeholder`,
  );
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
      // Prerender source files: \`.html\` for APP_PAGE / Pages Router,
      // \`.body\` for APP_ROUTE (opengraph-image, icon, sitemap, etc. — often
      // binary). Misclassifying a binary \`.body\` as HTML routes it through
      // \`copyHtmlWithDplId\` which reads as UTF-8 and corrupts PNG/JPEG
      // bytes into \`0xef 0xbf 0xbd\` replacement chars. Trust the source
      // extension over the pathname — \`/opengraph-image\` has no dot but
      // maps to \`opengraph-image.body\`.
      const isBinary = prerender.fallback.filePath.endsWith(".body");
      const isHtml = !isBinary && isStaticHtmlPage(prerender.pathname);
      let destRelative = prerender.pathname;
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

/**
 * Resolve a chunk reference from a Turbopack edge-wrapper's \`otherChunks\`
 * list. Turbopack emits heterogeneous path forms within the same list:
 *   - absolute paths: \`/abs/path/.next/server/chunks/foo.js\`
 *   - edge-relative:  \`chunks/ssr/foo.js\`      → \`{distDir}/server/edge/{rel}\`
 *   - dist-relative:  \`server/chunks/foo.js\`   → \`{distDir}/{rel}\`
 *
 * The third form is the one that broke Server Actions — Turbopack emits
 * the server-actions registry chunk (module 3103) into
 * \`.next/server/chunks/ssr/\` but edge-wrappers reference it via
 * \`server/chunks/...\`. Before this fix, all three forms were blindly joined
 * to \`{distDir}/server/edge\`, producing non-existent paths for forms 1 + 3.
 * The chunk was never imported, its module factories never registered, and
 * any request that invoked a server action threw
 * \`Module 3103 was instantiated ... but the module factory is not available\`.
 *
 * Returns null if no candidate exists on disk.
 */
async function resolveEdgeOtherChunkPath(
  distDir: string,
  rel: string,
): Promise<string | null> {
  const candidates: string[] = [];
  if (path.isAbsolute(rel)) {
    candidates.push(rel);
  } else {
    candidates.push(path.join(distDir, "server", "edge", rel));
    candidates.push(path.join(distDir, rel));
  }
  for (const cand of candidates) {
    try {
      await fs.access(cand);
      return cand;
    } catch {}
  }
  return null;
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
        // Skip large top-level directories that don't contain manifests.
        // Match on full relative path, not just name: a user route like
        // \`app/static/[slug]\` is a legitimate app directory whose
        // \`page_client-reference-manifest.js\` must be collected so the
        // Flight renderer can resolve its client components at request time
        // — skipping by basename alone drops those manifests and surfaces
        // as "Could not find the module ... in the React Client Manifest"
        // on middleware rewrites into that route.
        const rel = path.relative(distDir, fullPath);
        if (rel === "static" || rel === "cache" || rel === "server/chunks" || rel === "server/edge-chunks") continue;
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
  const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10MB cap (base64 inflates binary)

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
      const isDeclarationFile = fileOutputPath.endsWith(".d.ts");
      const isText = TEXT_EXTENSIONS.has(ext) || isDeclarationFile;
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
      if (fileOutputPath.includes("node_modules/") && !isBinary && !isDeclarationFile) continue;

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
  allowsFallbackShellResume?: boolean;
  initialRevalidate?: number | false;
  initialStatus?: number;
  initialHeaders?: Record<string, string | string[]>;
  initialExpiration?: number;
  pprHeaders?: Record<string, string>;
  lastModified?: number;
  segmentPaths?: string[];
  /**
   * Headers captured from the `.meta` sidecar file next to the prerendered
   * HTML (e.g. `.next/server/app/index.meta`). `initialHeaders` comes from
   * `prerender-manifest.json` and *does not* include the `x-next-cache-tags`
   * entry for cacheComponents routes — those tags are only written to the
   * per-route `.meta` file. Without reading them, our runtime tag-staleness
   * check (`__CREEK_TAG_INVALIDATED_AT` ∩ `staticEntry.cacheTags`) never
   * fires for cacheComponents pages, so `revalidateTag` silently fails.
   */
  metaHeaders?: Record<string, string | string[]>;
}

async function collectFallbackShellRoutes(
  distDir: string,
): Promise<Set<string> | null> {
  try {
    const raw = await fs.readFile(
      path.join(distDir, "prerender-manifest.json"),
      "utf-8",
    );
    const manifest = JSON.parse(raw);
    const dynamicRoutes =
      manifest?.dynamicRoutes && typeof manifest.dynamicRoutes === "object"
        ? manifest.dynamicRoutes
        : {};
    const out = new Set<string>();
    for (const [pathname, entry] of Object.entries<any>(dynamicRoutes)) {
      if (
        typeof pathname === "string" &&
        typeof entry?.fallback === "string" &&
        entry.fallback.length > 0
      ) {
        out.add(pathname);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Collect prerender entries from build outputs for App Router PPR/cache seeding.
 * Pages Router prerenders are served from assets and don't need to be embedded
 * in the worker bundle.
 */
async function collectPrerenderEntries(
  outputs: BuildContext["outputs"],
  fallbackShellRoutes: Set<string> | null,
): Promise<PrerenderEntry[]> {
  const entries: PrerenderEntry[] = [];
  // The Next adapter emits one \`prerenders\` entry per output file — including
  // \`.rsc\` sidecars and \`.segments/*.segment.rsc\` fragments. Those aren't
  // standalone page cache entries, they're assets fetched via the page seed.
  // Filter to \`.html\` fallbacks so the prerender map only indexes actual
  // page keys (e.g. \`/memory-pressure/30\`, not \`/memory-pressure/30.rsc\`).
  for (const prerender of outputs.prerenders) {
    const fallback = prerender.fallback;
    if (!fallback?.filePath || !fallback.filePath.endsWith(".html")) continue;
    const hasPostponedState =
      typeof fallback.postponedState === "string" &&
      fallback.postponedState.length > 0;
    const hasPprHeaders = !!prerender.pprChain?.headers;
    const isPprChain = hasPostponedState || hasPprHeaders;
    // Skip bracket-form fallback shells — they're handled via the
    // \`__CREEK_POSTPONED_BY_SHELL\` regex map, not as direct page seeds.
    if (!isPprChain && prerender.pathname.includes("[")) continue;

    try {
      const stat = await fs.stat(fallback.filePath).catch(() => null);
      const metaPath = fallback.filePath.replace(/\.(html|body)$/, ".meta");
      const meta = await fs.readFile(metaPath, "utf-8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      // Never inline HTML into the worker bundle — it can be multi-MB
      // (e.g. memory-pressure pages are ~2MB each). \`__creekSeededAppPageEntry\`
      // fetches HTML and RSC from the assets bucket at request time. The seed
      // only carries the metadata needed to reconstruct the cache entry shape.
      entries.push({
        pathname: prerender.pathname,
        html: "",
        postponedState: fallback.postponedState,
        allowsFallbackShellResume: fallbackShellRoutes
          ? fallbackShellRoutes.has(prerender.pathname)
          : undefined,
        initialRevalidate: fallback.initialRevalidate,
        initialStatus: fallback.initialStatus,
        initialHeaders: fallback.initialHeaders,
        initialExpiration: fallback.initialExpiration,
        pprHeaders: prerender.pprChain?.headers,
        lastModified: stat?.mtimeMs,
        segmentPaths: Array.isArray(meta?.segmentPaths) ? meta.segmentPaths : undefined,
        metaHeaders:
          meta?.headers && typeof meta.headers === "object"
            ? meta.headers
            : undefined,
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
  outputs: BuildContext["outputs"],
  fallbackShellRoutes: Set<string> | null,
): Promise<Map<string, ComposableCacheSeed[]>> {
  const zlib = await import("node:zlib");
  // Map bracket-form pathname → its cache entries. Gating by shell prevents
  // seeds from one prerender's request-scoped RDC from bleeding into
  // unrelated requests (e.g. \`/with-suspense/*\`'s build-time "buildtime"
  // leaking into \`/without-suspense/*\` where the test expects "runtime").
  const byShell = new Map<string, ComposableCacheSeed[]>();
  for (const prerender of outputs.prerenders) {
    if (
      prerender.pathname.includes("[") &&
      fallbackShellRoutes &&
      !fallbackShellRoutes.has(prerender.pathname)
    ) {
      continue;
    }
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
async function collectExternalizedModules(distDir: string): Promise<ExternalModuleLoader[]> {
  const found = new Set<string>();
  const scanDir = async (dir: string) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await scanDir(full);
        else if (e.name.endsWith(".js")) {
          try {
            const content = await fs.readFile(full, "utf-8");
            const matches = content.matchAll(/\w+\.y\("([^"]+)"\)/g);
            for (const m of matches) found.add(m[1]);
          } catch {}
        }
      }
    } catch {}
  };
  await scanDir(path.join(distDir, "server", "chunks"));
  await scanDir(path.join(distDir, "server", "edge", "chunks"));

  const projectRoot = path.dirname(distDir);
  return Promise.all(
    Array.from(found).map(async (id) => ({
      id,
      importSpecifier: await resolveExternalImportSpecifier(projectRoot, id),
    })),
  );
}

function stripTurbopackPackageAlias(specifier: string): string {
  const parts = specifier.split("/");
  const packageIndex = specifier.startsWith("@") ? 1 : 0;
  const packageName = parts[packageIndex];
  if (!packageName) return specifier;
  const match = /^(.*)-[0-9a-f]{16}$/i.exec(packageName);
  if (!match || !match[1]) return specifier;
  parts[packageIndex] = match[1];
  return parts.join("/");
}

function splitPackageSpecifier(specifier: string): { packageName: string; subpath: string } | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".",
    };
  }
  if (!parts[0]) return null;
  return {
    packageName: parts[0],
    subpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : ".",
  };
}

async function resolveExternalImportSpecifier(projectRoot: string, runtimeSpecifier: string): Promise<string> {
  const unaliased = stripTurbopackPackageAlias(runtimeSpecifier);
  const split = splitPackageSpecifier(unaliased);
  if (!split) return unaliased;

  const packageJsonPath = path.join(
    projectRoot,
    "node_modules",
    ...split.packageName.split("/"),
    "package.json",
  );
  let packageJson: any;
  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
  } catch {
    return unaliased;
  }

  const exportTarget = resolvePackageExportTarget(packageJson.exports, split.subpath);
  if (exportTarget && !exportTarget.startsWith(".") && !exportTarget.startsWith("/")) {
    return unaliased;
  }
  if (exportTarget) {
    return path.join(path.dirname(packageJsonPath), exportTarget);
  }

  if (split.subpath === "." && typeof packageJson.module === "string") {
    return path.join(path.dirname(packageJsonPath), packageJson.module);
  }
  if (split.subpath === "." && typeof packageJson.main === "string") {
    return path.join(path.dirname(packageJsonPath), packageJson.main);
  }
  return unaliased;
}

function resolvePackageExportTarget(exportsField: unknown, subpath: string): string | null {
  if (!exportsField) return null;
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return subpath === "." ? pickConditionalExportTarget(exportsField) : null;
  }
  if (typeof exportsField !== "object") return null;

  const exportsObj = exportsField as Record<string, unknown>;
  const hasSubpathKeys = Object.keys(exportsObj).some((key) => key === "." || key.startsWith("./"));
  const selected = hasSubpathKeys ? exportsObj[subpath] : subpath === "." ? exportsField : undefined;
  return pickConditionalExportTarget(selected);
}

function pickConditionalExportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = pickConditionalExportTarget(item);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const conditions = value as Record<string, unknown>;
  for (const condition of ["node", "import", "module", "default"]) {
    if (Object.prototype.hasOwnProperty.call(conditions, condition)) {
      const target = pickConditionalExportTarget(conditions[condition]);
      if (target) return target;
    }
  }
  for (const [condition, targetValue] of Object.entries(conditions)) {
    if (condition === "types" || condition === "browser" || condition === "require") continue;
    const target = pickConditionalExportTarget(targetValue);
    if (target) return target;
  }
  return null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

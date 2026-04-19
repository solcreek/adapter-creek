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
import { createRequire } from "node:module";

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

  async function walkRuntimes(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkRuntimes(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      if (
        entry.name.includes("[turbopack]_runtime") ||
        (entry.name.startsWith("turbopack-") && entry.name.includes("edge-wrapper")) ||
        entry.name.includes("edge-wrapper")
      ) {
        runtimePaths.push(full);
      }
    }
  }

  for (const dir of searchDirs) {
    await walkRuntimes(dir);
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

async function patchAppPageManifestSingletons(distDir: string): Promise<void> {
  const ssrDir = path.join(distDir, "server", "chunks", "ssr");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(ssrDir);
  } catch {
    return;
  }

  const manifestProxyPattern =
    /case"moduleLoading":case"entryCSSFiles":case"entryJSFiles":\{if\(!(\w+)\)throw[\s\S]*?let (\w+)=(\w+)\.get\(\1\.route\);if\(!\2\)throw[\s\S]*?return \2\[(\w+)\]\}/g;

  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    const filePath = path.join(ssrDir, entry);
    let code: string;
    try {
      code = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    if (!code.includes('entryCSSFiles') || !code.includes('without a work store')) {
      continue;
    }

    const patched = code.replace(
      manifestProxyPattern,
      (_match, workStoreVar: string, manifestVar: string, manifestsVar: string, propVar: string) =>
        `case"moduleLoading":case"entryCSSFiles":case"entryJSFiles":{if(!${workStoreVar}){for(let a of ${manifestsVar}.values()){let b=a[${propVar}];if(void 0!==b)return b}return}let ${manifestVar}=${manifestsVar}.get(${workStoreVar}.route);if(!${manifestVar}){for(let a of ${manifestsVar}.values()){let b=a[${propVar}];if(void 0!==b)return b}return}return ${manifestVar}[${propVar}]}`,
    );

    if (patched !== code) {
      await fs.writeFile(filePath, patched);
    }
  }
}

function patchBundledManifestSingleton(workerCode: string): string {
  const bundledManifestProxyPattern =
    /case "moduleLoading":\s*case "entryCSSFiles":\s*case "entryJSFiles": \{\s*if \(!(\w+)\) throw[\s\S]*?let (\w+) = (\w+)\.get\(\1\.route\);\s*if \(!\2\) throw[\s\S]*?return \2\[(\w+)\];\s*\}/g;
  const bundledManifestLookupPattern =
    /if \((\w+)\) \{\s*let (\w+) = (\w+)\.get\(\1\.route\);\s*if \(null == \2 \? void 0 : \2\[(\w+)\]\[(\w+)\]\) return \2\[\4\]\[\5\];\s*\} else for \(let (\w+) of \3\.values\(\)\) \{\s*let (\w+) = \6\[\4\]\[\5\];\s*if \(void 0 !== \7\) return \7;\s*\}/g;

  workerCode = workerCode.replace(
    bundledManifestProxyPattern,
    (_match, workStoreVar: string, manifestVar: string, manifestsVar: string, propVar: string) =>
      `case "moduleLoading":
              case "entryCSSFiles":
              case "entryJSFiles": {
                if (!${workStoreVar}) {
                  for (const manifest of ${manifestsVar}.values()) {
                    const entry = manifest[${propVar}];
                    if (entry !== undefined) {
                      return entry;
                    }
                  }
                  return undefined;
                }
                let ${manifestVar} = ${manifestsVar}.get(${workStoreVar}.route);
                if (!${manifestVar}) {
                  for (const manifest of ${manifestsVar}.values()) {
                    const entry = manifest[${propVar}];
                    if (entry !== undefined) {
                      return entry;
                    }
                  }
                  return undefined;
                }
                return ${manifestVar}[${propVar}];
              }`,
  );

  workerCode = workerCode.replace(
    bundledManifestLookupPattern,
    (
      _match,
      workStoreVar: string,
      manifestVar: string,
      manifestsVar: string,
      propVar: string,
      idVar: string,
      iterManifestVar: string,
      iterEntryVar: string,
    ) =>
      `if (${workStoreVar}) {
                    let ${manifestVar} = ${manifestsVar}.get(${workStoreVar}.route);
                    let ${iterEntryVar} = null == ${manifestVar} ? void 0 : ${manifestVar}[${propVar}][${idVar}];
                    if (void 0 === ${iterEntryVar} && ${propVar} === "edgeSSRModuleMapping") ${iterEntryVar} = null == ${manifestVar} ? void 0 : ${manifestVar}.ssrModuleMapping[${idVar}];
                    if (void 0 === ${iterEntryVar} && ${propVar} === "edgeRscModuleMapping") ${iterEntryVar} = null == ${manifestVar} ? void 0 : ${manifestVar}.rscModuleMapping[${idVar}];
                    if (typeof process !== "undefined" && process.env.CREEK_DEBUG_MANIFESTS === "1" && (${idVar} === "99807" || ${idVar} === 99807 || String(${workStoreVar}.route || "").includes("basic-edge"))) {
                      console.error("[creek:bundled-manifest:route]", JSON.stringify({
                        route: ${workStoreVar}.route,
                        prop: ${propVar},
                        id: ${idVar},
                        routeHit: !!${manifestVar},
                        entryId: ${iterEntryVar} && typeof ${iterEntryVar} === "object" ? ${iterEntryVar}.id ?? (typeof ${iterEntryVar}["*"] === "object" ? ${iterEntryVar}["*"].id : undefined) : undefined,
                      }));
                    }
                    if (void 0 !== ${iterEntryVar}) return ${iterEntryVar};
                  }
                  let __creekNodeFallback;
                  for (let ${iterManifestVar} of ${manifestsVar}.values()) {
                    let ${iterEntryVar} = ${iterManifestVar}[${propVar}][${idVar}];
                    if (typeof process !== "undefined" && process.env.CREEK_DEBUG_MANIFESTS === "1" && (${idVar} === "99807" || ${idVar} === 99807) && void 0 !== ${iterEntryVar}) {
                      console.error("[creek:bundled-manifest:scan-hit]", JSON.stringify({
                        prop: ${propVar},
                        id: ${idVar},
                        entryId: ${iterEntryVar} && typeof ${iterEntryVar} === "object" ? ${iterEntryVar}.id ?? (typeof ${iterEntryVar}["*"] === "object" ? ${iterEntryVar}["*"].id : undefined) : undefined,
                      }));
                    }
                    if (void 0 !== ${iterEntryVar}) return ${iterEntryVar};
                    if (void 0 === __creekNodeFallback && ${propVar} === "edgeSSRModuleMapping") __creekNodeFallback = ${iterManifestVar}.ssrModuleMapping[${idVar}];
                    if (void 0 === __creekNodeFallback && ${propVar} === "edgeRscModuleMapping") __creekNodeFallback = ${iterManifestVar}.rscModuleMapping[${idVar}];
                  }
                  if (typeof process !== "undefined" && process.env.CREEK_DEBUG_MANIFESTS === "1" && (${idVar} === "99807" || ${idVar} === 99807) && void 0 !== __creekNodeFallback) {
                    console.error("[creek:bundled-manifest:node-fallback]", JSON.stringify({
                      prop: ${propVar},
                      id: ${idVar},
                      entryId: __creekNodeFallback && typeof __creekNodeFallback === "object" ? __creekNodeFallback.id ?? (typeof __creekNodeFallback["*"] === "object" ? __creekNodeFallback["*"].id : undefined) : undefined,
                    }));
                  }
                  if (void 0 !== __creekNodeFallback) return __creekNodeFallback;`,
  );

  // Cloudflare Workers executes the bundled app through the edge runtime path,
  // but many app pages only populate the node/RSC module maps. Keep true edge
  // routes on the edge maps when they exist, otherwise fall back to the node
  // maps so React Server Consumer Manifest lookups can still resolve.
  workerCode = workerCode.replace(
    /moduleMap: j2, serverModuleMap:/g,
    "moduleMap: Object.keys(i2 || {}).length ? i2 : j2, serverModuleMap:",
  );

  return workerCode;
}

export async function bundleForWorkers(opts: BundleOptions): Promise<string[]> {
  // Patch Turbopack runtime BEFORE wrangler bundles.
  // Turbopack's R.c() dynamically loads chunks from the filesystem.
  // CF Workers has no filesystem, so we replace R.c() with a switch
  // statement that maps chunk paths to static require() calls.
  await patchTurbopackRuntime(opts.distDir);
  await patchAppPageManifestSingletons(opts.distDir);

  // Write the generated worker entry
  const entryPath = path.join(opts.outputDir, "__entry.mjs");
  await fs.writeFile(entryPath, opts.workerSource);

  if (process.env.CREEK_DEBUG) {
    await fs.writeFile(path.join(opts.outputDir, "__entry_debug.mjs"), opts.workerSource);
  }

  // Copy WASM files alongside the bundle BEFORE wrangler runs. wrangler's
  // bundler needs the files resolvable from the entry `import __wasm_0 from
  // "./wasm_<hex>.wasm"` to apply the CompiledWasm rule — copying later
  // (after the bundle step) is too late.
  for (const [name, absPath] of opts.wasmFiles) {
    const destName = name.endsWith(".wasm") ? name : name + ".wasm";
    const destPath = path.join(opts.outputDir, destName);
    await fs.copyFile(absPath, destPath);
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
      // sharp has native .node bindings that workerd can't load. Without this
      // alias, wrangler pulls in ~1MB of sharp's JS wrapper and the module
      // ends up non-callable at runtime — \`@vercel/og\`'s node path then
      // throws \`sharp is not a function\`. Aliasing to a shim whose default
      // is undefined makes \`@vercel/og\` fall back to its resvg.wasm path.
      "sharp": path.join(adapterDir, "src", "shims", "sharp.js"),
      // Replace Next's track-module-loading.{instance,external} with a
      // per-request AsyncLocalStorage version. The original keeps a
      // module-level CacheSignal whose internal setImmediate closure
      // leaks IoContext across requests on workerd — second-and-later
      // requests throw "Cannot perform I/O on behalf of a different
      // request" when CacheSignal.pendingTimeoutCleanup fires
      // clearImmediate on an Immediate from the first request. Repros
      // on any route that does dynamic imports during render (notably
      // \`new ImageResponse(...)\` — every \`@vercel/og\` call triggers
      // trackPendingImport). We alias \`.external\` as well because
      // call sites import from that module (the internal relative
      // \`./track-module-loading.instance\` import never passes through
      // esbuild's bare-specifier alias map). See
      // src/shims/track-module-loading.js.
      "next/dist/server/app-render/module-loading/track-module-loading.external":
        path.join(adapterDir, "src", "shims", "track-module-loading.js"),
      "next/dist/server/app-render/module-loading/track-module-loading.external.js":
        path.join(adapterDir, "src", "shims", "track-module-loading.js"),
      "next/dist/server/app-render/module-loading/track-module-loading.instance":
        path.join(adapterDir, "src", "shims", "track-module-loading.js"),
      "next/dist/server/app-render/module-loading/track-module-loading.instance.js":
        path.join(adapterDir, "src", "shims", "track-module-loading.js"),
      // NOTE: load-manifest and fast-set-immediate shims exist in src/shims/
      // but are handled by the fs shim (manifest loading) and nodejs_compat
      // (setImmediate) respectively, so no alias needed.
      // NOTE: http/node:http is NOT aliased — CF Workers nodejs_compat provides it.
      // The worker entry uses our custom IncomingMessage/ServerResponse inline via
      // the NODE_BRIDGE_CODE template, which imports from "http" (the built-in).
    },
  };
  const configPath = path.join(opts.outputDir, "__wrangler.json");
  await fs.writeFile(configPath, JSON.stringify(wranglerConfig));

  // Bundle with wrangler --dry-run
  // Wrangler internally uses esbuild but with Turbopack-aware resolution
  // and proper CJS/ESM interop for CF Workers.
  // Ensure @next/routing is resolvable from the project directory. It's a
  // dependency of the adapter, not the user's project, so wrangler can't
  // find it when run from the project's cwd. Resolve via \`createRequire\`
  // rather than guessing \`adapterDir/node_modules/@next/routing\` — pnpm's
  // virtual-store layout means that path often doesn't exist (the real
  // install lives under \`node_modules/.pnpm/@next+routing@X/\`), and the
  // guess only works for the link-protocol install of the adapter.
  const projectNodeModules = path.join(path.dirname(opts.distDir), "node_modules");
  const routingDest = path.join(projectNodeModules, "@next", "routing");
  const adapterRequire = createRequire(path.join(adapterDir, "package.json"));
  let routingSrc: string;
  try {
    routingSrc = path.dirname(adapterRequire.resolve("@next/routing/package.json"));
  } catch {
    // Fallback to the legacy guess so a classic link-install still works.
    routingSrc = path.join(adapterDir, "node_modules", "@next", "routing");
  }
  try {
    await fs.access(routingDest);
  } catch {
    await fs.mkdir(path.join(projectNodeModules, "@next"), { recursive: true });
    try {
      await fs.symlink(routingSrc, routingDest, "junction");
    } catch (err: unknown) {
      // Racy repeat runs (same project dir rebuilt back-to-back) can leave a
      // dangling symlink that \`access\` reports as missing while \`symlink\`
      // still refuses to overwrite.
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
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

    // Next.js's \`getInstrumentationModule\` does
    // \`await __require(path.join(projectDir, distDir, "server",
    // \`\${INSTRUMENTATION_HOOK_FILENAME}.js\`))\`. workerd can't resolve
    // dynamic-require paths — the call rejects, the catch above swallows it,
    // and \`instrumentation.register()\` is never invoked. Worker-entry
    // static-imports the user file onto \`globalThis.__CREEK_INSTRUMENTATION\`
    // when present, so prefer that over \`__require\` here. Falls through
    // to the original call when no user instrumentation is registered so
    // the \`module.exports = {}\` placeholder path still works.
    workerCode = workerCode.replace(
      /(cachedInstrumentationModule\s*=\s*\(0,\s*_interopdefault\.interopDefault\)\s*\()\s*await __require\(/g,
      "$1globalThis.__CREEK_INSTRUMENTATION || await __require(",
    );

    workerCode = patchBundledManifestSingleton(workerCode);

    // depd (via raw-body) uses `eval("(function ("+args+") {...})")` to build a
    // deprecation-wrapping thunk. workerd + CF Workers block code generation
    // from strings ("Code generation from strings disallowed for this context"),
    // so any module that pulls in raw-body — notably the Pages Router API
    // body parser — throws at module load time, and the outer try/catch in
    // parse-body.ts surfaces it to the browser as `400 Invalid body`.
    //
    // Replace the minified eval expression with a direct function literal
    // that preserves the runtime semantics (log + call). We lose the
    // `function.length` preservation the eval form achieved, but nothing
    // in the raw-body → parse-body call chain reads it.
    //
    // Fixes middleware-redirects "should redirect to api route with locale"
    // (and the /fr variant) — both fail because their navigation ends at
    // an API route whose parse-body path can't load raw-body.
    workerCode = workerCode.replace(
      /var\s+(\w+)\s*=\s*eval\("\(function \(".*?return\s+\1\s*;?\s*\}/s,
      "return function(){log.call(deprecate,message,site);return fn.apply(this,arguments)}}",
    );

    // Route \`externalImport(id)\` through \`globalThis.__CREEK_EXT_MODS\` so
    // we can serve bundled-but-externalized-by-Turbopack modules from
    // our worker-entry static imports. Turbopack emits chunks like
    // \`[externals]_next_dist_compiled_@vercel_og_index_node_...\` that do
    // \`await e.y("next/dist/compiled/@vercel/og/index.node.js")\`; on
    // workerd that \`await import(id)\` path throws "No such module" and
    // the handler 500s. When our entry registers the module in
    // \`__CREEK_EXT_MODS\`, the patched \`externalImport\` returns it
    // directly without going through workerd's external loader.
    // Fixes og-api \`/og-node\` (node runtime) +
    // use-cache-metadata-route-handler opengraph/icon tests.
    workerCode = workerCode.replace(
      /async function externalImport\((\w+)\)\s*\{\s*let\s+raw;\s*try\s*\{\s*raw\s*=\s*await import\(\1\);/g,
      (match, idVar) =>
        `async function externalImport(${idVar}) {\n` +
        `      let raw;\n` +
        `      { const __loaders = globalThis.__CREEK_EXT_LOADERS; if (__loaders && __loaders[${idVar}]) {\n` +
        `        const __cached = globalThis.__CREEK_EXT_MODS = globalThis.__CREEK_EXT_MODS || {};\n` +
        `        if (${idVar} in __cached) { raw = __cached[${idVar}]; }\n` +
        `        else { try { raw = await __loaders[${idVar}](); __cached[${idVar}] = raw; } catch (err) { throw new Error(\`Failed to load external module \${${idVar}}: \${err}\`); } }\n` +
        `        if (raw && raw.__esModule && raw.default && "default" in raw.default) { return interopEsm(raw.default, createNS(raw), true); }\n` +
        `        return raw;\n` +
        `      } }\n` +
        `      try {\n` +
        `        raw = await import(${idVar});`,
    );

    // \`@vercel/og/index.node.js\` evaluates at module load:
    //
    //   var fontData = fs.readFileSync(fileURLToPath(new URL("./Geist-Regular.ttf", import.meta.url)));
    //   var resvg_wasm = fs.readFileSync(fileURLToPath(new URL("./resvg.wasm", import.meta.url)));
    //
    // workerd rejects \`new URL("./X", import.meta.url)\` with
    // "Invalid URL string" in the bundled-worker context, so evaluation
    // aborts before any request hits the route. Rewrite these two calls
    // to pass literal paths into fs.readFileSync directly — our fs shim
    // has a basename fallback for .wasm/.ttf, so the embedded bundled
    // bytes resolve regardless of path.
    workerCode = workerCode.replace(
      /fileURLToPath\(new URL\(("\.\/[^"]+\.(?:wasm|ttf|otf|woff2?|png|jpg|jpeg|gif|webp|svg|ico)")\s*,\s*import\.meta\.url\)\)/g,
      (_match, filename) => filename.replace(/^"\.\//, '"'),
    );

    // Strip `AsyncLocalStorage.snapshot()` bindings in Next's
    // `server/app-render/async-local-storage.js` and its Turbopack-inlined
    // variants. On workerd, `ALS.snapshot()` captures the CURRENT IoContext
    // and invoking the returned function from a later request throws
    // "Cannot perform I/O on behalf of a different request". Next uses
    // `createSnapshot()` / `runInCleanSnapshot: ALS.snapshot()` for cache-
    // invalidation + edge-action callback propagation — both paths cross
    // request boundaries on workerd. Replace the snapshot binding with a
    // direct passthrough, matching @opennextjs/cloudflare's `patchUseCacheIO`
    // (their comment: "TODO: Find a better fix for this issue.").
    //
    // Four forms exist post-bundling:
    //   1. `function createSnapshot() { if (X) return X.snapshot(); return function(fn,...args){...}; }`
    //      — clean esm form from next/dist/esm (one copy embedded by wrangler).
    //   2. `function <name>() { return X ? X.snapshot() : function(a,...b){ return a(...b); }; }`
    //      — Turbopack's minified module-level shim (edge-side copies).
    //   3. `a.s(["bindSnapshot", 0, q, "createSnapshot", 0, function(){ return p ? p.snapshot() : ...; }])`
    //      — Turbopack's export-binding form in the same shim.
    //   4. `runInCleanSnapshot: X ? X.snapshot() : function(a,...b){ return a(...b); }`
    //      — inlined call-site in the bundled work-store constructor.
    // A single regex `(\w+) ? \1.snapshot() : ` stripped from the minified
    // forms covers 2/3/4; form 1 uses an if-guard so handle it separately.
    workerCode = workerCode.replace(
      /if\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+\1\.snapshot\(\);\s*\}/g,
      "// Ignored snapshot",
    );
    workerCode = workerCode.replace(
      /(\w+)\s*\?\s*\1\.snapshot\(\)\s*:\s*/g,
      "",
    );

    // Unify Next's `*AsyncStorageInstance` singletons across Turbopack
    // chunks via a `globalThis` key. Turbopack emits the `work-unit-async-
    // storage-instance.js` / `work-async-storage-instance.js` / etc.
    // factories INLINE into every chunk that references them (see the
    // `'turbopack-transition': 'next-shared'` import attribute in the
    // next-shared layer); each chunk evaluates its own
    // `createAsyncLocalStorage()` call and gets a fresh ALS instance.
    // On the edge-runtime server-action path this fragments the store:
    // the action handler runs `workUnitAsyncStorage.run(d, fn)` inside
    // chunk A's ALS, the inner `headers()` call reads from chunk B's
    // ALS, finds no store, and throws "headers was called outside a
    // request scope". Node action path survives because its caller +
    // callee happen to resolve to the same chunk's copy.
    //
    // Fix: rewrite the module factory bodies to key the ALS on the
    // exported instance name (`workUnitAsyncStorageInstance`, etc.)
    // under a single `globalThis.__CREEK_ALS` bag, so all chunks share
    // one instance per logical store. Name-keyed is narrower than
    // "dedup every `new AsyncLocalStorage()`" — we don't accidentally
    // merge unrelated per-store ALSes (tracing requestStorage,
    // react-server-dom temporaryReferences, etc.).
    //
    // Target pattern (both `a.i(N)` and `a.r(N)` create-variants
    // exist):
    //   let <v> = (0, a.i(43291).createAsyncLocalStorage)();
    //   …short gap…
    //   a.s(["<Name>AsyncStorageInstance", 0, <v>], …)
    // Replacement keeps the original create call so the per-isolate
    // fallback works if globalThis isn't carried through an unusual
    // loader; the `??=` idempotently promotes the first copy into the
    // shared bag.
    workerCode = workerCode.replace(
      /let\s+(\w+)\s*=\s*(\(0,\s*a\.[ir]\(\d+\)\.createAsyncLocalStorage\)\(\));([\s\S]{0,400}?a\.s\(\["(\w+AsyncStorageInstance)",\s*0,\s*\1\])/g,
      (_match, varName: string, createCall: string, tail: string, storeName: string) =>
        `let ${varName} = ((globalThis.__CREEK_ALS ??= {})["${storeName}"] ??= ${createCall});${tail}`,
    );
    // Same dedup for the CJS-wrapped variants esbuild produces when it
    // bundles Next's non-Turbopack ESM copy. Two observed shapes:
    //   a. `var <Name>AsyncStorageInstance = (0, _als.createAsyncLocalStorage)();`
    //      — top-level from `work-unit-async-storage-instance.js` etc.
    //   b. `Object.defineProperty(c, "<Name>AsyncStorageInstance", {…get…return <v>…}); let <v> = (0, a.r(N).createAsyncLocalStorage)();`
    //      — Turbopack-emitted CJS compiled form (edge chunks).
    workerCode = workerCode.replace(
      /var\s+(\w+AsyncStorageInstance)\s*=\s*(\(0,\s*\w+\.createAsyncLocalStorage\)\(\));/g,
      (_match, storeName: string, createCall: string) =>
        `var ${storeName} = ((globalThis.__CREEK_ALS ??= {})["${storeName}"] ??= ${createCall});`,
    );
    workerCode = workerCode.replace(
      /(Object\.defineProperty\(c,\s*"(\w+AsyncStorageInstance)",\s*\{[^}]*get:\s*(?:\/\*[^*]*\*\/\s*)?(?:__name\()?function\(\)\s*\{\s*return (\w+);[^}]*\}[\s\S]*?\}\);)\s*let\s+\3\s*=\s*(\(0,\s*a\.[ir]\(\d+\)\.createAsyncLocalStorage\)\(\))/g,
      (_match, prefix: string, storeName: string, varName: string, createCall: string) =>
        `${prefix}\nlet ${varName} = ((globalThis.__CREEK_ALS ??= {})["${storeName}"] ??= ${createCall})`,
    );

    // Turbopack's node.js runtime implements top-level-await by assigning
    // \`module.exports = <Promise>\`. esbuild's \`__toESM\` wraps imports with
    // \`__create(__getProtoOf(mod))\`, and for a Promise that yields a plain
    // object whose \`__proto__\` is \`Promise.prototype\`. Awaiting that object
    // invokes \`Promise.prototype.then\` with a non-Promise receiver — workerd
    // rejects it as "incompatible receiver" and the route 500s. Detect a
    // Promise input and return it unchanged so await resolves the real
    // async-module promise instead. Fixes \`metadata-edge\` and
    // \`metadata-dynamic-routes-async-deps\` \`opengraph-image\` routes.
    workerCode = workerCode.replace(
      /var __toESM = \(mod, isNodeMode, target\) => \(target = mod != null \? __create\(__getProtoOf\(mod\)\) : \{\}, __copyProps\(\s*(?:\/\/[^\n]*\n\s*)*isNodeMode \|\| !mod \|\| !mod\.__esModule \? __defProp\(target, "default", \{ value: mod, enumerable: true \}\) : target,\s*mod\s*\)\);/,
      `var __toESM = (mod, isNodeMode, target) => {
  if (mod != null && typeof mod === "object" && typeof mod.then === "function" && __getProtoOf(mod) === Promise.prototype) {
    return mod;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  return __copyProps(
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  );
};`,
    );

    await fs.writeFile(workerPath, workerCode);
  } catch {}

  // Emit wrangler.toml that covers both local dev (workerd via wrangler dev)
  // and \`wrangler deploy\`. Dev and prod MUST share the same config so
  // deployment behavior stays predictable — that's what the adapter is
  // expected to guarantee.
  //
  // The file lives alongside worker.js in \`.creek/adapter-output/server/\`.
  // Users can override specific values by creating a \`wrangler.toml\`
  // at their project root — the adapter reads that at build time and
  // merges over our defaults (support added in a follow-up TODO).
  await emitWranglerConfig({
    outputDir: opts.outputDir,
    assetsRelPath: "../assets", // server/ → assets/
    // Same normalization as the copy loop above — ensure every wasm
    // filename declared in the rules ends with \`.wasm\` so wrangler's
    // CompiledWasm rule discovers the file we actually wrote to disk.
    wasmFilenames: [...opts.wasmFiles.keys()].map((n) =>
      n.endsWith(".wasm") ? n : n + ".wasm"
    ),
  });

  // Clean up temp files
  await fs.rm(entryPath, { force: true });
  await fs.rm(configPath, { force: true });
  await fs.rm(bundleDir, { recursive: true, force: true });

  // List output files
  const files = await fs.readdir(opts.outputDir);
  return files.filter(f => !f.startsWith("__"));
}

/**
 * Write a wrangler.toml next to worker.js so the same config drives both
 * \`wrangler dev\` (local dev / test harness) and \`wrangler deploy\` (prod).
 *
 * Contents:
 *   - \`name\`, \`main\`, \`compatibility_date\`, \`compatibility_flags\` — runtime
 *   - \`[assets]\` — binds the assets directory with \`run_worker_first\` so our
 *     worker handles routing before workerd's static asset shortcut
 *   - \`[[durable_objects.bindings]]\` + \`[[migrations]]\` — the three DO
 *     classes the worker entry declares (DOQueueHandler, DOShardedTagCache,
 *     BucketCachePurge)
 *   - \`[[rules]] type = "CompiledWasm"\` — declares wasm siblings (next/og
 *     yoga/resvg, sharp, etc.) as module imports for workerd's loader
 */
async function emitWranglerConfig(opts: {
  outputDir: string;
  assetsRelPath: string;
  wasmFilenames: string[];
}): Promise<void> {
  const { outputDir, assetsRelPath, wasmFilenames } = opts;
  // Turbopack + wrangler both emit wasm siblings (hashed \`wasm_<xxh3>\`
  // from us, \`<sha1>-yoga.wasm\` / \`<sha1>-resvg.wasm\` from wrangler's
  // own esbuild pass when the app imports next/og). A wildcard glob
  // covers every sibling regardless of who emitted it. Listing specific
  // filenames fails because wrangler normalises import paths with a
  // leading \`./\` that literal-name globs don't match — the built-in
  // \`**/*.wasm\` rule then fires and aborts the build with
  // "ignored because a previous rule ... was not marked as fallthrough".
  let hasWasm = wasmFilenames.length > 0;
  if (!hasWasm) {
    try {
      const entries = await fs.readdir(outputDir);
      hasWasm = entries.some((e) => e.endsWith(".wasm"));
    } catch {}
  }
  const wasmRule = hasWasm
    ? [
        "",
        "# Declare every wasm sibling as a CompiledWasm module so \`import",
        "# foo from \"./<hash>.wasm\"\` in the bundle resolves at runtime.",
        "# Without this, Turbopack's runtime registry returns undefined and",
        "# throws \"dynamically loading WebAssembly is not supported\".",
        "[[rules]]",
        `globs = ["**/*.wasm"]`,
        `type = "CompiledWasm"`,
        `fallthrough = false`,
      ].join("\n")
    : "";

  const toml = `# Generated by @solcreek/adapter-creek. Hand edits will be overwritten on
# the next \`next build\`. To extend (add KV, queues, env vars, etc.), create
# a \`wrangler.toml\` at your project root — the adapter merges it on top.

name = "creek"
main = "worker.js"
compatibility_date = "2026-03-23"
compatibility_flags = ["nodejs_compat"]

# Static assets from Next.js's \`.next/static\` + \`public/\` live alongside
# this server dir under \`../assets/\`. \`run_worker_first = true\` tells
# workerd to invoke our worker BEFORE serving static files — the adapter
# handles middleware, routing, and cache headers before any asset shortcut.
[assets]
directory = "${assetsRelPath}"
binding = "ASSETS"
run_worker_first = true

# Durable Object classes declared by the adapter's worker-entry. The
# binding \`name\` (what runtime code reads via \`env.<NAME>\`) must match
# what Creek's control plane injects in production — see
# \`packages/control-plane/src/modules/deployments/deploy.ts:129-140\` in
# the Creek repo. Do NOT rename these without coordinating with Creek.
#
# \`class_name\` is our internal export name from worker-entry.ts.
# \`new_sqlite_classes\` (not \`new_classes\`) selects SQLite-backed DO
# storage — DOShardedTagCache and BucketCachePurge both use
# \`ctx.storage.sql\`. DOQueueHandler is currently a placeholder but
# declared under SQLite too so future queue persistence has no migration
# cost.
[[durable_objects.bindings]]
name = "NEXT_CACHE_DO_QUEUE"
class_name = "DOQueueHandler"
[[durable_objects.bindings]]
name = "NEXT_TAG_CACHE_DO_SHARDED"
class_name = "DOShardedTagCache"
[[durable_objects.bindings]]
name = "NEXT_CACHE_DO_BUCKET_PURGE"
class_name = "BucketCachePurge"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"]
${wasmRule}
`;
  await fs.writeFile(path.join(outputDir, "wrangler.toml"), toml);
}

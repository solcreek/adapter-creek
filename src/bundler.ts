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

    workerCode = patchBundledManifestSingleton(workerCode);

    await fs.writeFile(workerPath, workerCode);
  } catch {}

  // Copy WASM files alongside the bundle
  for (const [name, absPath] of opts.wasmFiles) {
    await fs.copyFile(absPath, path.join(opts.outputDir, name));
  }

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
    wasmFilenames: [...opts.wasmFiles.keys()],
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
  const wasmRule = wasmFilenames.length
    ? [
        "",
        "# Declare every wasm sibling as a CompiledWasm module so \`import",
        "# foo from \"./<hash>.wasm\"\` in the bundle resolves at runtime.",
        "# Without this, Turbopack's runtime registry returns undefined and",
        "# throws \"dynamically loading WebAssembly is not supported\".",
        "[[rules]]",
        `globs = [${wasmFilenames.map((g) => `"${g}"`).join(", ")}]`,
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

# Durable Object classes declared by the adapter's worker-entry. Bindings
# must exist even when unused, or workerd refuses to start. The matching
# \`new_classes\` migration registers them on first deploy.
[[durable_objects.bindings]]
name = "DOQueueHandler"
class_name = "DOQueueHandler"
[[durable_objects.bindings]]
name = "DOShardedTagCache"
class_name = "DOShardedTagCache"
[[durable_objects.bindings]]
name = "BucketCachePurge"
class_name = "BucketCachePurge"

[[migrations]]
tag = "v1"
new_classes = ["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"]
${wasmRule}
`;
  await fs.writeFile(path.join(outputDir, "wrangler.toml"), toml);
}

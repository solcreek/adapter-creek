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

  // Stage WASM files alongside __entry.mjs BEFORE wrangler runs. The
  // entry contains `import __wasm_N from "./<name>.wasm"` statements
  // (worker-entry.ts builds them for each [hex, filename] pair). Wrangler's
  // esbuild plugin walks those imports during bundling — if the .wasm
  // file isn't on disk next to the entry yet, the resolver throws and
  // the whole build fails (seen on @vercel/og fixtures pulling yoga.wasm
  // / resvg.wasm). Copy first, then bundle.
  for (const [name, absPath] of opts.wasmFiles) {
    await fs.copyFile(absPath, path.join(opts.outputDir, name));
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

    // `@vercel/og/index.node.js` evaluates at module load:
    //
    //   var fontData = fs.readFileSync(fileURLToPath(new URL("./Geist-Regular.ttf", import.meta.url)));
    //   var resvg_wasm = fs.readFileSync(fileURLToPath(new URL("./resvg.wasm", import.meta.url)));
    //
    // workerd rejects `new URL("./X", import.meta.url)` with "Invalid URL
    // string" in the bundled-worker context, so evaluation aborts before
    // any request hits the route. Rewrite these two calls to pass literal
    // paths into fs.readFileSync directly — our fs shim has a basename
    // fallback for .wasm/.ttf/.otf/.woff[2]/etc, so the embedded bundled
    // bytes resolve regardless of path.
    //
    // Companion to the externalImport restore — once externalImport routes
    // through __CREEK_EXT_LOADERS, the @vercel/og loader actually runs and
    // hits THIS line. Originally landed alongside in 325bf76; also dropped
    // by ee4a409.
    workerCode = workerCode.replace(
      /fileURLToPath\(new URL\(("\.\/[^"]+\.(?:wasm|ttf|otf|woff2?|png|jpg|jpeg|gif|webp|svg|ico)")\s*,\s*import\.meta\.url\)\)/g,
      (_match, filename) => filename.replace(/^"\.\//, '"'),
    );

    // Route `externalImport(id)` through `globalThis.__CREEK_EXT_LOADERS`
    // so Turbopack-externalized modules can be served from our worker-entry
    // static imports. Turbopack emits chunks like
    // `[externals]_next_dist_compiled_@vercel_og_index_node_…` that call
    // `await e.y("next/dist/compiled/@vercel/og/index.node.js")` at request
    // time; on workerd that falls through to `await import(id)` which
    // throws "No such module" — the route handler then 500s. When our
    // entry registers a loader in `__CREEK_EXT_LOADERS`, the patched
    // externalImport awaits it (lazy: keeps fs/wasm side-effects from
    // running before __USER_FILES is populated), caches the result in
    // `__CREEK_EXT_MODS`, and short-circuits workerd's external loader.
    //
    // The original patch landed in 325bf76 and was accidentally dropped
    // during the ee4a409 refactor — restoring it. Fixes og-api node-
    // runtime (`/og-node`) + use-cache-metadata-route-handler opengraph/
    // icon image tests.
    workerCode = workerCode.replace(
      /async function externalImport\((\w+)\)\s*\{\s*let\s+raw;\s*try\s*\{\s*raw\s*=\s*await import\(\1\);/g,
      (_match, idVar) =>
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

    await fs.writeFile(workerPath, workerCode);
  } catch {}

  // (WASM files were staged before wrangler ran — see above.)

  // Clean up temp files
  await fs.rm(entryPath, { force: true });
  await fs.rm(configPath, { force: true });
  await fs.rm(bundleDir, { recursive: true, force: true });

  // List output files
  const files = await fs.readdir(opts.outputDir);
  return files.filter(f => !f.startsWith("__"));
}

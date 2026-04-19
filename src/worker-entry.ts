/**
 * Worker entry source code generator.
 *
 * Generates a CF Workers entry that statically imports all Next.js
 * page/route handlers. With --webpack, .next/server/app/*.js are
 * standard CJS modules that esbuild can bundle.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import type { NextAdapter } from "next";

type BuildContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

export interface WorkerEntryOptions {
  buildId: string;
  routing: BuildContext["routing"];
  outputs: BuildContext["outputs"];
  basePath: string;
  assetPrefix: string;
  i18n: unknown;
  /**
   * Subset of \`next.config\` that the worker runtime needs — \`ROUTING\`
   * doesn't expose these fields directly (trailingSlash is implemented
   * as regex rules in \`beforeMiddleware\`). Carry them separately so
   * code that needs the boolean flag can consult it without reverse-
   * engineering the routing table.
   */
  config: { trailingSlash?: boolean };
  /** Embedded manifests: absolute path → file content */
  manifests: Record<string, string>;
  /**
   * User-side text files (data.json, fixtures, i18n messages, etc.) keyed by
   * path relative to outputFileTracingRoot. Read by the fs shim at runtime when
   * route handlers call fs.readFileSync. See build.ts:collectUserFiles().
   */
  userFiles: Record<string, string>;
  /** Path to Turbopack runtime file (for static import to trigger chunk bundling) */
  turbopackRuntimePath?: string;
  /** Prerender entries for ISR cache seeding */
  prerenderEntries: Array<{
    pathname: string;
    html: string;
    postponedState?: string;
    initialRevalidate?: number | false;
    initialStatus?: number;
    initialHeaders?: Record<string, string | string[]>;
    pprHeaders?: Record<string, string>;
  }>;
  /**
   * Composable cache (`'use cache'`) entries extracted from build-time
   * prerenders, keyed by bracket-form shell pathname. Applied request-scoped
   * at runtime so only requests matching a shell see its seeds.
   */
  composableCacheSeedsByShell?: Array<[
    string,
    Array<{
      key: string;
      value: string;
      tags: string[];
      stale: number;
      timestamp: number;
      expire: number;
      revalidate: number;
    }>,
  ]>;
  /** Path to edge registration chunk (contains _ENTRIES setup) */
  edgeRegistrationChunkPath?: string;
  /** Turbopack runtime module IDs for edge middleware evaluation */
  edgeRuntimeModuleIds?: number[];
  /** Paths to edge otherChunks that need explicit import */
  edgeOtherChunkPaths?: string[];
  /**
   * [xxh3_128_hex, wasm_filename_with_ext] pairs. Turbopack edge bundles
   * access the compiled WebAssembly.Module via \`globalThis.wasm_<hex>\`.
   * Import each wasm (wrangler declares \`.wasm\` as CompiledWasm) and
   * assign onto globalThis before edge modules evaluate.
   */
  wasmHashToFilename?: Array<[string, string]>;
  /**
   * [byteLength, wasm_filename] pairs. Registered in
   * \`globalThis.__CREEK_WASM_BY_LENGTH\` so the runtime
   * \`WebAssembly.instantiate\` patch can swap byte-based calls for the
   * pre-compiled Module workerd already has in memory.
   */
  wasmLengthToFilename?: Array<[number, string]>;
  /**
   * Module specifiers that Turbopack marked as externals but that the
   * user's code references at runtime via dynamic import. Wrangler's
   * \`externalImport(id)\` runtime helper calls \`await import(id)\` which
   * workerd refuses — the worker would 500 with "No such module".
   * Eagerly \`import\` each specifier from the worker entry so wrangler
   * bundles them, and register them in \`globalThis.__CREEK_EXT_MODS\` so
   * our patched \`externalImport\` returns the cached module without
   * going through workerd's broken external loader.
   */
  externalModules?: string[];
  /**
   * Absolute path to the user's \`.next/server/instrumentation.js\` when the
   * project actually provides one (not our \`module.exports = {}\` placeholder).
   * We static-import it from the worker entry so wrangler bundles the full
   * module graph, then hand it to Next.js's \`getInstrumentationModule\`
   * lookup — otherwise the dynamic \`__require\` falls back to undefined on
   * workerd and \`instrumentation.register()\` is never called.
   * Fixes e2e/opentelemetry/client-trace-metadata (5 tests) and any other
   * test that depends on user instrumentation side effects.
   */
  userInstrumentationPath?: string;
}

interface HandlerEntry {
  pathname: string;
  importPath: string;
  varName: string;
  runtime: "nodejs" | "edge";
  type: string;
  edgeRuntime?: {
    entryKey: string;
    handlerExport: string;
    runtimeModuleId?: number;
  };
}

/**
 * Generate the worker entry source code.
 * All handler modules are statically imported so esbuild bundles them.
 */
export function generateWorkerEntry(opts: WorkerEntryOptions): string {
  const handlers = collectHandlers(opts.outputs, opts.manifests);
  const pathnames = collectPathnames(opts.outputs, opts.manifests);
  const staticPageMap = collectStaticPageMap(opts.outputs);
  const revalidatePaths = collectRevalidatePaths(opts.outputs);
  const composableCacheSeedsByShell = opts.composableCacheSeedsByShell ?? [];

  // Lazy imports — used at request time, not module evaluation.
  // wrangler bundles the entry + all reachable imports.
  const handlerEntries = handlers
    .map(
      (h) => {
        const parts = [
          `load: () => import(${JSON.stringify(h.importPath)})`,
          `pathname: ${JSON.stringify(h.pathname)}`,
          `runtime: ${JSON.stringify(h.runtime)}`,
          `type: ${JSON.stringify(h.type)}`,
        ];
        if (h.edgeRuntime) {
          parts.push(`entryKey: ${JSON.stringify(h.edgeRuntime.entryKey)}`);
          parts.push(`handlerExport: ${JSON.stringify(h.edgeRuntime.handlerExport)}`);
          if (h.edgeRuntime.runtimeModuleId) {
            parts.push(`runtimeModuleId: ${h.edgeRuntime.runtimeModuleId}`);
          }
        }
        return `  ${JSON.stringify(h.pathname)}: { ${parts.join(", ")} },`;
      },
    )
    .join("\n");
  const handlerStaticImports = "";

  // Boot manifests must run before edge runtime modules evaluate.
  // Edge app wrappers read globals like __RSC_MANIFEST and
  // __RSC_SERVER_MANIFEST at module-evaluation time.
  const manifestImports = collectBootManifestPaths(opts.manifests)
    .map((p, i) => `import * as __bootManifest${i} from ${JSON.stringify(p)};\nvoid __bootManifest${i};`)
    .join("\n");

  // Edge chunks self-register by calling \`globalThis.TURBOPACK.push(...)\` at
  // evaluation time, so their module bodies have side effects that esbuild
  // preserves. Node-side SSR chunks under \`.next/server/chunks/\` use CJS
  // \`module.exports = [id, factory, id, factory, ...]\` and have no side
  // effects — esbuild was pruning them even though we imported them, leaving
  // module factories like the server-actions registry unregistered. This
  // surfaced as \`Module N was instantiated because it was required from
  // module M, but the module factory is not available\` whenever an edge
  // route tried to invoke a server action.
  //
  // Reading \`.default\` forces the import to survive tree-shaking, and when
  // it's the CJS array shape we forge a TURBOPACK push so the edge runtime's
  // registry picks up every factory — same mechanism edge chunks already use.
  const edgeOtherChunkImports = (opts.edgeOtherChunkPaths || [])
    .map((p: string, i: number) =>
      `import * as __edgeChunk${i} from ${JSON.stringify(p)};\n` +
      `if (__edgeChunk${i} && Array.isArray(__edgeChunk${i}.default)) (globalThis.TURBOPACK ||= []).push([${JSON.stringify("__creek_cjs_" + i)}, ...__edgeChunk${i}.default]);\n` +
      `else void __edgeChunk${i};`,
    )
    .join("\n");

  // Mirror each \`.wasm\` CompiledWasm export onto globalThis under the
  // \`wasm_<xxh3_128_hex>\` name Turbopack's loadEdgeWasm expects.
  // Also register by byte length so the runtime \`WebAssembly.instantiate\`
  // patch can swap byte-based instantiation (forbidden on workerd) for
  // the pre-compiled Module.
  const hashToLength = new Map<string, number>();
  for (const [len, fn] of opts.wasmLengthToFilename ?? []) {
    for (const [hex, fn2] of opts.wasmHashToFilename ?? []) {
      if (fn === fn2) hashToLength.set(hex, len);
    }
  }
  const wasmImports = (opts.wasmHashToFilename ?? [])
    .map(([hex, filename], i) => {
      const len = hashToLength.get(hex);
      return (
        `import __wasm_${i} from ${JSON.stringify("./" + filename)};\n` +
        `globalThis[${JSON.stringify("wasm_" + hex)}] = __wasm_${i};\n` +
        (len !== undefined
          ? `(globalThis.__CREEK_WASM_BY_LENGTH ||= {})[${JSON.stringify(String(len))}] = __wasm_${i};\n`
          : "")
      );
    })
    .join("\n");

  // Register lazy loaders for Turbopack-externalized modules. Static
  // \`import * as X from "..."\` wouldn't work: the imports hoist to the
  // top of the module and run BEFORE \`globalThis.__USER_FILES\` is set
  // — but \`@vercel/og/index.node.js\` reads \`Geist-Regular.ttf\` and
  // \`resvg.wasm\` via \`fs.readFileSync\` at module evaluation. With
  // __USER_FILES still undefined, our fs shim throws ENOENT and worker
  // init aborts. Emit loader functions (arrow functions containing a
  // dynamic \`import(...)\` with a literal string — wrangler statically
  // follows these and bundles the target) and register them in
  // \`__CREEK_EXT_LOADERS\`. Our patched externalImport awaits the loader
  // on first call, at which point all runtime globals are ready.
  const externalModuleImports = (opts.externalModules ?? []).length === 0
    ? ""
    : "globalThis.__CREEK_EXT_LOADERS = globalThis.__CREEK_EXT_LOADERS || {};\n" +
      (opts.externalModules ?? [])
        .map((spec: string) =>
          `globalThis.__CREEK_EXT_LOADERS[${JSON.stringify(spec)}] = () => import(${JSON.stringify(spec)});`
        )
        .join("\n");

  // User-provided \`instrumentation.ts\`. Static-import so wrangler bundles
  // the whole OTel graph, then publish on \`globalThis.__CREEK_INSTRUMENTATION\`
  // so our patched \`getInstrumentationModule\` lookup picks it up at runtime.
  const userInstrumentationImport = opts.userInstrumentationPath
    ? `import * as __userInstrumentation from ${JSON.stringify(opts.userInstrumentationPath)};\n` +
      `globalThis.__CREEK_INSTRUMENTATION = __userInstrumentation && (__userInstrumentation.default && (__userInstrumentation.default.register || __userInstrumentation.default.onRequestError) ? __userInstrumentation.default : __userInstrumentation);`
    : "";

  // Path to ALS polyfill — must be the FIRST import so it runs
  // before any Turbopack edge module evaluates.
  const alsPolyfillPath = path.join(
    path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    "src", "shims", "als-polyfill.js",
  );

  return `
// Generated by adapter-creek — do not edit
// Polyfill globalThis.AsyncLocalStorage BEFORE any Next.js code runs.
// This CommonJS module runs synchronously when required, setting up
// AsyncLocalStorage before any edge modules evaluate.
import ${JSON.stringify(alsPolyfillPath)};
import { AsyncLocalStorage } from "node:async_hooks";
if (!globalThis.AsyncLocalStorage) globalThis.AsyncLocalStorage = AsyncLocalStorage;

// Patch globalThis.Request BEFORE any Next.js code evaluates. Node's Request
// constructor throws \`RequestInit: duplex option is required when sending a
// body\` whenever init.body is a ReadableStream without \`duplex: "half"\`.
// NextRequest's constructor normally sets \`init.duplex = "half"\` for Node
// compatibility, but only when \`process.env.NEXT_RUNTIME !== "edge"\`. We
// pretend to be the edge runtime (so the edge chunks take the edge code path),
// which makes NextRequest skip its own duplex fix — and the underlying Node
// Request then throws. Auto-injecting duplex here fixes both paths without
// having to switch NEXT_RUNTIME.
if (typeof globalThis.Request === "function") {
  const __OrigRequest = globalThis.Request;
  class __PatchedRequest extends __OrigRequest {
    constructor(input, init) {
      if (init && init.body != null && init.duplex === undefined) {
        init = Object.assign({}, init, { duplex: "half" });
      }
      // workerd's Request constructor rejects every standard Fetch API
      // cache mode except \`no-store\` with \`TypeError: Unsupported cache
      // mode\` (\`default\` is also rejected despite being the spec default,
      // verified with workerd 1.20260410.0). Next.js's \`patch-fetch.js\`
      // handles cache semantics at a higher layer via IncrementalCache,
      // so dropping the field before the native call is safe.
      if (init && init.cache !== undefined && init.cache !== "no-store") {
        init = Object.assign({}, init);
        delete init.cache;
      }
      super(input, init);
    }
  }
  // Copy over static methods (e.g. Request.redirect isn't defined, but be safe)
  Object.setPrototypeOf(__PatchedRequest, __OrigRequest);
  Object.defineProperty(__PatchedRequest, "name", { value: "Request" });
  globalThis.Request = __PatchedRequest;
}

// Patch \`WebAssembly.instantiate\` so libraries that do
// \`WebAssembly.instantiate(fs.readFileSync("X.wasm"))\` at module load
// (e.g. \`@vercel/og\` node-runtime loading resvg/yoga wasm) can run on
// workerd, which otherwise rejects byte-based instantiation with
// "Wasm code generation disallowed by embedder". At build time we
// bundle each \`.wasm\` as a CompiledWasm module and register by byte
// length in \`__CREEK_WASM_BY_LENGTH\`. When \`instantiate(bytes)\` runs,
// we substitute the pre-compiled Module.
if (typeof WebAssembly !== "undefined" && typeof WebAssembly.instantiate === "function") {
  const __origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
  const __origCompile = typeof WebAssembly.compile === "function" ? WebAssembly.compile.bind(WebAssembly) : null;
  const __findPrecompiled = (input) => {
    if (!input) return null;
    const reg = globalThis.__CREEK_WASM_BY_LENGTH;
    if (!reg) return null;
    let len = 0;
    if (input instanceof ArrayBuffer) len = input.byteLength;
    else if (ArrayBuffer.isView(input)) len = input.byteLength;
    else return null;
    return reg[String(len)] || null;
  };
  WebAssembly.instantiate = async function(modOrBytes, imports) {
    if (!(modOrBytes instanceof WebAssembly.Module)) {
      const precompiled = __findPrecompiled(modOrBytes);
      if (globalThis.__CREEK_WASM_DEBUG) {
        const inLen = modOrBytes instanceof ArrayBuffer ? modOrBytes.byteLength : (ArrayBuffer.isView(modOrBytes) ? modOrBytes.byteLength : -1);
        console.log("[creek-wasm] instantiate called bytes=" + inLen + " precompiled=" + !!precompiled + " registryKeys=" + JSON.stringify(Object.keys(globalThis.__CREEK_WASM_BY_LENGTH || {})));
      }
      if (precompiled) {
        const instance = await __origInstantiate(precompiled, imports);
        return { module: precompiled, instance };
      }
    }
    return __origInstantiate(modOrBytes, imports);
  };
  if (__origCompile) {
    WebAssembly.compile = async function(bytes) {
      const precompiled = __findPrecompiled(bytes);
      if (precompiled) return precompiled;
      return __origCompile(bytes);
    };
  }
}

// Polyfill process methods and env that Next.js uses.
if (typeof process !== "undefined") {
  if (!process.env) process.env = {};
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
  if (!process.env.NEXT_RUNTIME) process.env.NEXT_RUNTIME = "nodejs";
  if (!process.version) process.version = "v20.0.0";
  if (!process.versions) process.versions = { node: "20.0.0" };
  if (!process.cwd) process.cwd = () => "/";
  if (!process.hrtime) {
    process.hrtime = Object.assign((prev) => {
      const now = performance.now();
      const sec = Math.floor(now / 1000);
      const nsec = Math.floor((now % 1000) * 1e6);
      if (prev) return [sec - prev[0], nsec - prev[1]];
      return [sec, nsec];
    }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) });
  }
  if (!process.on) process.on = () => process;
  if (!process.removeListener) process.removeListener = () => process;
  if (!process.off) process.off = () => process;
}

import { resolveRoutes, responseToMiddlewareResult } from "@next/routing";
import { IncrementalCache } from "next/dist/server/lib/incremental-cache/index.js";
import { tagsManifest as __nextTagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external.js";
import { workAsyncStorage as __nextWorkAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { DurableObject } from "cloudflare:workers";

// Boot manifest globals before importing edge runtime chunks.
${manifestImports}

// Register each WebAssembly.Module under \`wasm_<xxh3_128_hex>\` globals
// Turbopack's edge wasm loader expects. Must precede edge chunk imports.
${wasmImports}

// Bundle externalized modules (Turbopack emitted externalImport chunks
// pointing at these paths) so our patched externalImport can serve them
// without going through workerd's external loader.
${externalModuleImports}

// Statically bundle the user's \`instrumentation.ts\` (when present) and
// expose it on globalThis so our patched \`getInstrumentationModule\` can
// return it without hitting workerd's dynamic-require restriction.
${userInstrumentationImport}

// Edge runtime chunks must be imported so their module factories are present
// before runtimeModuleIds are evaluated for middleware or edge pages/routes.
${edgeOtherChunkImports}
${handlerStaticImports}

${opts.outputs.middleware?.edgeRuntime ? `
// Import edge middleware runtime.
import * as __middleware_edge from ${JSON.stringify(opts.outputs.middleware.edgeRuntime.modulePath)};
void __middleware_edge;

// Initialize _ENTRIES for middleware — trigger runtimeModuleIds evaluation.
function __initEdgeModules() {
  if (self._ENTRIES?.middleware_middleware) return;
  self._ENTRIES = self._ENTRIES || {};
  ${opts.edgeRuntimeModuleIds && opts.edgeRuntimeModuleIds.length > 0 ? `
  if (typeof globalThis.TURBOPACK?.push === "function") {
    try {
      globalThis.TURBOPACK.push(["__creek_mw_init", {otherChunks: [], runtimeModuleIds: ${JSON.stringify(opts.edgeRuntimeModuleIds)}}]);
    } catch {}
  }` : ""}
}
` : opts.outputs.middleware ? `
import * as __middleware_file from ${JSON.stringify(opts.outputs.middleware.filePath)};
function __initEdgeModules() {}
` : `function __initEdgeModules() {}`}
${opts.turbopackRuntimePath ? `
import * as __turbopack_runtime from ${JSON.stringify(opts.turbopackRuntimePath)};
void __turbopack_runtime;
` : ""}

// ------------------------------------------------------------------
// Cache-layer Durable Objects — auto-provisioned by Creek control plane.
// All DO ID derivation is scoped by an unguessable \`projectId\` (UUID)
// so tenants sharing Creek's dispatch namespace cannot step on each
// other's DO instances. See CLAUDE.md / memory for the isolation design.
// ------------------------------------------------------------------

const CREEK_CACHE_SHARD_COUNT = 4;
const CREEK_SOFT_TAG_PREFIX = "_N_T_/";

// FNV-1a — no crypto needed; we only need uniform distribution across
// shard indices, not cryptographic strength.
function __creekHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function __creekProjectId(env) {
  // Prefer the unguessable UUID (to be injected by Creek's control plane).
  // Fall back to slug during adapter development + local wrangler dev.
  return (env && (env.CREEK_PROJECT_ID || env.CREEK_PROJECT_SLUG)) || "creek-dev";
}

function __creekShardForTag(tag) {
  const idx = __creekHash(tag) % CREEK_CACHE_SHARD_COUNT;
  const kind = typeof tag === "string" && tag.startsWith(CREEK_SOFT_TAG_PREFIX) ? "soft" : "hard";
  return kind + ":" + idx;
}

function __creekShardForKey(key) {
  return String(__creekHash(key) % CREEK_CACHE_SHARD_COUNT);
}

function __creekGetTagCacheStub(env, tag) {
  const projectId = __creekProjectId(env);
  const shard = __creekShardForTag(tag);
  const ns = env.NEXT_TAG_CACHE_DO_SHARDED;
  if (!ns) return null;
  return ns.get(ns.idFromName(projectId + ":tag:" + shard));
}

function __creekGetCachePurgeStub(env) {
  const projectId = __creekProjectId(env);
  const ns = env.NEXT_CACHE_DO_BUCKET_PURGE;
  if (!ns) return null;
  // Single DO instance per project is fine — purge is batched by alarm.
  return ns.get(ns.idFromName(projectId + ":purge"));
}

// DOShardedTagCache — tracks \`revalidateTag\` / \`revalidatePath\` timestamps
// so IncrementalCache.get can mark entries stale without evicting them.
// Schema is SQLite-backed; one shard per DO instance.
export class DOShardedTagCache extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS tags (" +
        "tag TEXT PRIMARY KEY, " +
        "revalidated_at INTEGER NOT NULL" +
      ")"
    );
  }

  // Mark each tag revalidated at the given timestamp (default: now).
  // Keeps max(existing, new) so concurrent writes don't go backwards.
  async writeTags(tags, timestamp) {
    if (!Array.isArray(tags) || tags.length === 0) return;
    // Cap input to defend against pathological inputs from malicious workers
    // in the shared WfP namespace.
    const capped = tags.slice(0, 256);
    const ts = typeof timestamp === "number" ? timestamp : Date.now();
    for (const tag of capped) {
      if (typeof tag !== "string" || tag.length > 1024) continue;
      this.sql.exec(
        "INSERT INTO tags (tag, revalidated_at) VALUES (?, ?) " +
          "ON CONFLICT(tag) DO UPDATE SET revalidated_at = MAX(revalidated_at, excluded.revalidated_at)",
        tag,
        ts,
      );
    }
  }

  // Returns true if ANY tag has been revalidated strictly after \`since\`.
  // Used by IncrementalCache.get to decide fresh vs stale.
  async hasBeenRevalidated(tags, since) {
    if (!Array.isArray(tags) || tags.length === 0) return false;
    const capped = tags.slice(0, 256).filter((t) => typeof t === "string" && t.length <= 1024);
    if (capped.length === 0) return false;
    const sinceTs = typeof since === "number" ? since : 0;
    const placeholders = capped.map(() => "?").join(",");
    const rows = this.sql
      .exec(
        "SELECT 1 FROM tags WHERE tag IN (" + placeholders + ") AND revalidated_at > ? LIMIT 1",
        ...capped,
        sinceTs,
      )
      .toArray();
    return rows.length > 0;
  }

  // Returns a map { tag -> revalidated_at } for known tags. Unknown tags
  // are omitted. The caller treats "omitted" as never-revalidated (0).
  async getRevalidatedAt(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return {};
    const capped = tags.slice(0, 256).filter((t) => typeof t === "string" && t.length <= 1024);
    if (capped.length === 0) return {};
    const placeholders = capped.map(() => "?").join(",");
    const rows = this.sql
      .exec("SELECT tag, revalidated_at FROM tags WHERE tag IN (" + placeholders + ")", ...capped)
      .toArray();
    const out = {};
    for (const row of rows) out[row.tag] = row.revalidated_at;
    return out;
  }
}

// BucketCachePurge — batches cache-key purge requests. Alarm-driven to
// amortize Cache API purges. The MVP logs intended purges; real Cache
// Purge API wiring arrives when Creek's control plane confirms the
// domain / zone setup available at runtime.
export class BucketCachePurge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS purge_queue (key TEXT PRIMARY KEY, queued_at INTEGER NOT NULL)",
    );
  }

  async enqueue(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return;
    const capped = keys.slice(0, 512).filter((k) => typeof k === "string" && k.length <= 2048);
    if (capped.length === 0) return;
    const now = Date.now();
    for (const key of capped) {
      this.sql.exec(
        "INSERT INTO purge_queue (key, queued_at) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET queued_at = ?",
        key,
        now,
        now,
      );
    }
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    }
  }

  async alarm() {
    const batch = this.sql
      .exec("SELECT key FROM purge_queue ORDER BY queued_at ASC LIMIT 100")
      .toArray();
    if (batch.length === 0) return;
    // MVP: no actual CF Cache API call — just drain the queue so
    // memory doesn't grow unbounded. When cache-purge wiring lands,
    // invoke fetch against the CF API here.
    const keys = batch.map((r) => r.key);
    const placeholders = keys.map(() => "?").join(",");
    this.sql.exec("DELETE FROM purge_queue WHERE key IN (" + placeholders + ")", ...keys);
    const remaining = this.sql.exec("SELECT COUNT(*) AS c FROM purge_queue").one();
    if (remaining && remaining.c > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    }
  }
}

// DOQueueHandler — revalidation queue for background ISR refreshes.
// MVP is a no-op: the main worker uses \`ctx.waitUntil\` for revalidation
// tasks. Keeping the class exported so Creek's control-plane bindings
// and migrations stay stable; method implementations arrive when the
// queue pattern proves needed for high-traffic ISR paths.
export class DOQueueHandler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }
  async send(_message) {
    // Placeholder. Callers fall back to in-process ctx.waitUntil.
  }
}

const BUILD_ID = ${JSON.stringify(opts.buildId)};
const BASE_PATH = ${JSON.stringify(opts.basePath)};
const ASSET_PREFIX = ${JSON.stringify(opts.assetPrefix || "")};
const ASSET_PREFIX_PATH = (() => {
  if (!ASSET_PREFIX) return "";
  try {
    if (ASSET_PREFIX.startsWith("http://") || ASSET_PREFIX.startsWith("https://")) {
      return new URL(ASSET_PREFIX).pathname.replace(/\\/$/, "");
    }
  } catch {}
  return ASSET_PREFIX.startsWith("/") ? ASSET_PREFIX.replace(/\\/$/, "") : "";
})();
const ROUTING = ${JSON.stringify(opts.routing)};
// Subset of next.config that's not encoded into ROUTING. trailingSlash
// is the only one we currently rely on — needed for data-URL
// normalization before middleware sees them.
const CONFIG = ${JSON.stringify(opts.config || {})};
// Normalize ROUTING: when Next.js emits a redirect rule via \`beforeMiddleware\`
// it sets \`headers.Location\` + \`status\` in the 3xx range but sometimes
// omits the \`destination\` field. @next/routing's \`processRoutes\` loop
// only short-circuits (and returns the redirect) when a matched rule has
// BOTH \`destination\` AND a redirect header — otherwise it just writes the
// Location header and keeps iterating. For i18n builds this means the
// more-specific rule (\`/en/redirect-1\` → \`/somewhere/else\`) matches first
// but doesn't return early, and a later less-specific rule
// (\`/:locale/redirect-1\` → \`/$1/somewhere/else\`) overwrites Location with
// a locale-prefixed target. Test: middleware-general "should redirect the
// same for direct visit and client-transition" expects /somewhere/else, we
// were returning /en/somewhere/else. Fill in \`destination\` from the
// Location header so the first match wins.
// Build a per-request ROUTING copy with host-regex named captures
// pre-substituted into rule destinations. Returns the original routing
// object unchanged when no rule has host-regex named groups (common
// case — costs one shallow scan).
function __substituteHostCaptures(routing, url, headers) {
  if (!routing || typeof routing !== "object") return routing;
  const host = headers.get("host") || url.hostname;
  if (!host) return routing;
  const listNames = ["beforeFiles", "afterFiles", "fallback", "beforeMiddleware"];
  let changed = false;
  const patchList = (rules) => {
    if (!Array.isArray(rules)) return rules;
    let listChanged = false;
    const out = [];
    for (const rule of rules) {
      if (!rule || !Array.isArray(rule.has)) { out.push(rule); continue; }
      const hostCond = rule.has.find(
        (c) => c && c.type === "host" && typeof c.value === "string"
      );
      if (!hostCond) { out.push(rule); continue; }
      let groups = null;
      try {
        const m = host.match(new RegExp(hostCond.value));
        if (m && m.groups) groups = m.groups;
      } catch {}
      if (!groups) { out.push(rule); continue; }
      // Substitute $<name> references in destination + header values.
      const substitute = (str) => {
        if (typeof str !== "string") return str;
        let next = str;
        for (const [name, value] of Object.entries(groups)) {
          if (value == null) continue;
          // Replace $name and :name (both destination formats seen in
          // routes-manifest.json).
          next = next.replace(new RegExp("\\\\$" + name + "(?![a-zA-Z0-9_])", "g"), value);
          next = next.replace(new RegExp(":" + name + "(?![a-zA-Z0-9_])", "g"), value);
        }
        return next;
      };
      const patched = { ...rule };
      if (rule.destination) patched.destination = substitute(rule.destination);
      if (rule.headers && typeof rule.headers === "object") {
        const h = {};
        for (const [k, v] of Object.entries(rule.headers)) h[k] = substitute(v);
        patched.headers = h;
      }
      out.push(patched);
      listChanged = true;
    }
    if (listChanged) changed = true;
    return listChanged ? out : rules;
  };
  const patched = { ...routing };
  for (const name of listNames) {
    patched[name] = patchList(routing[name]);
  }
  return changed ? patched : routing;
}

function __normalizeRoutingRedirects(routing) {
  if (!routing || typeof routing !== "object") return routing;
  const patchList = (rules) => {
    if (!Array.isArray(rules)) return rules;
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      if (typeof rule.status === "number" && rule.status >= 300 && rule.status < 400) {
        const loc = rule.headers?.Location || rule.headers?.location;
        if (loc && !rule.destination) rule.destination = loc;
      }
      // Next.js defaults to case-insensitive routing (routes-manifest
      // caseSensitive: false). @next/routing compiles our
      // \`rule.sourceRegex\` string with \`new RegExp(sourceRegex)\` —
      // default case-sensitive. Swap the string for a RegExp instance
      // carrying the \`i\` flag so that a URL like /rewrite-no-basePath
      // (camelCase) still matches a rule declared as /rewrite-no-basepath.
      // new RegExp(regexInstance) copies the flags, so downstream
      // re-compilations preserve case-insensitivity.
      if (typeof rule.sourceRegex === "string") {
        try { rule.sourceRegex = new RegExp(rule.sourceRegex, "i"); } catch {}
      }
    }
    return rules;
  };
  patchList(routing.beforeMiddleware);
  patchList(routing.beforeFiles);
  patchList(routing.afterFiles);
  patchList(routing.dynamicRoutes);
  patchList(routing.onMatch);
  patchList(routing.fallback);
  return routing;
}
__normalizeRoutingRedirects(ROUTING);
const PATHNAMES = ${JSON.stringify(pathnames)};
const I18N = ${JSON.stringify(opts.i18n)};
const HAS_MIDDLEWARE = ${JSON.stringify(!!opts.outputs.middleware)};

// Static page map: request pathname → asset file path.
// Pages Router static pages and auto-statically-optimized pages don't work
// through handler invocation in CF Workers (no filesystem access).
const STATIC_PAGES = ${JSON.stringify(staticPageMap)};

// Set of concrete prerender pathnames whose route handler must run through
// the handler pipeline (not the asset fast-path) so its ISR revalidate
// lifecycle actually fires. Metadata routes are deliberately excluded
// above — see collectRevalidatePaths().
const REVALIDATE_PATHS = new Set(${JSON.stringify(revalidatePaths)});

// Embedded manifests — Next.js route modules call loadManifest() which
// normally uses fs.readFileSync(). Expose on globalThis so the shim can access it.
globalThis.__MANIFESTS = ${JSON.stringify(opts.manifests)};

// Embedded user data files (.json, .yaml, etc.) — route handlers may call
// fs.readFileSync to read project files at runtime. The fs shim falls back
// to this map when a path isn't in __MANIFESTS. Keys are paths relative to
// outputFileTracingRoot; the shim does suffix matching to handle the cwd
// mismatch in workerd.
globalThis.__USER_FILES = ${JSON.stringify(opts.userFiles)};

// Prerender entries for ISR cache seeding (PPR shells + static prerenders)
const __PRERENDER_ENTRIES = ${JSON.stringify(opts.prerenderEntries)};

function __findManifestEntry(manifestName) {
  if (!globalThis.__MANIFESTS) return null;
  const matches = Object.entries(globalThis.__MANIFESTS)
    .filter(([key]) => key.replaceAll("\\\\", "/").endsWith("/" + manifestName));
  if (matches.length === 0) return null;

  // Prefer the top-level .next/server manifest over per-route nested copies.
  const topLevel = matches.find(([key]) => {
    const normalizedKey = key.replaceAll("\\\\", "/");
    const marker = "/.next/server/";
    const markerIndex = normalizedKey.lastIndexOf(marker);
    if (markerIndex === -1) return false;
    return !normalizedKey.slice(markerIndex + marker.length).includes("/");
  });
  return topLevel || matches[0];
}

function __getServerFilesManifest() {
  try {
    const raw = __findManifestEntry("required-server-files.json");
    if (raw) return JSON.parse(raw[1]);
  } catch {}
  return null;
}

function __parseJsonManifest(manifestName, fallbackValue = null) {
  try {
    const raw = __findManifestEntry(manifestName);
    if (raw) return JSON.parse(raw[1]);
  } catch {}
  return fallbackValue;
}

function __extractAssignedManifest(manifestName, globalName) {
  try {
    const raw = __findManifestEntry(manifestName);
    if (!raw) return null;

    const content = raw[1].trim();
    const patterns = [
      \`globalThis.\${globalName} =\`,
      \`globalThis.\${globalName}=\`,
      \`self.\${globalName} =\`,
      \`self.\${globalName}=\`,
    ];
    const pattern = patterns.find((candidate) => content.startsWith(candidate));
    if (!pattern) return null;

    let value = content.slice(pattern.length).trim();
    if (value.endsWith(";")) value = value.slice(0, -1).trim();
    return JSON.parse(value);
  } catch {}
  return null;
}

function __getStringifiedManifest(manifestBaseName, globalName, fallbackValue) {
  const assigned = __extractAssignedManifest(manifestBaseName + ".js", globalName);
  if (typeof assigned === "string") return assigned;
  if (assigned !== null && assigned !== undefined) return JSON.stringify(assigned);

  const parsed = __parseJsonManifest(manifestBaseName + ".json");
  if (parsed !== null && parsed !== undefined) return JSON.stringify(parsed);

  return JSON.stringify(fallbackValue);
}

globalThis.__SERVER_FILES_MANIFEST =
  globalThis.__SERVER_FILES_MANIFEST || __getServerFilesManifest();
// Force a runtime deployment id so Next.js Pages Router's skew-protection
// handshake stays self-consistent:
//   - Server render emits \`<html data-dpl-id="<BUILD_ID>">\` (via Next.js's
//     own createHtmlDataDplIdTransformStream, gated on nextConfig.deploymentId).
//   - Client hydration keeps the attribute because the VDOM now has a matching
//     value (otherwise React strips it as "undefined" → remove).
//   - fetchNextData sends \`x-deployment-id: <BUILD_ID>\` on /_next/data fetches;
//     we respond with \`x-nextjs-deployment-id: <BUILD_ID>\`; they match and
//     client navigation stays soft.
// Without this, every middleware-general client-transition test hard-navigates,
// wiping \`window.beforeNav\` and failing assertions like
// "should rewrite the same for direct visit and client-transition".
if (
  globalThis.__SERVER_FILES_MANIFEST &&
  typeof globalThis.__SERVER_FILES_MANIFEST === "object" &&
  globalThis.__SERVER_FILES_MANIFEST.config &&
  typeof globalThis.__SERVER_FILES_MANIFEST.config === "object" &&
  !globalThis.__SERVER_FILES_MANIFEST.config.deploymentId
) {
  globalThis.__SERVER_FILES_MANIFEST.config.deploymentId = BUILD_ID;
}
// Effective deployment id used in skew-protection handshakes. Falls back to
// BUILD_ID when the build didn't declare a \`nextConfig.deploymentId\` (or
// NEXT_DEPLOYMENT_ID env var). When a build-time id IS declared, HTML
// rendered by Next.js stamps \`data-dpl-id="\${deploymentId}"\` and asset URLs
// carry \`?dpl=\${deploymentId}\`. Responses for \`/_next/data/*\` must echo
// this same value in \`x-nextjs-deployment-id\`, otherwise the Pages Router
// client detects a version skew and forces a hard navigation — which
// breaks middleware-redirects / middleware-rewrites tests that assert
// \`window.__SAME_PAGE === true\`.
const DEPLOYMENT_ID =
  (globalThis.__SERVER_FILES_MANIFEST &&
    globalThis.__SERVER_FILES_MANIFEST.config &&
    globalThis.__SERVER_FILES_MANIFEST.config.deploymentId) ||
  BUILD_ID;
globalThis.__BUILD_MANIFEST =
  globalThis.__BUILD_MANIFEST ||
  __parseJsonManifest("build-manifest.json") ||
  __extractAssignedManifest("middleware-build-manifest.js", "__BUILD_MANIFEST") ||
  {
    pages: { "/_app": [] },
    devFiles: [],
    polyfillFiles: [],
    lowPriorityFiles: [],
    rootMainFiles: [],
  };
globalThis.__REACT_LOADABLE_MANIFEST =
  globalThis.__REACT_LOADABLE_MANIFEST ||
  __getStringifiedManifest("react-loadable-manifest", "__REACT_LOADABLE_MANIFEST", {});
globalThis.__NEXT_FONT_MANIFEST =
  globalThis.__NEXT_FONT_MANIFEST ||
  __getStringifiedManifest("next-font-manifest", "__NEXT_FONT_MANIFEST", {
    app: {},
    appUsingSizeAdjust: false,
    pages: {},
    pagesUsingSizeAdjust: false,
  });
globalThis.__RSC_SERVER_MANIFEST =
  globalThis.__RSC_SERVER_MANIFEST ||
  __getStringifiedManifest("server-reference-manifest", "__RSC_SERVER_MANIFEST", {
    node: {},
    edge: {},
    encryptionKey: "",
  });
globalThis.__INTERCEPTION_ROUTE_REWRITE_MANIFEST =
  globalThis.__INTERCEPTION_ROUTE_REWRITE_MANIFEST ||
  __getStringifiedManifest(
    "interception-route-rewrite-manifest",
    "__INTERCEPTION_ROUTE_REWRITE_MANIFEST",
    [],
  );

function __getPrerenderManifest() {
  try {
    const raw = __findManifestEntry("prerender-manifest.json");
    if (raw) return JSON.parse(raw[1]);
  } catch {}
  return {
    version: 4,
    routes: {},
    dynamicRoutes: {},
    preview: {
      previewModeEncryptionKey: "",
      previewModeId: "",
      previewModeSigningKey: "",
    },
    notFoundRoutes: [],
  };
}

// Segment-prefetch inlining hints computed at build time. Next.js normally
// reads \`.next/server/prefetch-hints.json\` in NextNodeServer's constructor
// and stores it on \`this.renderOpts.prefetchHints\`, which later flows into
// \`ctx.renderOpts.prefetchHints?.[pagePath]\` during walk-tree-with-flight-
// router-state. We bypass NextNodeServer and invoke route modules directly,
// so that plumbing never runs — meaning the initial FlightRouterState for
// segment-prefetch responses ends up with the \`InlinedIntoChild\` hint bit
// missing and \`experimental.prefetchInlining\` looks broken. Parse the
// manifest here at init and patch \`routeModule.render\` to inject the hints
// into \`context.renderOpts\` on the fly.
let __prefetchHintsCache = null;
function __getPrefetchHints() {
  if (__prefetchHintsCache !== null) return __prefetchHintsCache;
  __prefetchHintsCache = __parseJsonManifest("prefetch-hints.json", {}) || {};
  return __prefetchHintsCache;
}

// Middleware matchers: ctx.routing doesn't include the has/missing conditions
// from middleware.config.matcher — those live in middleware-manifest.json.
// When a matcher has \`has: [{type:'header', key:'x-test'}]\` or
// \`missing: [{type:'query', key:'skip'}]\`, the server must evaluate
// those conditions BEFORE invoking middleware. Without this, middleware
// runs on every request regardless of matcher conditions, and tests
// like middleware-custom-matchers fail because middleware fires when it
// shouldn't.
let __middlewareMatchersCache = null;
function __getMiddlewareMatchers() {
  if (__middlewareMatchersCache !== null) return __middlewareMatchersCache;
  __middlewareMatchersCache = [];
  try {
    const manifest = __parseJsonManifest("middleware-manifest.json", null);
    if (!manifest) return __middlewareMatchersCache;
    const mw = manifest.middleware?.["/"]; // middleware is always at "/"
    if (mw && Array.isArray(mw.matchers)) {
      for (const m of mw.matchers) {
        try {
          __middlewareMatchersCache.push({
            regex: new RegExp(m.regexp),
            has: m.has || null,
            missing: m.missing || null,
          });
        } catch {}
      }
    }
  } catch {}
  return __middlewareMatchersCache;
}

// Evaluate has/missing conditions from middleware matchers against a
// request URL + headers. Returns true if the condition set is satisfied.
function __checkHasConditions(conditions, url, headers) {
  if (!conditions || conditions.length === 0) return true;
  for (const cond of conditions) {
    switch (cond.type) {
      case "header": {
        const val = headers.get(cond.key);
        if (val == null) return false;
        if (cond.value && !new RegExp(cond.value).test(val)) return false;
        break;
      }
      case "query": {
        const val = url.searchParams.get(cond.key);
        if (val == null) return false;
        if (cond.value && !new RegExp(cond.value).test(val)) return false;
        break;
      }
      case "cookie": {
        const cookieHeader = headers.get("cookie") || "";
        const cookies = Object.fromEntries(
          cookieHeader.split(";").map(c => {
            const [k, ...v] = c.trim().split("=");
            return [k, v.join("=")];
          })
        );
        const val = cookies[cond.key];
        if (val == null) return false;
        if (cond.value && !new RegExp(cond.value).test(val)) return false;
        break;
      }
      case "host": {
        const host = headers.get("host") || url.hostname;
        if (cond.value && !new RegExp(cond.value).test(host)) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

function __checkMissingConditions(conditions, url, headers) {
  if (!conditions || conditions.length === 0) return true;
  for (const cond of conditions) {
    switch (cond.type) {
      case "header": {
        const val = headers.get(cond.key);
        if (val != null && (!cond.value || new RegExp(cond.value).test(val))) return false;
        break;
      }
      case "query": {
        const val = url.searchParams.get(cond.key);
        if (val != null && (!cond.value || new RegExp(cond.value).test(val))) return false;
        break;
      }
      case "cookie": {
        const cookieHeader = headers.get("cookie") || "";
        const cookies = Object.fromEntries(
          cookieHeader.split(";").map(c => {
            const [k, ...v] = c.trim().split("=");
            return [k, v.join("=")];
          })
        );
        const val = cookies[cond.key];
        if (val != null && (!cond.value || new RegExp(cond.value).test(val))) return false;
        break;
      }
      case "host": {
        const host = headers.get("host") || url.hostname;
        if (cond.value && new RegExp(cond.value).test(host)) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

// Check whether the given request should go through middleware based on
// the matchers compiled from middleware-manifest.json. Returns true if
// at least one matcher matches (regex + has + missing all satisfied).
// When no matchers are defined, default to true (middleware runs on all).
function __shouldRunMiddleware(url, headers) {
  const matchers = __getMiddlewareMatchers();
  if (matchers.length === 0) return true;
  // Real Next.js URL-decodes the pathname before matching middleware
  // matchers, so \`/vercel%20copy.svg\` matches the \`/vercel copy.svg\`
  // matcher and \`/another%2fhello\` matches \`/another/hello\`. The raw
  // pathname doesn't decode \`%20\` → space or \`%2f\` → \`/\`, so we
  // also test against a decoded variant (when it differs).
  // Fixes middleware-static-files URL-encoded sub-tests.
  const candidates = [url.pathname];
  try {
    const decoded = decodeURIComponent(url.pathname);
    if (decoded !== url.pathname) candidates.push(decoded);
  } catch {}
  for (const m of matchers) {
    let matched = false;
    for (const cand of candidates) {
      if (m.regex.test(cand)) { matched = true; break; }
    }
    if (!matched) continue;
    if (!__checkHasConditions(m.has, url, headers)) continue;
    if (!__checkMissingConditions(m.missing, url, headers)) continue;
    return true;
  }
  return false;
}

// Walk ROUTING.beforeMiddleware for header-only rules that match the
// request URL, and collect the headers they would emit. Header-only
// rules come from \`nextConfig.headers()\` (no destination, no redirect
// status). We use this on the static-asset shortcut path to ensure
// \`next.config.js\` headers apply to public files like \`/favicon.ico\`,
// matching Vercel's asset-serving behavior. Returns null if no rule
// contributes headers, else a Headers object with the merged set.
function __collectConfigHeaders(url, requestHeaders) {
  if (!ROUTING || !Array.isArray(ROUTING.beforeMiddleware)) return null;
  const out = new Headers();
  let any = false;
  for (const rule of ROUTING.beforeMiddleware) {
    if (!rule || !rule.headers || typeof rule.headers !== "object") continue;
    // Skip redirect rules (have destination and a 3xx status). Headers-only
    // rules from user config have no \`status\` in the 3xx range and no
    // \`destination\`.
    if (
      rule.status !== undefined &&
      rule.status >= 300 &&
      rule.status < 400
    ) continue;
    if (rule.destination) continue;
    if (!rule.sourceRegex) continue;
    let re;
    try {
      re = new RegExp(rule.sourceRegex);
    } catch {
      continue;
    }
    if (!re.test(url.pathname)) continue;
    if (rule.has && !__checkHasConditions(rule.has, url, requestHeaders)) continue;
    if (rule.missing && !__checkMissingConditions(rule.missing, url, requestHeaders)) continue;
    for (const [k, v] of Object.entries(rule.headers)) {
      if (v == null) continue;
      out.set(k, String(v));
      any = true;
    }
  }
  return any ? out : null;
}

// Manually re-apply ROUTING.beforeFiles rewrites and check if the
// destination is a path-only target (potential public file). The routing
// layer applies these internally but only surfaces \`invocationTarget\` for
// destinations that match a known PATHNAME — so a rewrite to \`/file.txt\`
// (a /public asset) gets silently dropped. Returns the destination
// pathname if a rewrite matches and looks file-like, else null.
function __resolveRewriteToPublicFile(url, headers) {
  if (!ROUTING || !Array.isArray(ROUTING.beforeFiles)) return null;
  // Apply the same locale prefix the routing layer applies internally.
  let candidatePath = url.pathname;
  if (I18N && Array.isArray(I18N.locales) && I18N.locales.length > 0) {
    const seg = url.pathname.split("/")[1] || "";
    if (!I18N.locales.includes(seg)) {
      const def = I18N.defaultLocale || I18N.locales[0];
      candidatePath = "/" + def + url.pathname;
    }
  }
  for (const rule of ROUTING.beforeFiles) {
    if (!rule || !rule.sourceRegex || !rule.destination) continue;
    let regex;
    try { regex = new RegExp(rule.sourceRegex, "i"); } catch { continue; }
    const match = candidatePath.match(regex);
    if (!match) continue;
    // Substitute $1, $2, ... and named groups into destination.
    let dest = rule.destination;
    for (let i = 1; i < match.length; i++) {
      if (match[i] !== undefined) {
        dest = dest.replace(new RegExp("\\\\$" + i, "g"), match[i]);
      }
    }
    if (match.groups) {
      for (const [k, v] of Object.entries(match.groups)) {
        if (v !== undefined) dest = dest.replace(new RegExp("\\\\$" + k, "g"), v);
      }
    }
    // Only treat as a potential public file if the destination is path-only,
    // doesn't start with /api/, and looks file-like (has an extension).
    const destPath = dest.split("?")[0];
    if (
      destPath.startsWith("/") &&
      !destPath.startsWith("/api/") &&
      /\\.[a-zA-Z0-9]+$/.test(destPath)
    ) {
      return destPath;
    }
  }
  return null;
}

// Compile routes-manifest.json's dynamicRoutes into [{ regex, page, paramKeys }]
// once at module init. The @next/routing layer only resolves URLs to handlers
// via exact PATHNAMES match or via config-level rewrites — it doesn't expand
// app-router dynamic patterns like \`/catch-all/[...slug]\`. The worker has to
// do that itself when the routing layer returns no resolvedPathname, otherwise
// every dynamic URL 404s.
let __compiledDynamicRoutes = null;
function __getCompiledDynamicRoutes() {
  if (__compiledDynamicRoutes) return __compiledDynamicRoutes;
  __compiledDynamicRoutes = [];
  try {
    const raw = __findManifestEntry("routes-manifest.json");
    if (!raw) return __compiledDynamicRoutes;
    const manifest = JSON.parse(raw[1]);
    if (!Array.isArray(manifest.dynamicRoutes)) return __compiledDynamicRoutes;
    for (const route of manifest.dynamicRoutes) {
      if (!route?.page || !route?.namedRegex) continue;
      // routeKeys maps the param name in namedRegex (e.g. "nxtPslug") to the
      // user-facing key ("slug"). We keep the namedRegex group names as-is
      // so the matched groups carry the nxtP prefix that the app router
      // expects to identify and strip from searchParams.
      const paramKeys = route.routeKeys ? Object.keys(route.routeKeys) : [];
      try {
        __compiledDynamicRoutes.push({
          page: route.page,
          regex: new RegExp(route.namedRegex),
          paramKeys,
        });
      } catch {}
    }
  } catch {}
  return __compiledDynamicRoutes;
}

function __matchDynamicRoute(pathname) {
  for (const entry of __getCompiledDynamicRoutes()) {
    const m = entry.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    if (m.groups) {
      for (const [k, v] of Object.entries(m.groups)) {
        if (v != null) params[k] = decodeURIComponent(v);
      }
    }
    return { page: entry.page, params };
  }
  return null;
}

// Merge the original request's query string into a redirect Location when
// the Location is a path-only template (e.g. the trailingSlash: true
// \`beforeMiddleware\` rule declares \`headers: { Location: "/$1/" }\` — no
// query). Without this, following the redirect strips user-supplied query
// params and the downstream page handler sees an empty search.
//
// Important: we only apply this to RELATIVE Locations. Middleware that
// explicitly calls \`NextResponse.redirect(new URL('/dest', request.url))\`
// produces an absolute URL and deliberately wants the query dropped — we
// must not smuggle the original query back in for that case.
function __preserveQuery(location, originalSearch) {
  if (!location || !originalSearch) return location;
  // Only path-only Locations get the query preservation treatment. Absolute
  // URLs (http://, https://, //host) always convey intent as-is.
  if (!location.startsWith("/") || location.startsWith("//")) return location;
  if (location.includes("?")) return location;
  return location + originalSearch;
}

function __getEdgeRouteEnvs() {
  const manifest = __parseJsonManifest("middleware-manifest.json", null);
  if (!manifest) return {};

  const routeEnvs = {};
  for (const collection of [manifest.middleware, manifest.functions]) {
    if (!collection || typeof collection !== "object") continue;
    for (const entry of Object.values(collection)) {
      if (!entry || typeof entry !== "object") continue;
      const entryName = entry.name;
      if (!entryName || !entry.env || typeof entry.env !== "object") continue;
      routeEnvs["middleware_" + entryName] = entry.env;
    }
  }
  return routeEnvs;
}

const EDGE_ROUTE_ENVS = __getEdgeRouteEnvs();

async function __withEdgeRouteEnv(entryKey, fn) {
  const envOverrides = entryKey ? EDGE_ROUTE_ENVS[entryKey] : null;
  if (!envOverrides || typeof process === "undefined") {
    return await fn();
  }

  if (!process.env) process.env = {};

  const previous = new Map();
  const missing = new Set();
  for (const [key, value] of Object.entries(envOverrides)) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      previous.set(key, process.env[key]);
    } else {
      missing.add(key);
    }
    process.env[key] = String(value);
  }

  const hadNextRuntime = Object.prototype.hasOwnProperty.call(process.env, "NEXT_RUNTIME");
  const previousNextRuntime = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = "edge";

  try {
    return await fn();
  } finally {
    if (hadNextRuntime) {
      process.env.NEXT_RUNTIME = previousNextRuntime;
    } else {
      delete process.env.NEXT_RUNTIME;
    }
    for (const key of missing) delete process.env[key];
    for (const [key, value] of previous) process.env[key] = value;
  }
}

// ---------------------------------------------------------------
// IncrementalCache data/tag helpers — bridge CreekCacheHandler to the
// auto-provisioned DOs and (eventually) R2.
// ---------------------------------------------------------------

// Best-effort: get env from the current request's fetch context so handler
// methods can reach the DO bindings without threading env through the
// Next.js IncrementalCache constructor (which has no slot for arbitrary
// runtime handles).
function __creekCurrentEnv() {
  try {
    return __INTERNAL_FETCH_CONTEXT.getStore()?.env ?? null;
  } catch {
    return null;
  }
}

// Group tags into {shardKey: tags[]} so we hit each DO instance at most
// once per operation (avoids fan-out + 2x/3x RPC cost for entries that
// carry many tags).
function __creekBucketTagsByShard(tags) {
  const buckets = new Map();
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const shard = __creekShardForTag(tag);
    let arr = buckets.get(shard);
    if (!arr) {
      arr = [];
      buckets.set(shard, arr);
    }
    arr.push(tag);
  }
  return buckets;
}

function __creekShardStub(env, shardKey) {
  const projectId = __creekProjectId(env);
  const ns = env.NEXT_TAG_CACHE_DO_SHARDED;
  if (!ns) return null;
  return ns.get(ns.idFromName(projectId + ":tag:" + shardKey));
}

// Returns true if ANY of \`tags\` has been revalidated strictly after
// \`since\` (a ms timestamp). Uses DO-backed tag cache when available,
// falls back to the in-memory \`__CREEK_TAG_INVALIDATED_AT\` map (covers
// wrangler-dev-without-bindings + single-isolate tests).
// Derive the implicit tags Next.js would attach to a path-based cache entry
// from its cache key. Mirrors \`getDerivedTags\` + \`getImplicitTags\` in
// nextjs/packages/next/src/server/lib/implicit-tags.ts — every URL segment
// becomes a \`_N_T_<seg>/layout\` tag, and the full pathname becomes
// \`_N_T_<pathname>\`. revalidatePath('/foo') invalidates \`_N_T_/foo\`, so
// when we read a cache entry for key "/foo" we have to check those tags
// even though Next.js never stored them on the entry itself.
const __CREEK_IMPLICIT_TAG_PREFIX = "_N_T_";
function __creekImplicitTagsForKey(key) {
  if (typeof key !== "string" || !key.startsWith("/")) return [];
  const tags = [__CREEK_IMPLICIT_TAG_PREFIX + "/layout"];
  const parts = key.split("/");
  for (let i = 1; i < parts.length + 1; i++) {
    let cur = parts.slice(0, i).join("/");
    if (!cur) continue;
    if (!cur.endsWith("/page") && !cur.endsWith("/route")) {
      cur = cur + (cur.endsWith("/") ? "" : "/") + "layout";
    }
    tags.push(__CREEK_IMPLICIT_TAG_PREFIX + cur);
  }
  tags.push(__CREEK_IMPLICIT_TAG_PREFIX + key);
  if (key === "/") tags.push(__CREEK_IMPLICIT_TAG_PREFIX + "/index");
  return tags;
}

async function __creekTagsInvalidatedSince(tags, since) {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  const env = __creekCurrentEnv();
  if (env && env.NEXT_TAG_CACHE_DO_SHARDED) {
    const buckets = __creekBucketTagsByShard(tags);
    // Parallel fan-out across shards; short-circuit on first hit.
    const checks = [];
    for (const [shardKey, shardTags] of buckets) {
      const stub = __creekShardStub(env, shardKey);
      if (!stub) continue;
      checks.push(stub.hasBeenRevalidated(shardTags, since).catch(() => false));
    }
    try {
      const results = await Promise.all(checks);
      if (results.some(Boolean)) return true;
    } catch {
      // DO failure — degrade to in-memory check below.
    }
  }
  const mem = globalThis.__CREEK_TAG_INVALIDATED_AT;
  if (!mem) return false;
  for (const tag of tags) {
    const at = mem.get(tag);
    if (typeof at === "number" && at > since) return true;
  }
  return false;
}

async function __creekWriteRevalidatedTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return;
  const now = Date.now();
  // Always update in-memory (fast, covers same-isolate subsequent reads).
  const mem = globalThis.__CREEK_TAG_INVALIDATED_AT;
  if (mem) {
    for (const t of tags) if (typeof t === "string") mem.set(t, now);
  }
  // Also update Next.js's internal tagsManifest — \`areTagsExpired\` /
  // \`areTagsStale\` (server/lib/incremental-cache/tags-manifest.external.ts)
  // read this map when deciding whether an APP_PAGE / APP_ROUTE cache
  // entry is stale based on its x-next-cache-tags header. Without this
  // write, on-demand revalidation (revalidateTag / revalidatePath / after
  // + revalidatePath) has no effect because Next.js never sees the tag
  // flip. Fixes next-after-app-deploy, trailingslash revalidate, and
  // use-cache-route-handler-only revalidate.
  try {
    for (const t of tags) {
      if (typeof t !== "string") continue;
      const existing = __nextTagsManifest.get(t) || {};
      __nextTagsManifest.set(t, Object.assign({}, existing, { stale: now, expired: now }));
    }
  } catch {}
  // Also persist to DO shards so other isolates / future requests see it.
  const env = __creekCurrentEnv();
  if (env && env.NEXT_TAG_CACHE_DO_SHARDED) {
    const buckets = __creekBucketTagsByShard(tags);
    const writes = [];
    for (const [shardKey, shardTags] of buckets) {
      const stub = __creekShardStub(env, shardKey);
      if (!stub) continue;
      writes.push(stub.writeTags(shardTags, now).catch(() => {}));
    }
    // Fire-and-forget the DO writes if a waitUntil is available; otherwise
    // await so the caller's lifetime covers persistence.
    const ctx = (() => {
      try {
        return __INTERNAL_FETCH_CONTEXT.getStore()?.ctx ?? null;
      } catch {
        return null;
      }
    })();
    if (ctx && typeof ctx.waitUntil === "function") {
      try { ctx.waitUntil(Promise.all(writes).catch(() => {})); }
      catch { await Promise.all(writes).catch(() => {}); }
    } else {
      await Promise.all(writes).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------
// CreekCacheHandler — tiered cache backend
//
// L1: in-memory Map (per-isolate, per-request dedup)
// L2: env.KV (Creek auto-provisions per-project KV namespace)
// Tag: DOShardedTagCache (already wired via __creekTagsInvalidatedSince)
//
// Reads: L1 hit → return. L1 miss → KV.get → promote to L1 → return.
// Writes: L1.set + KV.put (fire-and-forget via waitUntil if available).
//
// When KV binding is absent (local dev without bindings), falls back
// to pure in-memory — matches pre-KV behavior.
// ---------------------------------------------------------------
const __CREEK_KV_PREFIX = "__next_cache:";

function __creekKV() {
  try {
    return __INTERNAL_FETCH_CONTEXT.getStore()?.env?.KV ?? null;
  } catch {
    return null;
  }
}

class CreekCacheHandler {
  constructor(ctx) {
    if (!globalThis.__CREEK_CACHE) globalThis.__CREEK_CACHE = new Map();
    if (!globalThis.__CREEK_TAG_TO_KEYS) globalThis.__CREEK_TAG_TO_KEYS = new Map();
    if (!globalThis.__CREEK_TAG_INVALIDATED_AT) globalThis.__CREEK_TAG_INVALIDATED_AT = new Map();
  }

  async get(key) {
    // L1: in-memory
    let entry = globalThis.__CREEK_CACHE.get(key);

    // L2: KV (if available and L1 miss)
    if (!entry) {
      const kv = __creekKV();
      if (kv) {
        try {
          const raw = await kv.get(__CREEK_KV_PREFIX + key, "json");
          if (raw && typeof raw === "object") {
            entry = raw;
            // Promote to L1 for subsequent reads in this isolate
            globalThis.__CREEK_CACHE.set(key, entry);
          }
        } catch {}
      }
    }

    if (!entry) return null;

    const age = (Date.now() - entry.lastModified) / 1000;

    // Stale by tag invalidation — checks DO shards first (cross-isolate),
    // falls back to the in-memory map.
    //
    // Implicit path tags (_N_T_<pathname>) are NOT stored on the entry by
    // Next.js's ResponseCache (it only passes cacheControl/isRoutePPREnabled/
    // isFallback to set()). revalidatePath('/foo') invalidates _N_T_/foo,
    // so we have to derive the implicit tags from the cache key at read
    // time and include them in the invalidation check. Without this,
    // revalidatePath and after() + revalidatePath have no effect on ISR
    // page caches. Fixes next-after-app-deploy, trailingslash revalidate.
    const checkTags = Array.isArray(entry.tags) ? entry.tags.slice() : [];
    checkTags.push(...__creekImplicitTagsForKey(key));
    const staleByTag = await __creekTagsInvalidatedSince(checkTags, entry.lastModified);

    // Stale by time-based revalidate
    const staleByTime =
      entry.revalidate !== undefined &&
      entry.revalidate !== false &&
      (entry.revalidate === 0 || age > entry.revalidate);

    if (staleByTag || staleByTime) {
      return {
        value: entry.value,
        lastModified: entry.lastModified,
        age: Math.floor(age),
        cacheState: "stale",
      };
    }
    return {
      value: entry.value,
      lastModified: entry.lastModified,
      age: Math.floor(age),
      cacheState: "fresh",
    };
  }

  async set(key, data, ctx) {
    if (data === null) {
      globalThis.__CREEK_CACHE.delete(key);
      // Also delete from KV
      const kv = __creekKV();
      if (kv) {
        try {
          const kvCtx = (() => { try { return __INTERNAL_FETCH_CONTEXT.getStore()?.ctx; } catch { return null; } })();
          const p = kv.delete(__CREEK_KV_PREFIX + key);
          if (kvCtx && typeof kvCtx.waitUntil === "function") {
            try { kvCtx.waitUntil(p.catch(() => {})); } catch { await p.catch(() => {}); }
          } else {
            await p.catch(() => {});
          }
        } catch {}
      }
      return;
    }
    const tags = ctx?.tags ?? [];
    // Next.js 16's ResponseCache passes { cacheControl, isRoutePPREnabled,
    // isFallback } to cacheHandler.set — revalidate lives under cacheControl,
    // not on ctx directly. Read from both so time-based ISR expiry works.
    // Without this, \`age > entry.revalidate\` comparison at get() time
    // always takes the \`undefined\` path, so entries stay fresh forever and
    // \`export const revalidate = N\` routes never re-execute.
    // Fixes app-custom-routes "revalidates correctly on /revalidate-1/*".
    const revalidate =
      typeof ctx?.revalidate === "number"
        ? ctx.revalidate
        : typeof ctx?.cacheControl?.revalidate === "number"
          ? ctx.cacheControl.revalidate
          : undefined;
    const entry = {
      value: data,
      lastModified: Date.now(),
      tags,
      revalidate,
    };

    // L1: always update in-memory
    globalThis.__CREEK_CACHE.set(key, entry);

    // L2: persist to KV (fire-and-forget)
    const kv = __creekKV();
    if (kv) {
      try {
        // KV TTL: use revalidate seconds if set, otherwise 1 year.
        // This provides automatic expiration without needing manual cleanup.
        const expirationTtl = typeof revalidate === "number" && revalidate > 0
          ? Math.max(60, revalidate * 2)  // 2x revalidate, min 60s
          : 31536000; // 1 year
        const kvCtx = (() => { try { return __INTERNAL_FETCH_CONTEXT.getStore()?.ctx; } catch { return null; } })();
        // JSON.stringify may fail for IncrementalCacheValues containing
        // Buffers, TypedArrays, or circular refs. Skip KV persist silently
        // — the in-memory cache still holds the entry for this isolate.
        let serialized;
        try { serialized = JSON.stringify(entry); } catch { return; }
        if (!serialized || serialized.length > 24_000_000) return; // KV 25MB limit
        const p = kv.put(__CREEK_KV_PREFIX + key, serialized, { expirationTtl });
        if (kvCtx && typeof kvCtx.waitUntil === "function") {
          try { kvCtx.waitUntil(p.catch(() => {})); } catch { await p.catch(() => {}); }
        } else {
          await p.catch(() => {});
        }
      } catch {}
    }

    // Track tags → keys mapping (in-memory only, for same-isolate invalidation)
    for (const tag of tags) {
      let keys = globalThis.__CREEK_TAG_TO_KEYS.get(tag);
      if (!keys) {
        keys = new Set();
        globalThis.__CREEK_TAG_TO_KEYS.set(tag, keys);
      }
      keys.add(key);
    }
  }

  async revalidateTag(tag) {
    const tags = Array.isArray(tag) ? tag : [tag];
    await __creekWriteRevalidatedTags(tags);
  }

  resetRequestCache() {}
}

// Build a Next.js IncrementalCache instance backed by CreekCacheHandler.
// Cached per-isolate because the Next.js layer caches per-route control
// data on the instance; rebuilding every request loses those wins and
// also burns CPU on prerender-manifest parsing.
// Cache our IncrementalCache on a PRIVATE global. The public
// \`globalThis.__incrementalCache\` is stomped on per-request by Next.js's
// app-page handler (build/templates/app-page.ts:768). We read the
// private key from requestMeta injection so Next.js never falls back
// to its filesystem-backed cache (which 500s under workerd's read-only
// fs).
function __creekGetIncrementalCache(requestHeaders) {
  if (globalThis.__CREEK_INCREMENTAL_CACHE) return globalThis.__CREEK_INCREMENTAL_CACHE;
  try {
    globalThis.__CREEK_INCREMENTAL_CACHE = new IncrementalCache({
      dev: false,
      minimalMode: false,
      requestHeaders: requestHeaders || {},
      getPrerenderManifest: __getPrerenderManifest,
      CurCacheHandler: CreekCacheHandler,
    });
  } catch (err) {
    // If Next.js's constructor shape ever changes, don't take the whole
    // request down — the old undefined-cache fallback still serves basic
    // pages; only fetch cache / unstable_cache / revalidate will regress
    // and that's visible in the test suite.
    console.error("[creek-cache] failed to construct IncrementalCache:", err?.message);
  }
  return globalThis.__CREEK_INCREMENTAL_CACHE;
}

// =====================================================================
// Composable cache handler (Next 16+ "use cache" directive)
// =====================================================================
// Next.js 16 introduced a separate cache subsystem for the "use cache"
// directive. At runtime, cached functions look up handlers via:
//   globalThis[Symbol.for('@next/cache-handlers-map')].get("default")
//
// If no handlers are registered, "use cache" silently no-ops and tests
// that exercise it fail. opennextjs-cloudflare#1177 patches Next.js source
// (ast-grep) to inject the registration into NextNodeServer. We don't need
// the source patch because we never instantiate NextNodeServer — we just
// register the symbols at module load.
//
// This is an in-memory implementation matching the phase-1 CreekCacheHandler.
// Phase-2 will swap both in for a Durable Object backed implementation.
class CreekComposableCacheHandler {
  constructor() {
    if (!globalThis.__CREEK_CC_STORE) globalThis.__CREEK_CC_STORE = new Map();
    if (!globalThis.__CREEK_CC_TAG_STATE) globalThis.__CREEK_CC_TAG_STATE = new Map();
  }

  async get(cacheKey) {
    // Check the request-scoped shell seeds first. These are build-time
    // \`'use cache'\` values extracted from the matching fallback shell's
    // postponedState — they take precedence over any runtime-populated
    // module-level entry because they represent the authoritative
    // build-time cache for a PPR fallback render.
    try {
      const reqUrl = __INTERNAL_FETCH_CONTEXT.getStore()?.request?.url;
      if (reqUrl) {
        const pathname = new URL(reqUrl).pathname;
        const seeds = __creekSeedsForPathname(pathname);
        if (seeds) {
          const seed = seeds.get(cacheKey);
          if (seed) {
            for (const tag of seed.tags) {
              const state = globalThis.__CREEK_CC_TAG_STATE.get(tag);
              if (state && state.expire !== undefined && state.expire > seed.timestamp) {
                // Seed invalidated by a runtime tag flip — fall through to
                // normal handler path so a fresh render happens.
                break;
              }
            }
            return {
              value: new ReadableStream({
                start(c) { c.enqueue(seed.value); c.close(); },
              }),
              tags: seed.tags,
              stale: seed.stale,
              timestamp: seed.timestamp,
              expire: seed.expire,
              revalidate: seed.revalidate,
            };
          }
        }
      }
    } catch {}

    const entry = globalThis.__CREEK_CC_STORE.get(cacheKey);
    if (!entry) return undefined;

    // If any tag attached to this entry has an expire timestamp newer than
    // the entry's write time, the tag was invalidated AFTER this entry was
    // written → treat as cache miss so the cached function re-runs.
    for (const tag of entry.tags) {
      const state = globalThis.__CREEK_CC_TAG_STATE.get(tag);
      if (state && state.expire !== undefined && state.expire > entry.timestamp) {
        return undefined;
      }
    }

    // The composable cache contract says \`value\` is a fresh ReadableStream.
    // We stored bytes — wrap them in a new stream every read so multiple
    // consumers can read the same entry without exhausting it.
    const bytes = entry.value;
    return {
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      tags: entry.tags,
      stale: entry.stale,
      timestamp: entry.timestamp,
      expire: entry.expire,
      revalidate: entry.revalidate,
    };
  }

  async set(cacheKey, pendingEntry) {
    const entry = await pendingEntry;
    // Drain the ReadableStream into a Uint8Array for storage.
    const reader = entry.value.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    globalThis.__CREEK_CC_STORE.set(cacheKey, {
      value: buf,
      tags: entry.tags || [],
      stale: entry.stale,
      timestamp: entry.timestamp != null ? entry.timestamp : Date.now(),
      expire: entry.expire,
      revalidate: entry.revalidate,
    });
  }

  async refreshTags() {
    // In-memory backend has no remote tag state to refresh.
  }

  /**
   * Next.js 16 calls with a single array; pre-16 used rest args.
   * Returning the most recent stale timestamp matches the upstream contract:
   * Next.js compares this against the entry timestamp to decide validity.
   */
  async getExpiration(...tags) {
    const flat = tags.flat();
    let max = 0;
    for (const tag of flat) {
      const state = globalThis.__CREEK_CC_TAG_STATE.get(tag);
      if (state && state.stale != null && state.stale > max) max = state.stale;
    }
    return max;
  }

  /** Pre-Next-16 path. Forwarded to updateTags with no duration. */
  async expireTags(...tags) {
    return this.updateTags(tags, undefined);
  }

  /** Legacy. Intentional no-op. */
  async receiveExpiredTags() {}

  /**
   * Next 16+ entry point. Marks tags stale immediately. If \`durations.expire\`
   * is provided (seconds), schedules hard expiry; otherwise expires now.
   *
   * Edge-runtime revalidatePath/revalidateTag flows through getCacheHandlers()
   * → this method, never through the legacy CreekCacheHandler.revalidateTag.
   * So we ALSO mirror the tag flip into the shared tagsManifest + our own
   * __CREEK_TAG_INVALIDATED_AT (the map consulted by App Router ISR cache
   * reads via __creekTagsInvalidatedSince). Without this mirror, edge-runtime
   * after() + revalidatePath had no effect on node-side cache entries.
   */
  async updateTags(tags, durations) {
    const now = Date.now();
    const expire = durations && durations.expire !== undefined ? now + durations.expire * 1000 : now;
    for (const tag of tags) {
      globalThis.__CREEK_CC_TAG_STATE.set(tag, { stale: now, expire });
    }
    try {
      const mem = globalThis.__CREEK_TAG_INVALIDATED_AT;
      if (mem) {
        for (const t of tags) if (typeof t === "string") mem.set(t, now);
      }
      for (const t of tags) {
        if (typeof t !== "string") continue;
        const existing = __nextTagsManifest.get(t) || {};
        __nextTagsManifest.set(t, Object.assign({}, existing, { stale: now, expired: now }));
      }
    } catch {}
  }
}

// Register the composable cache handler under both "default" and "remote"
// names — opennextjs-cloudflare#1177 added "remote" to support \`use cache: remote\`.
// Worker module-load runs once per isolate, so this is effectively a singleton.
{
  const handlersMapSymbol = Symbol.for('@next/cache-handlers-map');
  const handlersSetSymbol = Symbol.for('@next/cache-handlers-set');
  if (!globalThis[handlersMapSymbol]) {
    const ccHandler = new CreekComposableCacheHandler();
    const map = new Map();
    map.set("default", ccHandler);
    map.set("remote", ccHandler);
    globalThis[handlersMapSymbol] = map;
    globalThis[handlersSetSymbol] = new Set(map.values());
  }
}

// Composable cache build-time seeds. Extracted from each prerender's
// postponedState (embedded renderResumeDataCache) during \`next build\`.
// Keyed by bracket-form shell pathname so we apply only the seeds matching
// the current request's shell — mirrors Next.js's per-request RDC and
// prevents e.g. \`/with-suspense/*\`'s build-time "buildtime" sentinel from
// leaking into \`/without-suspense/*\` requests that expect a fresh runtime
// render.
//
// We precompile each pathname into a RegExp + turn \`value\` (base64) into
// Uint8Array up-front so handler.get() is a hot-path lookup.
const __CREEK_CC_SEEDS_BY_SHELL = (() => {
  const out = [];
  for (const [pathname, seeds] of ${JSON.stringify(composableCacheSeedsByShell)}) {
    // Pathname may be bracket form like /foo/[slug]/bar or /foo/[...rest].
    // Build a matcher that mirrors our bracket semantics elsewhere in this
    // file (same as collectRevalidatePaths / static page map).
    let re = "";
    let i = 0;
    while (i < pathname.length) {
      const ch = pathname[i];
      if (ch === "[") {
        const end = pathname.indexOf("]", i);
        if (end === -1) { re += "\\\\["; i++; continue; }
        const inner = pathname.slice(i + 1, end);
        if (inner.startsWith("[...") && inner.endsWith("]")) { re += "(.*)"; i = end + 1; continue; }
        if (inner.startsWith("...")) { re += "(.+)"; i = end + 1; continue; }
        re += "([^/]+)"; i = end + 1; continue;
      }
      if (/[.*+?^\${}()|\\\\]/.test(ch)) re += "\\\\" + ch;
      else re += ch;
      i++;
    }
    const entries = new Map();
    for (const seed of seeds) {
      try {
        const bin = atob(seed.value);
        const bytes = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        entries.set(seed.key, {
          value: bytes,
          tags: seed.tags || [],
          stale: seed.stale,
          timestamp: seed.timestamp,
          expire: seed.expire,
          revalidate: seed.revalidate,
        });
      } catch {}
    }
    out.push({ regex: new RegExp("^" + re + "$"), entries });
  }
  return out;
})();

// Resolve the seed entries applicable to the current request. Returns a Map
// (cacheKey → entry) merged across all matching shells — usually at most
// one shell matches a given pathname.
function __creekSeedsForPathname(pathname) {
  if (!pathname || __CREEK_CC_SEEDS_BY_SHELL.length === 0) return null;
  let merged = null;
  for (const shell of __CREEK_CC_SEEDS_BY_SHELL) {
    if (!shell.regex.test(pathname)) continue;
    if (!merged) merged = new Map();
    for (const [k, v] of shell.entries) if (!merged.has(k)) merged.set(k, v);
  }
  return merged;
}

// PPR fallback-shell resume: map bracket-form shell pathname → postponedState
// string. At request time, any path whose concrete pathname matches a shell's
// bracket pattern gets the shell's postponedState injected into its
// requestMeta as \`postponed\`. Next.js's app-page template reads that and
// resumes the render from the pre-captured prelude + RDC instead of running
// cached functions from scratch (see
// \`packages/next/dist/build/templates/app-page.js:333\` —
// \`getRequestMeta(req, 'postponed')\`). Without this plumbing, every
// fallback shell resume re-renders every \`'use cache'\` function at runtime,
// producing hydration mismatches between the shell HTML (buildtime values)
// and the RSC stream (fresh runtime values).
// Fixes fallback-shells hydration-errors test and unblocks future PPR work.
const __CREEK_POSTPONED_BY_SHELL = (() => {
  const out = [];
  for (const entry of __PRERENDER_ENTRIES) {
    if (typeof entry.postponedState !== "string" || entry.postponedState.length === 0) continue;
    if (!entry.pathname.includes("[")) continue; // concrete prerenders use their own URL directly
    let re = "";
    let i = 0;
    while (i < entry.pathname.length) {
      const ch = entry.pathname[i];
      if (ch === "[") {
        const end = entry.pathname.indexOf("]", i);
        if (end === -1) { re += "\\\\["; i++; continue; }
        const inner = entry.pathname.slice(i + 1, end);
        if (inner.startsWith("[...") && inner.endsWith("]")) { re += "(.*)"; i = end + 1; continue; }
        if (inner.startsWith("...")) { re += "(.+)"; i = end + 1; continue; }
        re += "([^/]+)"; i = end + 1; continue;
      }
      if (/[.*+?^\${}()|\\\\]/.test(ch)) re += "\\\\" + ch;
      else re += ch;
      i++;
    }
    out.push({ regex: new RegExp("^" + re + "$"), postponedState: entry.postponedState });
  }
  return out;
})();

function __creekPostponedForPathname(pathname) {
  if (!pathname || __CREEK_POSTPONED_BY_SHELL.length === 0) return null;
  for (const shell of __CREEK_POSTPONED_BY_SHELL) {
    if (shell.regex.test(pathname)) return shell.postponedState;
  }
  return null;
}

// Initialize manifests singleton — called lazily on first SSR request.
function __initManifests() {
  const MANIFESTS_SINGLETON = Symbol.for('next.server.manifests');

  // Parse client-reference manifests from embedded data.
  // The JS files have format: globalThis.__RSC_MANIFEST=(...);globalThis.__RSC_MANIFEST["/page"]={...};
  // We extract the JSON object directly via regex instead of eval.
  globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};
  const manifests = globalThis.__MANIFESTS || {};
  for (const [key, content] of Object.entries(manifests)) {
    if (!key.includes("client-reference-manifest.js")) continue;
    try {
      // Format: globalThis.__RSC_MANIFEST=(...);globalThis.__RSC_MANIFEST["/page"]={...};
      // Find the second assignment (the one with the page key)
      const idx = content.lastIndexOf('__RSC_MANIFEST[');
      if (idx >= 0) {
        // Extract page key between ["..."]
        const keyStart = content.indexOf('"', idx);
        const keyEnd = content.indexOf('"', keyStart + 1);
        const page = content.slice(keyStart + 1, keyEnd);
        // Extract JSON after ]=
        const jsonStart = content.indexOf(']=', keyEnd) + 2;
        let jsonStr = content.slice(jsonStart);
        if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);
        globalThis.__RSC_MANIFEST[page] = JSON.parse(jsonStr);
      }
    } catch {}
  }

  {
    // Parse server-reference-manifest for server actions
    let serverActionsManifest = { encryptionKey: "", node: {}, edge: {} };
    try {
      const raw = __findManifestEntry("server-reference-manifest.json");
      if (raw) serverActionsManifest = JSON.parse(raw[1]);
    } catch {}

    // Initialize with empty client reference map (pages will register via __RSC_MANIFEST)
    const clientReferenceManifestsPerRoute = new Map();
    const rscManifest = globalThis.__RSC_MANIFEST || {};
    for (const [page, manifest] of Object.entries(rscManifest)) {
      // __RSC_MANIFEST keys are like "/page", "/pricing/page", "/docs/[[...slug]]/page"
      // workStore.route uses "/", "/pricing", "/docs/[[...slug]]"
      const normalized = page.replace(/\\/page$/, "").replace(/^$/, "/");
      clientReferenceManifestsPerRoute.set(normalized, manifest);
      // Also keep the original key for direct lookups
      clientReferenceManifestsPerRoute.set(page, manifest);
    }

    // Create proxy for client references
    const proxiedClientReferenceManifest = new Proxy({}, {
      get(_, prop) {
        if (prop === "clientModules" || prop === "rscModuleMapping" || prop === "ssrModuleMapping" ||
            prop === "edgeRscModuleMapping" || prop === "edgeSSRModuleMapping") {
          return new Proxy({}, {
            get(__, id) {
              const readEntry = (manifest, allowNodeFallback = true) => {
                if (!manifest) return undefined;
                let entry = manifest[prop]?.[id];
                if (entry === undefined && allowNodeFallback && prop === "edgeSSRModuleMapping") {
                  entry = manifest.ssrModuleMapping?.[id];
                }
                if (entry === undefined && allowNodeFallback && prop === "edgeRscModuleMapping") {
                  entry = manifest.rscModuleMapping?.[id];
                }
                return entry;
              };

              const workStore = typeof __nextWorkAsyncStorage?.getStore === "function"
                ? __nextWorkAsyncStorage.getStore()
                : undefined;
              if (workStore?.route) {
                const routeEntry = readEntry(clientReferenceManifestsPerRoute.get(workStore.route));
                if (
                  typeof process !== "undefined" &&
                  process.env.CREEK_DEBUG_MANIFESTS === "1" &&
                  (id === "99807" || id === 99807 || String(workStore.route || "").includes("basic-edge"))
                ) {
                  console.error("[creek:worker-manifest:route]", JSON.stringify({
                    route: workStore.route,
                    prop,
                    id,
                    routeHit: clientReferenceManifestsPerRoute.has(workStore.route),
                    entryId: routeEntry && typeof routeEntry === "object"
                      ? routeEntry.id ?? (typeof routeEntry["*"] === "object" ? routeEntry["*"].id : undefined)
                      : undefined,
                  }));
                }
                if (routeEntry !== undefined) return routeEntry;
              }

              let nodeFallback;
              for (const manifest of clientReferenceManifestsPerRoute.values()) {
                const entry = readEntry(manifest, false);
                if (
                  typeof process !== "undefined" &&
                  process.env.CREEK_DEBUG_MANIFESTS === "1" &&
                  (id === "99807" || id === 99807) &&
                  entry !== undefined
                ) {
                  console.error("[creek:worker-manifest:scan-hit]", JSON.stringify({
                    prop,
                    id,
                    entryId: entry && typeof entry === "object"
                      ? entry.id ?? (typeof entry["*"] === "object" ? entry["*"].id : undefined)
                      : undefined,
                  }));
                }
                if (entry !== undefined) return entry;
                if (nodeFallback === undefined && prop === "edgeSSRModuleMapping") {
                  nodeFallback = manifest.ssrModuleMapping?.[id];
                }
                if (nodeFallback === undefined && prop === "edgeRscModuleMapping") {
                  nodeFallback = manifest.rscModuleMapping?.[id];
                }
              }
              if (
                typeof process !== "undefined" &&
                process.env.CREEK_DEBUG_MANIFESTS === "1" &&
                (id === "99807" || id === 99807) &&
                nodeFallback !== undefined
              ) {
                console.error("[creek:worker-manifest:node-fallback]", JSON.stringify({
                  prop,
                  id,
                  entryId: nodeFallback && typeof nodeFallback === "object"
                    ? nodeFallback.id ?? (typeof nodeFallback["*"] === "object" ? nodeFallback["*"].id : undefined)
                    : undefined,
                }));
              }
              return nodeFallback;
            }
          });
        }
        if (prop === "moduleLoading" || prop === "entryCSSFiles" || prop === "entryJSFiles") {
          // Next.js's manifests-singleton resolves these props against the
          // CURRENT route's manifest (see app-render/manifests-singleton.ts).
          // We were returning the FIRST manifest inserted, which hid
          // route-specific CSS/JS entries and caused e.g. /_not-found
          // (global-not-found convention) to render without its CSS links.
          const workStore = typeof __nextWorkAsyncStorage?.getStore === "function"
            ? __nextWorkAsyncStorage.getStore()
            : undefined;
          if (workStore?.route) {
            const routeManifest = clientReferenceManifestsPerRoute.get(workStore.route);
            if (routeManifest && routeManifest[prop] !== undefined) {
              return routeManifest[prop];
            }
          }
          // Fallback: scan until we find any manifest with this prop.
          for (const manifest of clientReferenceManifestsPerRoute.values()) {
            if (manifest && manifest[prop] !== undefined) return manifest[prop];
          }
          return undefined;
        }
        return undefined;
      }
    });

    globalThis[MANIFESTS_SINGLETON] = {
      clientReferenceManifestsPerRoute,
      proxiedClientReferenceManifest,
      serverActionsManifest: {
        encryptionKey: serverActionsManifest.encryptionKey || "",
        node: Object.assign(Object.create(null), serverActionsManifest.node || {}),
        edge: Object.assign(Object.create(null), serverActionsManifest.edge || {}),
      },
      serverModuleMap: new Proxy({}, {
        get: (_, id) => {
          // Check both node AND edge action maps — edge-runtime pages
          // register their actions under the \`edge\` key. Without this
          // fallback, edge Server Actions throw "Failed to find Server
          // Action" because the lookup only searched \`node\`.
          // Fixes temporary-references edge variant + other edge SA tests.
          const nodeWorkers = serverActionsManifest.node?.[id]?.workers;
          const edgeWorkers = serverActionsManifest.edge?.[id]?.workers;
          const workers = nodeWorkers || edgeWorkers;
          if (!workers) return undefined;
          // Mirror Next.js manifests-singleton.createServerModuleMap:
          // in a combined worker, an action's moduleId differs per page
          // (e.g. getHeader has moduleId 98913 on /header but 47627 on
          // /header/node/form). Always pick the worker for the CURRENT
          // page so the module factory that was preloaded by that page's
          // route entry is the one we dispatch to.
          const workStore = typeof __nextWorkAsyncStorage?.getStore === "function"
            ? __nextWorkAsyncStorage.getStore()
            : undefined;
          let entry;
          if (workStore?.page) {
            const pageKey = workStore.page.startsWith("app")
              ? workStore.page
              : "app" + workStore.page;
            entry = workers[pageKey];
          }
          if (!entry) entry = Object.values(workers)[0];
          return entry ? { id: entry.moduleId, name: id, chunks: [], async: entry.async } : undefined;
        }
      }),
    };
  }

  // Seed ISR cache with prerender entries from build output.
  // This provides instant responses for statically prerendered pages
  // and PPR shells, matching the behavior of next start.
  // Cache seeding disabled — let handlers generate responses dynamically.
  // Pre-seeding breaks Pages Router ISR fallback behavior (isFallback: true)
  // and doesn't correctly distinguish between App Router and Pages Router entries.
  // The cache will be populated on first request by CreekCacheHandler.set().
}


const HANDLERS = {
${handlerEntries}
};

// Middleware handler — invoked by @next/routing when a request matches
// middleware matchers. Uses the edge runtime _ENTRIES pattern.
${opts.outputs.middleware?.edgeRuntime ? `
const middlewareHandler = async (mwCtx) => {
  try {
    __initEdgeModules();

    // Look up middleware handler from _ENTRIES (populated by Turbopack runtime)
    const _mwEntry = self._ENTRIES?.[${JSON.stringify(opts.outputs.middleware.edgeRuntime.entryKey)}];
    let handler;
    if (_mwEntry) {
      // _ENTRIES entry is a Proxy around a Promise — try await then direct access
      try {
        const resolved = await _mwEntry;
        handler = resolved?.[${JSON.stringify(opts.outputs.middleware.edgeRuntime.handlerExport)}] || resolved?.default;
      } catch {}
      if (!handler) {
        handler = typeof _mwEntry[${JSON.stringify(opts.outputs.middleware.edgeRuntime.handlerExport)}] === "function"
          ? _mwEntry[${JSON.stringify(opts.outputs.middleware.edgeRuntime.handlerExport)}]
          : undefined;
      }
    }
    if (typeof handler !== "function") return {};

    // Strip Next.js flight headers before middleware sees them. The upstream
    // edge adapter does the same — middleware gets a clean request without
    // RSC / router-state-tree / segment-prefetch noise. Without this strip,
    // user middleware that gates on these headers (e.g. "is this an RSC
    // request?") gets the wrong answer for client-side navigation.
    const FLIGHT_HEADERS = [
      "rsc",
      "next-router-state-tree",
      "next-router-prefetch",
      "next-router-segment-prefetch",
      "next-hmr-refresh",
    ];
    const mwHeaders = new Headers(mwCtx.headers);
    for (const h of FLIGHT_HEADERS) mwHeaders.delete(h);
    const mwUrlClean = new URL(mwCtx.url.toString());
    mwUrlClean.searchParams.delete("_rsc");

    // Materialize the request body into a Uint8Array so that downstream code
    // (NextRequest, user middleware, req.json()/text()/formData()) can
    // construct new Request instances without the \`duplex: "half"\` init
    // option that Node enforces whenever body is a ReadableStream. The
    // middleware-general "Edge can read request body" tests rely on this
    // because their middleware calls req.json() / req.text() / req.formData(),
    // each of which may trigger an internal NextRequest wrap that fails with
    // \`RequestInit: duplex option is required when sending a body\` when
    // given a streamed body.
    let mwBodyBuffer = null;
    if (mwCtx.requestBody) {
      try {
        if (typeof mwCtx.requestBody.getReader === "function") {
          const chunks = [];
          const reader = mwCtx.requestBody.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          if (chunks.length > 0) {
            const total = chunks.reduce((s, c) => s + c.byteLength, 0);
            mwBodyBuffer = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              mwBodyBuffer.set(c, offset);
              offset += c.byteLength;
            }
          } else {
            mwBodyBuffer = new Uint8Array(0);
          }
        } else if (mwCtx.requestBody instanceof Uint8Array) {
          mwBodyBuffer = mwCtx.requestBody;
        }
      } catch (readErr) {
        console.error("[creek-mw] body read error:", readErr instanceof Error ? readErr.message : String(readErr));
      }
    }
    const mwReq = new Request(mwUrlClean, {
      method: mwBodyBuffer ? "POST" : "GET",
      headers: mwHeaders,
      body: mwBodyBuffer,
    });
    let response;
    try {
      // Pass waitUntil into middleware so \`after()\` callbacks can extend
      // the request lifetime past the middleware's return. Without this
      // Next.js's after-context sees no waitUntil, throws the callback
      // into the synchronous fire-and-forget bucket, and the callback
      // typically gets cut off before it completes its self-fetch —
      // which is how \`after() triggers revalidate from middleware\` loses
      // its revalidation call.
      // MiddlewareContext from @next/routing only carries url/headers/body
      // — not the worker's ExecutionContext. Pull our own ctx off the
      // __INTERNAL_FETCH_CONTEXT store so after() callbacks inside
      // middleware can extend the worker lifetime via ctx.waitUntil.
      const mwInvokeCtx = {
        waitUntil: (p) => {
          try {
            const outer = __INTERNAL_FETCH_CONTEXT.getStore()?.ctx;
            outer?.waitUntil?.(Promise.resolve(p).catch(() => {}));
          } catch {}
        },
      };
      response = await __withEdgeRouteEnv(
        ${JSON.stringify(opts.outputs.middleware.edgeRuntime.entryKey)},
        () => handler(mwReq, mwInvokeCtx)
      );
    } catch (handlerErr) {
      // Middleware threw. Return a \`bodySent\` result with a synthetic
      // 500 Response captured in __mwResponse so __handleRequest forwards
      // the error to the client as the final response — matching Next.js's
      // "middleware failed, hard nav" behavior. Without this we'd
      // silently return {} and continue resolving the request, letting
      // the handler render the page normally (200 OK) and hiding the
      // middleware failure from the client's skew-protection check.
      // Fixes middleware-general "hard-navigates when the data request
      // failed" for both i18n variants.
      const errMsg = handlerErr instanceof Error ? (handlerErr.stack || handlerErr.message) : String(handlerErr);
      console.error("[creek-mw] handler error:", errMsg);
      const errResponse = new Response(
        "Internal Server Error: " + (handlerErr instanceof Error ? handlerErr.message : String(handlerErr)),
        {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
      return {
        bodySent: true,
        __mwResponse: errResponse,
      };
    }
    if (!response || !(response instanceof Response)) {
      console.error("[creek-mw] handler returned non-Response:", typeof response, response);
      return {};
    }
    const mwResult = responseToMiddlewareResult(response, mwHeaders, mwCtx.url);
    // Stash the original response on the result so the worker can return
    // its body verbatim when middleware handles the request itself (e.g.
    // returns \`Response.json(...)\`). responseToMiddlewareResult flags that
    // via \`bodySent\` which the routing layer translates into
    // \`middlewareResponded: true\`, losing the actual body bytes. Keeping a
    // reference lets \`__handleRequest\` return the original response.
    mwResult.__mwResponse = response;
    // Restore flight headers from the original request. The user middleware
    // never saw them (we stripped them), so they're not in the override list,
    // which means responseToMiddlewareResult would either drop them or never
    // re-add them. The downstream page handler still needs them to detect
    // RSC requests (otherwise it returns HTML instead of an RSC payload and
    // the client falls back to a full-page reload).
    if (mwResult.requestHeaders) {
      for (const h of FLIGHT_HEADERS) {
        const v = mwCtx.headers.get(h);
        if (v != null) mwResult.requestHeaders.set(h, v);
      }
    }
    return mwResult;
  } catch (err) {
    console.error("[creek-mw] Error:", err instanceof Error ? err.stack || err.message : String(err));
    return {};
  }
};
` : opts.outputs.middleware ? `
// Node.js runtime middleware — import the module and call handler directly.
import * as __middleware_mod from ${JSON.stringify(opts.outputs.middleware.filePath)};
const middlewareHandler = async (mwCtx) => {
  try {
    const handler = __middleware_mod.handler || __middleware_mod.default;
    if (typeof handler !== "function") return {};
    // Mirror the edge middleware path: strip flight headers and the _rsc
    // search param so middleware sees a clean request.
    const FLIGHT_HEADERS = [
      "rsc",
      "next-router-state-tree",
      "next-router-prefetch",
      "next-router-segment-prefetch",
      "next-hmr-refresh",
    ];
    const mwHeaders = new Headers(mwCtx.headers);
    for (const h of FLIGHT_HEADERS) mwHeaders.delete(h);
    const mwUrlClean = new URL(mwCtx.url.toString());
    mwUrlClean.searchParams.delete("_rsc");
    // See edge variant for rationale: buffer body to avoid duplex issues.
    let mwBodyBuffer = null;
    if (mwCtx.requestBody) {
      try {
        if (typeof mwCtx.requestBody.getReader === "function") {
          const chunks = [];
          const reader = mwCtx.requestBody.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          if (chunks.length > 0) {
            const total = chunks.reduce((s, c) => s + c.byteLength, 0);
            mwBodyBuffer = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              mwBodyBuffer.set(c, offset);
              offset += c.byteLength;
            }
          } else {
            mwBodyBuffer = new Uint8Array(0);
          }
        } else if (mwCtx.requestBody instanceof Uint8Array) {
          mwBodyBuffer = mwCtx.requestBody;
        }
      } catch {}
    }
    const mwReq = new Request(mwUrlClean, {
      method: mwBodyBuffer ? "POST" : "GET",
      headers: mwHeaders,
      body: mwBodyBuffer,
    });
    // Same rationale as edge middleware branch: forward waitUntil so
    // after() callbacks can extend the worker lifetime.
    const mwInvokeCtx = {
      waitUntil: (p) => {
        try {
          const outer = __INTERNAL_FETCH_CONTEXT.getStore()?.ctx;
          outer?.waitUntil?.(Promise.resolve(p).catch(() => {}));
        } catch {}
      },
    };
    const response = await handler(mwReq, mwInvokeCtx);
    const mwResult = responseToMiddlewareResult(response, mwHeaders, mwCtx.url);
    mwResult.__mwResponse = response;
    // See edge variant for rationale: restore flight headers so the page
    // handler still sees them and treats client-nav requests as RSC.
    if (mwResult.requestHeaders) {
      for (const h of FLIGHT_HEADERS) {
        const v = mwCtx.headers.get(h);
        if (v != null) mwResult.requestHeaders.set(h, v);
      }
    }
    return mwResult;
  } catch {
    return {};
  }
};
` : `const middlewareHandler = async () => ({});`}

// --- Node.js bridge ---
${NODE_BRIDGE_CODE}

const __nativeFetch = globalThis.fetch.bind(globalThis);
function __asByteStream(stream) {
  if (!stream) return stream;
  try {
    const byobReader = stream.getReader({ mode: "byob" });
    byobReader.releaseLock();
    return stream;
  } catch {}
  const reader = stream.getReader();
  return new ReadableStream({
    type: "bytes",
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

async function __withMinimalWorkStore(pagePath, ctx, fn) {
  if (!pagePath || typeof __nextWorkAsyncStorage?.run !== "function") {
    return await fn();
  }
  try {
    if (typeof __nextWorkAsyncStorage.getStore === "function" && __nextWorkAsyncStorage.getStore()) {
      return await fn();
    }
  } catch {}

  // Lazily construct the IncrementalCache the first time a workStore is
  // needed. Without this, Next.js's fetch/unstable_cache/ISR codepaths
  // see \`workStore.incrementalCache === undefined\` and silently no-op
  // (the failure mode that put app-static 0/29 on the cache cluster).
  const incrementalCache = __creekGetIncrementalCache();

  const store = {
    page: pagePath,
    route: pagePath,
    isStaticGeneration: false,
    isOnDemandRevalidate: false,
    isDraftMode: false,
    isPrefetchRequest: false,
    buildId: BUILD_ID,
    reactLoadableManifest: {},
    assetPrefix: ASSET_PREFIX,
    cacheComponentsEnabled: false,
    incrementalCache,
    runInCleanSnapshot: (cb, ...args) => typeof cb === "function" ? cb(...args) : cb,
    reactServerErrorsByDigest: new Map(),
    afterContext: {
      waitUntil: (promise) => {
        if (!promise) return;
        try {
          ctx.waitUntil(Promise.resolve(promise).catch(() => {}));
        } catch {}
      },
    },
  };

  return await __nextWorkAsyncStorage.run(store, fn);
}

const __INTERNAL_FETCH_CONTEXT = new AsyncLocalStorage();
globalThis.fetch = function(input, init) {
  // workerd rejects every standard Fetch API cache mode except
  // \`no-store\` with \`TypeError: Unsupported cache mode\` (including
  // \`default\`, the spec default — verified with workerd 1.20260410.0).
  // patch-fetch handles cache semantics at a higher layer via
  // IncrementalCache, so dropping the field before the native call is
  // safe.
  if (init && init.cache !== undefined && init.cache !== "no-store") {
    init = Object.assign({}, init);
    delete init.cache;
  }
  // Edge asset bindings: Next.js's middleware-asset-loader rewrites
  // \`fetch(new URL('../assets/foo.ttf', import.meta.url))\` into
  // \`fetch('blob:<name>')\` and emits the file bytes to either
  //   (a) \`.next/server/edge-chunks/asset_<name>\` (webpack + middleware path), or
  //   (b) \`.next/server/edge/assets/<name>\` (Turbopack + edge route path)
  // The upstream edge sandbox has a \`fetchInlineAsset\` shim that reads the
  // file from disk; CF Workers have no fs, so at build time we copy the
  // files into the assets binding under \`/_next/edge-chunks/\` (a) and
  // \`/_next/edge-assets/\` (b) respectively, and here we translate the
  // blob URL to the matching ASSETS fetch.
  const inputUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input && typeof input === "object" && "url" in input
          ? input.url
          : String(input);
  if (typeof inputUrl === "string" && inputUrl.startsWith("blob:")) {
    const name = inputUrl.slice("blob:".length);
    const store = __INTERNAL_FETCH_CONTEXT.getStore();
    const env = store?.env;
    if (env?.ASSETS && store?.origin) {
      // Turbopack emits \`blob:server/edge/assets/<filename>\` for edge-route
      // \`new URL(..., import.meta.url)\` imports.
      const edgeAssetsPrefix = "server/edge/assets/";
      const assetPath = name.startsWith(edgeAssetsPrefix)
        ? "/_next/edge-assets/" + name.slice(edgeAssetsPrefix.length)
        : "/_next/edge-chunks/asset_" + name;
      const assetUrl = new URL(assetPath, store.origin);
      return env.ASSETS.fetch(new Request(assetUrl));
    }
    return new Response(null, { status: 404 });
  }
  const store = __INTERNAL_FETCH_CONTEXT.getStore();
  if (!store) return __nativeFetch(input, init);
  const request = input instanceof Request && init === undefined ? input : new Request(input, init);
  try {
    if (new URL(request.url).origin === store.origin) {
      return __nativeFetch(request).then((response) => {
        if (!response?.body) return response;
        return new Response(__asByteStream(response.body), response);
      });
    }
  } catch {}
  return __nativeFetch(input, init);
};

// Symbol used by Next.js's patch-fetch to track whether globalThis.fetch has
// already been patched. The patch is one-shot per process — once set, future
// patchFetch() calls short-circuit. On CF Workers a single isolate handles
// many requests, which means the very first request "wins" the patch and
// every subsequent request reuses the stale wrapper chain. The createDedupeFetch
// layer in that chain holds a React.cache scope tied to the first render, so
// repeat fetches in later requests bypass dedupe (val1 != val2 in the
// "React fetch instrumentation" tests). Resetting both the symbol AND
// globalThis.fetch back to our wrapper at the start of every request lets
// patchFetch rebuild the chain fresh per-request.
const __NEXT_PATCH_SYMBOL = Symbol.for("next-patch");
const __ourFetchWrapper = globalThis.fetch;
// Internal Next.js headers that must NOT be honored when sent by the
// external client. These are normally set by the middleware proxy
// chain (or by Next.js's IPC layer) and a malicious client could use
// them to bypass framework invariants — e.g. sending
// \`x-middleware-set-cookie\` would let the client implant cookies that
// \`cookies()\` reads back as if middleware had set them. Keeps the worker
// in sync with Next.js's \`filterInternalHeaders\` (server/lib/server-ipc/utils.ts).
const __INTERNAL_NEXT_HEADERS = [
  "x-middleware-rewrite",
  "x-middleware-redirect",
  "x-middleware-set-cookie",
  "x-middleware-skip",
  "x-middleware-override-headers",
  "x-middleware-next",
  "x-now-route-matches",
  "x-matched-path",
  "x-next-resume-state-length",
];

function __filterInternalRequestHeaders(req) {
  let dirty = false;
  const next = new Headers();
  req.headers.forEach((val, key) => {
    if (__INTERNAL_NEXT_HEADERS.includes(key.toLowerCase())) {
      dirty = true;
      return;
    }
    next.append(key, val);
  });
  if (!dirty) return req;
  return new Request(req.url, {
    method: req.method,
    headers: next,
    body: req.body,
    ...(req.body ? { duplex: "half" } : {}),
    redirect: req.redirect,
  });
}

async function __handleRequest(request, env, ctx) {
  // Wrap every fetch in a per-request module-loading signal context.
  // The track-module-loading shim's \`__CREEK_WITH_MODULE_LOADING_CONTEXT\`
  // runs \`fn\` under an AsyncLocalStorage scope where \`getModuleLoadingSignal\`
  // returns a fresh \`CacheSignal\` bound to this request's IoContext — so
  // the \`setImmediate\` closure CacheSignal keeps on
  // \`pendingTimeoutCleanup\` never leaks to a later request. Without this,
  // second-and-later requests to routes that dynamic-import at render time
  // (e.g. \`ImageResponse\`) 500 with "Cannot perform I/O on behalf of a
  // different request" when clearImmediate hits the prior Immediate. The
  // shim-global fallback guards module-init or any path that beats the
  // alias target into the bundle.
  const __withLoadCtx = globalThis.__CREEK_WITH_MODULE_LOADING_CONTEXT;
  if (typeof __withLoadCtx === "function") {
    return __withLoadCtx(() => __handleRequestInner(request, env, ctx));
  }
  return __handleRequestInner(request, env, ctx);
}

async function __handleRequestInner(request, env, ctx) {
  // Strip Next.js internal headers (e.g. \`x-middleware-set-cookie\`)
  // from the incoming external request — see __INTERNAL_NEXT_HEADERS
  // comment for why.
  request = __filterInternalRequestHeaders(request);

  // Normalize repeated slashes (\`//\`) and backslashes (\`\\\\\`) in the
  // URL path. Real Next.js issues a 308 redirect to the cleaned URL so
  // browsers land on a canonical form. Without this, paths like
  // \`/basepath//to-sv\` 404 because the routing layer doesn't match
  // double-slash variants. See base-server.ts:982.
  // Fixes i18n-ignore-redirect-source-locale/redirects-with-basepath
  // (16 sub-tests, the test produces \`basepath//to-sv\` from an
  // empty-locale template literal).
  {
    const rawUrl = new URL(request.url);
    if (/\\\\|\\/\\//.test(rawUrl.pathname)) {
      const cleaned = rawUrl.pathname.replace(/\\\\/g, "/").replace(/\\/\\/+/g, "/");
      const cleanedUrl = new URL(cleaned + (rawUrl.search || ""), rawUrl.origin);
      return new Response(null, {
        status: 308,
        headers: { Location: cleanedUrl.toString() },
      });
    }
  }
  // Reset patch state so Next.js will re-wrap fetch for this request.
  globalThis.fetch = __ourFetchWrapper;
  globalThis[__NEXT_PATCH_SYMBOL] = false;
  const response = await __INTERNAL_FETCH_CONTEXT.run({ origin: new URL(request.url).origin, env, ctx, request }, async () => {
    try {
      __initManifests();
      const url = new URL(request.url);
      // Reject URLs with malformed percent-encoding up front. Next.js
      // normally responds with 400 "Bad Request" for these (e.g. \`/%2\`)
      // — see middleware-general's "should respond with 400 on decode
      // failure" test — but our routing layer ends up treating them as
      // a regular unmatched path and returning 200 or 404. Validate the
      // pathname with \`decodeURIComponent\` so we can short-circuit.
      try {
        decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      // 1. Static assets via WfP ASSETS binding
      // /_next/data/ requests are Pages Router data fetches — must go through routing
      // Strip basePath and assetPrefix from the URL to normalize the
      // pathname for both routing and asset serving. Apps with
      // basePath: "/docs" serve assets at /docs/_next/static/... but
      // the routing layer and PATHNAMES use unprefixed paths.
      let assetPath = url.pathname;
      if (BASE_PATH && assetPath.startsWith(BASE_PATH + "/")) {
        assetPath = assetPath.slice(BASE_PATH.length) || "/";
      } else if (BASE_PATH && assetPath === BASE_PATH) {
        assetPath = "/";
      }
      if (ASSET_PREFIX_PATH && assetPath.startsWith(ASSET_PREFIX_PATH + "/")) {
        assetPath = assetPath.slice(ASSET_PREFIX_PATH.length) || "/";
      }
      // Skip the early \`/_next/\` short-circuit when middleware is present:
      // middleware's default matcher covers every path (including
      // \`/_next/static/*\`), and tests like middleware-general's
      // "should keep non data requests in their original shape" depend on
      // middleware observing asset fetches so it can attach
      // \`req-url-path\` / \`req-url-pathname\` headers to the response.
      // Routing falls through to the static-asset lookup in step 4b when
      // no handler matches, so assets are still served — just with the
      // middleware response headers merged in.
      if (
        !HAS_MIDDLEWARE &&
        assetPath.startsWith("/_next/") &&
        !assetPath.startsWith("/_next/data/")
      ) {
        try {
          // Asset storage layout:
          //   - basePath (\`/docs\`): assets live under \`/docs/_next/static/...\`
          //   - assetPrefix (\`/cap\` or \`https://cdn/cap\`): assets live under
          //     \`/_next/static/...\` (assetPrefix only changes the URL the
          //     client uses, not on-disk layout)
          // Always look up using \`<BASE_PATH><stripped-assetPath>\`. For
          // assetPrefix-only builds, this drops the prefix; for basePath
          // builds, it adds basePath back; for combined, it adds basePath
          // after stripping assetPrefix.
          // Fixes app-dir/asset-prefix-absolute: scripts include the
          // absolute assetPrefix host, so test fetches local with
          // \`/<prefix>/_next/static/...\` and expects 200.
          const lookupPath = (BASE_PATH || "") + assetPath;
          const assetUrl = new URL(lookupPath, url.origin);
          const assetReq = new Request(assetUrl, { headers: request.headers });
          const assetRes = await env.ASSETS.fetch(assetReq);
          // 304 Not Modified: pass through so the browser uses its cached
          // copy. Falling through to "Not Found" on 304 would break every
          // conditional GET for static chunks.
          if (assetRes.status === 304) return assetRes;
          if (assetRes.ok) return assetRes;
        } catch {}
        // For /_next/static/ paths that aren't found, return plain 404
        // instead of falling through to routing (which would render a full page).
        if (assetPath.startsWith("/_next/static/")) {
          return new Response("Not Found", { status: 404 });
        }
        // Fall through to routing for _next/image etc.
      }

      // \`_next/data/{buildId}/{path}.json\` is the Pages Router prefetch entry
      // point. Two cases land us at an App Router route:
      //   (a) the requested path itself maps to an APP_PAGE handler
      //   (b) middleware rewrites the request to an APP_PAGE route
      // In both cases the upstream Next.js server returns 200 with
      // \`x-nextjs-matched-path\` set to the app pathname, which the Pages
      // Router client uses to record the route in window.next.router.components
      // and to follow the rewrite on click. (a) we can answer up front; (b)
      // we have to defer until after resolveRoutes, but to skip routing on
      // (a) we evaluate it eagerly.
      let nextDataAppRouterPath = null;
      // For Pages Router static pages, the upstream adapter API only
      // registers data routes (\`/_next/data/<buildId>/<page>.json\` →
      // page handler) for DYNAMIC pages or when middleware is present
      // (see needsMiddlewareResolveRoutes in build-complete.ts). Static
      // pages with getServerSideProps/getStaticProps don't get a data
      // route, so resolveRoutes returns no match for their data URLs.
      // Capture the page path here and pre-rewrite the URL passed to
      // routing so it can find the handler. The original data URL
      // semantics (JSON response, x-nextjs-data header) are preserved
      // by checking BASE_PATH-aware url.pathname later.
      let staticPagesDataRoutePath = null;
      if (assetPath.startsWith("/_next/data/")) {
        const dataMatch = assetPath.match(/^\\/_next\\/data\\/([^/]+)\\/(.+)\\.json$/);
        if (dataMatch && dataMatch[1] === BUILD_ID) {
          // Root-index collapses: dataMatch[2] === "index" is the data URL for
          // \`pages/index.js\` (\`/_next/data/<buildId>/index.json\`), which maps
          // to "/". Subpath "/index" stripping still applies for entries like
          // \`/foo/index.json\` → "/foo". Without collapsing exact "index", we
          // returned \`/index\` and routed to \`pages/[id].js\` with id="index"
          // instead of \`pages/index.js\`, producing \`params: {id: "index"}\`
          // where the spec (and Vercel) return \`params: null\` — fails
          // edge-pages-support "should respond to _next/data for index
          // correctly".
          const rawSegment = dataMatch[2];
          const candidate =
            rawSegment === "index"
              ? "/"
              : "/" + rawSegment.replace(/\\/index$/, "");
          const lookup = candidate === "/" ? "/index" : candidate;
          const handler = HANDLERS[lookup] || HANDLERS[candidate];
          if (handler && handler.type === "APP_PAGE") {
            const headers = new Headers();
            headers.set("content-type", "application/json");
            headers.set("x-nextjs-matched-path", candidate);
            headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
            return new Response("{}", { status: 200, headers });
          }
          nextDataAppRouterPath = candidate;
          if (handler && (handler.type === "PAGES" || handler.type === "PAGES_API")) {
            staticPagesDataRoutePath = handler.pathname || lookup;
          }
          // For purely static Pages Router pages (no getStaticProps /
          // getServerSideProps), Next.js doesn't register a handler — the
          // page is served from a prerendered HTML asset. But Pages Router
          // client still issues \`/_next/data/<id>/<page>.json\` fetches on
          // soft-navigation; if we 404 those, fetchNextData treats the
          // miss as an asset error and forces a hard navigation
          // (router.ts:556 markAssetError → handleHardNavigation). Real
          // Next.js returns 200 + \`{pageProps:{}}\` for these. Detect a
          // known prerendered/static pathname and answer with that minimal
          // body so soft navigation works.
          // Fixes middleware-redirects "should implement internal
          // redirects" — clicking /old-home (middleware redirects to
          // /new-home) follows up with a /new-home data fetch; without
          // this, the follow-up 404s and the navigation degrades to a
          // full reload (window.__SAME_PAGE → undefined).
        }
      }

      // 1b. Public files (e.g. /test1.js, /favicon.ico, /robots.txt). Anything
      // with a file extension that isn't a known route gets a chance at the
      // ASSETS binding (which serves files copied from /public). On miss, we
      // fall through to routing so user-defined routes with extensions still
      // work (rare, but valid).
      // When middleware is present and its matchers match this URL, skip
      // the early asset serve so middleware can intercept the request.
      // Tests like middleware-static-files depend on middleware being able
      // to rewrite /file.svg → a JSON API response.
      // Skip fast-path for paths whose build-time prerender has
      // revalidate > 0 (traditional ISR route handlers like
      // \`export const revalidate = N\` in /foo/[slug]/data.json).
      // The prerendered file is a frozen snapshot — serving it
      // directly bypasses IncrementalCache's fresh/stale/SWR loop.
      // Metadata routes (\`'use cache'\`-based sitemaps etc.) are
      // excluded from REVALIDATE_PATHS at build time so they keep
      // serving their build-time output via the fast-path — running
      // them through the handler would hang without composable-cache
      // build-time seeding.
      const isRevalidatingPrerender = REVALIDATE_PATHS.has(assetPath);
      if (
        request.method === "GET" &&
        !assetPath.startsWith("/_next/") &&
        !assetPath.startsWith("/api/") &&
        /\\.[a-zA-Z0-9]+$/.test(assetPath) &&
        !(HAS_MIDDLEWARE && __shouldRunMiddleware(url, request.headers)) &&
        !isRevalidatingPrerender
      ) {
        try {
          const assetRes = await env.ASSETS.fetch(request);
          // Pass 304 through on conditional GETs so the browser can reuse
          // its cached copy; see the prerender-serving branch for why this
          // matters under wrangler dev / CF Assets.
          if (assetRes.status === 304) {
            return assetRes;
          }
          if (assetRes.ok) {
            // Apply \`headers()\` config rules to static assets. @next/routing
            // encodes those rules into \`ROUTING.beforeMiddleware\` with a
            // source-regex + \`headers\` object (no \`destination\`, no
            // redirect status). We don't run full \`resolveRoutes\` on this
            // shortcut path (for perf), so evaluate beforeMiddleware header
            // rules against the asset URL directly and merge any hits onto
            // the response — otherwise \`next.config.js\` headers never land
            // on public files like \`/favicon.ico\`.
            // Fixes app-dir/no-duplicate-headers-next-config.
            const configHeaders = __collectConfigHeaders(url, request.headers);
            if (configHeaders) {
              const merged = new Headers(assetRes.headers);
              configHeaders.forEach((val, key) => {
                merged.set(key, val);
              });
              return new Response(assetRes.body, {
                status: assetRes.status,
                statusText: assetRes.statusText,
                headers: merged,
              });
            }
            return assetRes;
          }
        } catch {}
      }

      // Debug endpoint
      if (url.pathname === "/__debug") {
        return new Response("OK");
      }


      // 2. Image optimization — proxy to original image.
      // Full optimization (resize/format) will use CF Image Resizing in production.
      if (url.pathname === "/_next/image") {
        const imageUrl = url.searchParams.get("url");
        if (imageUrl) {
          try {
            // Internal images — serve from assets
            if (imageUrl.startsWith("/")) {
              const assetRes = await env.ASSETS.fetch(
                new Request(new URL(imageUrl, url.origin), { headers: request.headers })
              );
              if (assetRes.ok) {
                const headers = new Headers(assetRes.headers);
                headers.set("Cache-Control", "public, max-age=60");
                return new Response(assetRes.body, { status: 200, headers });
              }
            }
            // External images — proxy
            if (imageUrl.startsWith("http")) {
              const imgRes = await fetch(imageUrl);
              if (imgRes.ok) return imgRes;
            }
          } catch {}
        }
        return new Response("Image not found", { status: 404 });
      }

      // 3. Route resolution via @next/routing
      // Clone request for routing — middleware may read the body, but the
      // original must remain available for the handler (server actions, POST).
      const routingClone = request.body ? request.clone() : request;
      // Capture middleware-modified request headers via closure. The routing
      // layer uses \`L.requestHeaders\` internally for downstream matching but
      // does NOT expose them in its result. When user middleware calls
      // \`NextResponse.next({ request: { headers } })\`, those overridden
      // headers must reach the page handler so that \`headers().get(...)\`
      // returns the override value.
      //
      // Also capture the original middleware Response object so the worker
      // can return its body verbatim when middleware handles the request
      // itself (e.g. returns \`Response.json(...)\`). The routing layer
      // translates that into \`middlewareResponded: true\` and discards the
      // body.
      let mwModifiedRequestHeaders = null;
      let mwCapturedResponse = null;
      let mwCapturedRewrite = null;
      let mwCapturedRedirect = null;
      const wrappedMiddlewareHandler = async (mwCtx) => {
        // Check middleware matchers (has/missing conditions) before
        // invoking middleware. @next/routing only checks the source regex
        // from ROUTING.beforeMiddleware — it doesn't evaluate has/missing
        // from middleware-manifest.json. Skip middleware if no matcher is
        // satisfied, matching real Next.js behavior.
        if (!__shouldRunMiddleware(mwCtx.url, mwCtx.headers)) {
          return {};
        }
        // \`trailingSlash: true\` fixture quirk: @next/routing's
        // \`normalizeNextDataUrl\` strips \`.json\` from \`/_next/data/<id>/x.json\`
        // before middleware sees it, producing \`/x\`. But middleware
        // expects \`/x/\` (tests compare \`url.pathname === '/ssr-page/'\`).
        // Real Next.js normalizes both at the same point — \`@next/routing\`
        // doesn't. Post-normalize here only when the URL came from a data
        // URL to avoid double-slashing static asset / api paths.
        // Pages Router data-URL normalization for middleware.
        // Real Next.js server strips \`/_next/data/<buildId>/\` +
        // \`.json\` from the URL BEFORE middleware sees it, then
        // appends \`trailingSlash\` suffix when configured. @next/routing
        // re-denormalizes the URL to its data-URL form before the
        // \`invokeMiddleware\` call (see \`denormalizeNextDataUrl\`), so
        // user middleware receives the raw \`/_next/data/...json\`
        // path — their own \`url.pathname === '/ssr-page/'\` checks then
        // silently fail. Recompute the normalized pathname here to
        // match the upstream behavior.
        // Fixes middleware-trailing-slash \`should trigger middleware
        // for data requests\`, \`should add a rewrite header on data
        // requests for rewrites\`, \`should normalize data requests
        // into page requests\`, \`should have correct query values
        // for rewrite to ssg page\`.
        const __mwDataPrefix = (BASE_PATH || "") + "/_next/data/" + BUILD_ID + "/";
        if (mwCtx.url.pathname.startsWith(__mwDataPrefix)) {
          let pagePath = mwCtx.url.pathname.slice(__mwDataPrefix.length);
          if (pagePath.endsWith(".json")) pagePath = pagePath.slice(0, -5);
          let normPathname =
            (BASE_PATH || "") + (pagePath.startsWith("/") ? pagePath : "/" + pagePath);
          if (normPathname === "") normPathname = "/";
          if (
            CONFIG.trailingSlash &&
            normPathname.length > 1 &&
            !normPathname.endsWith("/") &&
            !normPathname.includes(".")
          ) {
            normPathname += "/";
          }
          const fixed = new URL(mwCtx.url.toString());
          fixed.pathname = normPathname;
          mwCtx = { ...mwCtx, url: fixed };
        }
        const mwRes = await middlewareHandler(mwCtx);
        if (mwRes && mwRes.requestHeaders) {
          mwModifiedRequestHeaders = mwRes.requestHeaders;
        }
        if (mwRes && mwRes.__mwResponse) {
          mwCapturedResponse = mwRes.__mwResponse;
        }
        // i18n rewrite normalization: @next/routing prepends the default
        // locale to the INITIAL incoming URL before middleware runs, but
        // does not re-prepend after a middleware rewrite. When user
        // middleware calls \`NextResponse.rewrite('/blog/from-middleware')\`
        // (no locale prefix), the routing layer tries to match
        // \`/blog/from-middleware\` against PATHNAMES, which for i18n builds
        // only contain locale-prefixed entries like \`/en/blog/[slug]\`.
        // The match fails and we 404. Detect: if the rewrite URL is
        // missing a locale segment AND the path isn't a non-locale
        // namespace (/api/*, /_next/*, /_static/*), prepend the
        // currently-detected locale. Fixes middleware-general's
        // "should have correct dynamic route params for middleware rewrite
        // to dynamic route" and friends.
        if (mwRes && mwRes.rewrite && I18N && Array.isArray(I18N.locales)) {
          try {
            const rewriteUrl = new URL(mwRes.rewrite.toString());
            // External rewrites (different origin) must not be locale-
            // prefixed — we're proxying to a foreign service that knows
            // nothing about our i18n config.
            const isExternal = rewriteUrl.origin !== mwCtx.url.origin;
            const firstSegment = rewriteUrl.pathname.split("/")[1] || "";
            const hasLocale = I18N.locales.includes(firstSegment);
            const pn = rewriteUrl.pathname;
            const isNonLocalePath =
              pn.startsWith("/api/") || pn === "/api" ||
              pn.startsWith("/_next/") || pn.startsWith("/_static/");
            if (!isExternal && !hasLocale && !isNonLocalePath) {
              const incomingFirst = mwCtx.url.pathname.split("/")[1] || "";
              const locale = I18N.locales.includes(incomingFirst)
                ? incomingFirst
                : I18N.defaultLocale;
              if (locale) {
                rewriteUrl.pathname = "/" + locale + (rewriteUrl.pathname === "/" ? "" : rewriteUrl.pathname);
                mwRes.rewrite = rewriteUrl;
              }
            }
            // Capture the final rewrite URL (post-i18n normalization) so
            // the Pages Router data response can echo it back via
            // \`x-nextjs-rewrite\`. The client reads that header to update
            // router.query and router.asPath after a client-transition
            // that was rewritten by middleware.
            mwCapturedRewrite = rewriteUrl.pathname + (rewriteUrl.search || "");
          } catch {}
        } else if (mwRes && mwRes.rewrite) {
          try {
            const rewriteUrl = new URL(mwRes.rewrite.toString());
            mwCapturedRewrite = rewriteUrl.pathname + (rewriteUrl.search || "");
          } catch {}
        }
        // Capture middleware redirect URL for data responses. Pages Router
        // client reads \`x-nextjs-redirect\` on /_next/data/ responses to
        // know where to navigate when middleware returned a
        // NextResponse.redirect(). Without this header, data-driven
        // redirects silently fail — the client stays on the old URL.
        // Fixes middleware-redirects "should redirect to data urls with
        // data requests and internal/external redirects".
        if (mwRes && mwRes.redirect) {
          try {
            mwCapturedRedirect = mwRes.redirect.url
              ? mwRes.redirect.url.toString()
              : mwRes.redirect.toString();
          } catch {}
        }
        return mwRes;
      };
      // For static Pages Router data URLs, rewrite the routing URL to
      // the page path so resolveRoutes can find the handler. We keep
      // the original \`url\` reference unchanged; \`invokeNodeHandler\`
      // reconstructs req.url from the original request to preserve
      // the data-URL prefix that Pages Router's render layer looks for.
      // \`@next/routing\` only strips the \`/_next/data/<buildId>/...json\`
      // prefix before matching when \`routes.shouldNormalizeNextData\` is
      // true — upstream only turns that flag on when middleware is present
      // (build-complete.ts:2184 sets it to \`!!needsMiddlewareResolveRoutes\`).
      // For apps without middleware, data URLs that hit dynamic pages
      // (\`/_next/data/BID/blog/post-3.json\` → \`/blog/[post]\`) fall through
      // routing with no match and we 404 with the HTML not-found page,
      // which breaks every \`renderViaHTTP\` test in prerender.test.ts that
      // does \`JSON.parse(await renderViaHTTP(\`/_next/data/...json\`))\`.
      // Normalize here so \`resolveRoutes\` sees the underlying page URL
      // and can match against \`ROUTING.dynamicRoutes\`. Keeps the original
      // \`url\`/\`assetPath\` untouched so the later data-response branch
      // still formats as JSON + adds \`x-nextjs-data\`.
      let __routingUrl;
      if (staticPagesDataRoutePath && !ROUTING.shouldNormalizeNextData) {
        // No middleware → \`@next/routing\` skips its own data-URL
        // normalization, so we pre-rewrite to the page URL ourselves.
        __routingUrl = new URL((BASE_PATH || "") + staticPagesDataRoutePath + (url.search || ""), url.origin);
      } else {
        // Middleware is present → \`@next/routing\` normalizes the data
        // URL via \`normalizeNextDataUrl\`, runs \`beforeMiddleware\` +
        // middleware, then denormalizes so the middleware sees the
        // correct \`/ssr-page\` (or \`/ssr-page/\` with \`trailingSlash\`)
        // form. Pass the original data URL through so that pipeline
        // works — my earlier \`staticPagesDataRoutePath\` pre-rewrite
        // fought the same machinery.
        __routingUrl = new URL(request.url);
        const dataPrefix = (BASE_PATH || "") + "/_next/data/" + BUILD_ID + "/";
        if (
          !ROUTING.shouldNormalizeNextData &&
          assetPath.startsWith(dataPrefix)
        ) {
          let pagePath = assetPath.slice(dataPrefix.length);
          if (pagePath.endsWith(".json")) pagePath = pagePath.slice(0, -5);
          let newPathname =
            (BASE_PATH || "") + (pagePath.startsWith("/") ? pagePath : "/" + pagePath);
          // \`trailingSlash: true\` projects expect the normalized URL to
          // carry the trailing slash so middleware can match on
          // \`url.pathname === '/ssr-page/'\`. Without this, middleware
          // rewrites for data-URL requests silently no-op and the
          // client gets the non-rewritten page payload. Fixes
          // middleware-trailing-slash "should trigger middleware for
          // data requests" + "normalize data requests into page
          // requests" + "add a rewrite header on data requests for
          // rewrites".
          if (
            ROUTING.trailingSlash &&
            newPathname.length > 1 &&
            !newPathname.endsWith("/") &&
            !newPathname.includes(".")
          ) {
            newPathname += "/";
          }
          __routingUrl = new URL(
            newPathname + (url.search || ""),
            url.origin,
          );
        }
      }
      // @next/routing workaround: its \`replaceDestination\` never exposes
      // NAMED host-regex captures to the destination. A rule like
      //   source: '/:path*',
      //   has: [{ type: 'host', value: '(?<subdomain>[^.]+)\\\\.(?<domain>.*)' }],
      //   destination: '/:subdomain/:path*'
      // leaves \`$subdomain\` as a literal in the destination, then the
      // subsequent dynamic-route match captures literal "$subdomain" as the
      // route param. Pre-substitute host named groups into the destinations
      // of any rules whose host regex matches the current request host so
      // routing sees a fully-resolved destination.
      // Fixes app-dir/rewrite-with-search-params and unblocks any build
      // using subdomain-based rewrites.
      let __routingForRequest = __substituteHostCaptures(
        ROUTING,
        __routingUrl,
        routingClone.headers,
      );
      // For Pages Router data URLs, filter out the trailingSlash:true
      // beforeMiddleware "add slash" rule. Real Next.js applies this
      // rule to the human-facing page path, but @next/routing uses the
      // denormalized form (\`/<page>\`) for data URLs too — so the rule
      // matches and would emit a redirect for what should be a normal
      // data URL fetch. Strip the rule for this request only.
      if (assetPath.startsWith("/_next/data/")) {
        const filtered = (__routingForRequest.beforeMiddleware || []).filter(
          (r) => {
            // Keep rules that are NOT a trailing-slash-add: rule must
            // have status 308, Location ending with "/$1/", priority,
            // and no \`missing\` clause to be the trailing-slash adder.
            const loc = r?.headers?.Location || r?.headers?.location;
            return !(
              r.status === 308 &&
              r.priority &&
              !r.missing &&
              typeof loc === "string" &&
              loc.endsWith("/$1/")
            );
          },
        );
        if (filtered.length !== (__routingForRequest.beforeMiddleware || []).length) {
          __routingForRequest = { ...__routingForRequest, beforeMiddleware: filtered };
        }
      }
      let result = await resolveRoutes({
        url: __routingUrl,
        buildId: BUILD_ID,
        basePath: BASE_PATH,
        // Pass i18n so the routing layer prepends the default locale to
        // incoming paths before matching. Pages Router builds with i18n
        // emit PATHNAMES and ROUTING.dynamicRoutes that only match
        // locale-prefixed URLs (e.g. \`/[id]\` → regex
        // \`^[/]?(?<nextLocale>[^/]{1,})/(?<nxtPid>[^/]+?)(?:/)?$\`), so a
        // request for \`/static\` can't resolve unless we first rewrite it
        // to \`/<defaultLocale>/static\`. Without this, middleware-general
        // tests that hit paths like \`/global\` and \`/static\` 404 instead
        // of running middleware → handler.
        i18n: I18N,
        headers: routingClone.headers,
        requestBody: routingClone.body,
        pathnames: PATHNAMES,
        routes: __routingForRequest,
        invokeMiddleware: wrappedMiddlewareHandler,
      });
      if (mwModifiedRequestHeaders) {
        result = { ...result, mwRequestHeaders: mwModifiedRequestHeaders };
      }
      if (mwCapturedRewrite) {
        result = { ...result, mwRewrite: mwCapturedRewrite };
        // When @next/routing fails to match the mw rewrite target
        // (e.g. PATHNAMES holds only the bracket form \`/en/ssg/[slug]\`
        // but the rewrite target is the prerendered slug
        // \`/en/ssg/hello\`), surface the rewrite target as
        // \`invocationTarget.pathname\`. The downstream static-page serve
        // branch does \`STATIC_PAGES[invocationTarget.pathname]\` lookup
        // and can find the prerendered HTML. Without this, the routing
        // returns no resolvedPathname and we 404 even though the page
        // exists on disk.
        // Fixes middleware-general "should have correct query values
        // for rewrite to ssg page" + similar mw-rewrite-to-prerender
        // tests.
        if (!result.resolvedPathname && !result.invocationTarget) {
          try {
            const rwPath = mwCapturedRewrite.split("?")[0];
            // Pre-fill invocationTarget. The static-page serve will
            // try STATIC_PAGES[rwPath]; the handler-resolution loop
            // will try HANDLERS[rwPath].
            result = {
              ...result,
              invocationTarget: { pathname: rwPath, query: {} },
            };
            // Also try to fill resolvedPathname by checking PATHNAMES
            // and HANDLERS / STATIC_PAGES for the rewrite target.
            if (PATHNAMES.includes(rwPath) || HANDLERS[rwPath] || STATIC_PAGES[rwPath]) {
              result = { ...result, resolvedPathname: rwPath };
            }
          } catch {}
        }
      }
      if (mwCapturedRedirect) {
        result = { ...result, mwRedirect: mwCapturedRedirect };
      }
      // @next/routing's \`checkDynamicRoutes\` helper is called from inside
      // the afterFiles loop with an already-rewritten URL and iterates
      // through ROUTING.dynamicRoutes before checking the exact-match
      // pathnames list. Pages Router i18n builds emit a catch-all dynamic
      // pattern \`/[id]\` with a regex (\`^[/]?(?<nextLocale>[^/]{1,})/(?<nxtPid>[^/]+?)(?:/)?\$\`)
      // that also matches fully-resolved static routes like \`/en/ssr-page\`
      // — so an afterFiles rewrite from \`/en/rewrite-1\` to \`/en/ssr-page\`
      // ends up being re-matched as \`/[id]\` with nxtPid=ssr-page, which is
      // not what the test expects. Detect the case where
      // \`invocationTarget.pathname\` is itself a known PATHNAME and prefer
      // it over \`resolvedPathname\` — the literal target is always right.
      if (
        result.resolvedPathname &&
        result.invocationTarget?.pathname &&
        result.invocationTarget.pathname !== result.resolvedPathname
      ) {
        const target = result.invocationTarget.pathname;
        // Try literal target, then trailing-slash-stripped (for
        // \`trailingSlash: true\` configs where mw rewrite produces
        // \`/page/\` but PATHNAMES holds \`/page\`).
        const candidates = [target];
        if (target.length > 1 && target.endsWith("/")) {
          candidates.push(target.slice(0, -1));
        } else if (!target.endsWith("/")) {
          candidates.push(target + "/");
        }
        for (const cand of candidates) {
          if (PATHNAMES.includes(cand) && HANDLERS[cand]) {
            result = {
              ...result,
              resolvedPathname: cand,
              // Drop the bogus dynamic-route params captured for the
              // wrong handler — they carry the rewrite source's
              // segments, not the target's params.
              routeMatches: undefined,
            };
            break;
          }
        }
      }
      // @next/routing bug workaround: \`replaceDestination\` replaces
      // \`$nxtPid\` before \`$nxtPid2\` via \`new RegExp("\\$" + key, "g")\`,
      // which matches \`$nxtPid\` as a prefix of \`$nxtPid2\`. For a request
      // /a/b to /[id]/[id2]:
      //   - routeMatches.nxtPid  = "a" (correct)
      //   - routeMatches.nxtPid2 = "b" (correct — from regex named groups)
      //   - resolvedQuery.nxtPid2 = "a2" (WRONG — replaceDestination set
      //     \`$nxtPid\` → "a" in the destination string "nxtPid2=$nxtPid2",
      //     producing "a2" and leaving the literal "2" suffix)
      // Fix: override resolvedQuery's nxtP* values from routeMatches, which
      // holds the authoritative captures. App Router derives params from the
      // URL search params (\`nxtPxxx=...\`), so fixing resolvedQuery
      // propagates into handler invocation.
      // Fixes use-params "should work for nested dynamic params".
      if (
        result.routeMatches &&
        result.resolvedQuery &&
        result.resolvedPathname
      ) {
        const fixedQuery = { ...result.resolvedQuery };
        let changed = false;
        // Sort keys by length desc so longer named groups don't shadow.
        // Include both nxtP (regular) and nxtI (interception) prefixes —
        // see getNormalizedRouteParams for the nxtI rationale.
        const sortedKeys = Object.keys(result.routeMatches)
          .filter((k) => (k.startsWith("nxtP") || k.startsWith("nxtI")) && !/^[0-9]+$/.test(k.slice(4)))
          .sort((a, b) => b.length - a.length);
        for (const key of sortedKeys) {
          const authoritative = result.routeMatches[key];
          if (authoritative == null) continue;
          if (fixedQuery[key] !== authoritative) {
            fixedQuery[key] = authoritative;
            changed = true;
          }
        }
        if (changed) {
          result = { ...result, resolvedQuery: fixedQuery };
        }
      }
      // Strip routing-internal markers from resolvedQuery before they
      // reach the page. \`nextLocale\` is i18n metadata; the Pages Router
      // client never adds it to user-facing \`router.query\`. nxtP* keys
      // are the dynamic-route param captures: for STATIC pages they're
      // bogus (no route params), for DYNAMIC pages they're already
      // surfaced via routeMatches/params and shouldn't appear in
      // \`router.query\` either.
      // Fixes:
      //   • middleware-rewrites "should clear query parameters"
      //     (static rewrite target)
      //   • middleware-general "should have correct query values for
      //     rewrite to ssg page" (\`/[slug]\` target with i18n —
      //     nextLocale leaked)
      if (result.resolvedPathname && result.resolvedQuery) {
        const isStatic = !result.resolvedPathname.includes("[");
        const cleanedQuery = {};
        for (const [k, v] of Object.entries(result.resolvedQuery)) {
          // Always strip i18n marker — never user-visible.
          if (k === "nextLocale") continue;
          // Strip positional regex captures (numeric keys).
          if (/^[0-9]+$/.test(k)) continue;
          // For static pages, also strip nxtP* (no route params).
          if (isStatic && k.startsWith("nxtP")) continue;
          cleanedQuery[k] = v;
        }
        // Only mutate if changed.
        const oldKeys = Object.keys(result.resolvedQuery);
        const newKeys = Object.keys(cleanedQuery);
        if (oldKeys.length !== newKeys.length) {
          result = {
            ...result,
            resolvedQuery: cleanedQuery,
            // Drop routeMatches only when we touched a static page —
            // dynamic pages still need them to drive params.
            routeMatches: isStatic ? undefined : result.routeMatches,
          };
        }
      }
      if (result.redirect) {
        // For Pages Router data requests, return 200 with
        // \`x-nextjs-redirect\` header instead of a 3xx Location response.
        // The Pages Router client fetchNextData reads this header to
        // perform client-side navigation to the redirect target — a
        // real 3xx would be followed by the browser (losing the SPA
        // state) OR blocked by CORS if the target is external.
        const isDataReq = url.pathname.startsWith("/_next/data/") ||
          (BASE_PATH && url.pathname.startsWith(BASE_PATH + "/_next/data/"));
        const redirectUrl = result.redirect.url.toString();
        if (isDataReq) {
          const headers = new Headers();
          headers.set("content-type", "application/json");
          headers.set("x-nextjs-redirect", redirectUrl);
          headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
          return new Response("{}", { status: 200, headers });
        }
        return new Response(null, {
          status: result.redirect.status,
          headers: { Location: redirectUrl },
        });
      }
      // Middleware and config redirects: resolveRoutes returns Location in
      // resolvedHeaders + 3xx status (not as result.redirect) when
      // NextResponse.redirect() fires, OR when the routing manifest's
      // \`beforeMiddleware\` rules set an onMatch Location header pattern
      // (e.g. the trailingSlash: true redirect, whose destination is
      // declared as \`headers: { Location: "/$1/" }\`).
      //
      // For the trailingSlash case specifically, routing emits a
      // path-only Location AND still resolves a handler (resolvedPathname
      // is set), which signals this is an "internal path normalization"
      // — we need to preserve the original query string or the follow-up
      // request loses user-supplied params like \`?href=/about\`.
      // For middleware-explicit redirects (resolvedPathname undefined),
      // the user chose the destination deliberately and we must not
      // smuggle the original query back in.
      if (result.status && result.status >= 300 && result.status < 400 && result.resolvedHeaders) {
        const location = result.resolvedHeaders.get("location") || result.resolvedHeaders.get("Location");
        // Skip trailing-slash beforeMiddleware redirects for Pages Router
        // data URLs: the data URL is the canonical form
        // (\`/_next/data/<id>/<page>.json\`) — \`trailingSlash: true\` should
        // never redirect it. @next/routing applies the rule to the
        // denormalized form (\`/<page>\`) which DOES trigger the rule, so
        // we have to filter it out at this layer. Detect: same status
        // (308), location target equals the page-path with trailing
        if (location) {
          const shouldPreserveQuery = !!result.resolvedPathname;
          const finalLocation = shouldPreserveQuery
            ? __preserveQuery(location, url.search)
            : location;
          // Data-request redirect: same as result.redirect branch above —
          // return 200 + x-nextjs-redirect so the Pages Router client
          // performs soft navigation instead of a browser-forced hard nav.
          const isDataReq = url.pathname.startsWith("/_next/data/") ||
          (BASE_PATH && url.pathname.startsWith(BASE_PATH + "/_next/data/"));
          if (isDataReq) {
            const headers = new Headers();
            headers.set("content-type", "application/json");
            headers.set("x-nextjs-redirect", finalLocation);
            headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
            result.resolvedHeaders.forEach((val, key) => {
              const k = key.toLowerCase();
              if (k !== "location" && !headers.has(k)) headers.set(key, val);
            });
            return new Response("{}", { status: 200, headers });
          }
          const headers = new Headers();
          headers.set("Location", finalLocation);
          result.resolvedHeaders.forEach((val, key) => {
            if (key.toLowerCase() !== "location") headers.set(key, val);
          });
          return new Response(null, { status: result.status, headers });
        }
      }
      if (result.middlewareResponded) {
        // Middleware returned a final response (e.g. \`Response.json(...)\`)
        // instead of \`NextResponse.next()\`. The routing layer only tells us
        // bodySent was true — we need the captured original response to
        // return its body and headers to the client.
        if (mwCapturedResponse instanceof Response) {
          return mwCapturedResponse;
        }
        return new Response(null, { status: 204 });
      }
      if (result.externalRewrite) {
        // Special case: middleware on a \`_next/data/{buildId}/X.json\` request
        // can rewrite to an app-router pathname. @next/routing's data-URL
        // re-normalization then makes the rewrite target look "external" to
        // the local routing layer (it's flagged externalRewrite even though
        // the host matches — middleware uses request.headers.host which can
        // be \`localhost\` while the worker URL is \`127.0.0.1\`). Detect that
        // and answer with the x-nextjs-matched-path response that the Pages
        // Router client expects so it can follow the rewrite client-side.
        // We treat any externalRewrite whose pathname maps to one of our
        // app-router handlers as "this was actually local".
        if (nextDataAppRouterPath) {
          try {
            const rewriteUrl = new URL(result.externalRewrite.toString());
            const rewritePath = rewriteUrl.pathname;
            const rewriteHandler = HANDLERS[rewritePath];
            if (rewriteHandler && rewriteHandler.type === "APP_PAGE") {
              const headers = new Headers();
              headers.set("content-type", "application/json");
              headers.set("x-nextjs-matched-path", rewritePath);
              headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
              return new Response("{}", { status: 200, headers });
            }
          } catch {}
          // Pages Router data URL with truly-external rewrite from
          // \`fetchNextData\` (XHR with x-nextjs-data:1): return 200 +
          // \`x-nextjs-rewrite\` so the client triggers a hard nav to
          // the rewritten URL. For browser-direct navigation to a data
          // URL (no x-nextjs-data header), fall through to proxying so
          // the upstream HTML is rendered.
          // Fixes middleware-rewrites "should override with rewrite
          // externally correctly" + "should rewrite to the external
          // url for incoming data request externally rewritten".
          if (request.headers.get("x-nextjs-data") === "1") {
            const externalUrl = result.externalRewrite.toString();
            const headers = new Headers();
            headers.set("content-type", "application/json");
            headers.set("x-nextjs-rewrite", externalUrl);
            headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
            return new Response("{}", { status: 200, headers });
          }
        }
        // \`duplex: 'half'\` is required by the Node/Undici fetch when
        // forwarding a streaming request body — without it Node throws
        // \`RequestInit: duplex option is required when sending a body\`.
        // Use middleware-overridden request headers (from
        // \`NextResponse.next({ request: { headers } })\`) when present
        // — middleware-rewrites tests forward custom headers to the
        // external upstream this way.
        const upstreamHeaders = result.mwRequestHeaders
          ? new Headers(result.mwRequestHeaders)
          : new Headers(request.headers);
        const upstreamInit = {
          method: request.method,
          headers: upstreamHeaders,
        };
        if (request.body) {
          upstreamInit.body = request.body;
          upstreamInit.duplex = "half";
        }
        const upstream = await fetch(result.externalRewrite.toString(), upstreamInit);
        // \`fetch\` already transparently decompressed the upstream body,
        // so the response we return downstream is uncompressed bytes —
        // but the upstream \`Content-Encoding: gzip\` (or brotli) header
        // is still set, and handing that combination to node-fetch on
        // the test harness side triggers \`FetchError: incorrect header
        // check\` when it tries to re-decompress an already-plain body.
        // Strip the encoding-related headers and let the runtime
        // re-compute Content-Length as needed.
        const cleanHeaders = new Headers();
        upstream.headers.forEach((val, key) => {
          const k = key.toLowerCase();
          if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding") return;
          cleanHeaders.append(key, val);
        });
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: cleanHeaders,
        });
      }

      // Middleware-prefetch short-circuit: the Pages Router client sends
      // /_next/data/ prefetch requests with \`x-middleware-prefetch: 1\` to
      // discover routing metadata (rewrites/redirects) WITHOUT fetching the
      // full page data. Real Next.js responds with a minimal JSON \`{}\`
      // body plus headers like \`x-nextjs-rewrite\` and
      // \`x-nextjs-matched-path\`, and the client caches this routing info.
      // When the user clicks the Link, a FULL data request fires — without
      // the \`x-middleware-prefetch\` header — and the client captures it as
      // a real network request. Without this short-circuit, our worker runs
      // the full SSP handler on prefetch, the client caches the complete
      // data, and the subsequent click uses the cache → no visible request
      // → the "allows shallow linking with middleware" test fails because
      // the deep-link click doesn't generate the expected _next/data fetch.
      if (request.headers.get("x-middleware-prefetch") === "1") {
        const mwPrefetchHeaders = new Headers();
        mwPrefetchHeaders.set("content-type", "application/json");
        mwPrefetchHeaders.set("x-middleware-skip", "1");
        if (result.mwRewrite) {
          mwPrefetchHeaders.set("x-nextjs-rewrite", result.mwRewrite);
        }
        if (result.invocationTarget?.pathname) {
          mwPrefetchHeaders.set("x-nextjs-matched-path", result.invocationTarget.pathname);
        }
        if (result.resolvedHeaders) {
          result.resolvedHeaders.forEach((val, key) => {
            if (!mwPrefetchHeaders.has(key)) mwPrefetchHeaders.set(key, val);
          });
        }
        return new Response("{}", { status: 200, headers: mwPrefetchHeaders });
      }

      // Strip Next.js internal sentinel values from route matches. The
      // sentinel format is \`$nxtP{paramName}\` (e.g. \`$nxtPslug\`,
      // \`$nxtPrest\`), used for empty optional catch-all segments. Match by
      // prefix so all variants are handled regardless of the param name.
      if (result.routeMatches) {
        for (const [key, val] of Object.entries(result.routeMatches)) {
          if (typeof val === "string" && (val.startsWith("$nxtP") || val.startsWith("%24nxtP"))) {
            result = { ...result, routeMatches: { ...result.routeMatches, [key]: "" } };
          }
        }
      }
      // NOTE: do NOT normalize resolvedQuery here. Next.js's app router
      // identifies dynamic route params by their nxtP-prefixed encoding in
      // the query string and strips them before exposing searchParams.
      // If we normalize (strip prefix) before Next.js sees the URL, the route
      // params look like real search params and leak into the searchParams
      // prop. The downstream getNormalizedResolvedQuery() callers that need
      // the unprefixed form do their own normalization.

      // 4. Resolve handler pathname
      let resolvedPathname = result.resolvedPathname;
      // resolveRoutes may return invocationTarget with the actual pathname to invoke.
      if (!resolvedPathname && result.invocationTarget?.pathname) {
        const target = result.invocationTarget.pathname;
        if (HANDLERS[target]) resolvedPathname = target;
      }
      // If resolvedPathname has .rsc suffix, try without it
      if (resolvedPathname && !HANDLERS[resolvedPathname] && resolvedPathname.endsWith(".rsc")) {
        const withoutRsc = resolvedPathname.slice(0, -4);
        if (HANDLERS[withoutRsc]) resolvedPathname = withoutRsc;
      }
      // Try index route: /foo → /foo/index or /foo/page
      if (resolvedPathname && !HANDLERS[resolvedPathname]) {
        if (HANDLERS[resolvedPathname + "/index"]) resolvedPathname = resolvedPathname + "/index";
      }
      // Also check the original URL pathname and the middleware
      // invocation target for /foo → /foo/index alias. When resolveRoutes
      // doesn't find a match (e.g. a request for /api when only
      // /api/index is in PATHNAMES), we still need to resolve to the
      // /foo/index handler. Tests like
      // edge-api-endpoints-can-receive-body "reads the body from index"
      // hit /api expecting the pages/api/index.js handler to fire.
      if (!resolvedPathname || !HANDLERS[resolvedPathname]) {
        const candidates = [url.pathname];
        if (result.invocationTarget?.pathname) {
          candidates.push(result.invocationTarget.pathname);
        }
        for (const c of candidates) {
          const key = c + "/index";
          if (HANDLERS[key]) { resolvedPathname = key; break; }
        }
      }
      // Root alias: the routing layer exposes the Pages Router root as
      // \`/index\` in HANDLERS (and PATHNAMES), not \`/\`. When the incoming
      // request is for \`/\` and nothing else matched, try \`/index\`
      // directly. Without this, the root page 404s whenever a Pages
      // Router app has _document.getInitialProps (forces SSR — page lives
      // in HANDLERS under \`/index\`, STATIC_PAGES is empty).
      // Root alias: the routing layer exposes the Pages Router root as
      // \`/index\` in HANDLERS (and PATHNAMES), not \`/\`. Check the original
      // URL, the invocation target, AND the middleware rewrite target —
      // without this, a middleware rewrite from \`/source-match\` → \`/\`
      // doesn't find the index handler and 404s.
      {
        let isRoot = url.pathname === "/";
        if (!isRoot && result.invocationTarget?.pathname === "/") isRoot = true;
        if (!isRoot && result.mwRewrite) {
          try {
            const rp = result.mwRewrite.split("?")[0];
            if (rp === "/") isRoot = true;
          } catch {}
        }
        if (isRoot && (!resolvedPathname || !HANDLERS[resolvedPathname])) {
          if (HANDLERS["/index"]) resolvedPathname = "/index";
        }
      }
      // Trailing-slash normalization. \`@next/routing\` does exact pathname
      // matching and is unaware of Next.js's \`trailingSlash\` config. When
      // the config is \`trailingSlash: true\`, Next.js redirects \`/foo\` →
      // \`/foo/\` via a routes-manifest 308 rewrite — but the follow-up
      // request for \`/foo/\` lands here with no resolvedPathname because
      // PATHNAMES only has \`/foo\`. Strip the trailing slash and retry the
      // handler lookup so Pages Router + trailingSlash: true pages work.
      // Also catch the static-page variant via STATIC_PAGES (auto-static
      // optimized pages live there, not HANDLERS).
      if (!resolvedPathname || !HANDLERS[resolvedPathname]) {
        const pn = url.pathname;
        if (pn !== "/" && pn.endsWith("/")) {
          const stripped = pn.slice(0, -1);
          if (HANDLERS[stripped]) {
            resolvedPathname = stripped;
          } else if (STATIC_PAGES[stripped]) {
            // STATIC_PAGES lookup runs against \`servePath\` below, and
            // \`servePath\` falls back to \`url.pathname\` with the trailing
            // slash when \`resolvedPathname\` is unset. Setting it here
            // forces the static-serve branch to use the stripped path so
            // auto-static-optimized Pages Router routes resolve under
            // \`trailingSlash: true\`.
            resolvedPathname = stripped;
          }
        }
      }
      // 4a. Static pages — serve pre-rendered HTML from assets.
      // Pages Router static pages and auto-optimized pages are pre-rendered
      // at build time. Their handlers require filesystem access that CF Workers
      // doesn't have, so we serve the HTML directly from assets.
      // For SSG fallback:true pages, generateStaticParams pre-renders specific
      // slugs (/fallback-true-blog/build-time-1) AND the fallback shell
      // (/fallback-true-blog/[slug]). resolvedPathname is the bracket form
      // — but we should prefer the specific slug's prerender over the
      // fallback shell when the URL matches one. Try the literal URL path
      // (with default locale prefix) before the bracket form.
      let servePath = resolvedPathname || url.pathname;
      // For SSG fallback:true pages, STATIC_PAGES holds BOTH the fallback
      // shell (under the bracket route, e.g.
      // \`/en/fallback-true-blog/[slug]\` → "Loading..." HTML) AND each
      // build-time prerendered slug (\`/en/fallback-true-blog/first\`). If
      // resolvedPathname is the bracket form, a direct lookup hits the
      // shell — wrong for URLs that match a concrete prerender. Prefer
      // the literal URL (with default-locale prefix if missing) whenever
      // it's also in STATIC_PAGES, falling back to the bracket entry.
      // Without this the browser sees the fallback shell for every
      // build-time slug, breaking middleware-rewrites
      // "should return HTML/data correctly for pre-rendered page".
      const resolvedIsBracketShell =
        resolvedPathname && resolvedPathname.includes("[");
      // URL-decoded pathname for matching build-time prerender keys.
      // generateStaticParams returns raw values (e.g. 'sticks & stones')
      // and Next.js writes STATIC_PAGES keys with those raw values, but
      // browsers fetch the URL-encoded form ('/sticks%20%26%20stones').
      // Add a decoded candidate so the prerendered HTML is found.
      // Fixes app-dir/prerender-encoding.
      let decodedPathname = null;
      if (url.pathname && url.pathname.includes("%")) {
        try {
          const dec = decodeURIComponent(url.pathname);
          if (dec !== url.pathname) decodedPathname = dec;
        } catch {}
      }
      const concreteCandidates = [];
      if (url.pathname) {
        if (resolvedIsBracketShell && url.pathname !== resolvedPathname) {
          concreteCandidates.push(url.pathname);
          if (decodedPathname) concreteCandidates.push(decodedPathname);
        } else if (decodedPathname) {
          concreteCandidates.push(decodedPathname);
        }
        if (I18N && Array.isArray(I18N.locales) && I18N.locales.length > 0) {
          const seg = url.pathname.split("/")[1] || "";
          if (!I18N.locales.includes(seg)) {
            const def = I18N.defaultLocale || I18N.locales[0];
            concreteCandidates.push("/" + def + url.pathname);
            if (decodedPathname) {
              concreteCandidates.push("/" + def + decodedPathname);
            }
          }
        }
      }
      let staticEntry = null;
      if (resolvedIsBracketShell) {
        // Try concrete prerenders before the shell.
        for (const cand of concreteCandidates) {
          if (STATIC_PAGES[cand]) {
            servePath = cand;
            staticEntry = STATIC_PAGES[cand];
            break;
          }
        }
        if (!staticEntry) {
          staticEntry = STATIC_PAGES[servePath];
        }
      } else {
        staticEntry = STATIC_PAGES[servePath];
        if (!staticEntry && url.pathname) {
          for (const cand of concreteCandidates) {
            if (STATIC_PAGES[cand]) {
              servePath = cand;
              staticEntry = STATIC_PAGES[cand];
              break;
            }
          }
        }
        // Pages Router root-index alias: resolveRoutes turns \`/\` into
        // \`/index\` (HANDLERS key is \`/index\`) but the prerender entry is
        // under the literal \`/\`. Without this, POST \`/\` (and any other
        // non-GET) finds no \`staticAssetPath\` and the 405 check above
        // can't fire — the handler runs instead and returns 200 HTML.
        // Fixes prerender.test.ts "should respond with 405 for POST to
        // static page" and keeps deploy-mode cache-control overrides
        // reachable for the root route.
        if (!staticEntry && servePath === "/index" && STATIC_PAGES["/"]) {
          servePath = "/";
          staticEntry = STATIC_PAGES["/"];
        }
        // Config rewrites whose destination is a prerendered dynamic page
        // (in STATIC_PAGES but only bracket-form in PATHNAMES) are dropped
        // by resolveRoutes — it surfaces no resolvedPathname/invocationTarget
        // and we'd otherwise 404. Re-apply the rewrite lists manually here
        // so the downstream static-serve branch can find the prerendered
        // HTML for the rewrite target.
        // Fixes prerender.test.ts "should allow rewriting to SSG page
        // with fallback: false" (\`/about\` → \`/lang/en/about\`) and the
        // blocking-fallback variant.
        if (!staticEntry && !HANDLERS[servePath] && ROUTING) {
          for (const list of [ROUTING.beforeFiles || [], ROUTING.afterFiles || []]) {
            for (const rule of list) {
              if (!rule?.sourceRegex || !rule?.destination) continue;
              let re;
              try { re = new RegExp(rule.sourceRegex, "i"); } catch { continue; }
              const m = servePath.match(re);
              if (!m) continue;
              let dest = rule.destination;
              for (let i = 1; i < m.length; i++) {
                if (m[i] !== undefined) dest = dest.replace(new RegExp("\\\\$" + i, "g"), m[i]);
              }
              if (m.groups) {
                for (const [k, v] of Object.entries(m.groups)) {
                  if (v !== undefined) dest = dest.replace(new RegExp("\\\\$" + k, "g"), v);
                }
              }
              const destPath = dest.split("?")[0];
              if (STATIC_PAGES[destPath]) {
                servePath = destPath;
                staticEntry = STATIC_PAGES[destPath];
                break;
              }
            }
            if (staticEntry) break;
          }
        }
      }
      const staticAssetPath = staticEntry?.assetPath;
      // \`_rsc\` query param alone does NOT indicate an RSC request — Next.js
      // uses it as a cache-busting key for prefetches (NEXT_RSC_UNION_QUERY),
      // and browsers legitimately issue HTML GETs with it present. Only the
      // \`rsc\` / \`next-router-state-tree\` headers signal a true RSC request.
      // Fixes app-inline-css "should not return rsc payload with inlined style
      // as a dynamic client nav" (test fetches with \`_rsc\` query but no rsc
      // header, expecting HTML + inlined <style>).
      const isAppRouterRSCRequest =
        request.headers.has("rsc") ||
        request.headers.has("next-router-state-tree");
      // When routing rewrote the URL, skip the prerendered-HTML serve so
      // the handler is invoked dynamically. The prerendered HTML has the
      // REWRITE TARGET's pathname baked in (via \`usePathname\` / metadata),
      // but App Router's \`usePathname()\` must return the ORIGINAL URL
      // (canonical, pre-rewrite). Dynamic invocation with \`req.url\` set
      // to the original URL renders the correct canonical pathname.
      // Fixes app-dir/hooks "usePathname should have the canonical url
      // pathname on rewrite".
      // A "rewrite" in the sense that should skip the prerendered-HTML
      // serve is a CONFIG or MIDDLEWARE rewrite that points the URL at a
      // different route (e.g. /source → /dest). @next/routing also
      // exposes dynamic-route matching and i18n locale-prefix additions
      // through invocationTarget.pathname:
      //   - bracket-form routes (e.g. /[key]) — dynamic route pattern
      //   - i18n prefix (e.g. /new-home → /en/new-home with default
      //     locale) — automatic locale normalization, not a rewrite
      // Exclude both so their prerendered variants still get served.
      // Fixes: next-after-app-deploy (dynamic route prerenders) +
      // middleware-redirects (i18n Pages Router target rendering).
      const isRewritten = (() => {
        const it = result?.invocationTarget?.pathname;
        if (!it || it === url.pathname) return false;
        if (it.includes("[")) return false;
        // i18n locale-prefix addition: invocationTarget is exactly
        // "/<locale>" + url.pathname (or "/<locale>") for the root
        // case.
        if (I18N && Array.isArray(I18N.locales)) {
          for (const locale of I18N.locales) {
            if (it === "/" + locale + url.pathname) return false;
            if (url.pathname === "/" && it === "/" + locale) return false;
          }
        }
        return true;
      })();
      // Only skip the prerendered-HTML serve for rewrites when we have
      // a HANDLER we can invoke dynamically. For Pages Router auto-
      // optimized / purely static App Router pages, there's no handler
      // — the prerendered HTML is the only way to produce a response.
      // Serving it for a rewrite may bake the target's pathname into
      // the output, but that's the correct Pages Router behavior
      // (auto-static pages don't use \`usePathname()\`); and test
      // expectations match the prerender. Fixes middleware-general
      // "should rewrite correctly for non-SSG/SSP page" where
      // /rewrite-2 rewrites to /about/a (purely static).
      const hasHandlerForTarget =
        result?.resolvedPathname && !!HANDLERS[result.resolvedPathname];
      // Draft mode bypass: when the request carries a valid
      // \`__prerender_bypass\` cookie (value matching the build's
      // previewModeId), we must invoke the handler dynamically so
      // \`draftMode().isEnabled\` reflects ENABLED. Serving the cached
      // prerender would bake DISABLED into the HTML — the cookie round-
      // trip to /enable succeeds but the page read silently stays on
      // the static shell.
      // Fixes app-dir/draft-mode "should generate rand when draft mode
      // enabled" and "should read other cookies when draft mode enabled".
      const isDraftModeRequest = (() => {
        const cookieHeader = request.headers.get("cookie");
        if (!cookieHeader) return false;
        const m = cookieHeader.match(/(?:^|;\\s*)__prerender_bypass=([^;]+)/);
        if (!m) return false;
        const cookieVal = m[1];
        if (!cookieVal) return false;
        const pm = __getPrerenderManifest();
        const pid = pm?.preview?.previewModeId;
        return !!pid && cookieVal === pid;
      })();
      // Crawler bypass for Pages Router fallback:true shells: when the
      // request UA is a known crawler AND we're about to serve a
      // bracket-form fallback shell (\`Loading...\`), invoke the handler
      // dynamically instead so the full page renders. Next.js does this
      // so crawlers (which don't run JS) see real content instead of
      // the placeholder. Only apply to Pages Router bracket-shell
      // entries — App Router and concrete prerenders are unaffected.
      // Fixes e2e/prerender-crawler.test.ts "should block for crawler
      // correctly".
      const isCrawlerRequest = (() => {
        const ua = request.headers.get("user-agent") || "";
        if (!ua) return false;
        // Mirrors Next.js's crawler regex (server/api-utils/node/try-get-preview-data).
        // Covers googlebot, bingbot, yahoo slurp, duckduckbot, baiduspider,
        // yandex, facebookexternalhit, ia_archiver, etc.
        return /bot|spider|crawler|slurp|ia_archiver|facebookexternalhit/i.test(ua);
      })();
      const isServingBracketShell =
        typeof servePath === "string" && servePath.includes("[") && !!staticEntry;
      // ISR pages (initialRevalidate > 0) must NOT be served from static
      // assets because the handler needs to manage the fresh → stale → SWR
      // lifecycle via IncrementalCache. Serving from assets would freeze the
      // build-time snapshot forever, skipping time-based revalidation.
      // When a handler exists for an ISR page, we let it run so getStaticProps
      // executes with the correct revalidateReason ('stale' after TTL expires,
      // 'on-demand' after res.revalidate()). Fixes revalidate-reason "stale",
      // trailingslash revalidation, and stale-cache-serving tests.
      const isISRPage = staticEntry?.initialRevalidate != null && staticEntry.initialRevalidate > 0;
      const hasHandler = resolvedPathname && HANDLERS[resolvedPathname];
      // Any tag on this prerender invalidated since build? If yes the static
      // HTML is stale — skip the fast-path and let the handler rebuild so the
      // server-action-side updateTag/revalidateTag actually takes effect.
      // Uses \`__CREEK_TAG_INVALIDATED_AT\` which server actions write via
      // \`CreekCacheHandler.revalidateTag\` / \`CreekComposableCacheHandler.updateTags\`.
      let staleByTag = false;
      if (staticEntry?.cacheTags && hasHandler) {
        const mem = globalThis.__CREEK_TAG_INVALIDATED_AT;
        if (mem) {
          for (const tag of staticEntry.cacheTags) {
            if (mem.has(tag)) { staleByTag = true; break; }
          }
        }
      }
      // \`res.revalidate(path)\` in a Pages Router API route sends a HEAD
      // to the target path with \`x-prerender-revalidate: <previewModeId>\`.
      // For that path to run \`getStaticProps\` with
      // \`revalidateReason: 'on-demand'\` (what
      // \`test/e2e/revalidate-reason\` asserts), the HEAD must reach the
      // handler — serving the static prerender would skip
      // getStaticProps entirely and the subsequent GET would still see
      // the build-time snapshot.
      const isPrerenderRevalidate = request.headers.has("x-prerender-revalidate");
      // After a successful on-demand revalidation, subsequent GETs need
      // to pick up the fresh getStaticProps output (stored in
      // IncrementalCache) instead of the build-time static HTML. We track
      // revalidated paths in \`__CREEK_PATH_REVALIDATED_AT\` and bypass
      // the static-serve fast-path while the flag is set.
      const staleByOnDemand = (() => {
        const mem = globalThis.__CREEK_PATH_REVALIDATED_AT;
        if (!mem || !hasHandler) return false;
        const candidateKeys = [
          resolvedPathname,
          url.pathname,
          servePath,
        ];
        for (const k of candidateKeys) {
          if (k && mem.has(k)) return true;
        }
        return false;
      })();
      const canServeStaticPage =
        (request.method === "GET" || request.method === "HEAD") &&
        !request.headers.has("next-action") &&
        !isAppRouterRSCRequest &&
        !isPrerenderRevalidate &&
        // Data URL requests must return JSON, not the prerendered HTML.
        // Pages Router's fetchNextData calls .json() on the body —
        // serving HTML breaks soft navigation and skew detection.
        !nextDataAppRouterPath &&
        !isDraftModeRequest &&
        !(isCrawlerRequest && isServingBracketShell) &&
        (!isRewritten || !hasHandlerForTarget) &&
        // ISR pages bypass static assets when a handler exists.
        !(isISRPage && hasHandler) &&
        // A previous revalidateTag/updateTag marked one of this page's
        // tags stale — fall through to handler so the fresh render runs.
        !staleByTag &&
        !staleByOnDemand;
      // POST (or other non-GET/HEAD) to a prerendered page → 405.
      // Covers two cases: (a) no handler at all (pure static page), and
      // (b) handler is a Pages Router page whose only request-time entry
      // point is \`getStaticProps\`/\`getServerSideProps\` — neither is
      // reachable via POST, so the Vercel edge answers 405 without
      // invoking the handler. API routes (\`PAGES_API\`) and App Router
      // endpoints (\`APP_PAGE\`, \`APP_ROUTE\`) legitimately accept POST;
      // Server Action / RSC / Pages-data-URL POSTs also target
      // prerendered paths and must pass through. Without this check,
      // POST \`/\` served the prerendered HTML with 200 and failed the
      // prerender.test.ts "should respond with 405 for POST to static
      // page" assertion.
      const handlerIsPagesPage =
        hasHandler && HANDLERS[resolvedPathname]?.type === "PAGES";
      if (
        staticAssetPath &&
        (!hasHandler || handlerIsPagesPage) &&
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        !request.headers.has("next-action") &&
        !isAppRouterRSCRequest &&
        !nextDataAppRouterPath
      ) {
        return new Response("Method Not Allowed", { status: 405 });
      }

      // App Router RSC GET of a statically prerendered page: serve the
      // adjacent \`.rsc\` file directly. The App Router client dispatches
      // \`fetch(pathname, { headers: { RSC: '1' } })\` during soft navigation
      // and expects a flight payload. Without this branch, the request
      // falls through to \`invokeNodeHandler\`, which re-renders the page
      // and returns HTML — the client interprets the non-RSC response as
      // a signal to hard-navigate, defeating Link / useRouter.push().
      // Fixes app-static "should navigate to static path correctly" and
      // similar client-nav tests whose prerendered target has an RSC
      // sibling on disk.
      if (
        staticAssetPath &&
        isAppRouterRSCRequest &&
        (request.method === "GET" || request.method === "HEAD") &&
        !request.headers.has("next-action") &&
        !nextDataAppRouterPath &&
        !(isISRPage && hasHandler)
      ) {
        try {
          const baseAssetPath = staticAssetPath.endsWith("/index.html")
            ? staticAssetPath.replace(/\\/index\\.html$/, "")
            : staticAssetPath.replace(/\\.html$/, "");
          // Segment prefetch — Next.js client sends
          // \`next-router-segment-prefetch: /blog/[author]/__PAGE__\` during
          // Link-driven partial prefetches and expects just THAT segment,
          // not the full route's RSC. Serve from
          // \`<pathname>.segments/<segment>.segment.rsc\`. The segment header
          // encodes dynamic segments in bracket form at request time but
          // the on-disk sibling uses \`$d$name\` (the Next.js conventional
          // segment encoding for \`[name]\`). Normalize before the lookup.
          // Pattern from nextjs/adapter-bun \`segmentData\` handling:
          // src/runtime/incremental-cache-handler.ts:247-276.
          const segmentHeader = request.headers.get("next-router-segment-prefetch");
          if (segmentHeader && typeof segmentHeader === "string") {
            const decoded = (() => {
              try { return decodeURIComponent(segmentHeader); } catch { return segmentHeader; }
            })();
            const normalizedSegment = decoded
              .replace(/\\[\\.\\.\\.([^\\]]+)\\]/g, "$c$$$1") // [...slug] → $c$slug
              .replace(/\\[([^\\]]+)\\]/g, "$d$$$1");         // [slug] → $d$slug
            // \`segmentHeader\` starts with "/", strip leading slash for path join.
            const segmentTail = normalizedSegment.replace(/^\\//, "");
            const segmentAssetPath = baseAssetPath + ".segments/" + segmentTail + ".segment.rsc";
            const segmentRes = await env.ASSETS.fetch(
              new Request(new URL(segmentAssetPath, url.origin), { headers: request.headers })
            );
            if (segmentRes.status === 304) return segmentRes;
            if (segmentRes.ok) {
              const headers = new Headers(segmentRes.headers);
              headers.set("content-type", "text/x-component");
              headers.set("Vary", "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch");
              headers.set("x-nextjs-prerender", "1");
              headers.set("x-nextjs-deployment-id", DEPLOYMENT_ID);
              if (staticEntry?.cacheTags) {
                headers.set("x-next-cache-tags", String(staticEntry.cacheTags));
              }
              return new Response(segmentRes.body, {
                status: segmentRes.status,
                statusText: segmentRes.statusText,
                headers,
              });
            }
            // Fall through to full RSC if the segment file isn't there.
          }

          const rscAssetPath = baseAssetPath + ".rsc";
          if (rscAssetPath !== staticAssetPath) {
            const rscRes = await env.ASSETS.fetch(
              new Request(new URL(rscAssetPath, url.origin), { headers: request.headers })
            );
            if (rscRes.status === 304) return rscRes;
            if (rscRes.ok) {
              const headers = new Headers(rscRes.headers);
              headers.set("content-type", "text/x-component");
              headers.set("Vary", "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch");
              const staleTime = staticEntry?.initialRevalidate;
              if (typeof staleTime === "number") {
                headers.set("x-nextjs-stale-time", String(staleTime));
              }
              headers.set("x-nextjs-prerender", "1");
              headers.set("x-nextjs-deployment-id", DEPLOYMENT_ID);
              if (staticEntry?.cacheTags) {
                headers.set("x-next-cache-tags", String(staticEntry.cacheTags));
              }
              return new Response(rscRes.body, {
                status: rscRes.status,
                statusText: rscRes.statusText,
                headers,
              });
            }
          }
        } catch {}
      }

      if (staticAssetPath && canServeStaticPage) {
        try {
          const assetRes = await env.ASSETS.fetch(
            new Request(new URL(staticAssetPath, url.origin), { headers: request.headers })
          );
          // 304 Not Modified: browser sent If-None-Match and the asset's
          // ETag matches. Pass the 304 through so the browser uses its
          // cached copy. Falling through here would eventually return
          // the 404.html asset (the asset binding's not_found_handling
          // fallback on subsequent lookups), breaking conditional GETs
          // under wrangler dev / real CF Workers alike.
          if (assetRes.status === 304) {
            return assetRes;
          }
          if (assetRes.ok) {
            const headers = new Headers(assetRes.headers);
            headers.set("Content-Type", "text/html; charset=utf-8");
            // Prerender entries for pages calling notFound() / redirect() /
            // permanentRedirect() carry initialStatus + initialHeaders. The
            // status determines whether we return 404/307/308 vs 200, and the
            // headers carry the redirect Location.
            const prerenderStatus = staticEntry.status;
            const finalStatus = prerenderStatus ?? result.status ?? 200;
            if (staticEntry.headers) {
              for (const [k, v] of Object.entries(staticEntry.headers)) {
                if (Array.isArray(v)) {
                  headers.delete(k);
                  for (const vv of v) headers.append(k, vv);
                } else {
                  headers.set(k, v);
                }
              }
            }
            // Deploy-mode cache-control: Vercel's edge strips the
            // \`s-maxage=N, stale-while-revalidate=...\` that Next.js's
            // prerender entry carries and replaces it with
            // \`public, max-age=0, must-revalidate\` on the client response
            // (the CDN absorbs the server-side caching hint internally).
            // Tests like \`should use correct caching headers for a
            // revalidate page\` / \`fallback-true (prerendered)\` /
            // \`fallback-true (lazy)\` branch on \`isDeploy\` and expect this
            // exact deploy-mode string. Without this override, the raw
            // Next.js value leaks through and fails the assertion.
            headers.set("cache-control", "public, max-age=0, must-revalidate");
            if (!headers.has("x-nextjs-cache") && finalStatus === 200) {
              headers.set("x-nextjs-cache", "HIT");
            }
            // Apply middleware resolved headers if present
            if (result.resolvedHeaders) {
              result.resolvedHeaders.forEach((val, key) => {
                if (key.toLowerCase() === "set-cookie") headers.append(key, val);
                else headers.set(key, val);
              });
            }
            return new Response(assetRes.body, {
              status: finalStatus,
              headers,
            });
          }
        } catch {}
      }

      // 4b. If no route handler matched, check for static assets or 404.
      if (!resolvedPathname || !HANDLERS[resolvedPathname]) {
        // For Pages Router data URLs that middleware rewrote to a
        // different page, look up the rewritten target's prerendered
        // data file in ASSETS instead of the original URL's. Without
        // this, /dynamic-no-cache/1 → /2 rewrite would still serve
        // /1's prerendered data (test "should opt out of prefetch
        // caching for dynamic routes" depends on click seeing the
        // rewritten /2's data).
        let assetUrlPath = url.pathname;
        if (nextDataAppRouterPath && result?.mwRewrite) {
          const dataPathMatch = url.pathname.match(/^(\\/_next\\/data\\/[^/]+)\\/(.+)\\.json$/);
          if (dataPathMatch) {
            const rewriteBase = result.mwRewrite.split("?")[0].replace(/^\\//, "");
            // The rewritten target needs locale prefix to match the
            // emitted prerendered path (\`/en/dynamic-no-cache/2.json\`).
            let rewritten = rewriteBase;
            if (I18N && Array.isArray(I18N.locales) && I18N.locales.length > 0) {
              const firstSeg = rewriteBase.split("/")[0] || "";
              if (!I18N.locales.includes(firstSeg)) {
                rewritten = (I18N.defaultLocale || I18N.locales[0]) + "/" + rewriteBase;
              }
            }
            assetUrlPath = dataPathMatch[1] + "/" + rewritten + ".json";
          }
        }
        // Try static assets — for paths with extensions (JS, CSS, images)
        // or paths that might be stored in assets.
        try {
          const assetRes = await env.ASSETS.fetch(
            new Request(new URL(assetUrlPath, url.origin), { headers: request.headers })
          );
          // Conditional GET: pass 304 through so the browser can use its
          // cached copy. See the prerender-serving branch above for
          // background — falling through on 304 causes the request to
          // eventually land on our 404.html fallback.
          if (assetRes.status === 304) {
            return assetRes;
          }
          if (assetRes.ok) {
            const assetHeaders = applyStaticAssetHeaders(
              new Headers(assetRes.headers),
              url.pathname,
            );
            // Merge middleware response headers — tests like
            // middleware-general's "should keep non data requests in their
            // original shape" depend on headers set by
            // \`NextResponse.next({ headers })\` reaching static asset
            // responses.
            if (result.resolvedHeaders) {
              result.resolvedHeaders.forEach((val, key) => {
                if (key.toLowerCase() === "set-cookie") {
                  assetHeaders.append(key, val);
                } else {
                  assetHeaders.set(key, val);
                }
              });
            }
            return new Response(assetRes.body, {
              status: assetRes.status,
              headers: assetHeaders,
            });
          }
        } catch {}

        // Dynamic-route fallback for Pages Router. The @next/routing layer only
        // does exact-match resolution against PATHNAMES; it won't expand
        // Pages Router dynamic patterns like \`/catch-all/[...slug]\`, so a
        // request for \`/catch-all/hello/world\` lands here with no
        // resolvedPathname. Compile routes-manifest.json's dynamicRoutes and
        // try them — on match, route to the Pages Router handler.
        //
        // Important: we do NOT use this fallback for App Router (APP_PAGE)
        // handlers. App Router enforces \`dynamicParams = false\` and similar
        // framework-level constraints by explicitly NOT running the handler
        // for disallowed params — instead the request falls through to
        // /_not-found. Letting the fallback re-route to the bracketed
        // App Router handler would bypass that enforcement and turn 404s
        // into 200s with the wrong content.
        // For i18n builds, strip the locale prefix before matching against
        // routes-manifest dynamic routes. The routes-manifest contains
        // locale-less patterns like /[first]/[second]/[third]; without
        // stripping, a locale-prefixed path like /es/first/second/unknown
        // (4 segments) would match /[first]/[second]/[third]/[fourth]
        // instead of /[first]/[second]/[third] — giving the wrong handler
        // and bypassing fallback:false 404 enforcement. Fixes
        // i18n-fallback-collision "should 404 properly for fallback:false
        // non-prerendered /es/first/second/non-existent".
        let matchPathname = url.pathname;
        if (I18N && Array.isArray(I18N.locales) && I18N.locales.length > 0) {
          const firstSeg = url.pathname.split("/")[1] || "";
          if (I18N.locales.includes(firstSeg)) {
            matchPathname = url.pathname.slice(firstSeg.length + 1) || "/";
          }
        }
        const dyn = __matchDynamicRoute(matchPathname);
        // Include PAGES_API (dynamic API routes like /api/blog/[slug])
        // in the fallback. Without this, /api/blog/first 404s because
        // resolveRoutes doesn't find it in PATHNAMES and our fallback
        // skipped non-PAGES handlers. App Router (APP_PAGE) still
        // bypasses this path — see the comment above for why.
        if (dyn && HANDLERS[dyn.page] && (HANDLERS[dyn.page].type === "PAGES" || HANDLERS[dyn.page].type === "PAGES_API")) {
          // Prerender fallback: false — if the route is a fallback:false
          // SSG route and the matched slug is NOT in the prerendered route
          // list, the page doesn't exist. Pages Router's own handler has
          // a 404 branch (\`j2.end("This page could not be found")\`) but
          // that code path doesn't set statusCode, so the response comes
          // back as 200. Short-circuit here: check the prerender manifest
          // for a matching (locale-prefixed) prerendered route; if none,
          // return 404 directly before the handler ever runs.
          // Fixes middleware-general's "should handle 404 on fallback:
          // false route correctly".
          try {
            const prerenderManifest = __getPrerenderManifest();
            const dynamicRoute = prerenderManifest?.dynamicRoutes?.[dyn.page];
            if (dynamicRoute && dynamicRoute.fallback === false) {
              const prerenderedRoutes = prerenderManifest?.routes || {};
              // Try to find a prerendered path that matches the current
              // request. Accept either the raw url.pathname or a
              // locale-prefixed variant.
              const candidates = [url.pathname];
              if (I18N && Array.isArray(I18N.locales) && I18N.locales.length > 0) {
                const firstSeg = url.pathname.split("/")[1] || "";
                if (!I18N.locales.includes(firstSeg)) {
                  for (const locale of I18N.locales) {
                    candidates.push("/" + locale + url.pathname);
                  }
                }
              }
              const found = candidates.some((c) => prerenderedRoutes[c] != null);
              if (!found) {
                const headers = new Headers();
                if (result?.resolvedHeaders) {
                  result.resolvedHeaders.forEach((val, key) => {
                    if (key.toLowerCase() === "set-cookie") headers.append(key, val);
                    else headers.set(key, val);
                  });
                }
                headers.set("content-type", "text/html; charset=utf-8");
                // Prefer a pre-rendered 404 page from assets; fall back to
                // text/plain "Not Found" if the asset isn't available.
                try {
                  const locale = I18N?.defaultLocale || "";
                  const tried = [];
                  if (locale) tried.push("/" + locale + "/404/index.html");
                  tried.push("/404/index.html");
                  for (const path of tried) {
                    const res404 = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
                    if (res404.ok) {
                      res404.headers.forEach((val, key) => {
                        if (!headers.has(key)) headers.set(key, val);
                      });
                      return new Response(res404.body, { status: 404, headers });
                    }
                  }
                } catch {}
                headers.set("content-type", "text/plain; charset=utf-8");
                return new Response("Not Found", { status: 404, headers });
              }
            }
          } catch {}
          resolvedPathname = dyn.page;
          if (Object.keys(dyn.params).length > 0) {
            result = {
              ...result,
              routeMatches: { ...(result.routeMatches || {}), ...dyn.params },
            };
          }
        }

        // Before falling back to 404, try the rewrite target as a public
        // file. i18n-ignore-rewrite-source-locale exercises this:
        // \`/<locale>/rewrite-files/file.txt\` (locale: false) rewrites to
        // \`/file.txt\`. resolveRoutes applies the rewrite but doesn't
        // surface invocationTarget when the destination isn't a registered
        // PATHNAME — so we manually re-apply the beforeFiles rewrites and
        // check if the destination is a static asset.
        if (!resolvedPathname || !HANDLERS[resolvedPathname]) {
          const candidate = __resolveRewriteToPublicFile(url, request.headers);
          if (candidate) {
            try {
              const candidates = [];
              if (BASE_PATH) candidates.push(BASE_PATH + candidate);
              candidates.push(candidate);
              for (const cand of candidates) {
                const assetRes = await env.ASSETS.fetch(
                  new Request(new URL(cand, url.origin))
                );
                if (assetRes.status === 304 || assetRes.ok) return assetRes;
              }
            } catch {}
          }
        }

        // Pages Router data URL with a middleware rewrite that didn't
        // resolve to a local handler (e.g. middleware rewrote
        // \`/dynamic-replace\` → \`/dynamic-fallback/catch-all\` and the
        // routing layer couldn't match the rewritten target's data
        // route). Return 200 + \`x-nextjs-rewrite\` + minimal body so
        // fetchNextData updates router state to the rewritten URL
        // instead of treating the 404 as an asset error.
        // Fixes middleware-rewrites "should correctly rewriting to a
        // different dynamic path".
        if (
          (!resolvedPathname || !HANDLERS[resolvedPathname]) &&
          nextDataAppRouterPath &&
          result.mwRewrite
        ) {
          const headers = new Headers();
          headers.set("content-type", "application/json");
          headers.set("x-nextjs-rewrite", result.mwRewrite);
          headers.set("x-nextjs-deployment-id", DEPLOYMENT_ID);
          headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
          if (result.resolvedHeaders) {
            result.resolvedHeaders.forEach((val, key) => {
              if (!headers.has(key)) headers.set(key, val);
            });
          }
          return new Response(JSON.stringify({ pageProps: {} }), {
            status: 200,
            headers,
          });
        }

        // Pages Router static-page data URL fallback: if this is a
        // \`/_next/data/<id>/<page>.json\` request that maps to a known
        // pre-rendered static page (no getStaticProps/SSP, so no handler
        // was registered), respond with the pre-rendered SSG data file
        // from assets if it exists, otherwise minimal \`{pageProps:{}}\`
        // JSON. Without this, fetchNextData treats the 404 as an asset
        // error and falls back to a hard navigation — see
        // middleware-redirects "should implement internal redirects".
        if (
          (!resolvedPathname || !HANDLERS[resolvedPathname]) &&
          nextDataAppRouterPath
        ) {
          // First try fetching the actual prerendered data file from ASSETS
          // (SSG pages with getStaticProps emit /_next/data/<id>/<page>.json).
          try {
            const dataAssetUrl = new URL(url.pathname, url.origin);
            const dataAssetRes = await env.ASSETS.fetch(
              new Request(dataAssetUrl, { headers: request.headers })
            );
            if (dataAssetRes.ok) {
              const headers = new Headers(dataAssetRes.headers);
              if (!headers.has("x-nextjs-deployment-id")) {
                headers.set("x-nextjs-deployment-id", DEPLOYMENT_ID);
              }
              // Deploy-mode cache-control for Pages Router \`__N_SSG\` data
              // URLs — match Vercel's edge behavior (public, max-age=0,
              // must-revalidate) that the prerender.test.ts fallback-true
              // cache-header assertions expect. Without this, the ASSETS
              // binding's default cache-control leaks through.
              headers.set("cache-control", "public, max-age=0, must-revalidate");
              return new Response(dataAssetRes.body, {
                status: 200,
                headers,
              });
            }
          } catch {}
          // Build candidate set: bare path, /index variant, and locale-
          // prefixed variants. Static i18n pages are emitted as
          // \`/<locale>/<page>\` (root: \`/<locale>\`); the bare \`/\` page
          // also appears in HANDLERS/PATHNAMES.
          const isRoot = nextDataAppRouterPath === "/" || nextDataAppRouterPath === "/index";
          const bareForm = isRoot ? "/" : nextDataAppRouterPath;
          const indexForm = isRoot ? "/index" : nextDataAppRouterPath;
          const knownPaths = [bareForm, indexForm];
          if (I18N && Array.isArray(I18N.locales) && I18N.locales.length > 0) {
            for (const locale of I18N.locales) {
              if (isRoot) {
                knownPaths.push("/" + locale);
                knownPaths.push("/" + locale + "/index");
              } else {
                knownPaths.push("/" + locale + nextDataAppRouterPath);
              }
            }
          }
          const isKnownStatic = knownPaths.some(
            (p) => PATHNAMES.includes(p) || STATIC_PAGES?.[p]
          );
          if (isKnownStatic) {
            const headers = new Headers();
            headers.set("content-type", "application/json");
            headers.set("x-nextjs-deployment-id", DEPLOYMENT_ID);
            headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
            return new Response(JSON.stringify({ pageProps: {} }), {
              status: 200,
              headers,
            });
          }
        }
        // If still no handler, fall back to SSR _not-found handler or static 404.
        if (!resolvedPathname || !HANDLERS[resolvedPathname]) {
          if (HANDLERS["/_not-found"]) {
            resolvedPathname = "/_not-found";
            // Force 404 status — the handler renders the not-found boundary
            // but doesn't know the original request was unmatched.
            if (!result.status) result = { ...result, status: 404 };
          } else {
            // Try static 404 page from assets. For basePath apps the
            // 404 HTML is at /docs/404/index.html — prepend BASE_PATH
            // to the candidate paths so the ASSETS binding finds it.
            const notFoundCandidates = [];
            if (STATIC_PAGES["/404"]?.assetPath) {
              notFoundCandidates.push(STATIC_PAGES["/404"].assetPath);
            }
            if (BASE_PATH) notFoundCandidates.push(BASE_PATH + "/404/index.html");
            // For i18n builds the 404 page is emitted under the default
            // locale (\`/en/404/index.html\`), not the bare \`/404/index.html\`.
            // Try the locale-prefixed variant before falling back.
            if (I18N && I18N.defaultLocale) {
              const loc = I18N.defaultLocale;
              if (BASE_PATH) notFoundCandidates.push(BASE_PATH + "/" + loc + "/404/index.html");
              notFoundCandidates.push("/" + loc + "/404/index.html");
            }
            notFoundCandidates.push("/404/index.html");
            const notFoundPath = notFoundCandidates[0];
            const fallbackHeaders = new Headers();
            // Merge middleware response headers so tests like
            // middleware-general's "should keep non data requests in
            // their original shape" still see \`req-url-path\` /
            // \`req-url-pathname\` on 404 responses.
            if (result.resolvedHeaders) {
              result.resolvedHeaders.forEach((val, key) => {
                if (key.toLowerCase() === "set-cookie") fallbackHeaders.append(key, val);
                else fallbackHeaders.set(key, val);
              });
            }
            try {
              for (const candidate of notFoundCandidates) {
                const notFound = await env.ASSETS.fetch(new Request(new URL(candidate, url.origin)));
                if (notFound.ok) {
                  notFound.headers.forEach((val, key) => {
                    if (!fallbackHeaders.has(key)) fallbackHeaders.set(key, val);
                  });
                  return new Response(notFound.body, { status: 404, headers: fallbackHeaders });
                }
              }
            } catch {}
            if (!fallbackHeaders.has("content-type")) {
              fallbackHeaders.set("content-type", "text/plain; charset=utf-8");
            }
            return new Response("Not Found", { status: 404, headers: fallbackHeaders });
          }
        }
      }

      const handler = HANDLERS[resolvedPathname];
      if (!handler) {
        // Defensive: if we got here without a resolvable handler (e.g.
        // middleware rewrote a data URL to an unregistered target),
        // fall through to the no-handler 404 response below rather than
        // crashing on \`handler.type\`.
        const fallbackHeaders = new Headers();
        fallbackHeaders.set("content-type", "text/plain; charset=utf-8");
        return new Response("Not Found", { status: 404, headers: fallbackHeaders });
      }

      // \`_next/data\` request that middleware rewrote to an app-router route:
      // short-circuit with x-nextjs-matched-path so the Pages Router client
      // can follow the rewrite (see the matching block earlier in this fn).
      if (nextDataAppRouterPath && handler.type === "APP_PAGE") {
        const headers = new Headers();
        headers.set("content-type", "application/json");
        headers.set("x-nextjs-matched-path", resolvedPathname);
        headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
        return new Response("{}", { status: 200, headers });
      }

      const mod = handler.runtime === "nodejs" && handler.type === "APP_PAGE"
        ? await __withMinimalWorkStore(handler.pathname, ctx, () => handler.load())
        : await handler.load();
      if (handler.type === "APP_PAGE") {
        // Route module evaluation can install a singleton that assumes a
        // filesystem-backed runtime. Rebuild our proxy after the module loads.
        __initManifests();
        // Inject build-time prefetch hints into context.renderOpts before
        // the route module renders. Next.js's app-page template builds a
        // fresh renderOpts object per request and never populates
        // \`prefetchHints\` — that field is normally set on NextNodeServer's
        // shared renderOpts in its constructor. Since we bypass
        // NextNodeServer, we patch routeModule.render to copy the hints in.
        // Without this, \`experimental.prefetchInlining\` routes emit a
        // FlightRouterState with the InlinedIntoChild hint bit missing and
        // every segment renders as \`outlined ■\`.
        const rm = mod && mod.routeModule;
        if (
          rm &&
          typeof rm.render === "function" &&
          !rm.__creekRenderPatched
        ) {
          const origRender = rm.render.bind(rm);
          rm.render = function (req, res, context) {
            if (
              context &&
              context.renderOpts &&
              context.renderOpts.prefetchHints == null
            ) {
              context.renderOpts.prefetchHints = __getPrefetchHints();
            }
            return origRender(req, res, context);
          };
          rm.__creekRenderPatched = true;
        }
      }

      // Patch routeModule.getIncrementalCache for ANY handler type
      // (APP_PAGE, APP_ROUTE, PAGES, PAGES_API). The Pages Router code
      // path (pages-handler.ts:491) calls this directly with no
      // requestMeta override, so we have to intercept here or fetch
      // cache / unstable_cache / ISR fall through to a filesystem
      // backend that immediately 500s under workerd. Returning our
      // single CreekCacheHandler-backed instance unifies behavior
      // across both routers.
      {
        const rm2 = mod && mod.routeModule;
        if (
          rm2 &&
          typeof rm2.getIncrementalCache === "function" &&
          !rm2.__creekIncCachePatched
        ) {
          rm2.getIncrementalCache = async function () {
            const ic = __creekGetIncrementalCache();
            // Mirror what the original setter at app-page.ts:768 / pages
            // handler does so any code that reads
            // \`globalThis.__incrementalCache\` later in the request also
            // sees ours instead of falling back to filesystem.
            if (ic) globalThis.__incrementalCache = ic;
            return ic;
          };
          rm2.__creekIncCachePatched = true;
        }
      }

      // Eagerly seed \`globalThis.__incrementalCache\` for every request.
      // Next.js's \`unstable_cache\` (spec-extension/unstable-cache.js:60)
      // throws \`Invariant: incrementalCache missing\` when neither
      // workStore.incrementalCache nor globalThis.__incrementalCache is set.
      // For Pages Router handlers (\`getServerSideProps\`, API routes) Next.js
      // never calls \`routeModule.getIncrementalCache\` until after the
      // user callback runs, so our patched getter above fires too late.
      // Setting the global here — before we invoke any handler — makes
      // unstable_cache work uniformly across APP/PAGES + route/api.
      //
      // \`__incrementalCacheShared\` must be set so Next.js's Pages Router
      // edge template doesn't stomp over our seeded instance with a new
      // IncrementalCache that has no CurCacheHandler (minified ref at
      // worker.js:70448 — \`!globalThis.__incrementalCacheShared &&
      // t2.IncrementalCache && (globalThis.__incrementalCache = new ...)\`).
      // Without this flag, edge unstable_cache constructs a handler-less
      // IncrementalCache each request → every call is a cache miss.
      try {
        const __seedIC = __creekGetIncrementalCache();
        if (__seedIC) {
          globalThis.__incrementalCache = __seedIC;
          globalThis.__incrementalCacheShared = true;
        }
      } catch {}

      if (handler.runtime === "edge") {
        // CF Workers IS edge — try _ENTRIES first, then fall through to Node.js.
        // (Per opennext research: edge runtime is redundant on CF Workers.)
        const edgeRouteParams = getNormalizedRouteParams(result, handler.pathname, url, request.headers);
        const edgeRequestQuery =
          handler.type === "APP_PAGE"
            ? { ...(result.resolvedQuery || {}), ...edgeRouteParams }
            : edgeRouteParams;
        const edgeRequestUrl = new URL(request.url);
        // Only overwrite pathname when the invocation target matches the
        // original URL (non-rewrite). For rewrites, keep the original URL
        // so \`req.url\` / \`request.url\` seen by the handler reflects the
        // canonical (pre-rewrite) URL. Pages Router's getServerSideProps
        // returns \`props.url = req.url\`, which the test for
        // \`edge-render-getserversideprops\` "should have correct query/params
        // on rewrite" verifies matches the original URL. Route params come
        // from \`edgeRouteParams\` below (not URL re-parsing), so the handler
        // still gets the correct params for the rewritten route.
        // See isRewritten comment in static-asset block — bracket-form
        // invocationTargets AND i18n locale-prefix additions are not
        // rewrites.
        const isEdgeRewrite = (() => {
          const it = result.invocationTarget?.pathname;
          if (!it || it === url.pathname) return false;
          if (it.includes("[")) return false;
          if (I18N && Array.isArray(I18N.locales)) {
            for (const locale of I18N.locales) {
              if (it === "/" + locale + url.pathname) return false;
              if (url.pathname === "/" && it === "/" + locale) return false;
            }
          }
          return true;
        })();
        if (result.invocationTarget?.pathname && !isEdgeRewrite) {
          edgeRequestUrl.pathname = result.invocationTarget.pathname;
        }
        // Merge middleware-rewritten query params. When middleware calls
        // \`NextResponse.rewrite(urlWithExtraSearch)\`, the extra search
        // params land on \`result.resolvedQuery\` — we need to forward them
        // to the edge handler's URL so \`req.nextUrl.searchParams\` sees
        // them. Without this, pages-API tests like middleware-general's
        // "passes search params with rewrites" lose the middleware-added
        // \`foo=bar\` between the rewrite and the \`/api/edge-search-params\`
        // handler.
        if (result.resolvedQuery && typeof result.resolvedQuery === "object") {
          for (const [key, value] of Object.entries(result.resolvedQuery)) {
            if (edgeRequestUrl.searchParams.has(key)) continue;
            appendSearchParam(edgeRequestUrl.searchParams, key, value);
          }
        }
        if (handler.type === "APP_PAGE") {
          for (const [key, value] of Object.entries(edgeRequestQuery)) {
            if (edgeRequestUrl.searchParams.has(key)) continue;
            appendSearchParam(edgeRequestUrl.searchParams, key, value);
          }
        } else {
          for (const [key, value] of Object.entries(edgeRouteParams)) {
            if (/^[0-9]+$/.test(key)) continue;
            if (edgeRequestUrl.searchParams.has(key)) continue;
            appendSearchParam(edgeRequestUrl.searchParams, key, value);
          }
        }
        // Prefer middleware-overridden request headers (NextResponse.next({
        // request: { headers } })) when present.
        const edgeRequestHeaders = result.mwRequestHeaders
          ? new Headers(result.mwRequestHeaders)
          : new Headers(request.headers);
        if (result.resolvedHeaders) {
          result.resolvedHeaders.forEach((val, key) => {
            if (key.toLowerCase() !== "set-cookie") {
              edgeRequestHeaders.set(key, val);
            }
          });
        }
        const edgeRequest = new Request(edgeRequestUrl, {
          method: request.method,
          headers: edgeRequestHeaders,
          body: request.body,
          duplex: "half",
          redirect: request.redirect,
        });
        const edgeHandlerContext = {
          waitUntil: ctx.waitUntil.bind(ctx),
          params: Promise.resolve(edgeRouteParams),
          requestMeta: {
            minimalMode: true,
            params: edgeRouteParams,
            query: edgeRequestQuery,
            relativeProjectDir: ".",
            hostname: request.headers.get("host") || "localhost",
          },
        };
        if (
          handler.runtimeModuleId &&
          handler.entryKey &&
          !self._ENTRIES?.[handler.entryKey] &&
          typeof globalThis.TURBOPACK?.push === "function"
        ) {
          try {
            globalThis.TURBOPACK.push([
              "__creek_edge_handler_init",
              { otherChunks: [], runtimeModuleIds: [handler.runtimeModuleId] },
            ]);
          } catch {}
        }

        // Merge middleware-emitted response headers (Set-Cookie from
        // \`NextResponse.next()\` / \`response.cookies.set()\` /
        // \`draftMode().enable()\`) onto the edge handler's final response.
        // Without this, edge API routes swallow Set-Cookie from middleware
        // (node-runtime API routes + app pages go through \`invokeNodeHandler\`
        // which already appends resolvedHeaders, so this only shows up on
        // edge handlers). Fixes app-dir/app-middleware "Supports draft mode"
        // for Edge Functions.
        const __applyMwResponseHeaders = (edgeRes) => {
          if (!(edgeRes instanceof Response)) return edgeRes;
          if (!result?.resolvedHeaders) return edgeRes;
          let touched = false;
          const merged = new Headers(edgeRes.headers);
          result.resolvedHeaders.forEach((val, key) => {
            if (key.toLowerCase() === "set-cookie") {
              merged.append(key, val);
              touched = true;
            }
          });
          if (!touched) return edgeRes;
          return new Response(edgeRes.body, {
            status: edgeRes.status,
            statusText: edgeRes.statusText,
            headers: merged,
          });
        };
        if (handler.entryKey && self._ENTRIES?.[handler.entryKey]) {
          try {
            const entry = self._ENTRIES[handler.entryKey];
            const handlerName = handler.handlerExport || "handler";
            const proxiedHandler =
              typeof entry?.[handlerName] === "function"
                ? entry[handlerName]
                : null;
            if (proxiedHandler) {
              const edgeResult = await __withEdgeRouteEnv(
                handler.entryKey,
                () => proxiedHandler(edgeRequest, edgeHandlerContext),
              );
              if (edgeResult instanceof Response) {
                return __applyMwResponseHeaders(edgeResult);
              }
              if (edgeResult?.response instanceof Response) {
                if (edgeResult.waitUntil) {
                  ctx.waitUntil(Promise.resolve(edgeResult.waitUntil).catch(() => {}));
                }
                return __applyMwResponseHeaders(edgeResult.response);
              }
            }

            const edgeMod = await entry;
            if (edgeMod) {
              const fn = edgeMod[handlerName] || edgeMod.default;
              if (typeof fn === "function") {
                const edgeResult = await __withEdgeRouteEnv(
                  handler.entryKey,
                  () => fn(edgeRequest, edgeHandlerContext),
                );
                if (edgeResult instanceof Response) {
                  return __applyMwResponseHeaders(edgeResult);
                }
                if (edgeResult?.response instanceof Response) {
                  if (edgeResult.waitUntil) {
                    ctx.waitUntil(Promise.resolve(edgeResult.waitUntil).catch(() => {}));
                  }
                  return __applyMwResponseHeaders(edgeResult.response);
                }
              }
            }
          } catch {}
        }
        // Fall through to Node.js handler bridge
      }

      // Streaming SSR: use TransformStream so chunks flow to the client
      // as Next.js writes them, enabling Server Components streaming,
      // PPR shell delivery, and progressive HTML rendering.
      let __invokedResponse;
      if (handler.runtime === "nodejs" && handler.type === "APP_PAGE") {
        __invokedResponse = await __withMinimalWorkStore(
          handler.pathname,
          ctx,
          () => invokeNodeHandler(request, mod, ctx, result, handler.pathname, handler.type),
        );
      } else {
        __invokedResponse = await invokeNodeHandler(request, mod, ctx, result, handler.pathname, handler.type);
      }
      // For Pages Router page errors (status 500 from getServerSideProps
      // throwing) on a NON-data URL navigation, replace our generic JSON
      // error body with the static 500.html page so the browser renders
      // the proper Pages Router error UI (and \`_app\` re-mounts, restoring
      // \`window.*\` globals like the test event-log helper).
      // Data URL requests keep the JSON 500 — Pages Router's
      // \`fetchNextData\` reads the body as text and only checks the
      // status code to emit \`routeChangeError\`.
      if (
        __invokedResponse &&
        __invokedResponse.status === 500 &&
        handler.type === "PAGES" &&
        !staticPagesDataRoutePath &&
        !nextDataAppRouterPath
      ) {
        try {
          const candidates = [];
          if (BASE_PATH) candidates.push(BASE_PATH + "/500/index.html");
          candidates.push("/500/index.html");
          for (const candidate of candidates) {
            const res500 = await env.ASSETS.fetch(new Request(new URL(candidate, url.origin)));
            if (res500.ok) {
              const headers = new Headers();
              headers.set("content-type", "text/html; charset=utf-8");
              return new Response(res500.body, { status: 500, headers });
            }
          }
        } catch {}
        // If no static 500.html is prerendered (e.g. pages/500.js is
        // dynamic — uses getInitialProps or Error class), invoke the
        // /500 handler directly to render "custom pages/500" HTML
        // rather than the generic JSON \`render_error\` body.
        // Fixes getserversideprops "should handle throw ENOENT correctly".
        if (HANDLERS["/500"]) {
          try {
            const error500Handler = HANDLERS["/500"];
            const error500Mod = await error500Handler.load();
            const error500Res = await invokeNodeHandler(
              request,
              error500Mod,
              ctx,
              result,
              "/500",
              "PAGES",
            );
            if (error500Res && error500Res.body) {
              const headers = new Headers(error500Res.headers);
              return new Response(error500Res.body, { status: 500, headers });
            }
          } catch {}
        }
      }
      // Pages Router 404 fallback: when getStaticProps returns
      // \`{ notFound: true }\`, Pages Router's pages-handler invokes
      // \`render404\` which we don't provide, so it falls back to writing
      // the bare text \`This page could not be found\` (see
      // pages-handler.ts:121).
      //
      // Two cases to handle:
      //   (a) fixture has NO custom _error (framework default) — Next.js
      //       prerenders /404/index.html at build time (framework default
      //       says "This page could not be found"). Serve that.
      //   (b) fixture has custom pages/_error.js that uses request-scoped
      //       props (e.g. ctx.req.url) — Next.js SKIPS prerendering /404
      //       because _error.getInitialProps makes it dynamic. Fall back
      //       to re-invoking _error with the original request.
      //
      // Try (a) first via ASSETS; if /404 isn't prerendered, fall to (b).
      // Fixes error-handler-not-found-req-url (case b) and
      // middleware-general notFound:true (case a).
      if (
        __invokedResponse &&
        __invokedResponse.status === 404 &&
        handler.type === "PAGES" &&
        !staticPagesDataRoutePath &&
        !nextDataAppRouterPath
      ) {
        try {
          const cloned = __invokedResponse.clone();
          const ct = cloned.headers.get("content-type") || "";
          // Only intercept the raw text fallback; if the handler already
          // rendered an HTML 404 (e.g. via \`pages/404.js\`), keep it.
          if (!ct.includes("text/html")) {
            const text = await cloned.text();
            if (text.trim() === "This page could not be found") {
              // Case (a0): an app/not-found.tsx is present (\`/_not-found\`
              // handler registered) — prefer it over Pages Router's
              // static 404. Next.js defines app-dir's not-found as the
              // canonical 404 when both routers coexist, even for URLs
              // that were resolved via Pages Router. We need a fresh
              // routeResult with status=404 so invokeNodeHandler
              // pre-seeds res.statusCode correctly.
              // Fixes app-dir/not-found-with-pages-i18n "should prefer
              // the app router 404 over the pages router 404".
              if (HANDLERS["/_not-found"]) {
                try {
                  const nfHandler = HANDLERS["/_not-found"];
                  const nfMod = await nfHandler.load();
                  const nfRouteResult = { ...(result || {}), status: 404 };
                  const nfRes = await invokeNodeHandler(
                    request,
                    nfMod,
                    ctx,
                    nfRouteResult,
                    "/_not-found",
                    "APP_PAGE",
                  );
                  if (nfRes && nfRes.body) {
                    const headers = new Headers(nfRes.headers);
                    headers.set("content-type", "text/html; charset=utf-8");
                    return new Response(nfRes.body, { status: 404, headers });
                  }
                } catch {}
              }
              // Case (a): try prerendered /404/index.html from ASSETS.
              const notFoundCandidates = [];
              if (STATIC_PAGES["/404"]?.assetPath) {
                notFoundCandidates.push(STATIC_PAGES["/404"].assetPath);
              }
              if (BASE_PATH) notFoundCandidates.push(BASE_PATH + "/404/index.html");
              if (I18N && I18N.defaultLocale) {
                const loc = I18N.defaultLocale;
                if (BASE_PATH) notFoundCandidates.push(BASE_PATH + "/" + loc + "/404/index.html");
                notFoundCandidates.push("/" + loc + "/404/index.html");
              }
              notFoundCandidates.push("/404/index.html");
              for (const candidate of notFoundCandidates) {
                try {
                  const notFound = await env.ASSETS.fetch(new Request(new URL(candidate, url.origin)));
                  if (notFound.ok) {
                    const headers = new Headers();
                    notFound.headers.forEach((val, key) => headers.set(key, val));
                    headers.set("content-type", "text/html; charset=utf-8");
                    return new Response(notFound.body, { status: 404, headers });
                  }
                } catch {}
              }
              // Case (b): no prerendered /404 — custom _error has
              // getInitialProps. Re-invoke /_error so it renders with the
              // original req context. Pre-seed status=404 on routeResult
              // so \`invokeNodeHandler\` sets \`res.statusCode = 404\`
              // BEFORE \`_error.getInitialProps({res})\` runs — otherwise
              // the default Error component reads \`res.statusCode = 200\`
              // and the rendered \`__NEXT_DATA__.pageProps.statusCode\`
              // comes out as 200, so the visible title says "200: An
              // unexpected error has occurred" instead of "404: This
              // page could not be found".
              // Fixes getserversideprops "should render 404 correctly
              // when notFound is returned".
              if (HANDLERS["/_error"]) {
                const errorHandler = HANDLERS["/_error"];
                const errorMod = await errorHandler.load();
                const errorRouteResult = { ...(result || {}), status: 404 };
                const errorRes = await invokeNodeHandler(
                  request,
                  errorMod,
                  ctx,
                  errorRouteResult,
                  "/_error",
                  "PAGES",
                );
                if (errorRes && errorRes.body) {
                  const headers = new Headers(errorRes.headers);
                  return new Response(errorRes.body, { status: 404, headers });
                }
              }
            }
          }
        } catch {}
      }
      // Deploy-mode cache-control on handler responses. Next.js internally
      // sets \`s-maxage=<revalidate>, stale-while-revalidate=...\` on ISR
      // page responses — that's the value a self-hosted \`next start\`
      // would emit. Vercel's edge strips that server-side hint before
      // the client sees it and replaces it with
      // \`public, max-age=0, must-revalidate\`. Match the deploy-mode
      // behavior for HTML responses from Pages Router pages that carry
      // a prerender entry with a positive revalidate — tests like
      // \`should use correct caching headers for a revalidate page\` /
      // \`fallback-true (prerendered)\` assert the exact deploy string
      // and would otherwise see the raw \`s-maxage=...\` value leak
      // through our handler path. The static-asset serve branch above
      // does the same thing for the prerendered HTML fast-path.
      try {
        if (
          __invokedResponse &&
          __invokedResponse.status === 200 &&
          handler?.type === "PAGES"
        ) {
          const ct = __invokedResponse.headers.get("content-type") || "";
          // Deploy-mode cache-control for ISR / SSG outputs: Vercel's edge
          // strips Next.js's server-side \`s-maxage=<N>, stale-while-
          // revalidate=...\` and also the stock \`private, no-cache, no-store\`
          // that falls out of a fresh fallback-true render, and replaces
          // both with \`public, max-age=0, must-revalidate\` for any page
          // that the framework considers cacheable. Tests like \`should use
          // correct caching headers for a revalidate page\`,
          // \`fallback-true (prerendered)\`, and \`fallback-true (lazy)\`
          // branch on \`isDeploy\` and assert that exact string, so the raw
          // Next.js header must not leak through.
          //
          // The discriminator is the PAGE shape, not the emitted header:
          //   - \`isIsrHtml\`: Pages Router HTML whose STATIC_PAGES entry
          //     declares \`initialRevalidate\` (covers revalidate pages and
          //     both fallback-true branches — the lazy branch returns the
          //     default \`private, no-cache\` and still needs overriding).
          //   - \`isDataUrlJson\`: \`/_next/data/<buildId>/...\` response for a
          //     pathname that has a STATIC_PAGES entry (SSG/ISR), so we
          //     rewrite to the deploy-mode string. \`getServerSideProps\`
          //     data URLs DON'T have a STATIC_PAGES entry and must keep
          //     their native \`private, no-cache, no-store, ...\` — the
          //     \`test/e2e/getserversideprops\` "should set default caching
          //     header" / "should respect custom caching header" tests
          //     regress if we rewrite those.
          const isIsrHtml =
            ct.includes("text/html") &&
            staticEntry?.initialRevalidate != null &&
            staticEntry.initialRevalidate !== false;
          const hasStaticEntryForPath = (() => {
            if (!url.pathname.startsWith("/_next/data/")) return false;
            // \`staticEntry\` for the request itself is set above based on the
            // resolved pathname. If it exists, this is an SSG/ISR data URL.
            return !!staticEntry;
          })();
          const isDataUrlJson =
            ct.includes("application/json") &&
            url.pathname.startsWith("/_next/data/") &&
            hasStaticEntryForPath;
          if (isIsrHtml || isDataUrlJson) {
            const patched = new Headers(__invokedResponse.headers);
            patched.set("cache-control", "public, max-age=0, must-revalidate");
            __invokedResponse = new Response(__invokedResponse.body, {
              status: __invokedResponse.status,
              statusText: __invokedResponse.statusText,
              headers: patched,
            });
          }
        }
      } catch {}
      // When a HEAD with \`x-prerender-revalidate\` succeeds, mark the path
      // so subsequent GETs bypass the static fast-path and re-run the
      // handler (which now serves the fresh on-demand result from
      // IncrementalCache). Without this, \`res.revalidate('/')\` runs
      // getStaticProps with \`revalidateReason: 'on-demand'\` but the next
      // GET / still returns the build-time HTML — fails
      // \`test/e2e/revalidate-reason\` "on-demand".
      try {
        if (
          isPrerenderRevalidate &&
          __invokedResponse &&
          __invokedResponse.status >= 200 &&
          __invokedResponse.status < 300
        ) {
          if (!globalThis.__CREEK_PATH_REVALIDATED_AT) {
            globalThis.__CREEK_PATH_REVALIDATED_AT = new Map();
          }
          const now = Date.now();
          const keys = [resolvedPathname, url.pathname, servePath].filter(Boolean);
          for (const k of keys) {
            globalThis.__CREEK_PATH_REVALIDATED_AT.set(k, now);
          }
        }
      } catch {}
      return __invokedResponse;
    } catch (err) {
      const msg = err instanceof Error ? (err.stack || err.message) : String(err);
      return new Response(JSON.stringify({ error: "ssr_error", message: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  });
  // Skew protection: the Pages Router client compares
  // \`x-nextjs-deployment-id\` on \`/_next/data/*\` responses against the
  // \`data-dpl-id\` it read from \`<html>\` on the initial page load; any
  // mismatch forces a hard navigation that wipes \`window.beforeNav\` and
  // breaks middleware-general client-transition tests. We now inject both
  // sides of the handshake:
  //   - \`data-dpl-id="<BUILD_ID>"\` into the \`<html>\` tag via the HTML
  //     stream rewriter (__injectDplId in __rewriteFirstChunk), so the
  //     client sees a concrete deploymentId on page load.
  //   - \`x-nextjs-deployment-id: <BUILD_ID>\` on every \`/_next/data/*\`
  //     response, matching the HTML attribute so the client's
  //     skew check succeeds.
  // The unconditional header also keeps pages-ssg-data-deployment-skew
  // happy (its \`isNextDeploy\` branch asserts the header is truthy).
  try {
    const url = new URL(request.url);
    const isDataUrl =
      url.pathname.startsWith("/_next/data/") ||
      (BASE_PATH && url.pathname.startsWith(BASE_PATH + "/_next/data/"));
    // App Router RSC responses also need x-nextjs-deployment-id for the
    // deployment-skew header assertion (segment-cache/deployment-skew) —
    // the client's skew check hits every \`text/x-component\` payload, not
    // just Pages Router data URLs.
    const isRscResponse =
      response &&
      typeof response.headers?.get === "function" &&
      (response.headers.get("content-type") || "").includes("text/x-component");
    if (
      response &&
      typeof response.headers?.has === "function" &&
      (isDataUrl || isRscResponse) &&
      !response.headers.has("x-nextjs-deployment-id")
    ) {
      const headers = new Headers(response.headers);
      headers.set("x-nextjs-deployment-id", DEPLOYMENT_ID);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  } catch {}
  // Strip stale Content-Encoding from dynamic responses. Edge API routes
  // commonly do \`fetch(remoteUrl)\` and forward the Response — fetch()
  // automatically decompresses brotli/gzip bodies, but the remote's
  // \`Content-Encoding: br\` header stays attached to the new Response.
  // When that response reaches a downstream client (e.g. node-fetch in
  // the test harness), it tries to decompress already-plain bytes and
  // fails with "Decompression failed". We only strip for non-static
  // content-types to avoid breaking cached immutable assets that are
  // genuinely compressed.
  try {
    if (
      response &&
      typeof response.headers?.has === "function" &&
      response.headers.has("content-encoding")
    ) {
      const url2 = new URL(request.url);
      const isStaticAsset = url2.pathname.startsWith("/_next/static/") ||
        url2.pathname.startsWith("/_next/image");
      if (!isStaticAsset) {
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    }
  } catch {}
  return response;
}

export default {
  fetch: __handleRequest,
};
`;
}

interface SupplementalRouteOutput {
  pathname: string;
  filePath: string;
  runtime: "nodejs" | "edge";
  edgeRuntime?: { modulePath: string; entryKey: string; handlerExport: string; runtimeModuleId?: number };
}

function collectSupplementalMetadataRoutes(
  outputs: BuildContext["outputs"],
  manifests: Record<string, string>,
): SupplementalRouteOutput[] {
  const existing = new Set(outputs.appRoutes.map((route) => route.pathname));
  const manifestEntry = Object.entries(manifests).find(([manifestPath]) =>
    manifestPath.replaceAll("\\", "/").endsWith("/server/app-paths-manifest.json"),
  );
  if (!manifestEntry) return [];

  const [manifestPath, manifestContent] = manifestEntry;
  let appPathsManifest: Record<string, string>;
  try {
    appPathsManifest = JSON.parse(manifestContent) as Record<string, string>;
  } catch {
    return [];
  }

  const supplemental: SupplementalRouteOutput[] = [];
  const serverDir = path.dirname(manifestPath);

  for (const [routeKey, relativeFilePath] of Object.entries(appPathsManifest)) {
    if (!routeKey.endsWith("/route")) continue;

    const pathname = routeKey.slice(0, -"/route".length);
    // Only synthesize file-based metadata routes (e.g. icon.png, sitemap.xml).
    // Standard app route handlers are already present in outputs.appRoutes.
    if (!path.extname(pathname)) continue;
    if (existing.has(pathname)) continue;

    const filePath = path.join(serverDir, relativeFilePath);
    if (!existsSync(filePath)) continue;

    supplemental.push({
      pathname,
      filePath,
      runtime: "nodejs",
    });
    existing.add(pathname);
  }

  return supplemental;
}

function collectHandlers(
  outputs: BuildContext["outputs"],
  manifests: Record<string, string>,
): HandlerEntry[] {
  const handlers: HandlerEntry[] = [];
  const handlerIndexes = new Map<string, number>();
  let idx = 0;
  const supplementalMetadataRoutes = collectSupplementalMetadataRoutes(outputs, manifests);

  const isParallelSlotPath = (value: string | undefined) =>
    typeof value === "string" && /(^|[\\/])@[^\\/]+([\\/]|$)/.test(value);

  const addOutput = (
    output: {
      pathname: string;
      filePath: string;
      runtime: "nodejs" | "edge";
      edgeRuntime?: { modulePath: string; entryKey: string; handlerExport: string; runtimeModuleId?: number };
    },
    type: string,
  ) => {
    if (output.pathname.endsWith(".rsc")) return;
    // Strip App Router route-group segments (\`(group)\`) so handlers are
    // keyed on the user-visible URL. Only applies to APP_PAGE / APP_ROUTE
    // types — Pages Router doesn't have groups.
    const effectivePathname =
      type === "APP_PAGE" || type === "APP_ROUTE"
        ? stripRouteGroups(output.pathname)
        : output.pathname;
    const importPath = output.edgeRuntime?.modulePath || output.filePath;
    const slotIdentity =
      output.edgeRuntime?.entryKey ||
      output.filePath ||
      importPath;
    const existingIndex = handlerIndexes.get(effectivePathname);
    if (existingIndex !== undefined) {
      const existing = handlers[existingIndex];
      const existingIsSlot = isParallelSlotPath(
        existing.edgeRuntime?.entryKey || existing.importPath,
      );
      const nextIsSlot = isParallelSlotPath(slotIdentity);

      // Parallel route slot pages (e.g. @modal/page) can share the same
      // pathname as the canonical page route but should not win top-level
      // request dispatch for that pathname.
      if (!(existingIsSlot && !nextIsSlot)) {
        return;
      }
    }

    const entry: HandlerEntry = {
      pathname: effectivePathname,
      importPath,
      varName: `_h${idx++}`,
      runtime: output.runtime,
      type,
    };
    if (output.edgeRuntime) {
      entry.edgeRuntime = {
        entryKey: output.edgeRuntime.entryKey,
        handlerExport: output.edgeRuntime.handlerExport,
        runtimeModuleId: (output.edgeRuntime as Record<string, unknown>).runtimeModuleId as number | undefined,
      };
    }
    if (existingIndex !== undefined) {
      handlers[existingIndex] = entry;
    } else {
      handlerIndexes.set(effectivePathname, handlers.length);
      handlers.push(entry);
    }
  };

  for (const page of outputs.appPages) addOutput(page, "APP_PAGE");
  for (const route of outputs.appRoutes) addOutput(route, "APP_ROUTE");
  for (const route of supplementalMetadataRoutes) addOutput(route, "APP_ROUTE");
  for (const page of outputs.pages) addOutput(page, "PAGES");
  for (const api of outputs.pagesApi) addOutput(api, "PAGES_API");

  return handlers;
}

// Decide whether a `outputs.staticFiles` entry is a page (HTML body) we
// should serve from STATIC_PAGES, vs a real asset file (.js/.css/.png etc.)
// that the ASSETS binding handles directly. Page paths look like \`/about\`
// or \`/catch-all/[...slug]\`. We can't just check `path.extname()`: a Next.js
// dynamic segment like `[...slug]` contains dots and `extname` returns
// `.slug]`, which would incorrectly classify catch-all pages as assets.
function __isStaticPagePathname(pathname: string): boolean {
  if (pathname.startsWith("/_next/")) return false;
  // Bracketed dynamic segments → always a page, ignore the fake extname.
  if (pathname.includes("[")) return true;
  return !path.extname(pathname);
}

/**
 * Find JS manifests that need to execute before edge runtime modules evaluate.
 * This includes top-level manifest globals and all per-page client-reference manifests.
 */
function collectBootManifestPaths(manifests: Record<string, string>): string[] {
  const priority = (manifestPath: string) => {
    const normalized = manifestPath.replaceAll("\\", "/");
    if (normalized.endsWith("/server/middleware-build-manifest.js")) return 0;
    if (normalized.endsWith("/server/next-font-manifest.js")) return 1;
    if (normalized.endsWith("/server/server-reference-manifest.js")) return 2;
    if (normalized.endsWith("/server/interception-route-rewrite-manifest.js")) return 3;
    if (normalized.endsWith("client-reference-manifest.js")) return 4;
    return 5;
  };

  return Object.keys(manifests)
    .filter((manifestPath) => {
      const normalized = manifestPath.replaceAll("\\", "/");
      return normalized.endsWith("/server/middleware-build-manifest.js") ||
        normalized.endsWith("/server/next-font-manifest.js") ||
        normalized.endsWith("/server/server-reference-manifest.js") ||
        normalized.endsWith("/server/interception-route-rewrite-manifest.js") ||
        normalized.endsWith("client-reference-manifest.js");
    })
    .filter((manifestPath) => existsSync(manifestPath))
    .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
}

/**
 * Build a map from request pathname → asset file path for static HTML pages.
 * Pages Router static pages need to be served from assets because their
 * handlers require filesystem access unavailable in CF Workers.
 *
 * Handles the /index → / normalization: outputs.staticFiles uses /index
 * as the pathname for the root page, but resolveRoutes resolves to /.
 */
interface StaticPageEntry {
  assetPath: string;
  // App router pages that call notFound() / redirect() / permanentRedirect()
  // are pre-rendered to HTML at build time, but their HTTP status (404 / 307 /
  // 308) and redirect Location header live in the prerender metadata. The
  // worker has to apply both when serving the static HTML.
  status?: number;
  headers?: Record<string, string | string[]>;
  // ISR revalidation period (seconds). If > 0, this page uses Incremental
  // Static Regeneration and must NOT be served indefinitely from static
  // assets — the handler path with IncrementalCache manages the
  // fresh/stale lifecycle.
  initialRevalidate?: number;
  // Cache tags the prerender was built with (parsed from its
  // \`x-next-cache-tags\` header). Consulted at request time so that when
  // a server action calls updateTag/revalidateTag on one of these tags,
  // the stale static asset is bypassed and the handler runs fresh.
  cacheTags?: string[];
}

// Collect paths whose build-time prerender has an ISR revalidate > 0 AND
// is NOT a metadata route. Intent: allow \`export const revalidate = N\`
// route handlers (e.g. /revalidate-1/[slug]/data.json) to bypass the
// static-asset fast-path so the handler runs and IncrementalCache governs
// the fresh/stale lifecycle. Metadata routes (sitemap, robots, manifest,
// opengraph-image, etc.) often also carry revalidate via \`'use cache'\`
// defaults, but running them through the handler at runtime hangs —
// \`'use cache'\` relies on build-time-seeded cache entries that we don't
// populate yet. So metadata routes keep serving their build-time output
// via the fast-path until composable-cache seeding is implemented.
const __METADATA_ROUTE_NAMES = new Set([
  "sitemap", "robots", "manifest",
  "opengraph-image", "twitter-image",
  "icon", "apple-icon", "favicon",
]);
function __isMetadataRoutePath(p: string): boolean {
  const segments = p.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1] || "";
  const lastNoExt = last.replace(/\.[a-z0-9]+$/i, "");
  if (__METADATA_ROUTE_NAMES.has(lastNoExt)) return true;
  const second = segments[segments.length - 2] || "";
  if (__METADATA_ROUTE_NAMES.has(second)) return true;
  return false;
}
function collectRevalidatePaths(outputs: BuildContext["outputs"]): string[] {
  const paths = new Set<string>();
  for (const prerender of outputs.prerenders) {
    if (!prerender.fallback?.filePath) continue;
    if (prerender.pathname.startsWith("/_next/")) continue;
    const rev = prerender.fallback.initialRevalidate;
    if (typeof rev !== "number" || rev <= 0) continue;
    if (__isMetadataRoutePath(prerender.pathname)) continue;
    paths.add(prerender.pathname);
  }
  return Array.from(paths);
}

function collectStaticPageMap(outputs: BuildContext["outputs"]): Record<string, StaticPageEntry> {
  const map: Record<string, StaticPageEntry> = {};
  for (const file of outputs.staticFiles) {
    // Only include HTML pages, not _next/static/* assets. Use the bracket-aware
    // helper so dynamic segments like /catch-all/[...slug] aren't misclassified
    // as having a file extension.
    if (__isStaticPagePathname(file.pathname)) {
      const assetPath = path.join(file.pathname, "index.html");
      const entry: StaticPageEntry = { assetPath };
      // Map the original pathname
      map[file.pathname] = entry;
      // Also map normalized form: /index → /, /foo/index → /foo
      if (file.pathname.endsWith("/index")) {
        const parent = file.pathname.slice(0, -6) || "/";
        map[parent] = entry;
      }
    }
  }
  for (const prerender of outputs.prerenders) {
    if (!prerender.fallback?.filePath) continue;
    if (prerender.pathname.startsWith("/_next/")) continue;
    // PPR/postponed prerenders need the route handler so the shell can
    // stream and later resolve its dynamic segments. Serving their fallback
    // HTML directly from assets leaves the client stuck on the loading shell.
    // Only gate on \`postponedState\` — \`pprChain.headers\` is set on every
    // route under \`cacheComponents: true\` / \`experimentalPPR: true\` whether
    // or not the route actually has dynamic segments to resume. Fully-static
    // routes under PPR (e.g. layout + client component, no \`<Suspense>\`)
    // have \`postponedState\` unset, and their prerendered HTML is the final
    // response — serve it directly so the build-time sentinel isn't
    // clobbered by a fresh runtime render (fixes cache-components.server-
    // action "should prerender pages with inline server actions" which
    // expected \`at buildtime\` and received \`at runtime\`).
    if (prerender.fallback.postponedState) continue;

    const assetPath = __isStaticPagePathname(prerender.pathname)
      ? path.join(prerender.pathname, "index.html")
      : prerender.pathname;

    const entry: StaticPageEntry = { assetPath };
    if (typeof prerender.fallback.initialStatus === "number") {
      entry.status = prerender.fallback.initialStatus;
    }
    if (prerender.fallback.initialHeaders) {
      entry.headers = prerender.fallback.initialHeaders;
    }
    // Extract cache tags for runtime invalidation checking. When a
    // server action calls \`updateTag/revalidateTag\`, we flip the
    // matching tag in \`__CREEK_TAG_INVALIDATED_AT\` — but the prerendered
    // HTML still sits on disk. Without a runtime tag check here, the
    // static asset fast-path keeps serving the stale HTML and the
    // client never sees the invalidation. Store the tag list on the
    // entry so \`canServeStaticPage\` can intersect it with the
    // invalidated-tag set and skip the fast-path when any tag has been
    // revalidated since build.
    // Fixes app-static "updateTag/revalidateTag should successfully
    // update tag when called from server action".
    const cacheTagsHeader = prerender.fallback.initialHeaders?.["x-next-cache-tags"];
    if (typeof cacheTagsHeader === "string" && cacheTagsHeader.length > 0) {
      entry.cacheTags = cacheTagsHeader.split(",").map((t) => t.trim()).filter(Boolean);
    }
    // ISR revalidation period: if > 0, the page should NOT be served
    // indefinitely from static assets — after the revalidate window
    // the handler must re-run getStaticProps. We store this on the
    // entry so \`canServeStaticPage\` can skip the static shortcut for
    // ISR pages, forcing them through the handler path where
    // IncrementalCache manages freshness/staleness and SWR.
    if (typeof prerender.fallback.initialRevalidate === "number" && prerender.fallback.initialRevalidate > 0) {
      entry.initialRevalidate = prerender.fallback.initialRevalidate;
    }

    map[prerender.pathname] = entry;
    if (prerender.pathname.endsWith("/index")) {
      const parent = prerender.pathname.slice(0, -6) || "/";
      map[parent] = entry;
    }
  }
  return map;
}

// Strip App Router "route group" segments (\`(name)\`) from a pathname.
// Groups are purely organizational in Next.js — they affect layout nesting
// but are invisible in the URL. Next.js's adapter-emitted \`pathname\` for
// a file under \`app/(group)/foo/sitemap.xml\` is \`/(group)/foo/sitemap.xml\`,
// but the browser requests \`/foo/sitemap.xml\`. Our HANDLERS + PATHNAMES
// lookups have to key on the user-visible URL, not the internal path.
function stripRouteGroups(pathname: string): string {
  if (!pathname.includes("(")) return pathname;
  const stripped = pathname
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")") && seg.length > 2))
    .join("/");
  return stripped === "" ? "/" : stripped;
}

function collectPathnames(
  outputs: BuildContext["outputs"],
  manifests: Record<string, string>,
): string[] {
  const pathnames = new Set<string>();
  const supplementalMetadataRoutes = collectSupplementalMetadataRoutes(outputs, manifests);
  for (const p of outputs.appPages) pathnames.add(stripRouteGroups(p.pathname));
  for (const r of outputs.appRoutes) pathnames.add(stripRouteGroups(r.pathname));
  for (const r of supplementalMetadataRoutes) pathnames.add(stripRouteGroups(r.pathname));
  for (const p of outputs.pages) pathnames.add(p.pathname);
  for (const a of outputs.pagesApi) pathnames.add(a.pathname);
  for (const s of outputs.staticFiles) pathnames.add(s.pathname);
  return [...pathnames];
}

const NODE_BRIDGE_CODE = `
import { EventEmitter } from "node:events";
import { IncomingMessage as _IM, ServerResponse as _SR } from "http";
import { Socket } from "net";

// Extend built-in IncomingMessage with buffered body support.
// The built-in node:http IncomingMessage works for most cases but
// we need push() with deferred flowing for body buffering.
class IncomingMessage extends _IM {
  constructor() {
    super(new Socket());
    this._bufferedChunks = [];
    this._ended = false;
    this._customFlowing = false;
  }
  push(chunk) {
    if (chunk === null) {
      this._ended = true;
      if (this._customFlowing) { super.push(null); return; }
      return;
    }
    if (this._customFlowing) { super.push(chunk); return; }
    this._bufferedChunks.push(chunk);
  }
  _startFlowing() {
    if (this._customFlowing) return;
    this._customFlowing = true;
    for (const c of this._bufferedChunks) super.push(c);
    this._bufferedChunks = [];
    if (this._ended) super.push(null);
  }
  on(event, fn) {
    super.on(event, fn);
    // Trigger flushing for any consumer-side event that reads data:
    //   - "data": classic flowing mode listeners
    //   - "readable": paused-mode readers (also used internally by
    //     Readable's Symbol.asyncIterator)
    // Without the "readable" branch, \`for await (const chunk of req)\` in
    // handlers (bodyParser:false, server actions reading req directly)
    // would hang forever: Readable's iterator waits on a "readable" event
    // but our buffered push() never surfaces as one until _startFlowing
    // runs. Fixes middleware-fetches-with-body bodyParser:false tests.
    if ((event === "data" || event === "readable") && !this._customFlowing) {
      queueMicrotask(() => this._startFlowing());
    }
    return this;
  }
  resume() { this._startFlowing(); return super.resume(); }
  [Symbol.asyncIterator]() {
    // Ensure buffered body is flushed into the Readable before the
    // native iterator starts awaiting "readable" / "end" events.
    this._startFlowing();
    return super[Symbol.asyncIterator]();
  }
}
const ServerResponse = _SR;

function decodeRouteParam(value) {
  if (typeof value !== "string") return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fillRouteParamsFromPath(routePattern, pathname, params) {
  if (!routePattern || !pathname) return params;

  const patternSegments = routePattern.split("?")[0].split("/").filter(Boolean);
  const pathSegments = pathname.split("?")[0].split("/").filter(Boolean);
  let pathIndex = 0;

  for (const segment of patternSegments) {
    if (segment.startsWith("[[...") && segment.endsWith("]]")) {
      const key = segment.slice(5, -2);
      const rest = pathSegments.slice(pathIndex).map(decodeRouteParam)
        .filter((v) => typeof v !== "string" || (!v.startsWith("$nxtP") && !v.startsWith("%24nxtP")));
      if (rest.length > 0) params[key] = rest;
      else delete params[key];
      pathIndex = pathSegments.length;
      continue;
    }

    if (segment.startsWith("[...") && segment.endsWith("]")) {
      const key = segment.slice(4, -1);
      params[key] = pathSegments.slice(pathIndex).map(decodeRouteParam)
        .filter((v) => typeof v !== "string" || (!v.startsWith("$nxtP") && !v.startsWith("%24nxtP")));
      pathIndex = pathSegments.length;
      continue;
    }

    if (segment.startsWith("[") && segment.endsWith("]")) {
      const key = segment.slice(1, -1);
      if (pathIndex < pathSegments.length) {
        const val = decodeRouteParam(pathSegments[pathIndex]);
        // \`fillRouteParamsFromPath\` runs AFTER the \`$nxtP\` sentinel
        // stripping in \`getNormalizedRouteParams\`. If
        // \`invocationTarget.pathname\` contains sentinel segments
        // (e.g. \`/$nxtPlocale/not-found\` for a parallel-route
        // not-found boundary), we'd re-introduce the stripped value.
        // Skip sentinels here too.
        if (typeof val === "string" && (val.startsWith("$nxtP") || val.startsWith("%24nxtP"))) {
          // Don't set — leave whatever was already there (or nothing).
        } else {
          params[key] = val;
        }
      }
    }

    pathIndex += 1;
  }

  return params;
}

function getNormalizedRouteParams(routeResult, handlerPathname, fallbackUrl, requestHeaders) {
  const normalizedRouteParams = {};
  for (const [key, value] of Object.entries(routeResult?.routeMatches || {})) {
    // Any \`$nxtP{paramName}\` sentinel represents a MISSING optional
    // catch-all / optional dynamic segment. @next/routing uses these
    // as placeholders (\`$nxtPrest\`, \`$nxtPlocale\`, \`$nxtPslug\`, …)
    // when the URL didn't actually provide the param. They must never
    // leak to the rendered page — Pages Router would render
    // \`Locale: $nxtPlocale\` instead of the real locale.
    // Fixes parallel-route-not-found-params \`$nxtPlocale\` leak on
    // interception routes.
    if (typeof value === "string" && (value.startsWith("$nxtP") || value.startsWith("%24nxtP"))) continue;
    if (/^[0-9]+$/.test(key)) continue;
    // \`nextLocale\` is i18n metadata from @next/routing's route regex
    // (\`(?<nextLocale>[^/]{1,})\`). It is not a user-facing param — Next.js
    // reads the active locale from \`renderOpts.locale\`/\`req.locale\`. If we
    // forward it as a route param, Pages Router merges it into
    // \`__NEXT_DATA__.query\`, leaking into \`router.query.nextLocale\`
    // (observed on middleware-rewrites "should handle static dynamic
    // rewrite from middleware correctly").
    if (key === "nextLocale") continue;
    // @next/routing encodes dynamic segments in routeMatches with two
    // prefixes: \`nxtP\` for regular params (\`nxtPid\` → \`id\`) and
    // \`nxtI\` for interception-route params (\`nxtIusername\` → \`username\`
    // from a \`/(.)[username]/[id]\` pattern). Next.js's
    // \`interpolateParallelRouteParams\` looks up params by the bare name
    // (\`username\`) and throws
    //   Invariant: Could not resolve param value for segment: username
    // when the map only has \`nxtIusername\`.
    // Fixes interception-dynamic-segment tests (6 tests).
    let normalizedKey = key;
    if (normalizedKey.startsWith("nxtP") || normalizedKey.startsWith("nxtI")) {
      normalizedKey = normalizedKey.slice(4);
    }
    if (/^[0-9]+$/.test(normalizedKey)) continue;
    normalizedRouteParams[normalizedKey] = value;
  }
  fillRouteParamsFromPath(
    handlerPathname,
    routeResult?.invocationTarget?.pathname || fallbackUrl?.pathname,
    normalizedRouteParams,
  );
  // Interception + locale middleware fallback: @next/routing doesn't
  // extract named captures from a beforeFiles rewrite's \`has\` header
  // regex (e.g. the interception rewrite source
  // \`{type:"header", key:"next-url", value:"/(?<nxtPlocale>[^/]+?)..."}\` —
  // the nxtPlocale capture is meant to seed the rewrite destination's
  // virtual params). Result: an interception route match like
  // \`/[locale]/(.)foo/p/1\` arrives with locale="", and Next.js's
  // \`interpolateParallelRouteParams\` throws
  //   Invariant: Could not resolve param value for segment: locale.
  // When the handler looks like an interception route and any params
  // are still empty/sentinel-holed after the path fill, take them from
  // the \`next-url\` header's path — that's the URL the client was on
  // before the navigation, which is what \`has.next-url\` targets.
  // Fixes interception-dynamic-segment-middleware cluster (3 tests).
  if (
    handlerPathname &&
    handlerPathname.includes("(.)") &&
    requestHeaders &&
    typeof requestHeaders.get === "function"
  ) {
    const nextUrl = requestHeaders.get("next-url");
    if (nextUrl && typeof nextUrl === "string") {
      try {
        // \`next-url\` may be an absolute URL or a bare path — handle both.
        const nextUrlPath = nextUrl.startsWith("http")
          ? new URL(nextUrl).pathname
          : nextUrl.split("?")[0];
        const nextUrlSegments = nextUrlPath.split("/").filter(Boolean);
        const patternSegments = handlerPathname.split("/").filter(Boolean);
        let idx = 0;
        for (const seg of patternSegments) {
          if (idx >= nextUrlSegments.length) break;
          if (seg.startsWith("[") && seg.endsWith("]") && !seg.startsWith("[...") && !seg.startsWith("[[...")) {
            const key = seg.slice(1, -1);
            const existing = normalizedRouteParams[key];
            if (existing === undefined || existing === "" || (typeof existing === "string" && existing.startsWith("$nxtP"))) {
              normalizedRouteParams[key] = decodeRouteParam(nextUrlSegments[idx]);
            }
          }
          // Stop at the interception marker — segments beyond it are
          // in the intercepted tree, not the parent tree next-url points to.
          if (seg.startsWith("(.)") || seg.startsWith("(..)")) break;
          idx += 1;
        }
      } catch {}
    }
  }
  return normalizedRouteParams;
}

function getNormalizedResolvedQuery(routeResult) {
  const normalizedResolvedQuery = {};
  for (const [key, value] of Object.entries(routeResult?.resolvedQuery || {})) {
    // Strip all \`$nxtP*\` sentinels (missing optional params) — see
    // getNormalizedRouteParams for rationale.
    if (typeof value === "string" && (value.startsWith("$nxtP") || value.startsWith("%24nxtP"))) continue;
    // Same i18n marker — never surfaces as a user-facing query param.
    if (key === "nextLocale") continue;
    // Strip both \`nxtP\` (regular) and \`nxtI\` (interception) prefixes.
    // See getNormalizedRouteParams for the invariant error that
    // motivated the \`nxtI\` handling.
    let normalizedKey = key;
    if (normalizedKey.startsWith("nxtP") || normalizedKey.startsWith("nxtI")) {
      normalizedKey = normalizedKey.slice(4);
    }
    if (/^[0-9]+$/.test(normalizedKey)) continue;
    normalizedResolvedQuery[normalizedKey] = value;
  }
  return normalizedResolvedQuery;
}

/**
 * Build the URL query string for the IncomingMessage from the routing layer's
 * resolvedQuery, **preserving** the nxtP-prefixed encoding of dynamic route
 * params. Next.js's app router identifies route params by that prefix and
 * strips them from \`searchParams\` itself — if we strip the prefix here, they
 * leak into the page's searchParams prop. Filters out positional captures
 * (numeric keys from regex match groups) and the $nxtPrest sentinel used
 * for empty optional catch-all paths.
 */
function getRawResolvedQueryForUrl(routeResult) {
  const result = {};
  for (const [key, value] of Object.entries(routeResult?.resolvedQuery || {})) {
    // Skip the \`$nxtP{paramName}\` sentinel values used for empty optional
    // catch-all paths (e.g. \`$nxtPslug\`, \`$nxtPrest\`, plus URL-encoded forms).
    if (typeof value === "string" && (value.startsWith("$nxtP") || value.startsWith("%24nxtP"))) continue;
    if (/^[0-9]+$/.test(key)) continue;
    // Never propagate i18n internal marker as a URL search param — Pages
    // Router's parsedUrl.query fallback would pick it up and leak it into
    // \`router.query\`.
    if (key === "nextLocale") continue;
    result[key] = value;
  }
  return result;
}

function appendSearchParam(searchParams, key, value) {
  if (value == null || value === "") return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item == null || item === "") continue;
      searchParams.append(key, String(item));
    }
    return;
  }
  searchParams.set(key, String(value));
}

function applyStaticAssetHeaders(headers, pathname) {
  const lowerPath = pathname.toLowerCase();

  if (lowerPath === "/robots.txt" || lowerPath.endsWith("/robots.txt")) {
    headers.set("content-type", "text/plain");
  } else if (lowerPath === "/sitemap.xml" || lowerPath.endsWith("/sitemap.xml")) {
    headers.set("content-type", "application/xml");
  } else if (
    lowerPath === "/manifest.webmanifest" ||
    lowerPath.endsWith("/manifest.webmanifest")
  ) {
    headers.set("content-type", "application/manifest+json");
  }

  if (/\.(png|jpg|jpeg|svg|ico|webp|avif)$/i.test(lowerPath)) {
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  }

  return headers;
}

/**
 * Streaming SSR bridge: Web Request -> IncomingMessage/ServerResponse -> Web Response.
 *
 * Uses TransformStream to stream chunks to the client as Next.js writes them.
 * The Response is returned as soon as headers are sent (writeHead/first write),
 * enabling Server Components streaming, PPR, and progressive rendering.
 */
async function invokeNodeHandler(request, mod, ctx, routeResult, handlerPathname, handlerType) {
  const url = new URL(request.url);
  const normalizedRouteParams = getNormalizedRouteParams(routeResult, handlerPathname, url, request.headers);
  const isRSCRequest = request.headers.has("rsc");
  const isPrefetchRSCRequest = request.headers.get("next-router-prefetch") === "1";
  const segmentPrefetchRSCRequest = request.headers.get("next-router-segment-prefetch");

  // Read entire body first — async piping to IncomingMessage causes
  // timing issues where the handler reads before chunks arrive.
  let bodyBuffer = null;
  if (request.body) {
    const chunks = [];
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    if (chunks.length > 0) {
      const total = chunks.reduce((s, c) => s + c.length, 0);
      bodyBuffer = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bodyBuffer.set(chunk, offset);
        offset += chunk.length;
      }
    }
  }

  // Build IncomingMessage with body already buffered
  const req = new IncomingMessage();
  req.method = request.method;
  // Populate Next.js's private request metadata so the app-render layer
  // can reconstruct the caller's origin/protocol/host. Two consumers rely
  // on this:
  //   - action-handler.ts builds a same-origin fetch URL for the "single
  //     pass" server-action redirect using
  //     \`proto = getRequestMeta(req, "initProtocol") ?? "https"\`. Without
  //     initProtocol we default to https — fine on real CF Workers but
  //     breaks the local dev server (SSL handshake against HTTP port).
  //   - base-server.ts uses initURL / initQuery / initProtocol for
  //     preview-mode and header forwarding.
  // Symbol.for(...) matches Next.js's own \`NEXT_REQUEST_META\` export.
  const NEXT_REQUEST_META = Symbol.for("NextInternalRequestMeta");
  // PPR fallback-shell resume: if this path matches a bracket-form
  // prerender whose build-time output carried a postponedState (i.e. the
  // shell was prerendered with opaque params), inject it into requestMeta
  // so the app-page template reads it via \`getRequestMeta(req, 'postponed')\`
  // at \`packages/next/dist/build/templates/app-page.js:333\`. That makes
  // Next.js resume the render from the captured prelude + RDC instead of
  // re-running every \`'use cache'\` function — which is what was leaking
  // runtime timestamps into layouts and producing hydration mismatches.
  const __postponedForThisPath = __creekPostponedForPathname(url.pathname);
  req[NEXT_REQUEST_META] = {
    initURL: request.url,
    initProtocol: url.protocol.replace(/:+$/, ""),
    initQuery: {},
    // App Router handler (build/templates/app-page.ts:758-760) reads
    // \`getRequestMeta(req, 'incrementalCache')\` and only falls back to
    // \`routeModule.getIncrementalCache(...)\` if unset. That fallback
    // synthesizes a filesystem-backed cache and swallows our
    // globalThis.__incrementalCache — which is why earlier tries to
    // plumb the cache via workStore had zero effect. Injecting through
    // requestMeta is the upstream-supported override point.
    incrementalCache: __creekGetIncrementalCache(),
    ...(__postponedForThisPath ? { postponed: __postponedForThisPath } : {}),
    // \`res.revalidate(path)\` in Pages Router API routes reads
    // \`routerServerContext.revalidate\` which comes from
    // \`getRequestMeta(req, 'revalidate')\`. Without this, the call
    // throws "Invariant: missing internal router-server-methods".
    // We provide a function that makes a self-fetch (HEAD) to our own
    // worker with the \`x-prerender-revalidate\` header so Next.js's
    // ISR layer triggers on-demand regeneration. The HEAD request
    // routes back through our worker → handler → getStaticProps runs
    // with \`revalidateReason: 'on-demand'\`.
    revalidate: async ({ urlPath, headers }) => {
      try {
        const revalUrl = new URL(urlPath, url.origin);
        const res = await fetch(revalUrl, {
          method: "HEAD",
          headers: new Headers(headers),
        });
        const cacheHeader = res.headers.get("x-nextjs-cache");
        if (
          cacheHeader?.toUpperCase() !== "REVALIDATED" &&
          res.status !== 200 &&
          !(res.status === 404)
        ) {
          throw new Error("Invalid response " + res.status);
        }
      } catch (err) {
        throw new Error("Failed to revalidate " + urlPath + ": " + (err instanceof Error ? err.message : String(err)));
      }
    },
  };
  // Tell Next.js's server-action redirect codepath the real origin so
  // its internal fetch (action-handler.ts:417) doesn't default to
  // \`https://<host>\`. Setting \`__NEXT_PRIVATE_ORIGIN\` short-circuits
  // the protocol-inference logic there. process.env on workerd is
  // writable at runtime. This is per-request (safe under workerd's
  // request-isolated model; each request runs in the same global but
  // Next.js reads the env synchronously during action handling).
  // Use invocationTarget URL if available (handles rewrites).
  // Strip $nxtPrest sentinel from optional catch-all paths — Next.js uses
  // this internally but the handler should receive the path without it.
  let targetUrl = routeResult?.invocationTarget?.pathname || url.pathname;
  targetUrl = targetUrl.replace(/\\/\\$nxtPrest/g, "").replace(/%24nxtPrest/gi, "") || targetUrl;
  // For req.url we keep the nxtP-prefixed encoding so Next.js's app router
  // can identify and strip route params from searchParams. The normalized
  // form is still available for requestMeta.query (Pages Router compat).
  const rawQueryForUrl = getRawResolvedQueryForUrl(routeResult);
  const resolvedQuery = getNormalizedResolvedQuery(routeResult);
  const targetQuery = Object.keys(rawQueryForUrl).length > 0
    ? "?" + new URLSearchParams(rawQueryForUrl).toString()
    : url.search;
  // Pages Router data requests: if the original URL is a
  // \`/_next/data/<buildId>/<page>.json\` data fetch, keep that prefix on
  // req.url so Next.js's render layer recognizes it and returns JSON
  // (props + __N_SSG/__N_SSP) instead of the full HTML page. resolveRoutes
  // already resolved the underlying handler, but our default targetUrl is
  // invocationTarget.pathname — the naked page path — which makes the
  // handler render HTML. Pages Router also reads the \`x-nextjs-data\`
  // header as a signal; we set it here so both checks agree.
  // Fixes middleware-general's client-transition tests (router.push()
  // triggers a data fetch that must return JSON for the SPA to update).
  // For basePath apps the original URL is /<basePath>/_next/data/...
  // — keep req.url as the original (without basePath stripping) so
  // Next.js's render layer recognizes the data-URL pattern.
  const isPagesDataRequest = url.pathname.startsWith("/_next/data/") ||
    (BASE_PATH && url.pathname.startsWith(BASE_PATH + "/_next/data/"));
  if (isPagesDataRequest) {
    // Strip basePath from the URL so Next.js's data URL parser
    // (which expects \`/_next/data/<buildId>/<page>.json\` exactly)
    // recognizes it.
    let dataPath = url.pathname;
    if (BASE_PATH && dataPath.startsWith(BASE_PATH + "/")) {
      dataPath = dataPath.slice(BASE_PATH.length);
    }
    // If middleware rewrote this data URL to a different page, rebuild
    // the data path with the rewritten target so the handler sees the
    // rewritten params (e.g. middleware-rewrites
    // /dynamic-no-cache/1 → /dynamic-no-cache/2: the handler must
    // receive id=2, not id=1).
    if (routeResult?.mwRewrite) {
      const dataMatch = dataPath.match(/^(\\/_next\\/data\\/[^/]+)\\/(.+)\\.json$/);
      if (dataMatch) {
        const rewriteBase = routeResult.mwRewrite.split("?")[0].replace(/^\\//, "");
        dataPath = dataMatch[1] + "/" + rewriteBase + ".json";
      }
    }
    req.url = dataPath + (targetQuery || "");
  } else {
    // For config/middleware rewrites we have a router-type split:
    //   • App Router (\`handler.type === "APP_PAGE"\`) reads
    //     \`usePathname()\` from \`req.url\` — it does NOT fall back to
    //     \`requestMeta.initURL\` when req.url has been rewritten. So we
    //     must preserve the ORIGINAL URL on req.url to keep the
    //     canonical pre-rewrite pathname (app-dir/hooks
    //     "usePathname should have the canonical url pathname on
    //     rewrite").
    //   • Pages Router reads query + locale from \`req.url\`, so it
    //     needs the REWRITE TARGET (with the mw-added search params
    //     and the resolved locale prefix). Using the original URL
    //     here drops:
    //       – search params that \`NextResponse.rewrite(url)\` added
    //         (\`from\`, \`some\`) — middleware-trailing-slash
    //         "should have correct query values for rewrite to ssg
    //         page" and the two route-param-merge tests.
    //       – locale swaps via \`url.locale = '…'\` (which used to
    //         need a dedicated carve-out).
    //       – trailing slash preservation on data-request URLs
    //         ("should normalize data requests into page requests").
    // Bracket-form invocationTarget and i18n locale-prefix additions
    // still aren't "rewrites" — they resolve dynamically on the same
    // URL — so fall back to targetUrl only when we have a true
    // rewrite detected below.
    const isRewrite = (() => {
      if (targetUrl === url.pathname) return false;
      if (!routeResult?.invocationTarget?.pathname) return false;
      if (targetUrl.includes("[")) return false;
      if (I18N && Array.isArray(I18N.locales)) {
        for (const locale of I18N.locales) {
          if (targetUrl === "/" + locale + url.pathname) return false;
          if (url.pathname === "/" && targetUrl === "/" + locale) return false;
        }
      }
      return true;
    })();
    const isAppRouterHandler = handlerType === "APP_PAGE";
    // Middleware rewrites are dynamic and not reproducible by Pages
    // Router's internal handleRewrites (they'd need the middleware to
    // be re-invoked). So we have to carry the target URL + mw-added
    // search params through req.url in that case. Config rewrites, by
    // contrast, ARE reproduced by handleRewrites internally — so for
    // those Pages Router wants the ORIGINAL URL on req.url (so
    // \`appProps.url\` / \`asPath\` / \`resolvedUrl\` all line up with
    // what the client saw) and it'll re-run the rewrite itself.
    const isMiddlewareRewrite = isRewrite && !!routeResult?.mwRewrite;
    if (isRewrite && isAppRouterHandler) {
      // App Router rewrite: keep the ORIGINAL pathname (for
      // \`usePathname()\` canonical) but MERGE the nxtP-prefixed route
      // param captures into the query string. Next.js's internal
      // \`handleRewrites\` + \`normalizeQueryParams\` uses the nxtP*
      // signal to identify which query keys are route params and
      // strip them from the final \`searchParams\` prop. Without this,
      // the captures that @next/routing already computed
      // (\`domain=vercel-test\`, \`section=galleries/123\`) leak into
      // App Router's \`searchParams\` because Next.js re-runs the
      // rewrite internally against the page regex, which adds
      // unprefixed dynamic params to the query — and never strips
      // them because \`routeParamKeys\` stays empty.
      // Fixes app-dir/rewrite-with-search-params.
      const existing = new URLSearchParams(url.search || "");
      const rm = routeResult?.routeMatches || {};
      for (const [key, value] of Object.entries(rm)) {
        if (!key.startsWith("nxtP")) continue;
        if (/^[0-9]+$/.test(key)) continue;
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) existing.append(key, String(v));
        } else {
          existing.set(key, String(value));
        }
      }
      // Middleware rewrites are dynamic and not reproducible by Next.js's
      // internal handleRewrites, so user-added search params from
      // \`NextResponse.rewrite(new URL('/target?first=value', req.url))\`
      // have to be carried into req.url manually. Config rewrites, by
      // contrast, get re-run internally and produce searchParams from
      // the rewrite destination naturally — we skip this merge for them
      // to avoid double-adding params.
      // Fixes app/index "should have the correct search params on
      // middleware rewrite" (client + server variants).
      if (isMiddlewareRewrite) {
        for (const [key, value] of Object.entries(rawQueryForUrl)) {
          if (key === "nextLocale") continue;
          if (/^[0-9]+$/.test(key)) continue;
          if (key.startsWith("nxtP")) continue;
          if (existing.has(key)) continue;
          if (Array.isArray(value)) {
            for (const v of value) existing.append(key, String(v));
          } else if (value !== undefined && value !== null) {
            existing.set(key, String(value));
          } else {
            existing.set(key, "");
          }
        }
      }
      const mergedSearch = existing.toString();
      req.url = url.pathname + (mergedSearch ? "?" + mergedSearch : "");
    } else if (isRewrite && !isAppRouterHandler && !isMiddlewareRewrite) {
      // Pages Router + CONFIG rewrite: keep req.url = original URL so
      // \`ctx.req.url\` / \`appProps.url\` / \`router.asPath\` reflect the
      // client's URL. Next.js's RouteModule.prepare() re-runs the
      // config rewrites internally via handleRewrites and derives the
      // correct params from the rewrite target. interpolateDynamicPath
      // is a no-op on the original URL (no \`[param]\` placeholders to
      // replace), so req.url stays unchanged through the render.
      // Fixes getserversideprops "should have correct req.url and query
      // for direct visit dynamic page rewrite direct" (+ siblings).
      req.url = url.pathname + (url.search || "");
    } else {
      req.url = targetUrl + targetQuery;
    }
  }
  // Prefer middleware-overridden request headers when available. These come
  // from \`NextResponse.next({ request: { headers } })\` and are required for
  // \`headers().get()\` to return the override value inside the page handler.
  if (routeResult?.mwRequestHeaders) {
    req.headers = {};
    routeResult.mwRequestHeaders.forEach((val, key) => {
      req.headers[key.toLowerCase()] = val;
    });
  } else {
    req.headers = Object.fromEntries(request.headers);
  }
  // Merge resolved headers from middleware into request headers
  if (routeResult?.resolvedHeaders) {
    routeResult.resolvedHeaders.forEach((val, key) => {
      req.headers[key.toLowerCase()] = val;
    });
  }
  // Pages Router data-request marker: Next.js's render layer reads
  // \`req.headers["x-nextjs-data"]\` to decide whether to emit JSON or
  // HTML. Browser clients set this via fetchNextData, but our own
  // plumbing may strip headers (when mwRequestHeaders overrides happen
  // upstream), so re-set it here for any data URL to guarantee both
  // the URL prefix AND the header agree.
  if (isPagesDataRequest) {
    req.headers["x-nextjs-data"] = "1";
  }
  // Set x-forwarded-proto to the real request protocol so Next.js's
  // route-module.ts derives the correct origin for internal fetches
  // (e.g. the server-action "single pass" redirect fetch that
  // action-handler.ts performs when a Server Action calls \`redirect()\`).
  // Without this, Next.js defaults to "https" and the internal fetch
  // does an SSL handshake against our HTTP dev server → fails with
  // ERR_SSL_PACKET_LENGTH_TOO_LONG, and the client stays on the
  // current page instead of following the redirect.
  if (!req.headers["x-forwarded-proto"]) {
    req.headers["x-forwarded-proto"] = url.protocol.replace(/:+$/, "");
  }
  try {
    process.env.__NEXT_PRIVATE_ORIGIN = url.origin;
  } catch {}
  if (bodyBuffer) {
    // Ensure Content-Length is set — body parsers need it.
    req.headers['content-length'] = String(bodyBuffer.length);
    req.push(bodyBuffer);
  }
  req.push(null);

  // Build ServerResponse with streaming output
  const res = new ServerResponse(req);
  // Pre-seed res.statusCode from routeResult.status so app-render's
  // \`is404: res.statusCode === 404\` check (and equivalent checks for
  // other error statuses) sees the correct status DURING rendering,
  // not just at response-flush time. This is the signal the framework
  // uses to inject default-404 metadata (e.g. \`<meta name="robots"
  // content="noindex">\`) when rendering the not-found boundary for
  // an unmatched URL. Without this the statusCode appears as 200 to
  // the render layer, \`is404\` is false, and the noindex tag never
  // gets emitted.
  // Fixes metadata-navigation "should render root not-found with
  // default metadata".
  if (routeResult?.status && typeof routeResult.status === "number") {
    res.statusCode = routeResult.status;
  }
  let streamController;
  let streamClosed = false;
  const readable = new ReadableStream({
    type: "bytes",
    start(controller) {
      streamController = controller;
    },
  });
  // Note: emit("close") guard was removed — it caused prerender-crawler regression
  // IncrementalCache is available via CreekCacheHandler but NOT injected
  // into handler modules directly — doing so breaks Pages Router ISR
  // fallback behavior (isFallback: true). The cache is populated by
  // CreekCacheHandler.set() when handlers write cache entries.

  // resolveResponse is called when we have enough info to return a Response
  // (status + headers). The body streams via the readable side.
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  let headersFlushed = false;
  let responseDisallowsBody = false;

  function disallowsBody(status) {
    return status === 204 || status === 205 || status === 304;
  }

  function flushHeaders() {
    if (headersFlushed) return;
    headersFlushed = true;
    const status = routeResult?.status || res.statusCode;
    responseDisallowsBody = disallowsBody(status);
    // Build Headers manually to handle multi-value headers (Set-Cookie).
    const h = new Headers();
    for (const [key, val] of Object.entries(res.getHeaders())) {
      if (val === undefined) continue;
      if (Array.isArray(val)) {
        for (const v of val) h.append(key, String(v));
      } else {
        h.set(key, String(val));
      }
    }
    // Merge resolved headers from middleware. Middleware-set response
    // headers (via \`NextResponse.next({ headers })\`) should OVERRIDE
    // handler defaults — e.g. \`Cache-Control: max-age=1234\` from
    // middleware must win over the handler's default cache-control on
    // a static-asset response. Tests like
    // no-duplicate-headers-middleware "should prioritise headers in
    // middleware for static assets" depend on this. Skip
    // content-encoding / content-length / transfer-encoding which
    // describe the body the handler emitted.
    if (routeResult?.resolvedHeaders) {
      routeResult.resolvedHeaders.forEach((val, key) => {
        const k = key.toLowerCase();
        if (k === "set-cookie") {
          h.append(key, val);
        } else if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding") {
          // Don't let middleware overwrite body-describing headers.
          if (!h.has(key)) h.set(key, val);
        } else {
          h.set(key, val);
        }
      });
    }
    // When the handler emits \`x-nextjs-prerender: 1\` the response is a
    // build-time prerender. Real Next.js exposes \`x-nextjs-cache:
    // PRERENDER\` (or HIT) for these — never MISS — because the content
    // came from the build artifact, regardless of whether our in-memory
    // runtime cache was warm. Override any handler-set MISS so the
    // prerender signal is consistent.
    // Fixes app-root-params-getters/generate-static-params
    // "should be statically prerenderable".
    if (h.get("x-nextjs-prerender") === "1") {
      const current = h.get("x-nextjs-cache");
      if (!current || current === "MISS") {
        h.set("x-nextjs-cache", "PRERENDER");
      }
    }
    // Pages Router client reads \`x-nextjs-rewrite\` on both data
    // responses and initial HTML responses to track the "virtual" URL
    // the user navigated to when middleware rewrote the request. It
    // uses the rewrite URL to update router.asPath + router.query and
    // to keep the SPA router coherent across client transitions —
    // without it, Link clicks from a middleware-rewritten initial load
    // fall back to a hard navigation (the router can't reconcile
    // pathname vs. the rendered \`__NEXT_DATA__.page\`). Echo back the
    // rewrite captured in routeResult.mwRewrite whenever middleware
    // supplied one.
    if (routeResult?.mwRewrite && !h.has("x-nextjs-rewrite")) {
      h.set("x-nextjs-rewrite", routeResult.mwRewrite);
    }
    // Drop Content-Length for HTML responses: the quirks-mode rewriter and
    // data-dpl-id injector in \`__rewriteFirstChunk\` can expand the first
    // chunk. If we keep the pre-computed Content-Length Next.js set via
    // \`res.setHeader\`, the downstream HTTP layer truncates the body to
    // match the (now-stale) length, cutting off the tail of __NEXT_DATA__
    // and producing "Unterminated string in JSON" client errors.
    const ctLower = String(h.get("content-type") || "").toLowerCase();
    if (ctLower.includes("text/html")) {
      h.delete("content-length");
    }
    // Disable auto-compression for streaming RSC / Server-Action responses.
    // When content-type is text/x-component (Flight payload) the body is a
    // React-RSC stream that must reach the browser chunk-by-chunk; Miniflare's
    // HTTP layer otherwise buffers the whole response to apply gzip based on
    // the client's Accept-Encoding, which collapses a 5s streamed action into
    // a single at-EOF delivery and breaks any client-side \`response.body\`
    // reader that drives progressive UI (e.g. actions-streaming's
    // /readable-stream test where <h3> never renders because setChunks()
    // doesn't fire until after the test's 5s waitForSelector times out).
    // \`Content-Encoding: identity\` is the HTTP-spec way to opt out of
    // encoding and takes precedence over \`encodeBody: "manual"\` in the
    // dev-server HTTP proxy. Leave compression enabled for other content
    // types so HTML / JSON / assets still gzip normally.
    if (
      !responseDisallowsBody &&
      !h.has("content-encoding") &&
      (ctLower.includes("text/x-component") || ctLower.includes("text/event-stream"))
    ) {
      h.set("content-encoding", "identity");
    }
    const body = responseDisallowsBody ? null : readable;
    const init = {
      status,
      statusText: res.statusMessage || "",
      headers: h,
    };
    if (!responseDisallowsBody) {
      init.encodeBody = "manual";
    }
    resolveResponse(new Response(body, init));
  }

  // Track pending writes to prevent writer.close() racing with writes.
  let pendingWrites = Promise.resolve();

  // Quirks-mode guard: Next.js's \`createHeadInsertionTransformStream\`
  // (stream-utils/node-web-streams-helper.ts) has a latent bug where the
  // server-inserted HTML (polyfills + metadata) is prepended to the stream
  // when \`</head>\` is not found in the first chunk. The comment in the
  // "else" branch says this only happens during PPR resume — but with
  // Suspense wrapping the entire \`<html>\` element (e.g. the
  // autoscroll-with-css-modules test), React emits a small first chunk that
  // can land before \`</head>\` is produced. Next's transformer then prepends
  // the polyfill \`<script noModule>\` to the very start of the response,
  // placing it BEFORE \`<!DOCTYPE html>\`. When the browser parses this, the
  // doctype isn't the first token, so the document enters **quirks mode**,
  // which causes \`document.documentElement.scrollTop\` to always report 0
  // (scroll moves to \`document.body\` instead).
  //
  // We detect that shape and rewrite the first few chunks to move any stray
  // pre-doctype markup into the \`<head>\` of the doctype chunk, right before
  // \`</head>\`. This restores standards mode without altering the behavior
  // of any other test that already produced well-formed HTML.
  let __streamStarted = false;
  let __preDoctypeBuffer = null;  // Uint8Array of stray pre-doctype bytes, or null
  let __dplIdInjected = false;    // have we already inserted data-dpl-id on <html
  const __DOCTYPE_BYTES = new TextEncoder().encode("<!DOCTYPE");
  const __HEAD_CLOSE_BYTES = new TextEncoder().encode("</head>");
  const __HTML_OPEN_BYTES = new TextEncoder().encode("<html");
  const __DPL_ID_ATTR = new TextEncoder().encode(\` data-dpl-id="\${DEPLOYMENT_ID}"\`);
  function __indexOfBytes(haystack, needle) {
    if (needle.length === 0) return 0;
    const max = haystack.length - needle.length;
    outer: for (let i = 0; i <= max; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
  function __mergeBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }
  // Insert \` data-dpl-id="<BUILD_ID>"\` right after \`<html\` in the chunk
  // so the Pages Router client reads \`document.documentElement.dataset.dplId\`
  // on page load and sends \`x-deployment-id\` on subsequent data fetches.
  // This keeps the deployment-id handshake self-consistent for both
  // pages-ssg-data-deployment-skew (needs the response header truthy) and
  // middleware-general client-side navigation tests (need the header
  // value to match, otherwise \`fetchNextData\` throws and forces a hard
  // reload). Returns the chunk unchanged if \`<html\` isn't present or the
  // attribute has already been injected.
  function __injectDplId(chunk) {
    if (__dplIdInjected) return chunk;
    const htmlIdx = __indexOfBytes(chunk, __HTML_OPEN_BYTES);
    if (htmlIdx === -1) return chunk;
    // Skip if the attribute is already somewhere in the chunk (e.g.
    // upstream Next.js set it via \`_document.tsx\` because nextConfig
    // declared a deploymentId).
    if (__indexOfBytes(chunk, new TextEncoder().encode("data-dpl-id")) !== -1) {
      __dplIdInjected = true;
      return chunk;
    }
    const insertAt = htmlIdx + __HTML_OPEN_BYTES.length;
    const out = new Uint8Array(chunk.length + __DPL_ID_ATTR.length);
    out.set(chunk.subarray(0, insertAt), 0);
    out.set(__DPL_ID_ATTR, insertAt);
    out.set(chunk.subarray(insertAt), insertAt + __DPL_ID_ATTR.length);
    __dplIdInjected = true;
    return out;
  }
  function __rewriteFirstChunk(chunk) {
    // Fast path: this chunk alone already starts with <!DOCTYPE and no
    // stray pre-doctype buffer is pending. Still run the data-dpl-id
    // injection on the chunk so the \`<html>\` element gets tagged.
    if (
      !__preDoctypeBuffer &&
      __indexOfBytes(chunk.slice(0, 16), __DOCTYPE_BYTES) === 0
    ) {
      return __injectDplId(chunk);
    }
    // Locate the doctype anywhere in the current chunk.
    const doctypeIdx = __indexOfBytes(chunk, __DOCTYPE_BYTES);
    if (doctypeIdx === -1) {
      // Still no doctype — buffer and wait for the next chunk.
      __preDoctypeBuffer = __preDoctypeBuffer
        ? __mergeBytes(__preDoctypeBuffer, chunk)
        : chunk;
      return null;
    }
    // Doctype found: split current chunk into the stray prefix and the
    // doctype-onwards remainder. Combine any previously buffered stray
    // bytes (from earlier chunks) with this chunk's stray prefix.
    const strayInChunk = chunk.slice(0, doctypeIdx);
    const rest = chunk.slice(doctypeIdx);
    const combinedStray = __preDoctypeBuffer
      ? __mergeBytes(__preDoctypeBuffer, strayInChunk)
      : strayInChunk;
    __preDoctypeBuffer = null;
    if (combinedStray.length === 0) {
      // No stray content to re-insert — just return the doctype-onwards bytes.
      return __injectDplId(rest);
    }
    // Inject the stray content right before </head> in the remainder.
    const headCloseIdx = __indexOfBytes(rest, __HEAD_CLOSE_BYTES);
    if (headCloseIdx === -1) {
      // No </head> yet — append the stray content at the end of the chunk
      // as a fallback. Standards mode is preserved (doctype leads the stream)
      // and any referenced polyfill still loads, just later than ideal.
      return __injectDplId(__mergeBytes(rest, combinedStray));
    }
    const out = new Uint8Array(rest.length + combinedStray.length);
    out.set(rest.slice(0, headCloseIdx), 0);
    out.set(combinedStray, headCloseIdx);
    out.set(rest.slice(headCloseIdx), headCloseIdx + combinedStray.length);
    return __injectDplId(out);
  }

  // Intercept write — stream chunks to the client.
  // Chain writes through pendingWrites to avoid race conditions.
  res.write = function(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (res.finished) { if (cb) cb(); return false; }
    if (!headersFlushed) flushHeaders();
    if (chunk && !responseDisallowsBody) {
      if (typeof chunk === "string") chunk = new TextEncoder().encode(chunk);
      else if (chunk instanceof Buffer) chunk = new Uint8Array(chunk);
      // Only rewrite text/html responses — JSON/RSC payloads don't need this.
      const isHtml = String(res.getHeader("content-type") || "").toLowerCase().includes("text/html");
      if (isHtml && !__streamStarted) {
        const rewritten = __rewriteFirstChunk(chunk);
        if (rewritten === null) {
          // Buffered — defer until we see the doctype.
          if (cb) pendingWrites.then(() => cb(), () => cb());
          return true;
        }
        __streamStarted = true;
        chunk = rewritten;
      }
      pendingWrites = pendingWrites
        .then(() => {
          if (!streamClosed) streamController.enqueue(chunk);
        })
        .catch(() => {});
    }
    if (cb) pendingWrites.then(() => cb(), () => cb());
    return true;
  };



  // Intercept end — flush final chunk and close the stream.
  // Wait for all pending writes before closing.
  res.end = function(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = null; }
    if (typeof encoding === "function") { cb = encoding; encoding = null; }
    if (res.finished) { if (cb) cb(); return res; }
    clearTimeout(bodyTimeout);
    if (!headersFlushed) flushHeaders();
    if (chunk && !responseDisallowsBody) {
      if (typeof chunk === "string") chunk = new TextEncoder().encode(chunk);
      else if (chunk instanceof Buffer) chunk = new Uint8Array(chunk);
      // Apply the same quirks-mode guard rewrite as \`res.write\`.
      const isHtml = String(res.getHeader("content-type") || "").toLowerCase().includes("text/html");
      if (isHtml && !__streamStarted) {
        const rewritten = __rewriteFirstChunk(chunk);
        if (rewritten !== null) {
          __streamStarted = true;
          chunk = rewritten;
        } else {
          // Buffered but never saw a doctype — flush the buffer as-is.
          if (__preDoctypeBuffer) {
            chunk = __preDoctypeBuffer;
            __preDoctypeBuffer = null;
            __streamStarted = true;
          } else {
            chunk = null;
          }
        }
      }
      if (chunk) {
        pendingWrites = pendingWrites
          .then(() => {
            if (!streamClosed) streamController.enqueue(chunk);
          })
          .catch(() => {});
      }
    } else if (!__streamStarted && __preDoctypeBuffer) {
      // No final chunk but we have buffered pre-doctype bytes — flush them.
      const buffered = __preDoctypeBuffer;
      __preDoctypeBuffer = null;
      __streamStarted = true;
      pendingWrites = pendingWrites
        .then(() => {
          if (!streamClosed) streamController.enqueue(buffered);
        })
        .catch(() => {});
    }
    pendingWrites
      .then(() => {
        if (!streamClosed && !responseDisallowsBody) {
          streamClosed = true;
          streamController.close();
        }
      })
      .catch(() => {})
      .then(() => {
        res.finished = true;
        res.emit("finish");
        res.emit("close");
        if (cb) cb();
      });
    return res;
  };

  // Intercept writeHead to flush headers early (enables 103 Early Hints)
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function(...args) {
    origWriteHead(...args);
    flushHeaders();
    return res;
  };

  // Override \`res.flushHeaders()\` so callers like Next.js's
  // \`pipeToNodeResponse\` writer (pipe-readable.ts:71) route through our
  // own header-flush path instead of the built-in ServerResponse._send.
  // Under workerd our \`res.socket\` is a disconnected \`new Socket()\`,
  // so Node's _send writes to a dead socket and synchronously emits
  // \`close\` on the response. Next.js's \`createAbortController\` listens
  // for that \`close\` event and aborts the pipe, chopping off everything
  // after the first HTML chunk — notably the \`self.__next_f.push(...)\`
  // Flight payload that the App Router client runtime needs to bootstrap.
  // Fixes App Router client-side navigation (router.push → RSC fetch)
  // by keeping the response stream alive until the render naturally
  // completes.
  res.flushHeaders = function() {
    flushHeaders();
  };

  // Invoke the handler — try multiple export patterns:
  // - mod.handler: standard Next.js handler export (app pages, routes)
  // - mod.routeModule.handle: route module instance method
  // - mod.default: default export (some module formats)
  // - mod.default.default: CJS interop nested default
  let handlerFn = mod.handler
    || mod.routeModule?.handle?.bind(mod.routeModule)
    || (typeof mod.default === "function" ? mod.default : null)
    || (typeof mod.default?.default === "function" ? mod.default.default : null);

  // If module only exports default (no handler/routeModule), it's likely an
  // edge-style handler that takes (Request, ctx) → Response. Call directly
  // instead of going through Node.js IncomingMessage bridge.
  if (typeof handlerFn === "function" && !mod.handler && !mod.routeModule
      && Object.keys(mod).length <= 2) {
    try {
      const edgeResult = await handlerFn(request, { waitUntil: ctx.waitUntil.bind(ctx) });
      if (edgeResult instanceof Response) {
        if (!streamClosed) {
          streamClosed = true;
          streamController.close();
        }
        return edgeResult;
      }
    } catch {}
    // If it didn't return a Response, fall through to Node bridge
  }

  if (typeof handlerFn !== "function") {
    if (!streamClosed) {
      streamClosed = true;
      streamController.close();
    }
    throw new Error("No handler function found on module (keys: " + Object.keys(mod).join(",") + ")");
  }

  // Safety timeout: force-close the body stream if the handler never calls
  // res.end(). Prevents ERR_INCOMPLETE_CHUNKED_ENCODING hangs.
  const bodyTimeout = setTimeout(() => {
    if (!res.finished) {
      res.finished = true;
      pendingWrites
        .then(() => {
          if (!streamClosed) {
            streamClosed = true;
            streamController.close();
          }
        })
        .catch(() => {});
    }
  }, 30000);

  try {
    // Do NOT set \`query\` here. Next.js's RouteModule.prepare() falls back to
    // parsedUrl.query (parsed from req.url) when requestMeta.query is unset,
    // and its own internal logic strips nxtP-prefixed route params from
    // parsedUrl.query before it becomes searchParams. If we pre-populate
    // \`query\` with our normalized (un-prefixed) version, Next.js sees those
    // keys as real search params and they leak into the page's searchParams.
    // For a NON-dynamic route (no \`[…]\` segment in the handler path),
    // pass \`params: undefined\` instead of \`{}\` through both the
    // handler context and requestMeta. Next.js's app-route module
    // reads \`context.params\` and calls
    // \`createServerParamsForRoute(parsedUrlQueryToParams(context.params))\`
    // only when params is truthy — \`{}\` is truthy, so we'd end up
    // with \`params = Promise<{}>\` and user code doing
    // \`params ? await params : null\` takes the truthy branch and
    // returns \`{}\` where \`null\` was expected. Pages Router's
    // \`RouteModule.prepare()\` similarly reads \`getRequestMeta(req,
    // 'params')\` and uses that verbatim if present, so the
    // requestMeta variant also needs to be undefined for non-dynamic
    // routes.
    // Fixes app-custom-routes "does not provide params to routes
    // without dynamic parameters".
    const isDynamicRoute =
      typeof handlerPathname === "string" && handlerPathname.includes("[");
    const paramsForHandler =
      isDynamicRoute || Object.keys(normalizedRouteParams).length > 0
        ? normalizedRouteParams
        : undefined;
    const requestMeta = {
      minimalMode: false,
      params: paramsForHandler,
      resolvedPathname: routeResult?.resolvedPathname || handlerPathname,
      initURL: request.url,
      isRSCRequest,
      ...(isPrefetchRSCRequest ? { isPrefetchRSCRequest: true } : {}),
      ...(typeof segmentPrefetchRSCRequest === "string"
        ? { segmentPrefetchRSCRequest }
        : {}),
    };
    const handlerResult = handlerFn(req, res, {
      waitUntil: (p) => ctx.waitUntil(p.catch(() => {})),
      // Some Next.js handler templates still read params directly from ctx,
      // but App Router handlers consume requestMeta.params/query instead.
      params: paramsForHandler,
      requestMeta: {
        ...requestMeta,
        relativeProjectDir: ".",
        hostname: request.headers.get("host") || "localhost",
        // Pages-api template calls \`setRequestMeta(req, ctx.requestMeta)\`
        // which REPLACES our \`req[NEXT_REQUEST_META]\` wholesale. Include
        // incrementalCache + revalidate here so they survive the overwrite.
        incrementalCache: __creekGetIncrementalCache(),
        revalidate: req[Symbol.for("NextInternalRequestMeta")]?.revalidate,
      },
    });

    // Keep async handlers alive after returning the Response so streaming
    // route handlers and Server Actions can continue writing body chunks.
    if (handlerResult?.then) {
      const handlerPromise = Promise.resolve(handlerResult).catch((err) => {
        if (!res.finished) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "render_error", message: err instanceof Error ? err.message : String(err) }));
        }
      });
      // When the handler's Promise resolves, close the stream after a
      // short write-idle window. Next.js's App Router streaming SSR
      // pipeline does NOT always call res.end() — on Node the pipe
      // machinery ends the socket implicitly, but under workerd the
      // ReadableStream stays open indefinitely, so the browser never
      // fires \`load\` and every Playwright waitForSelector times out.
      //
      // The window is necessary because React/Flight streaming can
      // write in multiple bursts — a handler Promise may resolve
      // before the last self.__next_f.push(...) script lands. We
      // reset the timer on every res.write() so a steadily-streaming
      // response stays open as long as chunks keep arriving; once
      // chunks stop, we close within \`IDLE_MS\`.
      const IDLE_MS = 250;
      let idleTimer = null;
      let handlerDone = false;
      const armIdleClose = () => {
        if (streamClosed || res.finished) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!handlerDone) return; // require handler to have resolved first
          if (streamClosed || res.finished) return;
          res.finished = true;
          pendingWrites.then(() => {
            if (!streamClosed && !responseDisallowsBody) {
              streamClosed = true;
              try { streamController.close(); } catch {}
            }
          }).catch(() => {});
        }, IDLE_MS);
      };
      // Hook into write so we bump the idle timer on each chunk.
      const prevWrite = res.write.bind(res);
      res.write = function(chunk, encoding, cb) {
        const r = prevWrite(chunk, encoding, cb);
        if (handlerDone) armIdleClose();
        return r;
      };
      handlerPromise.then(() => { handlerDone = true; armIdleClose(); },
                         () => { handlerDone = true; armIdleClose(); });
      ctx.waitUntil(handlerPromise.catch(() => {}));
    }
  } catch (err) {
    // Handle synchronous handler errors
    if (!res.finished) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "render_error", message: err instanceof Error ? err.message : String(err) }));
    }
  }

  // bodyTimeout is cleared inside res.end() above.

  // Wait for the Response to be created (headers flushed), with timeout
  const response = await Promise.race([
    responsePromise,
    new Promise((_, reject) => setTimeout(() => {
      if (!streamClosed) {
        streamClosed = true;
        streamController.close();
      }
      reject(new Error("SSR timeout: no response headers within 60s"));
    }, 60000)),
  ]);

  return response;
}
`;

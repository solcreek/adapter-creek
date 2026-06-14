import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync } from "node:fs";
import type { NextAdapter } from "next";
import { applyBaseModifyConfig } from "@solcreek/adapter-next-core";
import { handleBuild } from "./build.js";

// Build-time DB driver swaps: in the Workers build only, redirect a local
// SQLite driver import to a Creek shim that backs the same ORM with the
// request's D1 binding (env.DB, resolved lazily). Local dev is untouched —
// the adapter only runs under the Creek build. Aliases are harmless when the
// module isn't imported, so they apply unconditionally.
const SHIMS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "shims");
const DB_DRIVER_ALIASES: Record<string, string> = {
  // Drizzle: `drizzle-orm/better-sqlite3` → D1-backed drizzle. No WASM.
  "drizzle-orm/better-sqlite3$": path.join(SHIMS_DIR, "drizzle-better-sqlite3.js"),
  // The native better-sqlite3 client the user passes to drizzle() — stubbed,
  // since the swap ignores it and uses env.DB. Keeps the native .node out of
  // the Workers bundle.
  "better-sqlite3$": path.join(SHIMS_DIR, "better-sqlite3-stub.js"),
};

// Path to the cache handler shipped by @solcreek/adapter-next-core, resolved
// from THIS module's location — not from the consumer project. The adapter is
// not always installed in the project's own node_modules: the Creek CLI
// lazy-installs it into <project>/.creek/node_modules, which is outside the
// project's require walk. Resolving from import.meta.url walks up from
// wherever the adapter actually lives, so it finds the dependency under npm
// hoisting, pnpm's content-addressed store, and the CLI's .creek install
// alike.
function resolveCacheHandlerPath(): string {
  try {
    return createRequire(import.meta.url).resolve(
      "@solcreek/adapter-next-core/cache-handler",
    );
  } catch {
    // Last resort: assume a flat install in the consumer project.
    return path.join(process.cwd(), "node_modules", "@solcreek", "adapter-next-core", "dist", "cache-handler.js");
  }
}
const fallbackCacheHandlerPath = resolveCacheHandlerPath();

function mirrorCacheHandlerIntoProject(cacheHandlerPath: string): string {
  if (!existsSync(cacheHandlerPath)) return cacheHandlerPath;

  const localPath = path.join(process.cwd(), ".solcreek-cache-handler.mjs");
  if (path.resolve(cacheHandlerPath) === path.resolve(localPath)) return localPath;

  try {
    copyFileSync(cacheHandlerPath, localPath);
    return localPath;
  } catch (err) {
    console.warn(
      `  [Creek Adapter] Failed to mirror cache-handler into project (${
        err instanceof Error ? err.message : String(err)
      }); falling back to ${cacheHandlerPath}`,
    );
    return cacheHandlerPath;
  }
}

const adapter: NextAdapter = {
  name: "adapter-creek",

  modifyConfig(config, ctx) {
    // First apply the shared base — auto-transpile, monorepo tracing
    // root, TS error suppression, cache handler wiring.
    const baseConfig = applyBaseModifyConfig(config, ctx, {
      logLabel: "Creek Adapter",
      cacheHandlerPath: fallbackCacheHandlerPath,
    });

    // Then layer CF-Workers-specific knobs on top. These only apply at
    // production build phase; applyBaseModifyConfig is a passthrough
    // for other phases, so guarding here matches its behaviour.
    if (ctx.phase !== "phase-production-build") return baseConfig;

    // Keep the mirrored handler anchored to this adapter's dependency tree,
    // not the consumer project's shared @solcreek/adapter-next-core copy.
    // For Workers the project-local .solcreek-cache-handler.mjs path is a
    // bundler sentinel: dynamic imports of that path are redirected to the
    // inline CreekCacheHandler in worker-entry. If we mirror an arbitrary
    // project copy here, Node App Page fetch-cache paths can bypass the
    // Workers-specific runtime cache implementation.
    const cacheHandlerPath = mirrorCacheHandlerIntoProject(fallbackCacheHandlerPath);

    return {
      ...baseConfig,
      // Next may dynamically import this cache handler on error/404 render
      // paths. Keep it as a project-local sentinel path instead of a pnpm
      // node_modules realpath; the Workers bundler redirects that sentinel
      // to the inline CreekCacheHandler.
      cacheHandler: cacheHandlerPath,
      // Disable memory cache — CF Workers doesn't have persistent fs.
      // The runtime cache handler is inlined in the worker entry (CreekCacheHandler).
      cacheMaxMemorySize: 0,
      // Cap maxPostponedStateSize so Next.js's zlib inflate (5x this) stays
      // under workerd's 128MB max output length. Default is 100MB → 500MB
      // decompressed → workerd RangeError. 20MB compressed → 100MB decompressed
      // → safely under limit. Real PPR fallback shells are typically ≤ a few
      // KB anyway, so this cap is purely defensive.
      experimental: {
        ...(baseConfig.experimental ?? {}),
        maxPostponedStateSize: "20mb",
      },
      // Swap local SQLite ORM drivers → D1-backed shims (Workers build only).
      // Compose with any webpack fn the base config already set.
      webpack(webpackConfig: any, webpackCtx: any) {
        const cfg =
          typeof (baseConfig as { webpack?: unknown }).webpack === "function"
            ? (baseConfig as { webpack: (c: unknown, x: unknown) => any }).webpack(webpackConfig, webpackCtx)
            : webpackConfig;
        cfg.resolve = cfg.resolve ?? {};
        cfg.resolve.alias = { ...(cfg.resolve.alias ?? {}), ...DB_DRIVER_ALIASES };
        return cfg;
      },
    };
  },

  async onBuildComplete(ctx) {
    await handleBuild(ctx);
  },
};

export default adapter;

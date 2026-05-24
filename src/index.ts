import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync } from "node:fs";
import type { NextAdapter } from "next";
import { applyBaseModifyConfig } from "@solcreek/adapter-next-core";
import { handleBuild } from "./build.js";

// Dev-fallback path to the cache handler shipped by @solcreek/adapter-next-core.
// applyBaseModifyConfig prefers the node_modules-installed copy when one
// exists (the production path); this resolves the package's own bundled
// copy as a last resort for the rare case where the adapter is used
// without `npm install`ing it.
const coreEntryUrl = new URL(
  "../node_modules/@solcreek/adapter-next-core/dist/cache-handler.js",
  import.meta.url,
);
const fallbackCacheHandlerPath = existsSync(fileURLToPath(coreEntryUrl))
  ? fileURLToPath(coreEntryUrl)
  : path.join(process.cwd(), "node_modules", "@solcreek", "adapter-next-core", "dist", "cache-handler.js");

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

    const resolvedBaseCacheHandlerPath =
      typeof baseConfig.cacheHandler === "string"
        ? baseConfig.cacheHandler
        : fallbackCacheHandlerPath;
    const cacheHandlerPath = mirrorCacheHandlerIntoProject(
      resolvedBaseCacheHandlerPath,
    );

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
    };
  },

  async onBuildComplete(ctx) {
    await handleBuild(ctx);
  },
};

export default adapter;

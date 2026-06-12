import * as path from "node:path";
import { createRequire } from "node:module";
import { copyFileSync, existsSync } from "node:fs";
import type { NextAdapter } from "next";
import { applyBaseModifyConfig } from "@solcreek/adapter-next-core";
import { handleBuild } from "./build.js";

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
    };
  },

  async onBuildComplete(ctx) {
    await handleBuild(ctx);
  },
};

export default adapter;

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { NextAdapter } from "next";
import { applyBaseModifyConfig } from "@solcreek/adapter-core";
import { handleBuild } from "./build.js";

// Dev-fallback path to the cache handler shipped by @solcreek/adapter-core.
// applyBaseModifyConfig prefers the node_modules-installed copy when one
// exists (the production path); this resolves the package's own bundled
// copy as a last resort for the rare case where the adapter is used
// without `npm install`ing it.
const coreEntryUrl = new URL(
  "../node_modules/@solcreek/adapter-core/dist/cache-handler.js",
  import.meta.url,
);
const fallbackCacheHandlerPath = existsSync(fileURLToPath(coreEntryUrl))
  ? fileURLToPath(coreEntryUrl)
  : path.join(process.cwd(), "node_modules", "@solcreek", "adapter-core", "dist", "cache-handler.js");

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

    return {
      ...baseConfig,
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

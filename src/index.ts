import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { NextAdapter } from "next";
import { handleBuild } from "./build.js";

/**
 * Detect the monorepo root by walking up looking for workspace markers.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (
      existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      existsSync(path.join(dir, "turbo.json"))
    ) {
      return dir;
    }
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

const cacheHandlerPath = fileURLToPath(new URL("./cache-handler.js", import.meta.url));

const adapter: NextAdapter = {
  name: "adapter-creek",

  modifyConfig(config, { phase }) {
    if (phase !== "phase-production-build") return config;

    const projectDir = process.cwd();
    const repoRoot = findRepoRoot(projectDir);
    const isMonorepo = repoRoot !== projectDir;
    const installedCacheHandlerPath = path.join(
      projectDir,
      "node_modules",
      "@solcreek",
      "adapter-creek",
      "dist",
      "cache-handler.js",
    );
    const resolvedCacheHandlerPath = existsSync(installedCacheHandlerPath)
      ? installedCacheHandlerPath
      : cacheHandlerPath;

    return {
      ...config,
      // Disable memory cache — CF Workers doesn't have persistent fs.
      cacheMaxMemorySize: 0,
      // Route/ISR cache must avoid the default filesystem-backed handler.
      cacheHandler: config.cacheHandler || resolvedCacheHandlerPath,
      // Skip TypeScript type checking during build — CF Workers adapter
      // builds run `next build` where TS errors block the build. Type
      // checking should happen before deployment, not during bundling.
      typescript: { ...config.typescript, ignoreBuildErrors: true },
      // Monorepo: set tracing root so Next.js traces deps from repo root
      ...(isMonorepo && {
        outputFileTracingRoot: repoRoot,
      }),
    };
  },

  async onBuildComplete(ctx) {
    await handleBuild(ctx);
  },
};

export default adapter;

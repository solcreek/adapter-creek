import * as path from "node:path";
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

const adapter: NextAdapter = {
  name: "adapter-creek",

  modifyConfig(config, { phase }) {
    if (phase !== "phase-production-build") return config;

    const projectDir = process.cwd();
    const repoRoot = findRepoRoot(projectDir);
    const isMonorepo = repoRoot !== projectDir;

    // Copy cache handler into the project directory so Turbopack can resolve it.
    // Turbopack rejects paths outside the project root.
    const { copyFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const adapterDir = path.dirname(new URL(import.meta.url).pathname);
    const creekDir = path.join(projectDir, ".creek");
    mkdirSync(creekDir, { recursive: true });
    copyFileSync(
      path.join(adapterDir, "cache-handler.js"),
      path.join(creekDir, "cache-handler.js"),
    );
    const cacheHandlerPath = path.join(creekDir, "cache-handler.js");

    return {
      ...config,
      cacheHandler: cacheHandlerPath,
      cacheMaxMemorySize: 0,
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import adapter from "./index.js";

describe("adapter modifyConfig", () => {
  let originalCwd: string;
  let projectDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(path.join(tmpdir(), "adapter-creek-config-"));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("keeps the Workers cache handler sentinel target-owned", () => {
    const fakeCoreRoot = path.join(
      projectDir,
      "node_modules",
      "@solcreek",
      "adapter-next-core",
    );
    mkdirSync(path.join(fakeCoreRoot, "dist"), { recursive: true });
    writeFileSync(
      path.join(fakeCoreRoot, "package.json"),
      JSON.stringify({
        name: "@solcreek/adapter-next-core",
        type: "module",
        exports: {
          "./cache-handler": {
            default: "./dist/cache-handler.js",
          },
        },
      }),
    );
    writeFileSync(
      path.join(fakeCoreRoot, "dist", "cache-handler.js"),
      "export const marker = 'project-level-core-handler';",
    );

    const config = adapter.modifyConfig?.(
      {},
      { phase: "phase-production-build" } as never,
    );

    const sentinelPath = path.join(projectDir, ".solcreek-cache-handler.mjs");
    expect(realpathSync(String(config?.cacheHandler))).toBe(
      realpathSync(sentinelPath),
    );
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(sentinelPath, "utf8")).not.toContain(
      "project-level-core-handler",
    );
  });

  // Reproduces the Creek CLI lazy-install layout: the CLI installs the
  // adapter into <project>/.creek/node_modules (npm-hoisted, so
  // adapter-next-core sits as a SIBLING of adapter-creek), and the project's
  // own node_modules has no @solcreek packages. The cache handler must be
  // resolved from the adapter's own install tree — resolution from the
  // project directory can never reach .creek/node_modules.
  it("resolves the cache handler when lazy-installed under .creek/node_modules", async () => {
    const scopeDir = path.join(projectDir, ".creek", "node_modules", "@solcreek");
    const adapterDist = path.join(scopeDir, "adapter-creek", "dist");
    const coreDir = path.join(scopeDir, "adapter-next-core");
    mkdirSync(adapterDist, { recursive: true });
    mkdirSync(path.join(coreDir, "dist"), { recursive: true });

    // Transpile the real src/index.ts into the fake layout so import.meta.url
    // points inside .creek; stub its two runtime imports.
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const transpiled = ts.transpileModule(
      readFileSync(path.join(srcDir, "index.ts"), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    writeFileSync(
      path.join(scopeDir, "adapter-creek", "package.json"),
      JSON.stringify({ name: "@solcreek/adapter-creek", type: "module" }),
    );
    writeFileSync(path.join(adapterDist, "index.js"), transpiled);
    writeFileSync(
      path.join(adapterDist, "build.js"),
      "export async function handleBuild() {}",
    );

    writeFileSync(
      path.join(coreDir, "package.json"),
      JSON.stringify({
        name: "@solcreek/adapter-next-core",
        type: "module",
        exports: {
          ".": { default: "./dist/index.js" },
          "./cache-handler": { default: "./dist/cache-handler.js" },
        },
      }),
    );
    // Stand-in for applyBaseModifyConfig's fallback behaviour when nothing is
    // resolvable from the project: keep the adapter-supplied handler path.
    writeFileSync(
      path.join(coreDir, "dist", "index.js"),
      "export function applyBaseModifyConfig(config, ctx, opts) { return { ...config, cacheHandler: opts.cacheHandlerPath }; }",
    );
    writeFileSync(
      path.join(coreDir, "dist", "cache-handler.js"),
      "export const marker = 'creek-lazy-install-handler';",
    );

    const mod = await import(
      pathToFileURL(path.join(adapterDist, "index.js")).href
    );
    const config = mod.default.modifyConfig(
      {},
      { phase: "phase-production-build" },
    );

    const sentinelPath = path.join(projectDir, ".solcreek-cache-handler.mjs");
    expect(realpathSync(String(config.cacheHandler))).toBe(
      realpathSync(sentinelPath),
    );
    expect(readFileSync(sentinelPath, "utf8")).toContain(
      "creek-lazy-install-handler",
    );
  });
});

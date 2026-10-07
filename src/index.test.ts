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

import adapter, { assertD1SwapApplies, d1SwapDependencies } from "./index.js";

describe("Turbopack guard for the SQLite-to-D1 swap", () => {
  let saved: string | undefined;
  let originalCwd: string;
  let dir: string;
  beforeEach(() => {
    saved = process.env.TURBOPACK;
    originalCwd = process.cwd();
    dir = mkdtempSync(path.join(tmpdir(), "adapter-creek-guard-"));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TURBOPACK;
    else process.env.TURBOPACK = saved;
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const writePkg = (pkg: object) => writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));

  it("finds the swap packages in dependencies and devDependencies", () => {
    writePkg({
      dependencies: { next: "16.2.3", "@prisma/adapter-better-sqlite3": "7.8.0" },
      devDependencies: { "better-sqlite3": "12.0.0" },
    });
    expect(d1SwapDependencies(dir)).toEqual(["better-sqlite3", "@prisma/adapter-better-sqlite3"]);
  });

  it("finds none in a project without them, or without a package.json", () => {
    writePkg({ dependencies: { next: "16.2.3", "drizzle-orm": "0.44.0", "@prisma/client": "7.8.0" } });
    expect(d1SwapDependencies(dir)).toEqual([]);
    expect(d1SwapDependencies(path.join(dir, "missing"))).toEqual([]);
  });

  it("accepts a webpack build of a project that relies on the swap", () => {
    expect(() => assertD1SwapApplies({}, ["better-sqlite3"])).not.toThrow();
  });

  it("accepts a Turbopack build of a project that does not rely on the swap", () => {
    // The Next.js deploy suite builds its fixtures under Turbopack.
    expect(() => assertD1SwapApplies({ TURBOPACK: "1" }, [])).not.toThrow();
  });

  it.each(["1", "auto"])("refuses a Turbopack build (TURBOPACK=%s) of a project that relies on the swap", (value) => {
    // "1": `next build --turbopack`; "auto": plain `next build`, Turbopack by default.
    expect(() => assertD1SwapApplies({ TURBOPACK: value }, ["@prisma/adapter-d1"])).toThrow(
      /depends on @prisma\/adapter-d1\..*Build with `next build --webpack`/,
    );
  });

  it("stops such a production build in modifyConfig, before anything is bundled", () => {
    writePkg({ dependencies: { "better-sqlite3": "12.0.0" } });
    process.chdir(dir);
    process.env.TURBOPACK = "auto";
    expect(() => adapter.modifyConfig?.({}, { phase: "phase-production-build" } as never)).toThrow(
      /\[Creek Adapter\] This build uses Turbopack \(TURBOPACK=auto\), and the project depends on better-sqlite3/,
    );
  });

  it("lets a Turbopack production build of any other project through modifyConfig", () => {
    writePkg({ dependencies: { next: "16.2.3" } });
    process.chdir(dir);
    process.env.TURBOPACK = "auto";
    expect(() => adapter.modifyConfig?.({}, { phase: "phase-production-build" } as never)).not.toThrow();
  });

  it("leaves next dev alone, which runs Turbopack by default", () => {
    writePkg({ dependencies: { "better-sqlite3": "12.0.0" } });
    process.chdir(dir);
    process.env.TURBOPACK = "auto";
    expect(() => adapter.modifyConfig?.({}, { phase: "phase-development-server" } as never)).not.toThrow();
  });
});

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

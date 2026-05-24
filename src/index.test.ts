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
});

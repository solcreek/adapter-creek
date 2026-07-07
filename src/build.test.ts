import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { collectManifests, countNativeModuleRefs, dedupeWasmByContent } from "./build.js";

// Regression for the misleading "N native modules" hint: an oversized bundle
// whose real cause was a stale `.next/dev` reported dozens of phantom natives
// because the count matched bare `.node` property access. The count must only
// see quoted `.node` filenames (actual inlined binaries).
describe("countNativeModuleRefs", () => {
  it("does not count bare member access like tree.node / this.node", () => {
    const js = "const a = tree.node; if (this.node) walk(parent.node);";
    expect(countNativeModuleRefs(js)).toBe(0);
  });

  it("counts quoted .node filenames (require / path strings)", () => {
    const js = `require("build/Release/better_sqlite3.node"); const p = 'a/b/sharp.node';`;
    expect(countNativeModuleRefs(js)).toBe(2);
  });

  it("ignores .node that merely appears inside a longer string", () => {
    expect(countNativeModuleRefs(`const s = "see foo.node for details";`)).toBe(0);
  });

  it("mixes real refs and property access without double-counting", () => {
    const js = `x.node; require("better_sqlite3.node"); y.node; load("z.node");`;
    expect(countNativeModuleRefs(js)).toBe(2);
  });
});

// Regression: a stale `.next/dev` (Turbopack dev-server output left by
// `npm run dev`) must never be scanned into the worker — a real deploy bundled
// it and produced a 202MB worker.js.
describe("collectManifests", () => {
  let distDir: string;

  beforeEach(() => {
    distDir = mkdtempSync(path.join(tmpdir(), "creek-next-"));
  });
  afterEach(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  function writeJson(rel: string, content: unknown) {
    const full = path.join(distDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(content));
  }

  it("collects production server manifests", () => {
    writeJson("server/app-paths-manifest.json", { ok: true });
    writeJson("routes-manifest.json", { version: 3 });
    return collectManifests(distDir).then((m) => {
      const keys = Object.keys(m).map((k) => path.relative(distDir, k));
      expect(keys).toContain("server/app-paths-manifest.json");
      expect(keys).toContain("routes-manifest.json");
    });
  });

  it("never scans .next/dev (stale Turbopack dev output)", async () => {
    writeJson("server/app-paths-manifest.json", { ok: true });
    // Simulate stale dev output with its own manifests.
    writeJson("dev/server/app-build-manifest.json", { dev: true });
    writeJson("dev/static/chunks/manifest.json", { dev: true });

    const m = await collectManifests(distDir);
    const keys = Object.keys(m).map((k) => path.relative(distDir, k));
    expect(keys).toContain("server/app-paths-manifest.json"); // prod kept
    expect(keys.some((k) => k.startsWith("dev/"))).toBe(false); // dev skipped
  });

  it("still skips the other large non-manifest dirs", async () => {
    writeJson("server/x-manifest.json", {});
    writeJson("static/chunks/a.json", {});
    writeJson("cache/b.json", {});
    const m = await collectManifests(distDir);
    const keys = Object.keys(m).map((k) => path.relative(distDir, k));
    expect(keys.some((k) => k.startsWith("static/") || k.startsWith("cache/"))).toBe(false);
  });
});

describe("dedupeWasmByContent", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wasm-dedup-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, bytes: Buffer): [string, string] {
    const p = path.join(dir, name);
    writeFileSync(p, bytes);
    return [name, p];
  }

  it("drops the duplicate-byte wasm, keeping the staged Prisma name", async () => {
    // The real B11 case: Next traces query_compiler_fast_bg.wasm (added first),
    // collectPrismaCompilerWasm stages identical bytes as …sqlite.wasm (last).
    const prismaBytes = Buffer.from("PRISMA_QUERY_COMPILER_BYTES");
    const wasmFiles = new Map([
      write("query_compiler_fast_bg.wasm", prismaBytes),
      write("resvg.wasm", Buffer.from("A_DIFFERENT_WASM")),
      write("query_compiler_fast_bg.sqlite.wasm", prismaBytes),
    ]);

    const dropped = await dedupeWasmByContent(wasmFiles, "query_compiler_fast_bg.sqlite.wasm");

    expect(dropped).toBe(1);
    expect([...wasmFiles.keys()].sort()).toEqual([
      "query_compiler_fast_bg.sqlite.wasm",
      "resvg.wasm",
    ]);
  });

  it("keeps the first-seen when neither duplicate is the staged Prisma wasm", async () => {
    const bytes = Buffer.from("SAME_BYTES");
    const wasmFiles = new Map([write("a.wasm", bytes), write("b.wasm", bytes)]);

    const dropped = await dedupeWasmByContent(wasmFiles, null);

    expect(dropped).toBe(1);
    expect([...wasmFiles.keys()]).toEqual(["a.wasm"]);
  });

  it("leaves distinct-content wasm untouched", async () => {
    const wasmFiles = new Map([
      write("x.wasm", Buffer.from("XXXX")),
      write("y.wasm", Buffer.from("YYYY")),
    ]);

    const dropped = await dedupeWasmByContent(wasmFiles, null);

    expect(dropped).toBe(0);
    expect(wasmFiles.size).toBe(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { collectManifests } from "./build.js";

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

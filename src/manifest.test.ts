import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeManifest } from "./manifest";
import { WORKER_COMPATIBILITY_DATE, WORKER_COMPATIBILITY_FLAGS } from "./compat";

// These guard the bug that shipped to the sandbox deploy path: the worker
// statically imports node:http, whose server modules are only available on
// `nodejs_compat` (not `nodejs_compat_v2`) at a compatibility_date that
// auto-enables `enable_nodejs_http_server_modules` (>= 2025-09-01). The
// manifest is the contract the Creek CLI deploys against, so it must carry
// exactly what the bundle was built with.
describe("worker compatibility settings", () => {
  it("uses nodejs_compat, never nodejs_compat_v2", () => {
    expect(WORKER_COMPATIBILITY_FLAGS).toContain("nodejs_compat");
    expect(WORKER_COMPATIBILITY_FLAGS).not.toContain("nodejs_compat_v2");
  });

  it("pins a compatibility_date >= 2025-09-01 (node:http server modules)", () => {
    // ISO yyyy-mm-dd strings sort lexicographically.
    expect(WORKER_COMPATIBILITY_DATE >= "2025-09-01").toBe(true);
  });
});

describe("writeManifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "creek-manifest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits the shared worker compat date/flags (deploy matches build)", async () => {
    await writeManifest(dir, {
      buildId: "b1",
      nextVersion: "16.2.9",
      entrypoint: "worker.js",
      serverFiles: ["worker.js"],
      hasMiddleware: false,
      hasPrerender: false,
    });
    const manifest = JSON.parse(
      readFileSync(path.join(dir, "manifest.json"), "utf-8"),
    );
    expect(manifest.compatibilityFlags).toEqual([...WORKER_COMPATIBILITY_FLAGS]);
    expect(manifest.compatibilityDate).toBe(WORKER_COMPATIBILITY_DATE);
    expect(manifest.compatibilityFlags).not.toContain("nodejs_compat_v2");
    expect(manifest.framework).toBe("nextjs");
    expect(manifest.doBindings).toBe(true);
  });
});

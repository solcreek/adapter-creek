import { describe, expect, it } from "vitest";
import { evaluateBundleSize, WORKER_SIZE_LIMIT, WORKER_SIZE_WARN_RATIO } from "./bundle-size.js";

const MiB = 1024 * 1024;

describe("evaluateBundleSize", () => {
  it("is ok well under the limit", () => {
    const v = evaluateBundleSize([
      { name: "worker.js", size: 1.5 * MiB },
      { name: "x.wasm", size: 1.0 * MiB },
    ]);
    expect(v.level).toBe("ok");
    expect(v.message).toBeNull();
    expect(v.totalSize).toBe(2.5 * MiB);
  });

  // Regression: the old guard measured gzip against 3 MB (free) / 10 MB (paid)
  // and failed builds Cloudflare now accepts.
  it("accepts bundles past the retired 3 MB / 10 MB gzipped limits", () => {
    expect(evaluateBundleSize([{ name: "worker.js", size: 4 * MiB }]).level).toBe("ok");
    expect(evaluateBundleSize([{ name: "worker.js", size: 20 * MiB }]).level).toBe("ok");
  });

  it("is ok just under the warn threshold", () => {
    const v = evaluateBundleSize([{ name: "worker.js", size: 48 * MiB - 1 }]);
    expect(v.level).toBe("ok");
  });

  it("warns (not errors) at the warn threshold", () => {
    const v = evaluateBundleSize([{ name: "worker.js", size: 48 * MiB }]);
    expect(v.level).toBe("near-limit");
    expect(v.message).toMatch(/75% of the 64\.0 MiB Cloudflare Workers script limit/);
  });

  it("warns near the limit and surfaces the largest files", () => {
    const v = evaluateBundleSize([
      { name: "worker.js", size: 50 * MiB },
      { name: "compiler.wasm", size: 4 * MiB },
    ]);
    expect(v.level).toBe("near-limit");
    expect(v.message).toMatch(/54\.0 MiB uncompressed/);
    expect(v.message).toMatch(/worker\.js — 50\.0 MiB/);
    expect(v.message).toMatch(/compiler\.wasm — 4\.0 MiB/);
  });

  it("allows a bundle exactly at the limit", () => {
    const v = evaluateBundleSize([{ name: "worker.js", size: WORKER_SIZE_LIMIT }]);
    expect(v.level).toBe("near-limit");
  });

  it("flags over-limit one byte past the limit", () => {
    const v = evaluateBundleSize([{ name: "worker.js", size: WORKER_SIZE_LIMIT + 1 }]);
    expect(v.level).toBe("over-limit");
    expect(v.message).toMatch(/over the Cloudflare Workers script limit \(64\.0 MiB\)/);
  });

  it("sums every file, so modules individually under the limit can still be over", () => {
    const v = evaluateBundleSize([
      { name: "worker.js", size: 40 * MiB },
      { name: "compiler.wasm", size: 30 * MiB },
    ]);
    expect(v.level).toBe("over-limit");
    expect(v.totalSize).toBe(70 * MiB);
    expect(v.message).toMatch(/70\.0 MiB uncompressed/);
  });

  it("lists likely causes (stale .next/dev + native module) and a clean-build remedy", () => {
    const v = evaluateBundleSize([{ name: "worker.js", size: 200 * MiB }], { nativeRefs: 310 });
    expect(v.level).toBe("over-limit");
    expect(v.message).toMatch(/\.next\/dev/);              // the real-world top cause
    expect(v.message).toMatch(/better-sqlite3/);
    expect(v.message).toMatch(/CK-SYNC-SQLITE/);
    expect(v.message).toMatch(/rm -rf \.next \.creek/);     // remedy clears .next too
    expect(v.message).toMatch(/310 inlined native-module reference/); // softened, parenthetical
  });

  it("omits the .node parenthetical when there are no native-module references", () => {
    const v = evaluateBundleSize([{ name: "worker.js", size: 200 * MiB }], { nativeRefs: 0 });
    expect(v.level).toBe("over-limit");
    expect(v.message).not.toMatch(/native-module reference/);
  });

  it("does not mention native modules on a near-limit warning", () => {
    const v = evaluateBundleSize([{ name: "worker.js", size: 60 * MiB }], { nativeRefs: 5 });
    expect(v.level).toBe("near-limit");
    expect(v.message).not.toMatch(/native-module reference/);
  });

  it("lists at most the three largest files", () => {
    const v = evaluateBundleSize([
      { name: "a.js", size: 30 * MiB },
      { name: "b.wasm", size: 20 * MiB },
      { name: "c.js", size: 10 * MiB },
      { name: "d.js", size: 5 * MiB },
    ]);
    expect(v.level).toBe("over-limit");
    expect(v.message).toMatch(/a\.js/);
    expect(v.message).toMatch(/b\.wasm/);
    expect(v.message).toMatch(/c\.js/);
    expect(v.message).not.toMatch(/d\.js/); // 4th largest is omitted
  });

  it("treats an empty file list as ok", () => {
    const v = evaluateBundleSize([]);
    expect(v.level).toBe("ok");
    expect(v.totalSize).toBe(0);
  });

  it("respects a custom limit and warn ratio", () => {
    expect(evaluateBundleSize([{ name: "w.js", size: 2 * MiB }], { limit: 1.5 * MiB }).level).toBe(
      "over-limit",
    );
    expect(
      evaluateBundleSize([{ name: "w.js", size: 1 * MiB }], { limit: 2 * MiB, warnRatio: 0.5 }).level,
    ).toBe("near-limit");
    expect(
      evaluateBundleSize([{ name: "w.js", size: 1 * MiB }], { limit: 2 * MiB, warnRatio: 0.9 }).level,
    ).toBe("ok");
  });

  it("exposes the real Workers limit as a constant", () => {
    // 64 MiB uncompressed, all plans — verified 2026-10-07 against a dispatch namespace.
    expect(WORKER_SIZE_LIMIT).toBe(64 * MiB);
    expect(WORKER_SIZE_WARN_RATIO).toBe(0.75);
  });
});

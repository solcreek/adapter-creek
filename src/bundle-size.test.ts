import { describe, expect, it } from "vitest";
import { evaluateBundleSize, WFP_FREE_LIMIT, WFP_PAID_LIMIT } from "./bundle-size.js";

const MB = 1024 * 1024;

describe("evaluateBundleSize", () => {
  it("is ok at or under the free limit", () => {
    const v = evaluateBundleSize([
      { name: "worker.js", gzipSize: 1.5 * MB },
      { name: "x.wasm", gzipSize: 1.0 * MB },
    ]);
    expect(v.level).toBe("ok");
    expect(v.message).toBeNull();
    expect(v.totalGzip).toBe(2.5 * MB);
  });

  it("warns (not errors) when over free but within paid", () => {
    const v = evaluateBundleSize([
      { name: "worker.js", gzipSize: 4 * MB },
      { name: "compiler.wasm", gzipSize: 1.2 * MB },
    ]);
    expect(v.level).toBe("free-warning");
    expect(v.message).toMatch(/free-plan limit/);
    // Largest file is surfaced.
    expect(v.message).toMatch(/worker\.js — 4\.0 MB/);
  });

  it("flags over-limit past the paid ceiling", () => {
    const v = evaluateBundleSize([{ name: "worker.js", gzipSize: 50 * MB }]);
    expect(v.level).toBe("over-limit");
    expect(v.message).toMatch(/over the Cloudflare Workers script limit/);
    expect(v.message).toMatch(/50\.0 MB/);
  });

  it("lists likely causes (stale .next/dev + native module) and a clean-build remedy", () => {
    const v = evaluateBundleSize([{ name: "worker.js", gzipSize: 60 * MB }], { nativeRefs: 310 });
    expect(v.level).toBe("over-limit");
    expect(v.message).toMatch(/\.next\/dev/);              // the real-world top cause
    expect(v.message).toMatch(/better-sqlite3/);
    expect(v.message).toMatch(/CK-SYNC-SQLITE/);
    expect(v.message).toMatch(/rm -rf \.next \.creek/);     // remedy now clears .next too
    expect(v.message).toMatch(/310 inlined native-module reference/); // softened, parenthetical
  });

  it("omits the .node parenthetical when there are no native-module references", () => {
    const v = evaluateBundleSize([{ name: "worker.js", gzipSize: 60 * MB }], { nativeRefs: 0 });
    expect(v.level).toBe("over-limit");
    expect(v.message).not.toMatch(/native-module reference/);
  });

  it("lists at most the three largest files", () => {
    const v = evaluateBundleSize([
      { name: "a.js", gzipSize: 5 * MB },
      { name: "b.wasm", gzipSize: 4 * MB },
      { name: "c.js", gzipSize: 3 * MB },
      { name: "d.js", gzipSize: 2 * MB },
    ]);
    expect(v.level).toBe("over-limit");
    expect(v.message).toMatch(/a\.js/);
    expect(v.message).toMatch(/b\.wasm/);
    expect(v.message).toMatch(/c\.js/);
    expect(v.message).not.toMatch(/d\.js/); // 4th largest is omitted
  });

  it("respects custom limits", () => {
    const v = evaluateBundleSize([{ name: "w.js", gzipSize: 2 * MB }], {
      freeLimit: 1 * MB,
      paidLimit: 1.5 * MB,
    });
    expect(v.level).toBe("over-limit");
  });

  it("exposes the real Workers limits as constants", () => {
    expect(WFP_FREE_LIMIT).toBe(3 * MB);
    expect(WFP_PAID_LIMIT).toBe(10 * MB);
  });
});

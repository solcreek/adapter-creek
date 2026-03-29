import { describe, it, expect, beforeEach } from "vitest";

// The cache handler uses module.exports (CJS), import the compiled version
// For testing, we replicate the interface here
let CacheHandler: any;

beforeEach(async () => {
  // Dynamic import to get a fresh module each test suite
  const mod = await import("./cache-handler.js");
  CacheHandler = mod.default || mod;
});

describe("CacheHandler", () => {
  it("returns null for missing keys", async () => {
    const handler = new CacheHandler();
    const result = await handler.get("nonexistent");
    expect(result).toBeNull();
  });

  it("stores and retrieves values", async () => {
    const handler = new CacheHandler();
    await handler.set("test-key", { kind: "APP_PAGE", html: "<h1>hello</h1>" }, { tags: ["tag1"] });
    const result = await handler.get("test-key");
    expect(result).not.toBeNull();
    expect(result.value.html).toBe("<h1>hello</h1>");
    expect(result.cacheState).toBe("fresh");
  });

  it("marks stale entries based on revalidate time", async () => {
    const handler = new CacheHandler();
    await handler.set("stale-key", { kind: "APP_PAGE", html: "old" }, {
      tags: [],
      revalidate: 0, // immediately stale
    });

    // Wait a tick for the entry to become stale
    await new Promise((r) => setTimeout(r, 10));

    const result = await handler.get("stale-key");
    expect(result).not.toBeNull();
    expect(result.cacheState).toBe("stale");
  });

  it("invalidates entries by tag", async () => {
    const handler = new CacheHandler();
    await handler.set("a", { html: "a" }, { tags: ["shared"] });
    await handler.set("b", { html: "b" }, { tags: ["shared", "extra"] });
    await handler.set("c", { html: "c" }, { tags: ["other"] });

    await handler.revalidateTag("shared");

    expect(await handler.get("a")).toBeNull();
    expect(await handler.get("b")).toBeNull();
    expect(await handler.get("c")).not.toBeNull();
  });

  it("invalidates by multiple tags at once", async () => {
    const handler = new CacheHandler();
    await handler.set("x", { html: "x" }, { tags: ["t1"] });
    await handler.set("y", { html: "y" }, { tags: ["t2"] });

    await handler.revalidateTag(["t1", "t2"]);

    expect(await handler.get("x")).toBeNull();
    expect(await handler.get("y")).toBeNull();
  });

  it("handles set with null data (delete)", async () => {
    const handler = new CacheHandler();
    await handler.set("del-key", { html: "exists" }, { tags: [] });
    expect(await handler.get("del-key")).not.toBeNull();

    await handler.set("del-key", null);
    expect(await handler.get("del-key")).toBeNull();
  });

  it("resetRequestCache is a no-op", () => {
    const handler = new CacheHandler();
    expect(() => handler.resetRequestCache()).not.toThrow();
  });
});

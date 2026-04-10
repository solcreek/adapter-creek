import { describe, it, expect } from "vitest";
import CacheHandler from "./cache-handler.js";

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

  it("marks tagged entries stale on revalidateTag (SWR semantics)", async () => {
    // SWR: revalidateTag marks entries stale but does NOT delete them.
    // Next.js needs the old value to serve while it re-renders in the
    // background. See opennextjs-cloudflare#1168 for the rationale.
    const handler = new CacheHandler();
    await handler.set("a", { html: "a" }, { tags: ["shared"] });
    // Sleep so the invalidation timestamp is strictly greater than
    // lastModified — same-millisecond writes would otherwise be treated as
    // fresh because we use `>` not `>=`.
    await new Promise((r) => setTimeout(r, 5));
    await handler.set("b", { html: "b" }, { tags: ["shared", "extra"] });
    await new Promise((r) => setTimeout(r, 5));
    await handler.set("c", { html: "c" }, { tags: ["other"] });
    await new Promise((r) => setTimeout(r, 5));

    await handler.revalidateTag("shared");

    const a = await handler.get("a");
    expect(a).not.toBeNull();
    expect(a!.value).toEqual({ html: "a" });
    expect(a!.cacheState).toBe("stale");

    const b = await handler.get("b");
    expect(b).not.toBeNull();
    expect(b!.value).toEqual({ html: "b" });
    expect(b!.cacheState).toBe("stale");

    const c = await handler.get("c");
    expect(c).not.toBeNull();
    expect(c!.cacheState).toBe("fresh"); // unrelated tag
  });

  it("re-set after revalidateTag returns to fresh", async () => {
    // After revalidateTag marks stale, Next.js re-renders and calls set()
    // again. The new entry's lastModified is after the invalidation
    // timestamp, so it should report fresh on the next get().
    const handler = new CacheHandler();
    await handler.set("k", { html: "v1" }, { tags: ["t"] });
    await new Promise((r) => setTimeout(r, 5));
    await handler.revalidateTag("t");
    await new Promise((r) => setTimeout(r, 5));
    await handler.set("k", { html: "v2" }, { tags: ["t"] });

    const result = await handler.get("k");
    expect(result).not.toBeNull();
    expect(result!.value).toEqual({ html: "v2" });
    expect(result!.cacheState).toBe("fresh");
  });

  it("marks stale via multiple tags at once", async () => {
    const handler = new CacheHandler();
    await handler.set("x", { html: "x" }, { tags: ["t1"] });
    await handler.set("y", { html: "y" }, { tags: ["t2"] });
    await new Promise((r) => setTimeout(r, 5));

    await handler.revalidateTag(["t1", "t2"]);

    const x = await handler.get("x");
    expect(x?.cacheState).toBe("stale");
    expect(x?.value).toEqual({ html: "x" });

    const y = await handler.get("y");
    expect(y?.cacheState).toBe("stale");
    expect(y?.value).toEqual({ html: "y" });
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

import { describe, expect, it } from "vitest";

import CacheHandler from "./cache-handler.js";
import CoreCacheHandler from "@solcreek/adapter-next-core/cache-handler";

// Smoke test: the cache-handler subpath export on @solcreek/adapter-creek
// must resolve to the same class @solcreek/adapter-next-core ships. The
// full behavioural test suite for CacheHandler lives there; here we
// only verify the re-export is intact so legacy
//   cacheHandler: require.resolve("@solcreek/adapter-creek/cache-handler")
// users keep working.
describe("cache-handler re-export", () => {
  it("is the same class as @solcreek/adapter-next-core/cache-handler", () => {
    expect(CacheHandler).toBe(CoreCacheHandler);
  });

  it("can be instantiated and round-trips a set/get", async () => {
    const h = new CacheHandler();
    await h.set("k", { hello: "world" }, { tags: [], revalidate: undefined });
    const got = await h.get("k");
    expect(got?.value).toEqual({ hello: "world" });
    expect(got?.cacheState).toBe("fresh");
  });
});

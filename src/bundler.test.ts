import { describe, expect, it } from "vitest";
import { patchUseCachePrerenderDanglingPromiseBailout } from "./bundler";

describe("patchUseCachePrerenderDanglingPromiseBailout", () => {
  it("patches readable Next use-cache wrapper output", () => {
    const input = `
      const serializedCacheKey = typeof encodedCacheKeyParts === 'string' ? // fast path
        encodedCacheKeyParts : await encodeFormData(encodedCacheKeyParts);
      // rootParams is undefined when nested inside unstable_cache.
      const rootParams = workUnitStore.rootParams;
      if (renderResumeDataCache.dynamicCacheKeys?.has(serializedCacheKey)) {
        return (0, _dynamicrenderingutils.makeHangingPromise)(
          workUnitStore.renderSignal,
          workStore.route,
          'dynamic "use cache"'
        );
      }
    `;

    const output = patchUseCachePrerenderDanglingPromiseBailout(input);

    expect(output).toContain("__creekDanglingThenableStart");
    expect(output).toContain("const rootParams = workUnitStore.rootParams");
    expect(output).toContain(
      "(0, _dynamicrenderingutils.makeHangingPromise)(workUnitStore.renderSignal, workStore.route",
    );
  });

  it("patches minified comma declaration output", () => {
    const input = `
      let a=typeof b=="string"?b:await c(b),d=e.rootParams;
      if(null==q?void 0:q.has(a)){
        return (0,f.makeHangingPromise)(e.renderSignal,g.route,'dynamic "use cache"');
      }
    `;

    const output = patchUseCachePrerenderDanglingPromiseBailout(input);

    expect(output).toContain("__creekDanglingThenableStart");
    expect(output).toContain("let d = e.rootParams");
    expect(output).toContain(
      "(0, f.makeHangingPromise)(e.renderSignal, g.route",
    );
  });
});

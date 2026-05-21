import { describe, expect, it } from "vitest";
import {
  patchAppPageRevalidationPostponedState,
  patchNullFallbackPartialShellBlocking,
  patchUseCachePrerenderDanglingPromiseBailout,
} from "./bundler";

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

describe("patchNullFallbackPartialShellBlocking", () => {
  it("keeps generic null-fallback partial shells on the blocking path", () => {
    const input = `
      if ((prerenderInfo == null ? void 0 : prerenderInfo.fallback) === null && !hasOmittedConcreteFallbackParam && !hasUnresolvedRootFallbackParams && remainingPrerenderableParams.length > 0) {
        // Generic source shells without unresolved root params don't have a
        // concrete fallback file of their own.
        fallbackMode = _fallback.FallbackMode.PRERENDER;
      }
    `;

    const output = patchNullFallbackPartialShellBlocking(input);

    expect(output).toContain(
      "fallbackMode = _fallback.FallbackMode.BLOCKING_STATIC_RENDER;",
    );
    expect(output).not.toContain("fallbackMode = _fallback.FallbackMode.PRERENDER;");
  });
});

describe("patchAppPageRevalidationPostponedState", () => {
  it("keeps readable App PPR revalidation on the previous postponed state", () => {
    const input = `
        let postponed =
          !isOnDemandRevalidate && !isRevalidating && minimalPostponed
            ? minimalPostponed
            : undefined

        if (
          // If this is a dynamic RSC request or a server action request, we should
          supportsRDCForNavigations
        ) {}
    `;

    const output = patchAppPageRevalidationPostponedState(input);

    expect(output).toContain("isRevalidating");
    expect(output).toContain("previousIncrementalCacheEntry?.value?.kind === CachedRouteKind.APP_PAGE");
    expect(output).toContain("postponed = previousIncrementalCacheEntry.value.postponed");
  });

  it("keeps minified App PPR revalidation on the previous postponed state", () => {
    const input = `
      let o2=/* @__PURE__ */__name(async({hasResolved:a7,previousCacheEntry:e2,isRevalidating:g2,span:h2,forceStaticRender:i3=false})=>{
        let j2=false===M.isDev,k3=a7||O.writableEnded;
        try{
          if(au&&am&&!e2&&!X)return null;
          let q2=au||g2||!aM?void 0:aM;
          if(aT&&!X&&l2&&(aO||aD)&&!i3){}
          return n2({span:h2,postponed:q2,fallbackRouteParams:null,forceStaticRender:i3});
        }catch(a8){throw a8}
      },"o")
    `;

    const output = patchAppPageRevalidationPostponedState(input);

    expect(output).toContain("__creekRevalidationPostponedState");
    expect(output).toContain('e2.value.kind==="APP_PAGE"');
    expect(output).toContain("q2=e2.value.postponed");
  });
});

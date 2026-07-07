import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  minifyWorker,
  patchAppPageRevalidationPostponedState,
  patchNullFallbackPartialShellBlocking,
  patchUseCachePrerenderDanglingPromiseBailout,
  resolveWranglerEntry,
} from "./bundler";

describe("resolveWranglerEntry", () => {
  let treeDir: string;

  beforeEach(() => {
    // realpath the tmpdir up front — require.resolve returns realpaths,
    // and macOS's tmpdir lives behind a /var → /private/var symlink.
    treeDir = mkdtempSync(path.join(realpathSync(tmpdir()), "adapter-creek-wrangler-"));
  });

  afterEach(() => {
    rmSync(treeDir, { recursive: true, force: true });
  });

  /** Write a fake package into <root>/node_modules and return its dir. */
  function writePkg(root: string, name: string, pkg: object): string {
    const dir = path.join(root, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, ...pkg }));
    return dir;
  }

  // Reproduces the Creek CLI lazy-install layout: npm hoists wrangler to
  // the TOP of .creek/node_modules, as a sibling of @solcreek/adapter-creek
  // — the adapter's own nested node_modules/.bin doesn't exist. Resolution
  // must walk up from the adapter, not guess a nested path.
  it("resolves a wrangler hoisted to the top of the install tree", async () => {
    const adapterDir = writePkg(treeDir, "@solcreek/adapter-creek", { version: "0.0.0" });
    const wranglerDir = writePkg(treeDir, "wrangler", {
      version: "4.82.2",
      bin: { wrangler: "bin/wrangler.js" },
    });
    mkdirSync(path.join(wranglerDir, "bin"), { recursive: true });
    writeFileSync(path.join(wranglerDir, "bin", "wrangler.js"), "");

    const adapterRequire = createRequire(path.join(adapterDir, "package.json"));
    await expect(resolveWranglerEntry(adapterRequire)).resolves.toBe(
      path.join(wranglerDir, "bin", "wrangler.js"),
    );
  });

  it("supports a string-form bin field", async () => {
    const adapterDir = writePkg(treeDir, "@solcreek/adapter-creek", { version: "0.0.0" });
    const wranglerDir = writePkg(treeDir, "wrangler", {
      version: "4.82.2",
      bin: "bin/wrangler.js",
    });
    mkdirSync(path.join(wranglerDir, "bin"), { recursive: true });
    writeFileSync(path.join(wranglerDir, "bin", "wrangler.js"), "");

    const adapterRequire = createRequire(path.join(adapterDir, "package.json"));
    await expect(resolveWranglerEntry(adapterRequire)).resolves.toBe(
      path.join(wranglerDir, "bin", "wrangler.js"),
    );
  });

  it("throws a descriptive error when the bin field is unusable", async () => {
    const adapterDir = writePkg(treeDir, "@solcreek/adapter-creek", { version: "0.0.0" });
    writePkg(treeDir, "wrangler", { version: "4.82.2" });

    const adapterRequire = createRequire(path.join(adapterDir, "package.json"));
    await expect(resolveWranglerEntry(adapterRequire)).rejects.toThrow(
      /no usable bin field/,
    );
  });

  it("resolves the real wrangler dependency from this repo's install", async () => {
    const selfRequire = createRequire(import.meta.url);
    const entry = await resolveWranglerEntry(selfRequire);
    expect(entry).toMatch(/wrangler/);
  });
});

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

describe("minifyWorker", () => {
  let workDir: string;
  const selfRequire = createRequire(import.meta.url);

  beforeEach(() => {
    workDir = mkdtempSync(path.join(realpathSync(tmpdir()), "adapter-creek-minify-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.CREEK_ADAPTER_MINIFY;
  });

  // Off by default: 0.2.13 shipped minify ON and broke Prisma-D1 apps at
  // runtime, so nothing minifies unless a build explicitly opts in.
  it("is off by default (no opt-in) and leaves the worker untouched", async () => {
    const workerPath = path.join(workDir, "worker.js");
    const source = "export const x = 1;  // keep me\n";
    writeFileSync(workerPath, source);

    const outcome = await minifyWorker(workerPath, selfRequire);

    expect(outcome.minified).toBe(false);
    expect(outcome.reason).toMatch(/off by default/);
    expect(readFileSync(workerPath, "utf-8")).toBe(source);
  });

  it("minifies in place when opted in via CREEK_ADAPTER_MINIFY=1", async () => {
    process.env.CREEK_ADAPTER_MINIFY = "1";
    const workerPath = path.join(workDir, "worker.js");
    const verbose =
      "// a comment that must not survive\n" +
      "export function handler ( request ) {\n" +
      "  const   greeting   =   'hello' ;\n" +
      "  /* block comment */\n" +
      "  return greeting + String( request ) ;\n" +
      "}\n";
    writeFileSync(workerPath, verbose);

    const outcome = await minifyWorker(workerPath, selfRequire);

    expect(outcome).toEqual({ minified: true });
    const output = readFileSync(workerPath, "utf-8");
    expect(output.length).toBeLessThan(verbose.length);
    expect(output).not.toContain("block comment");
    expect(output).toContain("export"); // still ESM
  });

  it("ships unminified instead of failing when esbuild is unresolvable", async () => {
    process.env.CREEK_ADAPTER_MINIFY = "1";
    const workerPath = path.join(workDir, "worker.js");
    const source = "export const x = 1;\n";
    writeFileSync(workerPath, source);
    const brokenRequire = {
      resolve: () => {
        throw new Error("Cannot find module 'wrangler/package.json'");
      },
    } as unknown as Pick<NodeRequire, "resolve">;

    const outcome = await minifyWorker(workerPath, brokenRequire);

    expect(outcome.minified).toBe(false);
    expect(outcome.reason).toMatch(/esbuild unresolvable/);
    expect(readFileSync(workerPath, "utf-8")).toBe(source);
  });

  it("ships unminified instead of failing on unparseable output", async () => {
    process.env.CREEK_ADAPTER_MINIFY = "1";
    const workerPath = path.join(workDir, "worker.js");
    const source = "export const = broken syntax {{{\n";
    writeFileSync(workerPath, source);

    const outcome = await minifyWorker(workerPath, selfRequire);

    expect(outcome.minified).toBe(false);
    expect(outcome.reason).toMatch(/transform failed/);
    expect(readFileSync(workerPath, "utf-8")).toBe(source);
  });
});

import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { generateWorkerEntry, type WorkerEntryOptions } from "./worker-entry.js";

/** Smallest options generateWorkerEntry accepts, plus overrides. */
function entry(overrides: Partial<WorkerEntryOptions>): string {
  return generateWorkerEntry({
    buildId: "test-build",
    routing: {
      beforeMiddleware: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {},
    } as unknown as WorkerEntryOptions["routing"],
    outputs: { appPages: [], appRoutes: [], pages: [], pagesApi: [], prerenders: [], staticFiles: [] } as unknown as WorkerEntryOptions["outputs"],
    basePath: "",
    assetPrefix: "",
    config: {},
    manifests: {},
    userFiles: {},
    prerenderEntries: [],
    ...overrides,
  });
}

describe("generateWorkerEntry: webpack edge functions", () => {
  const webpackEdge = {
    webpackEdgeBootstrapPath: "/p/.next/server/creek-edge-bootstrap.js",
    webpackEdgeRuntimePath: "/p/.next/server/edge-runtime-webpack.js",
    webpackEdgeChunkPaths: ["/p/.next/server/edge-chunks/754.js", "/p/.next/server/edge-chunks/890.js"],
  };
  const importAt = (src: string, file: string) => src.indexOf(`from ${JSON.stringify(file)}`);

  it("imports the bootstrap, the runtime and the shared chunks in that order, without middleware", () => {
    const src = entry(webpackEdge);
    const at = [
      importAt(src, webpackEdge.webpackEdgeBootstrapPath),
      importAt(src, webpackEdge.webpackEdgeRuntimePath),
      importAt(src, webpackEdge.webpackEdgeChunkPaths[0]),
      importAt(src, webpackEdge.webpackEdgeChunkPaths[1]),
    ];
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("imports none of them for a build without webpack edge functions", () => {
    expect(entry({})).not.toMatch(/import \* as (__creek_edge_bootstrap|__webpack_edge_runtime|__webpack_edge_chunk_\d+) from/);
  });

  it("calls an entry without a handler export through Next's edge adapter params", () => {
    const src = entry(webpackEdge);
    expect(src).toContain("function __creekEdgeAdapterParams(request, pathname, params, ctx)");
    expect(src).toMatch(/adapterStyle\s*\?\s*fn\(__creekEdgeAdapterParams\(edgeRequest, handler\.pathname, edgeRouteParams, edgeHandlerContext\)\)/);
  });

  it("forwards requestMeta and waitUntil to Next's edge adapter, as Next's edge wrapper does", () => {
    const src = entry(webpackEdge);
    const helper = src.slice(src.indexOf("function __creekEdgeAdapterParams"), src.indexOf("async function __withEdgeRouteEnv"));
    expect(helper).toContain("requestMeta: ctx?.requestMeta");
    expect(helper).toContain("waitUntil: ctx?.waitUntil");
  });
});

/** Source of a top-level function declaration in the generated entry. */
function fnSource(src: string, name: string): string {
  const start = src.search(new RegExp(`\\n(async )?function ${name}\\(`)) + 1;
  expect(start).toBeGreaterThan(0);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 2);
}

describe("generateWorkerEntry: client reference manifests per route", () => {
  const src = entry({});
  const normalize = new Function(`${fnSource(src, "__creekNormalizeAppPath")}; return __creekNormalizeAppPath;`)() as (
    page: string,
  ) => string;

  it("keys a manifest by the route Next's work store reports, as normalizeAppPath does", async () => {
    const { normalizeAppPath } = await import("next/dist/shared/lib/router/utils/app-paths.js");
    for (const page of [
      "/page",
      "/pricing/page",
      "/docs/[[...slug]]/page",
      "/nested-folder/(foo)/product-category/[...slugs]/page",
      "/(marketing)/(nested)/about/page",
      "/@modal/(.)photo/[id]/page",
      "/dashboard/@team/settings/page",
      "/api/(v1)/items/route",
      "/(group)/page",
      "/_not-found/page",
      "/blog/page-two/page",
    ]) {
      expect(normalize(page)).toBe(normalizeAppPath(page));
    }
  });

  it("drops route groups and parallel slots", () => {
    expect(normalize("/nested-folder/(foo)/product-category/[...slugs]/page")).toBe("/nested-folder/product-category/[...slugs]");
    expect(normalize("/(group)/page")).toBe("/");
    expect(normalize("/dashboard/@team/settings/page")).toBe("/dashboard/settings");
  });

  it("registers each manifest under its normalized route", () => {
    expect(src).toContain("clientReferenceManifestsPerRoute.set(__creekNormalizeAppPath(page), manifest);");
  });
});

describe("generateWorkerEntry: the render in progress for edge entries", () => {
  const src = entry({});
  type Render = { page?: string; route?: string } | undefined;

  /** The generated helpers, with a node work store the test controls. */
  function load(nodeStore: { getStore(): unknown; run?: unknown }) {
    const decl = src.slice(src.indexOf("const __creekEdgeEntryStorage"), src.indexOf(";", src.indexOf("const __creekEdgeEntryStorage")) + 1);
    const body = [
      fnSource(src, "__creekNormalizeAppPath"),
      decl,
      fnSource(src, "__creekEdgeEntryInfo"),
      fnSource(src, "__creekCurrentRender"),
      fnSource(src, "__withEdgeRouteEnv"),
      "return { __creekCurrentRender, __withEdgeRouteEnv };",
    ].join("\n");
    return new Function("AsyncLocalStorage", "__nextWorkAsyncStorage", "EDGE_ROUTE_ENVS", "__CREEK_NEXT_RUNTIME_KEY", "process", body)(
      AsyncLocalStorage,
      nodeStore,
      { "middleware_app/env/page": { FOO: "1" } },
      "NEXT_RUNTIME",
      { env: {} },
    ) as {
      __creekCurrentRender(): Render;
      __withEdgeRouteEnv<T>(entryKey: string, fn: () => Promise<T>): Promise<T>;
    };
  }

  it("reports the edge entry's page and route across awaits", async () => {
    const h = load({ getStore: () => undefined });
    const seen = await h.__withEdgeRouteEnv("middleware_app/header/(g)/edge/form/page", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return h.__creekCurrentRender();
    });
    expect(seen).toEqual({
      entryKey: "middleware_app/header/(g)/edge/form/page",
      page: "app/header/(g)/edge/form/page",
      route: "/header/edge/form",
    });
    expect(h.__creekCurrentRender()).toBeUndefined();
  });

  it("keeps it for entries with env overrides", async () => {
    const h = load({ getStore: () => undefined });
    expect(await h.__withEdgeRouteEnv("middleware_app/env/page", async () => h.__creekCurrentRender())).toEqual({
      entryKey: "middleware_app/env/page",
      page: "app/env/page",
      route: "/env",
    });
  });

  it("keeps concurrent edge requests apart", async () => {
    const h = load({ getStore: () => undefined });
    const run = (key: string, ms: number) =>
      h.__withEdgeRouteEnv(key, async () => {
        await new Promise((r) => setTimeout(r, ms));
        return h.__creekCurrentRender()?.page;
      });
    expect(await Promise.all([run("middleware_app/a/page", 5), run("middleware_app/b/page", 1)])).toEqual(["app/a/page", "app/b/page"]);
  });

  it("gives no route for a non-app entry", async () => {
    const h = load({ getStore: () => undefined });
    expect(await h.__withEdgeRouteEnv("middleware_pages/api/edge", async () => h.__creekCurrentRender())).toEqual({
      entryKey: "middleware_pages/api/edge",
      page: "pages/api/edge",
      route: undefined,
    });
  });

  it("gives a nested request to another edge entry that entry, and restores the caller's", async () => {
    const h = load({ getStore: () => undefined });
    const seen = await h.__withEdgeRouteEnv("middleware_app/source/page", async () => {
      const inner = await h.__withEdgeRouteEnv("middleware_app/target/page", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return h.__creekCurrentRender()?.page;
      });
      await new Promise((r) => setTimeout(r, 1));
      return { inner, outer: h.__creekCurrentRender()?.page };
    });
    expect(seen).toEqual({ inner: "app/target/page", outer: "app/source/page" });
  });

  it("hides a node render's work store from an edge entry it requests, and restores it", async () => {
    const node = new AsyncLocalStorage<{ page: string; route: string }>();
    const h = load(node);
    const nodeStore = { page: "/node/page", route: "/node" };
    const seen = await node.run(nodeStore, async () => {
      const inner = await h.__withEdgeRouteEnv("middleware_app/edge/page", async () => h.__creekCurrentRender()?.page);
      return { inner, outer: h.__creekCurrentRender() };
    });
    expect(seen.inner).toBe("app/edge/page");
    expect(seen.outer).toBe(nodeStore);
  });

  it("prefers the node work store when one is active", async () => {
    const nodeStore = { page: "/node/page", route: "/node" };
    const h = load({ getStore: () => nodeStore });
    expect(h.__creekCurrentRender()).toBe(nodeStore);
  });

  it("is what every manifest lookup reads", () => {
    expect(src.match(/const workStore = __creekCurrentRender\(\);/g)?.length).toBe(3);
  });
});

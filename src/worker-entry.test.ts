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

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

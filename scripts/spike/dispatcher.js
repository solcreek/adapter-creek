// Spike dispatcher: decides which runtime worker gets the request,
// forwards via service binding, echoes response headers as response.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Demo routing: /node/* → node worker, /edge/* → edge worker,
    // anything else → dispatcher itself.
    if (url.pathname.startsWith("/node")) {
      const resp = await env.NODE_WORKER.fetch(request);
      // Tag so we can verify the pass-through chain.
      const headers = new Headers(resp.headers);
      headers.set("x-creek-dispatcher-saw", "node-worker");
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
    }

    if (url.pathname.startsWith("/edge")) {
      const resp = await env.EDGE_WORKER.fetch(request);
      const headers = new Headers(resp.headers);
      headers.set("x-creek-dispatcher-saw", "edge-worker");
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
    }

    // Streaming test path: dispatcher asks node worker for a stream,
    // passes it back untouched so we can validate streaming end-to-end.
    if (url.pathname === "/stream-via-node") {
      return env.NODE_WORKER.fetch(new Request(new URL("/stream", request.url), request));
    }

    return new Response(JSON.stringify({ from: "dispatcher", path: url.pathname }), {
      headers: { "content-type": "application/json" },
    });
  },
};

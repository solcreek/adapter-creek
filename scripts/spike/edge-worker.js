// Spike edge-runtime worker: minimal handler for the cross-worker test.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    return new Response(JSON.stringify({ from: "edge-worker", path: url.pathname }), {
      headers: {
        "content-type": "application/json",
        "x-creek-worker-origin": "edge",
      },
    });
  },
};

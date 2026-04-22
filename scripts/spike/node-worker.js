// Spike node-runtime worker: acts like a simple route handler.
// Streaming endpoint tests that service-binding-forwarded streams
// actually stream (not buffer).
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Kick off async writes so the response can stream.
      (async () => {
        for (let i = 0; i < 5; i++) {
          await writer.write(encoder.encode(`chunk-${i}\n`));
          // Force a distinct event-loop tick between chunks.
          await new Promise((r) => setTimeout(r, 50));
        }
        await writer.close();
      })();

      return new Response(readable, {
        headers: {
          "content-type": "text/plain",
          "x-creek-worker-origin": "node",
          "transfer-encoding": "chunked",
        },
      });
    }

    return new Response(JSON.stringify({ from: "node-worker", path: url.pathname }), {
      headers: {
        "content-type": "application/json",
        "x-creek-worker-origin": "node",
      },
    });
  },
};

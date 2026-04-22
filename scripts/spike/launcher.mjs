// Spike: multi-worker miniflare launcher. Validates Phase 0 assumptions:
//  - miniflare SDK can run N workers in one process
//  - service bindings between them work
//  - streaming responses pass through without being buffered
//
// Run:  node scripts/spike/launcher.mjs
// Exercise: curl http://127.0.0.1:8899/ , /node/foo , /edge/bar , /stream-via-node
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const mf = new Miniflare({
  port: 8899,
  workers: [
    {
      name: "dispatcher",
      modules: true,
      scriptPath: join(__dirname, "dispatcher.js"),
      // Internal service bindings reference sibling workers by name.
      serviceBindings: {
        NODE_WORKER: "node-runtime",
        EDGE_WORKER: "edge-runtime",
      },
    },
    {
      name: "node-runtime",
      modules: true,
      scriptPath: join(__dirname, "node-worker.js"),
    },
    {
      name: "edge-runtime",
      modules: true,
      scriptPath: join(__dirname, "edge-worker.js"),
    },
  ],
});

await mf.ready;
console.log("spike launcher: miniflare ready on http://127.0.0.1:8899");
console.log("  /              → dispatcher only");
console.log("  /node/foo      → dispatcher → node-runtime");
console.log("  /edge/bar      → dispatcher → edge-runtime");
console.log("  /stream-via-node → dispatcher → node-runtime /stream (chunked)");

// Keep the process alive. Ctrl+C or SIGTERM to stop.
process.on("SIGTERM", async () => {
  await mf.dispose();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await mf.dispose();
  process.exit(0);
});

// A Web Worker script: webpack also emits it among the server chunks, where
// it must not run when the Cloudflare worker starts. The dynamic import gives
// its bundle a chunk loader of its own, and the wasm URL an asset beside the
// server chunks.
const wasmUrl = new URL("./add.wasm", import.meta.url);
import("./web-worker-dep").then(({ ready }) => self.postMessage(`${ready} ${wasmUrl.pathname.endsWith(".wasm")}`));

// A Web Worker script: webpack also emits it among the server chunks, where
// it must not run when the Cloudflare worker starts.
self.postMessage("worker-ready");

#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, openSync, writeSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";

// Mirror all stdout/stderr from the worker (including console.log inside the
// bundled worker.js) to a stable path under /tmp so the e2e harness can't
// nuke it during cleanup. Set CREEK_WORKER_LOG to override the default.
//
// The double-write is done at process.stdout._write level rather than via
// shell tee because:
//   - shell tee + bash backgrounding (`> >(tee ...) &`) is fragile
//   - the test harness deletes the test app dir (including .adapter-server.log)
//     before any post-mortem inspection is possible
// With this in place, /tmp/creek-worker.log accumulates output across runs;
// truncate it manually if you need to isolate a single test.
{
  const logPath = process.env.CREEK_WORKER_LOG || "/tmp/creek-worker.log";
  let logFd;
  try {
    logFd = openSync(logPath, "a");
  } catch {
    logFd = null;
  }
  if (logFd !== null) {
    const installMirror = (stream) => {
      const origWrite = stream.write.bind(stream);
      stream.write = (chunk, encoding, cb) => {
        try {
          if (typeof chunk === "string") {
            writeSync(logFd, chunk);
          } else if (chunk instanceof Uint8Array) {
            writeSync(logFd, chunk);
          }
        } catch {}
        return origWrite(chunk, encoding, cb);
      };
    };
    installMirror(process.stdout);
    installMirror(process.stderr);
    // Write a session boundary so successive runs in the same log are easy
    // to tell apart.
    writeSync(logFd, `\n=== creek-worker session ${new Date().toISOString()} pid=${process.pid} ===\n`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value == null) continue;
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toAssetPathname(urlPathname) {
  const pathname = decodeURIComponent(urlPathname);
  if (pathname.endsWith("/")) return pathname + "index.html";
  if (!path.extname(pathname)) return pathname + "/index.html";
  return pathname;
}

function createAssetsBinding(assetsDir) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const assetPath = toAssetPathname(url.pathname);
      const resolved = path.resolve(assetsDir, "." + assetPath);
      if (!resolved.startsWith(path.resolve(assetsDir))) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!(await fileExists(resolved))) {
        return new Response("Not Found", { status: 404 });
      }
      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }
      const headers = new Headers();
      headers.set("Content-Type", getContentType(resolved));
      headers.set("Content-Length", String(fileStat.size));
      return new Response(Readable.toWeb(createReadStream(resolved)), {
        status: 200,
        headers,
      });
    },
  };
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || 3000);
const workerPath = args.worker;
const assetsDir = args.assets;

if (!workerPath || !assetsDir) {
  console.error("Usage: worker-dev-server.mjs --worker <path> --assets <dir> --port <port>");
  process.exit(1);
}

globalThis.self = globalThis;

// Polyfill URLPattern for local dev. CF Workers (and Edge runtime) expose
// URLPattern as a global, so \`next/server\`'s conditional export
// (\`typeof URLPattern !== "undefined" ? URLPattern : undefined\`) picks it
// up. Node.js through v22 doesn't have it yet (experimental behind a flag
// in v23), which means middleware that uses \`new URLPattern(...)\` — and
// any test fixture that imports \`URLPattern\` from \`next/server\` — crashes
// with "re is not a constructor". Install the polyfill before importing
// the worker so the bundled check succeeds.
if (typeof globalThis.URLPattern === "undefined") {
  try {
    const { URLPattern } = await import("urlpattern-polyfill");
    globalThis.URLPattern = URLPattern;
  } catch {
    // Polyfill missing from devDeps — middleware using URLPattern will
    // fail loudly at first invocation.
  }
}

const workerSource = await readFile(path.resolve(workerPath), "utf8");
let patchedWorkerSource = workerSource.replace(
  'import { DurableObject } from "cloudflare:workers";',
  "class DurableObject {}",
);

// WebAssembly module bindings for local dev:
// When Next.js's edge route handlers use `next/og` (or any other `?module`
// wasm imports), Turbopack compiles them into closures like
// `() => wasm_<hash>`. The wasm bytes are dropped next to worker.js by
// wrangler as `wasm_<hash>` (no extension), but wrangler never emits the
// top-level `import wasm_<hash> from ...` binding that would make those
// identifiers resolvable. In a real CF Workers deploy the wasm files are
// picked up via the module-deploy format; for the local Node dev server
// we can't use CF's ESM wasm import, so instead compile each wasm file
// eagerly and prepend a `const wasm_<hash> = globalThis.__creek_wasm_<hash>`
// binding that pulls from a process-global map we set up here.
const workerDir = path.dirname(path.resolve(workerPath));
const wasmHashes = new Set();
for (const m of patchedWorkerSource.matchAll(/\bwasm_[0-9a-f]{32}\b/g)) {
  wasmHashes.add(m[0]);
}
if (wasmHashes.size > 0) {
  const bindingLines = [];
  for (const ident of wasmHashes) {
    const wasmPath = path.join(workerDir, ident);
    try {
      const buf = await readFile(wasmPath);
      globalThis[`__creek_${ident}`] = new WebAssembly.Module(buf);
      bindingLines.push(`const ${ident} = globalThis.__creek_${ident};`);
    } catch (err) {
      console.error(
        `[worker-dev-server] Failed to load wasm module ${ident}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (bindingLines.length > 0) {
    patchedWorkerSource = bindingLines.join("\n") + "\n" + patchedWorkerSource;
  }
}

const workerModule = await import(
  `data:text/javascript;base64,${Buffer.from(patchedWorkerSource).toString("base64")}`
);
const worker = workerModule.default;

if (!worker || typeof worker.fetch !== "function") {
  console.error("Worker module does not export default.fetch");
  process.exit(1);
}

const env = {
  ASSETS: createAssetsBinding(path.resolve(assetsDir)),
};

// Use `localhost` rather than `127.0.0.1` so Request URLs match what Next.js
// normalizes internally — NextURL.parseURL() (see next-url.ts) rewrites any
// loopback hostname (127.0.0.1, ::1, localhost) to "localhost", so middleware
// code like `new URL('/dest', request.url)` always produces localhost URLs.
// Keeping the binding and the origin on "localhost" lets test assertions that
// compare against `next.url` match without a hostname mismatch.
const server = createServer(async (req, res) => {
  const origin = `http://localhost:${port}`;
  const url = new URL(req.url || "/", origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value != null) {
      headers.set(key, value);
    }
  }

  const init = {
    method: req.method,
    headers,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }

  const waitUntilPromises = [];
  const ctx = {
    waitUntil(promise) {
      waitUntilPromises.push(Promise.resolve(promise).catch(() => {}));
    },
  };

  try {
    const response = await worker.fetch(new Request(url, init), env, ctx);
    const responseHeaders = response?.headers ? new Headers(response.headers) : new Headers();
    const setCookies =
      typeof responseHeaders.getSetCookie === "function"
        ? responseHeaders.getSetCookie()
        : responseHeaders.get("set-cookie")
          ? [responseHeaders.get("set-cookie")]
          : [];
    if (setCookies.length > 0) {
      res.setHeader("set-cookie", setCookies);
    }
    responseHeaders.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.statusMessage = response.statusText || res.statusMessage;

    if (!response.body || req.method === "HEAD") {
      res.end();
      return;
    }

    const body = Readable.fromWeb(response.body);
    body.on("error", (err) => {
      if (!res.headersSent) res.writeHead(500);
      res.destroy(err);
    });
    body.pipe(res);
    res.on("close", () => {
      body.destroy();
    });
    void Promise.all(waitUntilPromises);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(err instanceof Error ? err.stack || err.message : String(err));
  }
});

server.listen(port, "localhost", () => {
  console.error(`[worker-dev-server] Ready on http://localhost:${port}`);
});

# adapter-creek

Next.js deployment adapter for [Creek](https://creek.dev).

## What is Creek?

Creek is an open-source edge deployment platform built on [Cloudflare Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/). It provides a managed infrastructure layer so you can deploy full-stack apps to the edge without managing Cloudflare resources directly.

```bash
npx creek deploy
# Live in seconds → https://my-app-acme.bycreek.com
```

Creek handles: multi-tenant isolation, preview URLs, custom domains, environment variables, DO bindings, static asset hosting, team management, and AI agent integration (MCP server) — all through a single CLI or API.

## Why adapter-creek?

This adapter implements the Next.js 16.2+ `NextAdapter` interface to deploy Next.js apps through Creek's infrastructure. It bundles build output directly for Cloudflare Workers.

**Creek vs. self-hosting with Cloudflare + opennext:**

| | Creek | Cloudflare + opennext |
|--|-------|----------------------|
| Deploy | `creek deploy` (one command) | wrangler.toml + opennext build + wrangler deploy |
| Config | Zero-config (auto-detect) | Manual wrangler.toml + open-next.config.ts |
| CF account | Not needed | Required (your own account) |
| Preview URLs | Automatic per-deploy | DIY routing |
| Custom domains | `creek domains add` | CF Dashboard + manual DNS |
| DO for ISR | Auto-injected | Manual setup + migration management |
| Env variables | Encrypted, `creek env set` | wrangler.toml or CF Dashboard |
| Teams / RBAC | Built-in | None |
| Adapter updates | Creek team maintains | You maintain opennext patches |
| Build pipeline | Adapter API (typed) | 8-step workaround chain |

Creek is a **platform** — this adapter is the bridge between Next.js and that platform. opennext is a **tool** for self-hosting on your own CF account.

## Status

Near-complete Next.js coverage on Cloudflare Workers. Single entry in the skip manifest is an upstream Turbopack canary regression, unrelated to the adapter.

| Feature | Status |
|---------|:------:|
| Static pages / SSG | ✅ |
| SSR (progressive streaming) | ✅ |
| Middleware (edge + node runtimes) | ✅ |
| Server Actions | ✅ |
| App Router incl. PPR / `'use cache'` | ✅ |
| ISR, tag / path revalidation | ✅ (Durable-Objects-backed) |
| Image Optimization | ✅ CF Image Resizing |
| `@vercel/og` (node + edge) | ✅ WASM-path |
| `sqlite3` native-addon packages | ✅ transparent sql.js shim |
| Multi-runtime isolation (opt-in) | ✅ `CREEK_MULTI_WORKER=1` |
| Next.js e2e deploy suite | ~99% of in-scope tests |

## Requirements

- Next.js ≥ 16.2
- Turbopack (default) or Webpack via `--webpack`

## Usage

The adapter is used automatically when deploying with Creek:

```bash
npx creek deploy
```

For manual use, set `NEXT_ADAPTER_PATH`:

```bash
NEXT_ADAPTER_PATH=@solcreek/adapter-creek npx next build
```

Or configure in `next.config.js`:

```js
module.exports = {
  adapterPath: require.resolve('@solcreek/adapter-creek'),
}
```

Output goes to `.creek/adapter-output/`:

```
.creek/adapter-output/
  assets/              — static files (WfP Static Assets API)
  server/worker.js     — bundled CF Workers entry (single-worker mode)
  server/wrangler.toml — bindings, DOs, nodejs_compat flags
  manifest.json        — deploy metadata
```

### Opt-in multi-worker mode (enterprise-tier)

`CREEK_MULTI_WORKER=1` switches the build to a 3-worker topology with runtime-label-aware dispatch — the same shape Vercel uses for its per-runtime deployment model. Unlocks Node-runtime × Edge-runtime isolation inside a single Creek deploy without losing the `env.*` bindings that Next.js expects.

```
.creek/adapter-output/
  dispatcher/worker.js    — route → runtime map + service-binding fan-out
  node-runtime/worker.js  — nodejs handlers
  edge-runtime/worker.js  — edge handlers
  assets/ …
```

## How It Works

```
next build  (Turbopack by default, Webpack via --webpack)
  → modifyConfig
      • `outputFileTracingRoot` (monorepo aware)
      • `cacheMaxMemorySize: 0` (we ship a DO-backed IncrementalCache)
      • `maxPostponedStateSize: 20mb` (workerd-safe PPR fallback size)

  → onBuildComplete
      1. Collect static files from typed outputs
      2. Embed .next/ manifests (JSON + JS, base64-safe)
      3. Seed ISR/`'use cache'` entries (composable cache handler in-bundle)
      4. Bundle `.sqlite` fixtures via Next.js's file trace
      5. Generate the worker entry
           - middleware + `@next/routing` resolveRoutes
           - streaming HTML with `Content-Encoding: identity` pin
             (stops miniflare's edge-sim from bulk-gzipping progressive chunks)
           - edge/node dispatch via `_ENTRIES` registry
           - same-origin `fetch()` coalescer for RSC chunk-count fidelity
           - `IncomingMessage` / `ServerResponse` bridge
      6. Post-process Turbopack output
           - hard-resolve `[externals]*.js` lazy-requires
           - collect ssr/ lazy-require aliases → wrangler `alias` map
           - (preserves module identity; no source rewrite of ssr/ chunks)
      7. esbuild + workerd bundle via `wrangler --dry-run`
      8. Write `.creek/adapter-output/` + deploy manifest
```

Side systems plugged in for specific Next.js features:

- **`@solcreek/adapter-creek` sqlite3 shim** — post-install patch at `scripts/patch-node-modules-sqlite3.mjs` replaces `node_modules/sqlite3`'s native binding with a sql.js-backed drop-in so user code that imports `sqlite3` builds and runs on workerd. Same-API, WASM-path.
- **Content-Encoding: identity on FL-compressed types** — labels text/html / text/plain / JSON / RSC streams so miniflare's edge-simulator doesn't collapse progressive chunks into a single gzipped blob. Real CF edge still re-compresses at the byte-stream level in production.

## Testing

This adapter runs the [Next.js adapter test suite](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath#testing-adapters) against the real workerd runtime via [miniflare](https://miniflare.dev/) embedded in-process (not `wrangler dev` spawning a subprocess).

Each adapter tests against its own target runtime:

| Adapter | Test runtime |
|---------|-------------|
| adapter-vercel | Node.js (`next start`) |
| adapter-bun | Bun (`bun serve`) |
| **adapter-creek** | **CF Workers via miniflare** |

This ensures test results reflect real workerd behaviour — `nodejs_compat` boundaries, V8 isolate limits, chunked transfer semantics — not a Node.js approximation.

### Harness scripts

```bash
scripts/e2e-deploy.sh              # Build + start miniflare, print localhost URL
scripts/e2e-logs.sh                # Return BUILD_ID, DEPLOYMENT_ID, server logs
scripts/e2e-cleanup.sh             # Stop the miniflare process + its children
scripts/worker-dev-server-miniflare.mjs   # single-worker launcher (default)
scripts/multi-worker-dev.mjs              # 3-worker launcher (CREEK_MULTI_WORKER=1)
```

### Running locally

```bash
# Clone the Next.js repo alongside this adapter
git clone --depth 25 --branch canary https://github.com/vercel/next.js nextjs
cd nextjs && pnpm install && pnpm build && pnpm install
pnpm playwright install chromium

# Single test, default single-worker mode
./scripts/local-test.sh test/e2e/app-dir/actions/app-action.test.ts

# Opt-in multi-worker mode
CREEK_MULTI_WORKER=1 ./scripts/local-test.sh test/e2e/app-dir/actions/app-action.test.ts
```

### CI

- `.github/workflows/checks.yml` — PR + push on main; typecheck, unit tests, build
- `.github/workflows/test-e2e-deploy.yml` — workflow_dispatch; full 16-way e2e matrix against canary Next.js

## License

Apache 2.0

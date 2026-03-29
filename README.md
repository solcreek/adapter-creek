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
| Worker size | ~1.5 MB gzip | ~2.6 MB gzip |
| Build pipeline | Adapter API (typed) | 8-step workaround chain |

Creek is a **platform** — this adapter is the bridge between Next.js and that platform. opennext is a **tool** for self-hosting on your own CF account.

## Status

| Feature | Status |
|---------|:------:|
| Static pages / SSG | ✅ Working |
| SSR (streaming) | ✅ Working |
| Middleware (edge) | ✅ Working |
| Server Actions | ✅ Working |
| ISR / Cache | ✅ In-memory (DO planned) |
| PPR cache seeding | ✅ Working |
| Image Optimization | ✅ CF Image Resizing |
| Test suite | 🔲 In progress |

## Requirements

- Next.js >= 16.2
- `--webpack` build flag (Turbopack output is incompatible with esbuild)

## Usage

The adapter is used automatically when deploying with Creek:

```bash
npx creek deploy
```

For manual use, set `NEXT_ADAPTER_PATH`:

```bash
NEXT_ADAPTER_PATH=@solcreek/adapter-creek npx next build --webpack
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
  assets/          — static files (WfP Static Assets API)
  server/worker.js — bundled CF Workers entry point
  manifest.json    — deploy metadata
```

## How It Works

```
next build --webpack
  → modifyConfig: output "standalone", outputFileTracingRoot, cacheHandler
  → onBuildComplete:
    1. Collect static files from typed outputs
    2. Embed .next/ manifests (JSON + JS)
    3. Seed ISR cache with prerender entries
    4. Generate worker entry:
       - @next/routing resolveRoutes
       - Streaming SSR via TransformStream
       - Edge middleware via _ENTRIES registry
       - RSC manifests singleton initialization
       - IncomingMessage/ServerResponse bridge
    5. esbuild bundle (platform: node, 14 CF Workers shims)
    6. Post-build __require normalization
    7. Write deploy manifest
```

## Testing

Test suite scripts for the [Next.js adapter test harness](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath#testing-adapters). Uses `wrangler dev` (miniflare) for local testing:

```bash
scripts/e2e-deploy.sh    # Build + start local server, print URL
scripts/e2e-logs.sh      # Return BUILD_ID, DEPLOYMENT_ID
scripts/e2e-cleanup.sh   # Stop local server
```

## License

Apache 2.0

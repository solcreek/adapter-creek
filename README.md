# adapter-creek

Next.js deployment adapter for [Creek](https://creek.dev) — deploys Next.js apps to Cloudflare Workers.

Implements the Next.js 16.2+ `NextAdapter` interface. Bundles build output directly for CF Workers, replacing the opennext + wrangler multi-step pipeline.

## Status

| Feature | Status |
|---------|:------:|
| Static pages / SSG | ✅ Working |
| React hydration | ✅ Working |
| SSR (Server-Side Rendering) | ✅ Working (103 Early Hints) |
| CF Workers deploy | ✅ Passes validation |
| ISR / Cache | 🔲 Phase 2 |
| Middleware | 🔲 Phase 2 |
| Test suite | 🔲 In progress |

## Requirements

- Next.js >= 16.2 (requires `NextAdapter` interface)
- `--webpack` flag required (Turbopack chunked format is incompatible with esbuild)

## Usage

Set `NEXT_ADAPTER_PATH` to the adapter's entry point:

```bash
NEXT_ADAPTER_PATH=@solcreek/adapter-creek npx next build --webpack
```

Or configure in `next.config.js`:

```js
module.exports = {
  adapterPath: require.resolve('@solcreek/adapter-creek'),
}
```

The adapter handles everything automatically:
- `modifyConfig()` injects `output: "standalone"` + monorepo settings
- `onBuildComplete()` collects outputs, bundles worker, writes deploy manifest

Output goes to `.creek/adapter-output/`:
```
.creek/adapter-output/
  assets/          — static files for WfP Static Assets API
  server/worker.js — bundled CF Workers entry point
  manifest.json    — deploy metadata
```

## How It Works

```
next build --webpack
  → modifyConfig: output: "standalone", outputFileTracingRoot
  → onBuildComplete:
    1. Collect static files (typed outputs)
    2. Embed manifests from .next/ (JSON + JS)
    3. Generate worker entry:
       - @next/routing resolveRoutes
       - Lazy import() handlers
       - Manifests singleton init (RSC + server actions)
       - IncomingMessage/ServerResponse bridge
    4. esbuild bundle (platform: node, shims, banner)
    5. Post-build: __require normalization
    6. Write manifest.json
```

14 CF Workers compatibility issues handled via esbuild plugins (define/banner/onLoad/alias).

## Comparison with opennext

| | opennext | adapter-creek |
|--|:---:|:---:|
| Worker size (gzipped) | ~2.6 MB | ~1.5 MB |
| Build steps | 8 | 1 |
| Dependencies | opennext + wrangler | esbuild only |
| Workarounds | 5 regex patches | 0 (shim files) |

## Testing

Test suite scripts for the [Next.js adapter test harness](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath#testing-adapters):

```bash
scripts/e2e-deploy.sh    # Build + deploy, print URL to stdout
scripts/e2e-logs.sh      # Return BUILD_ID, DEPLOYMENT_ID
scripts/e2e-cleanup.sh   # Tear down deployment
```

## License

Apache 2.0

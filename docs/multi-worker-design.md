# Multi-Worker Service Bindings — Design

Branch: `feat/multi-worker-service-bindings`
Author: 2026-04-21

## Problem

`test/e2e/app-dir/actions/app-action.test.ts` has 4 subtests (× 2 with
`app-action-node-middleware.test.ts` re-run = 8) that assume the app is
deployed as multiple isolated functions: one per (runtime × page boundary).
The failure mode is a `Failed to find Server Action` CLI log when the
in-flight delayed action's continuation lands in an isolate that doesn't
have the action handler's module loaded.

The current adapter bundles every `appPages`, `appRoutes`, `pages`,
`pagesApi` handler into one `worker.js`, so the `edge` and `nodejs`
runtime routes share one isolate. That matches Workers' single-bundle
model but breaks the test's isolation assumption.

## Goal

Emit a **dispatcher-plus-runtime-workers** topology so that
`/delayed-action/edge/*` runs in the edge-runtime worker and
`/delayed-action/node/*` runs in the node-runtime worker, dispatched by
a dispatcher worker that still handles middleware + routing + static
assets.

Non-goal (for this iteration): per-route worker sharding, cross-version
("skew protection") forwarding. Those can build on top of this topology
later.

## Architecture

```
CF edge  ─►  dispatcher worker  ─►  env.NODE_WORKER.fetch(req)  ─►  node-runtime worker
                 │                                                       │
                 │                   env.EDGE_WORKER.fetch(req)  ─►  edge-runtime worker
                 │                                                       │
                 ├─ middleware                                            ├─ AppPageRouteModule.render
                 ├─ @next/routing resolve                                 ├─ response streamed back
                 ├─ static-asset fast path (env.ASSETS)                   │
                 └─ dispatch by runtime label  ◄──────────────────────────┘
```

### Worker responsibilities

**dispatcher**
- Middleware execution (cookies, rewrites, redirects, headers)
- `@next/routing` resolveRoutes → pick handler
- Static asset serve via `env.ASSETS.fetch` (shortcut before dispatch)
- Dispatch:
  - `handler.runtime === "nodejs"` → `env.NODE_WORKER.fetch(req)`
  - `handler.runtime === "edge"` → `env.EDGE_WORKER.fetch(req)`
- Merge response headers (middleware-added, adapter-added)
- Cache Durable Object bindings (read side)

**node-runtime worker**
- Only contains `nodejs` handlers from `appPages`/`appRoutes`/`pages`/
  `pagesApi`
- Full Node compat (Buffer, process, node:*)
- Cache DO bindings (read/write)

**edge-runtime worker**
- Only contains `edge` handlers (edge middleware is separate; this worker
  hosts app-page/app-route edge runtimes)
- Lighter imports (no Node shim cost on cold start)
- Same DO bindings

### Shared bindings (all three workers)

```toml
# wrangler.toml — shared-bindings block repeated in all three workers
[[durable_objects.bindings]]
name = "NEXT_CACHE_DO_QUEUE"
class_name = "DOQueueHandler"
# (script_name differs: dispatcher declares the class; node/edge bind to dispatcher's script)

[[durable_objects.bindings]]
name = "NEXT_TAG_CACHE_DO_SHARDED"
class_name = "DOShardedTagCache"

[[durable_objects.bindings]]
name = "NEXT_CACHE_DO_BUCKET_PURGE"
class_name = "BucketCachePurge"
```

DO classes are declared ONCE (on the dispatcher) and consumed from the
other workers via `script_name = "<dispatcher-script-name>"`. This
matches CF's documented "shared DO" pattern.

### Dispatcher → runtime worker wire protocol

The dispatcher's outbound `env.NODE_WORKER.fetch(req)` is a regular
fetch; the runtime worker receives a `Request` identical to the original
(plus adapter-internal headers). This keeps the runtime worker's
handler entry point identical to the current `__handleRequest` —
minimal adapter-internal change.

**Extra headers the dispatcher sets on the inbound request:**
- `x-creek-resolved-pathname`: final pathname after middleware rewrite
- `x-creek-route-runtime`: `"nodejs"` | `"edge"` (for debug/log)
- `x-creek-middleware-headers`: serialized middleware response headers
  (so the runtime worker can include them without re-running middleware)

**The runtime worker:**
- Skips middleware (already ran)
- Skips `@next/routing` (already resolved)
- Goes straight to handler invocation

### Middleware placement rationale

Middleware CANNOT run inside the runtime worker because:
1. It must run ONCE per request, not once per dispatch path
2. Its rewrite decision determines which worker handles the request
3. Edge middleware is its own runtime — bundling it into either
   runtime worker adds unnecessary cost

Placing it in the dispatcher means:
- `HAS_MIDDLEWARE` flag + middleware bundle lives only in dispatcher
- Runtime workers stay lean

## Build-output schema

Current:
```
.creek/adapter-output/
├── server/
│   ├── worker.js
│   └── wrangler.toml
└── assets/
```

Proposed:
```
.creek/adapter-output/
├── dispatcher/
│   ├── worker.js         # middleware + routing + dispatch
│   ├── wrangler.toml     # declares DO classes; binds ASSETS + service bindings
│   └── (manifests)
├── node-runtime/
│   ├── worker.js         # node handlers only
│   └── wrangler.toml     # script_name-binds DO classes
├── edge-runtime/
│   ├── worker.js         # edge handlers only
│   └── wrangler.toml
└── assets/               # shared; dispatcher's ASSETS binding points here
```

**Single-worker fallback**: if the app has only nodejs handlers and no
edge runtime at all, the adapter skips the multi-worker emit and
produces the current `server/worker.js` output. Detection: scan
`ctx.outputs.*` for any `runtime === "edge"`.

## Test harness (`scripts/e2e-deploy.sh`)

**Current**: start `wrangler dev` on `server/`, wait for it to listen,
echo URL to stdout.

**New**: need to start 3 wrangler devs with cross-process service
bindings, then echo dispatcher URL.

### Options evaluated

**Option 1**: Single wrangler with `[[services]]` entries pointing to
local worker scripts.
→ Wrangler does NOT support this currently — services must point to
deployed scripts, not local files. RULED OUT.

**Option 2**: 3 separate `wrangler dev` processes + explicit
`--experimental-local-server-binding-registry` or similar.
→ Wrangler has `--port` overrides but no first-class local service
binding between separate `dev` processes. Fragile, ruled out.

**Option 3**: Write a custom multi-worker launcher using miniflare's
`Miniflare` SDK directly. Miniflare supports multiple workers in one
process with service bindings via the `workers` array.
→ This is the documented pattern. Chose this.

### Option 3 sketch

```ts
// scripts/multi-worker-launcher.mjs
import { Miniflare } from "miniflare";

const mf = new Miniflare({
  workers: [
    {
      name: "dispatcher",
      scriptPath: ".creek/adapter-output/dispatcher/worker.js",
      serviceBindings: { NODE_WORKER: "node-runtime", EDGE_WORKER: "edge-runtime" },
      // + DO classes, ASSETS binding, env vars
    },
    {
      name: "node-runtime",
      scriptPath: ".creek/adapter-output/node-runtime/worker.js",
      // bindings shared via dispatcher
    },
    {
      name: "edge-runtime",
      scriptPath: ".creek/adapter-output/edge-runtime/worker.js",
    },
  ],
  port: 8787,
});

await mf.ready;
console.log(await mf.dispatchFetch("http://localhost"));
```

The deploy script then echoes `http://localhost:<port>` to stdout.

## Risks & open questions

### R1: AsyncLocalStorage state doesn't cross service bindings 🟡
Our `__CREEK_ALS` registry (for workStore / workUnitStore dedup) is
per-isolate. When dispatcher forwards to node-runtime via
`env.NODE_WORKER.fetch`, the runtime worker starts a fresh isolate
execution context — no shared ALS state.

**Mitigation**: dispatcher passes state via explicit request headers
(postponed state, requestMeta JSON), the runtime worker reconstructs
it. Same pattern we already use for `x-middleware-*` headers.

### R2: Response streaming through service bindings 🟢
CF Workers service bindings fully support streaming responses. No code
change needed — `return response` from the runtime worker streams
through the dispatcher's `env.WORKER.fetch` pass-through.

### R3: Cold-start × 3 🟡
Each service binding call incurs a potential isolate cold start on the
receiving side. In steady state this is ~0ms (warm isolates), but cold
paths add up to ~3× current P99 latency. Acceptable trade-off for the
isolation benefits; Vercel's multi-lambda architecture has the same
cost profile.

### R4: Durable Object migration 🟢
DO classes don't change — still declared once (on dispatcher), bound
elsewhere via `script_name`. No data migration needed; existing DO
instances keep working.

### R5: Middleware execution count 🟢
Middleware runs ONLY in dispatcher. The runtime worker gets a
pre-routed, post-middleware request with serialized middleware results
in request headers. Net effect: same middleware semantics, no double
execution.

### R6: `@next/routing` duplicate initialisation 🟡
`resolveRoutes` lives in dispatcher. Runtime worker does NOT call it
(uses `x-creek-resolved-pathname`). Saves bundle size on runtime
workers. Risk: dispatcher's resolved pathname must match exactly what
the runtime worker would compute — any mismatch in decoding /
normalisation causes wrong handler selection. Mitigation: share the
routing-normalisation helpers as a minimal `creek-routing` module
imported by all three workers.

## Phased implementation

### Phase 0 — Spike (1-2 days)
- Write this design doc (done)
- Minimal miniflare SDK launcher: 2 workers, 1 service binding,
  basic fetch-forwarding. Validates the dev-harness approach.
- **Go/No-go decision**: if the launcher can't reliably forward +
  stream between workers, fall back to skipping the Category A tests.

### Phase 1 — Build-output split (2-3 days)
- Refactor `build.ts` to group handlers by runtime
- Emit 3 worker sources (stub dispatcher for now)
- Each worker builds independently and runs a "hello world" fetch

### Phase 2 — Dispatcher logic (2-3 days)
- Move middleware + `@next/routing` into dispatcher
- Implement runtime-label-based dispatch
- Static asset fast path stays in dispatcher
- Response header merging

### Phase 3 — Test harness (1-2 days)
- Port `scripts/e2e-deploy.sh` to use the multi-worker launcher
- `scripts/e2e-logs.sh` aggregates logs from all three workers
- Verify one known-good test (e.g. `/` homepage) passes through all
  three workers

### Phase 4 — Validation (1-2 days)
- Run `app-action.test.ts` (target: 4 sub-tests now pass)
- Run the rest of the existing adapter tests — triage regressions
- Back-patch any cross-worker state leak issues (R1)

**Total: 8-13 days**.

## Fallback plan

If Phase 0 spike reveals that miniflare's multi-worker service bindings
have a blocker we can't work around locally (e.g. streaming doesn't
actually work, or DO script_name bindings don't resolve in dev), the
fallback is:

1. Keep the current single-worker build output
2. Mark Category A as explicitly "non-applicable by adapter design"
   in the verified-adapter submission
3. Document the multi-worker design as future work

The 1-2 day Phase 0 investment is a cheap de-risking of the 8-13 day
full implementation.

// Shim for `next/dist/server/app-render/module-loading/track-module-loading.instance`.
//
// Next's original keeps `_moduleLoadingSignal` as a **module-level singleton**:
//
//   let _moduleLoadingSignal
//   function getModuleLoadingSignal() {
//     if (!_moduleLoadingSignal) _moduleLoadingSignal = new CacheSignal()
//     return _moduleLoadingSignal
//   }
//
// On Node that's fine — there's no IoContext. On workerd it's a cross-request
// leak: CacheSignal.noMorePendingCaches schedules a `setImmediate` inside
// `scheduleImmediateAndTimeoutWithCleanup` and stores the returned cleanup
// closure (which captures the Immediate) on `this.pendingTimeoutCleanup`. The
// Immediate object is bound to the creating request's IoContext. A later
// request calls `beginRead()` → `this.pendingTimeoutCleanup()` →
// `clearImmediate(immediate)`, at which point workerd throws:
//
//   "Cannot perform I/O on behalf of a different request."
//
// Repro on workerd: hit `/opengraph-image` (a route that uses dynamic imports
// during render) twice — the second request 500s with the stack ending in
// `CacheSignal.pendingTimeoutCleanup → patchedClearImmediate`.
//
// Fix: scope the signal per-request via AsyncLocalStorage so the closed-over
// Immediate never crosses requests. The adapter's fetch handler calls
// `__withModuleLoadingContext(fn)` before invoking user handlers; every call
// inside that scope shares one signal.
//
// Outside a scope (shouldn't happen at runtime on workerd) we fall back to a
// module-level instance. That preserves the original behavior for build-time
// callers or any surface we haven't wrapped.

import { AsyncLocalStorage } from "node:async_hooks";
import { CacheSignal } from "next/dist/server/app-render/cache-signal.js";

const als = new AsyncLocalStorage();
let fallbackSignal = null;

function getModuleLoadingSignal() {
  const scoped = als.getStore();
  if (scoped) return scoped;
  if (!fallbackSignal) fallbackSignal = new CacheSignal();
  return fallbackSignal;
}

export function trackPendingChunkLoad(promise) {
  getModuleLoadingSignal().trackRead(promise);
}

export function trackPendingImport(exportsOrPromise) {
  if (exportsOrPromise && typeof exportsOrPromise.then === "function") {
    const promise = Promise.resolve(exportsOrPromise);
    getModuleLoadingSignal().trackRead(promise);
  }
}

export function trackPendingModules(cacheSignal) {
  const moduleLoadingSignal = getModuleLoadingSignal();
  const unsubscribe = moduleLoadingSignal.subscribeToReads(cacheSignal);
  cacheSignal.cacheReady().then(unsubscribe);
}

// Adapter hook: run `fn` with a fresh module-loading signal scoped to the
// current async context. Called from worker-entry at the start of each fetch.
globalThis.__CREEK_WITH_MODULE_LOADING_CONTEXT = function (fn) {
  return als.run(new CacheSignal(), fn);
};

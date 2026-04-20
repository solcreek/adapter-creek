// Shim for next/dist/server/node-environment-extensions/fast-set-immediate.
//
// We previously attempted both a global patch (aae8f5e, reverted: +5/-8) and
// a scoped patch inside `DANGEROUSLY_runPendingImmediatesAfterCurrentTask()`
// (43dd840: +2 cached-navigations/vary-params, −4 memory-pressure/search-params/
// next-form-prefetch/use-link-status). Both net-negative.
//
// Accept no-op until we find a per-call-site patch (e.g. targeting
// runInSequentialTasks directly) that doesn't shift the prefetch-cache cluster's
// setImmediate timing. CF Workers with nodejs_compat provides native
// setImmediate; Next's cacheComponents staging fails to guarantee "fast
// immediates" as well as on Node, but segment-cache/cached-navigations +
// vary-params being 2 failures is a smaller cost than 4 prefetch-cluster
// regressions.
export function install() {}
// Keep the named export Next's app-render-scheduling reads.
export const unpatchedSetImmediate = globalThis.setImmediate;

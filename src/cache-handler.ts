// Re-export the shared in-memory Next.js ISR cache handler from
// @solcreek/adapter-core. The implementation now lives there so both
// adapter-creek and adapter-creekd can share a single tested copy.
//
// This file exists for backwards compatibility: users who set
// `cacheHandler: require.resolve("@solcreek/adapter-creek/cache-handler")`
// in their next.config continue to work without changes. New users
// can wire either path; both resolve to the same module at runtime.

export { default } from "@solcreek/adapter-core/cache-handler";

/**
 * Cache handler for Next.js ISR on Cloudflare Workers.
 *
 * Implements the cacheHandler interface (get/set/revalidateTag/resetRequestCache).
 * Uses in-memory Map for single-instance caching.
 *
 * TODO: Phase 2 — migrate to Durable Objects for persistent, multi-instance cache
 * with tag-based invalidation via DOShardedTagCache.
 */

interface CacheEntry {
  value: unknown;
  lastModified: number;
  tags: string[];
  revalidate?: number;
}

const cache = new Map<string, CacheEntry>();
const tagToKeys = new Map<string, Set<string>>();

module.exports = class CacheHandler {
  constructor(_ctx?: unknown) {
    // Context includes serverDistDir, dev, etc.
    // Not needed for in-memory implementation.
  }

  async get(key: string, _ctx?: { kind?: string }) {
    const entry = cache.get(key);
    if (!entry) return null;

    // Check if stale (time-based revalidation)
    // revalidate: 0 means always stale (revalidate on every request)
    if (entry.revalidate !== undefined && entry.revalidate !== false) {
      const age = (Date.now() - entry.lastModified) / 1000;
      if (entry.revalidate === 0 || age > entry.revalidate) {
        // Stale — return data but signal revalidation needed
        return {
          value: entry.value,
          lastModified: entry.lastModified,
          age: Math.floor(age),
          cacheState: "stale" as const,
        };
      }
    }

    return {
      value: entry.value,
      lastModified: entry.lastModified,
      age: Math.floor((Date.now() - entry.lastModified) / 1000),
      cacheState: "fresh" as const,
    };
  }

  async set(
    key: string,
    data: unknown | null,
    ctx?: { tags?: string[]; revalidate?: number | false },
  ) {
    if (data === null) {
      cache.delete(key);
      return;
    }

    const tags = ctx?.tags ?? [];
    const revalidate = typeof ctx?.revalidate === "number" ? ctx.revalidate : undefined;

    cache.set(key, {
      value: data,
      lastModified: Date.now(),
      tags,
      revalidate,
    });

    // Index by tags for revalidateTag()
    for (const tag of tags) {
      let keys = tagToKeys.get(tag);
      if (!keys) {
        keys = new Set();
        tagToKeys.set(tag, keys);
      }
      keys.add(key);
    }
  }

  async revalidateTag(tag: string | string[]) {
    const tags = Array.isArray(tag) ? tag : [tag];

    for (const t of tags) {
      const keys = tagToKeys.get(t);
      if (keys) {
        for (const key of keys) {
          cache.delete(key);
        }
        tagToKeys.delete(t);
      }
    }
  }

  resetRequestCache() {
    // No per-request cache to reset in this implementation.
  }
};

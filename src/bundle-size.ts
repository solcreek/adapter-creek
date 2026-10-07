/**
 * Worker bundle size guard.
 *
 * Cloudflare Workers cap a script at 64 MiB UNCOMPRESSED — the sum of every
 * uploaded module (worker.js + wasm + any other module), on every plan. Since
 * 2026-09-04 that is the only size check; the old gzipped limits (3 MB free /
 * 10 MB paid) are gone. Verified 2026-10-07 against a Workers for Platforms
 * dispatch namespace: a 60 MiB script (45 MiB gzipped) uploads, a 70 MiB
 * script that gzips to 0.1 MiB is rejected with code 10027 "Your Worker
 * exceeded the uncompressed size limit of 64 MiB."
 *
 * A bundle over the limit only fails at UPLOAD — by then the user has waited
 * through a full build with no hint at the cause. The usual culprits are a
 * stale `.next/dev` build being scanned, or a native (.node) module (e.g.
 * better-sqlite3) getting inlined into the worker.
 *
 * This evaluates the bundled script size BEFORE upload so the build can fail
 * fast with the actual size, the limit, the largest files, and a likely cause.
 * Pure + exported for testing; build.ts feeds it real sizes.
 */

const MiB = 1024 * 1024;

/** Workers script size limit: uncompressed bytes, all plans. */
export const WORKER_SIZE_LIMIT = 64 * MiB;

/**
 * Warn once a bundle passes this share of the limit. It still uploads, but a
 * script this large is also the one most likely to blow the 1 s startup limit,
 * and a few more dependencies tip it over.
 */
export const WORKER_SIZE_WARN_RATIO = 0.75;

export interface ScriptFileSize {
  /** File name (e.g. "worker.js", "<hash>-compiler.wasm"). */
  name: string;
  /** Uncompressed size in bytes (what the Workers limit is measured against). */
  size: number;
}

export interface BundleSizeVerdict {
  /** "ok" under the warn threshold; "near-limit" at/over it but ≤ the limit; "over-limit" past the limit. */
  level: "ok" | "near-limit" | "over-limit";
  totalSize: number;
  /** Human-readable warning/error text (null when ok). */
  message: string | null;
}

function fmtMiB(bytes: number): string {
  return `${(bytes / MiB).toFixed(1)} MiB`;
}

/**
 * Classify a bundled worker's uncompressed script size against the Workers
 * limit. `nativeRefs` (count of quoted `.node` filename references in the
 * worker — inlined native modules, not bare `.node` property access) drives a
 * native-module hint on the over-limit message.
 */
export function evaluateBundleSize(
  files: ScriptFileSize[],
  opts: { nativeRefs?: number; limit?: number; warnRatio?: number } = {},
): BundleSizeVerdict {
  const limit = opts.limit ?? WORKER_SIZE_LIMIT;
  const warnAt = limit * (opts.warnRatio ?? WORKER_SIZE_WARN_RATIO);
  const nativeRefs = opts.nativeRefs ?? 0;
  const totalSize = files.reduce((n, f) => n + f.size, 0);

  if (totalSize < warnAt) return { level: "ok", totalSize, message: null };

  const biggest = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, 3)
    .map((f) => `      ${f.name} — ${fmtMiB(f.size)}`)
    .join("\n");

  if (totalSize > limit) {
    let message =
      `Worker bundle is ${fmtMiB(totalSize)} uncompressed, over the Cloudflare Workers ` +
      `script limit (${fmtMiB(limit)}). It would be rejected at upload.\n` +
      `    Largest files:\n${biggest}\n` +
      `    Common causes: a stale \`.next/dev\` dev build being scanned, or a native ` +
      `module inlined (e.g. better-sqlite3 — the Creek adapter swaps it for D1, see ` +
      `CK-SYNC-SQLITE). Try a clean build: \`rm -rf .next .creek && npx creek@latest deploy\`.`;
    if (nativeRefs > 0) {
      message += `\n    (${nativeRefs} inlined native-module reference(s) (\`.node\`) seen — a hint, not a guarantee.)`;
    }
    return { level: "over-limit", totalSize, message };
  }

  return {
    level: "near-limit",
    totalSize,
    message:
      `Worker bundle is ${fmtMiB(totalSize)} uncompressed, ` +
      `${Math.round((totalSize / limit) * 100)}% of the ${fmtMiB(limit)} Cloudflare Workers ` +
      `script limit. It will upload, but has little headroom.\n    Largest files:\n${biggest}`,
  };
}

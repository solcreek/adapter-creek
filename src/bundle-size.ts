/**
 * Worker bundle size guard.
 *
 * Cloudflare Workers enforce a per-script size limit (gzipped): ~3MB on the
 * free plan, ~10MB on paid. A bundle that blows past this only fails at UPLOAD
 * with a terse "Payload Too Large" — by then the user has waited through a full
 * build with no hint at the cause. The usual culprit is a native (.node) module
 * (e.g. better-sqlite3) getting inlined into the worker.
 *
 * This evaluates the bundled script size BEFORE upload so the build can fail
 * fast with the actual size, the limit, the largest files, and a likely cause.
 * Pure + exported for testing; build.ts feeds it real sizes.
 */

const MB = 1024 * 1024;
export const WFP_FREE_LIMIT = 3 * MB;
export const WFP_PAID_LIMIT = 10 * MB;

export interface ScriptFileSize {
  /** File name (e.g. "worker.js", "<hash>-compiler.wasm"). */
  name: string;
  /** Gzipped size in bytes (what the Workers limit is measured against). */
  gzipSize: number;
}

export interface BundleSizeVerdict {
  /** "ok" ≤ free limit; "free-warning" over free but ≤ paid; "over-limit" over paid. */
  level: "ok" | "free-warning" | "over-limit";
  totalGzip: number;
  /** Human-readable warning/error text (null when ok). */
  message: string | null;
}

function fmtMB(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * Classify a bundled worker's gzipped script size against the Workers limits.
 * `nativeRefs` (count of quoted `.node` filename references in the worker —
 * inlined native modules, not bare `.node` property access) drives a
 * native-module hint on the over-limit message.
 */
export function evaluateBundleSize(
  files: ScriptFileSize[],
  opts: { nativeRefs?: number; freeLimit?: number; paidLimit?: number } = {},
): BundleSizeVerdict {
  const freeLimit = opts.freeLimit ?? WFP_FREE_LIMIT;
  const paidLimit = opts.paidLimit ?? WFP_PAID_LIMIT;
  const nativeRefs = opts.nativeRefs ?? 0;
  const totalGzip = files.reduce((n, f) => n + f.gzipSize, 0);

  if (totalGzip <= freeLimit) return { level: "ok", totalGzip, message: null };

  const biggest = [...files]
    .sort((a, b) => b.gzipSize - a.gzipSize)
    .slice(0, 3)
    .map((f) => `      ${f.name} — ${fmtMB(f.gzipSize)}`)
    .join("\n");

  if (totalGzip > paidLimit) {
    let message =
      `Worker bundle is ${fmtMB(totalGzip)} gzipped, over the Cloudflare Workers ` +
      `script limit (${fmtMB(paidLimit)}). It would be rejected at upload.\n` +
      `    Largest files:\n${biggest}\n` +
      `    Common causes: a stale \`.next/dev\` dev build being scanned, or a native ` +
      `module inlined (e.g. better-sqlite3 — the Creek adapter swaps it for D1, see ` +
      `CK-SYNC-SQLITE). Try a clean build: \`rm -rf .next .creek && npx creek@latest deploy\`.`;
    if (nativeRefs > 0) {
      message += `\n    (${nativeRefs} inlined native-module reference(s) (\`.node\`) seen — a hint, not a guarantee.)`;
    }
    return { level: "over-limit", totalGzip, message };
  }

  return {
    level: "free-warning",
    totalGzip,
    message:
      `Worker bundle is ${fmtMB(totalGzip)} gzipped, over the ${fmtMB(freeLimit)} ` +
      `free-plan limit (fits the paid plan).\n    Largest files:\n${biggest}`,
  };
}

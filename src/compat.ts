/**
 * Single source of truth for the compatibility settings the generated
 * worker is built AND deployed with.
 *
 * The Next.js worker statically imports node:http (server APIs). Per
 * Cloudflare's Node.js docs, node:http is served by the umbrella
 * `nodejs_compat` flag (NOT `nodejs_compat_v2`, which the docs no longer
 * list and which WfP rejects for node:http). Its SERVER modules
 * (`http.createServer`/`Server`/`ServerResponse`) are gated behind
 * `enable_nodejs_http_server_modules`, auto-enabled only at
 * compatibility_date >= 2025-09-01 (client APIs at 2025-08-15). This is why
 * a 2025-03-14 deploy was rejected with "No such module node:http".
 *
 * The bundle step (bundler.ts) and the deploy manifest (manifest.ts) MUST
 * agree: the worker is validated at upload against the date/flags it ships
 * with, so the deploy must use exactly what the bundle was built against.
 * Keep DATE >= 2025-09-01.
 */
export const WORKER_COMPATIBILITY_DATE = "2026-03-28";
export const WORKER_COMPATIBILITY_FLAGS: readonly string[] = ["nodejs_compat"];

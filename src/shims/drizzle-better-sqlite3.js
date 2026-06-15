// Creek build-time swap for `drizzle-orm/better-sqlite3` → Cloudflare D1.
//
// Only active in the Creek/Workers build (aliased by adapter-creek's
// modifyConfig); local dev keeps the real better-sqlite3 driver. The user's
// `drizzle(new Database(...), config)` call is preserved verbatim — we ignore
// the local client and back the same Drizzle instance with the request's D1
// binding instead, resolved lazily so it works at module scope (env.DB is
// only available per-request via AsyncLocalStorage).
import { drizzle as drizzleD1 } from "drizzle-orm/d1";

// Resolve the request's D1 binding, distinguishing the two failure modes so the
// error is actionable:
//   - no `__creekEnv` accessor  → we're running outside a request, i.e. at
//     BUILD time. Next runs DB code during static generation (`next build`);
//     the D1 binding only exists at request time on Workers.
//   - accessor present, no DB   → deployed, but no database resource is bound.
function resolveCreekD1() {
  const accessor = globalThis.__creekEnv;
  if (typeof accessor !== "function") {
    throw new Error(
      "[creek] Database accessed during build (static generation). The D1 " +
        "binding only exists at request time on Workers — mark this route/page " +
        '`export const dynamic = "force-dynamic"` (or move the query into a ' +
        "request handler) so it runs on D1 at runtime.",
    );
  }
  const db = (accessor() || {}).DB;
  if (!db) {
    throw new Error(
      "[creek] D1 binding `env.DB` is unavailable. Add `database = true` under [resources] in creek.toml.",
    );
  }
  return db;
}

const lazyD1 = new Proxy(
  {},
  {
    get(_t, prop) {
      const db = resolveCreekD1();
      const v = db[prop];
      return typeof v === "function" ? v.bind(db) : v;
    },
  },
);

export function drizzle(_client, config) {
  // _client is the user's better-sqlite3 instance — ignored on Workers.
  return drizzleD1(lazyD1, config);
}

export default drizzle;

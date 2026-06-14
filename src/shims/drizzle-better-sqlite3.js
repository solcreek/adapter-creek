// Creek build-time swap for `drizzle-orm/better-sqlite3` → Cloudflare D1.
//
// Only active in the Creek/Workers build (aliased by adapter-creek's
// modifyConfig); local dev keeps the real better-sqlite3 driver. The user's
// `drizzle(new Database(...), config)` call is preserved verbatim — we ignore
// the local client and back the same Drizzle instance with the request's D1
// binding instead, resolved lazily so it works at module scope (env.DB is
// only available per-request via AsyncLocalStorage).
import { drizzle as drizzleD1 } from "drizzle-orm/d1";

const lazyD1 = new Proxy(
  {},
  {
    get(_t, prop) {
      const env = (globalThis.__creekEnv && globalThis.__creekEnv()) || {};
      const db = env.DB;
      if (!db) {
        throw new Error(
          "[creek] D1 binding `env.DB` is unavailable. Add `database = true` under [resources] in creek.toml.",
        );
      }
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

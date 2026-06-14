// Creek build-time swap for `@prisma/adapter-better-sqlite3` → Cloudflare D1.
//
// Only active in the Creek/Workers build (aliased by adapter-creek's
// modifyConfig); local dev keeps the real better-sqlite3 adapter. Prisma 7
// requires a driver adapter, so the user already passes
// `new PrismaClient({ adapter: new PrismaBetterSqlite3(...) })`. The ONLY
// env-specific difference on Workers is which adapter backs the client — the
// schema, generated client, and queries are identical. We mirror the
// better-sqlite3 factory's shape but back it with `@prisma/adapter-d1` over the
// request's D1 binding.
//
// The user constructs the adapter at module scope, before env.DB exists.
// Prisma reads `provider` synchronously at PrismaClient construction and only
// calls `connect()` at the first query (request time), so D1 is resolved
// lazily inside connect() — never at construction.
//
// `@prisma/adapter-d1` is an OPTIONAL peer of adapter-creek: it isn't shipped
// to non-Prisma projects. The Creek CLI installs it into .creek on demand when
// it detects a Prisma-on-D1 project (matching the project's Prisma version),
// so this import resolves at build time only when the swap is actually used.
import { PrismaD1 } from "@prisma/adapter-d1";

function resolveD1() {
  const env = (globalThis.__creekEnv && globalThis.__creekEnv()) || {};
  const db = env.DB;
  if (!db) {
    throw new Error(
      "[creek] D1 binding `env.DB` is unavailable. Add `database = true` under [resources] in creek.toml.",
    );
  }
  return db;
}

class PrismaBetterSqlite3 {
  constructor() {
    // Read synchronously by @prisma/client at construction time.
    this.provider = "sqlite";
    this.adapterName = "@prisma/adapter-d1";
  }

  connect() {
    return new PrismaD1(resolveD1()).connect();
  }

  connectToShadowDb() {
    const factory = new PrismaD1(resolveD1());
    return factory.connectToShadowDb
      ? factory.connectToShadowDb()
      : factory.connect();
  }
}

export { PrismaBetterSqlite3 };
export default PrismaBetterSqlite3;

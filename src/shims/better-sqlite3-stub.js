// Creek: better-sqlite3 is a native module that cannot run on Cloudflare
// Workers. The Drizzle/Prisma driver-swap shims ignore the local client and
// use the D1 binding instead, so the actual better-sqlite3 instance is never
// used on Workers — stub it to a harmless no-op so the bundle builds. Local
// dev keeps the real better-sqlite3.
class Database {
  constructor() {}
  prepare() { throw new Error("[creek] better-sqlite3 is not available on Workers; queries run on D1 via the driver swap."); }
  exec() {}
  close() {}
  pragma() {}
}
export default Database;
export { Database };

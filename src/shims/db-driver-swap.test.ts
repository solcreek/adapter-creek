import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import adapter from "../index.js";

// The drizzle shim imports `drizzle-orm/d1`, which is resolved from the user's
// project at build time (drizzle-orm is not an adapter-creek dependency). Mock
// it so the swap logic can be unit-tested in isolation: the mock drizzle()
// just records the client + config it was handed.
vi.mock("drizzle-orm/d1", () => ({
  drizzle: (client: unknown, config: unknown) => ({ __d1Client: client, __config: config }),
}));

// The Prisma shim imports `@prisma/adapter-d1` (an adapter-creek dependency).
// Mock PrismaD1 so connect() can be asserted without a live D1 binding.
vi.mock("@prisma/adapter-d1", () => ({
  PrismaD1: class {
    db: unknown;
    constructor(db: unknown) { this.db = db; }
    connect() { return { kind: "d1-adapter", db: this.db }; }
    connectToShadowDb() { return { kind: "d1-shadow", db: this.db }; }
  },
}));

const SHIMS_DIR = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  delete (globalThis as { __creekEnv?: unknown }).__creekEnv;
});

describe("DB driver-swap aliases (modifyConfig)", () => {
  it("aliases the local SQLite drivers to Creek shims in the Workers build", () => {
    const config = adapter.modifyConfig?.(
      {},
      { phase: "phase-production-build" } as never,
    );

    // The adapter exposes webpack(cfg, ctx); applying it surfaces the aliases.
    const webpack = (config as { webpack?: (c: unknown, x: unknown) => any }).webpack;
    expect(typeof webpack).toBe("function");

    const built = webpack!({ resolve: {} }, {});
    const alias = built.resolve.alias as Record<string, string>;

    expect(alias["drizzle-orm/better-sqlite3$"]).toBe(
      path.join(SHIMS_DIR, "drizzle-better-sqlite3.js"),
    );
    expect(alias["@prisma/adapter-better-sqlite3$"]).toBe(
      path.join(SHIMS_DIR, "prisma-adapter-better-sqlite3.js"),
    );
    expect(alias["better-sqlite3$"]).toBe(
      path.join(SHIMS_DIR, "better-sqlite3-stub.js"),
    );
    // Prisma query-compiler base64 → tiny sentinel stub (size optimization).
    expect(alias["@prisma/client/runtime/query_compiler_fast_bg.sqlite.wasm-base64.mjs$"]).toBe(
      path.join(SHIMS_DIR, "prisma-wasm-base64-stub.mjs"),
    );
  });

  it("ships a small sentinel stub for the Prisma compiler base64", async () => {
    const { wasm } = await import("./prisma-wasm-base64-stub.mjs");
    // Must be valid base64 that decodes to a fixed, non-trivial sentinel
    // length (build.ts registers the precompiled compiler under it), and far
    // smaller than the real ~4.7MB base64 it replaces.
    expect(typeof wasm).toBe("string");
    expect(wasm.length).toBeLessThan(20_000);
    const decoded = Buffer.from(wasm as string, "base64").byteLength;
    expect(decoded).toBeGreaterThan(0);
  });

  it("preserves a base webpack fn while adding the DB aliases", () => {
    // modifyConfig composes its webpack on top of whatever the base set; verify
    // a pre-existing alias survives alongside the swap aliases.
    const config = adapter.modifyConfig?.(
      {},
      { phase: "phase-production-build" } as never,
    );
    const webpack = (config as { webpack?: (c: unknown, x: unknown) => any }).webpack;
    const built = webpack!({ resolve: { alias: { "pre-existing": "/x" } } }, {});
    const alias = built.resolve.alias as Record<string, string>;
    expect(alias["pre-existing"]).toBe("/x");
    expect(alias["drizzle-orm/better-sqlite3$"]).toContain("drizzle-better-sqlite3.js");
  });

  it("does not add the aliases outside the production build phase", () => {
    const config = adapter.modifyConfig?.({}, { phase: "phase-development-server" } as never);
    // Dev passthrough should not install the Workers-only webpack swap.
    expect((config as { webpack?: unknown }).webpack).toBeUndefined();
  });
});

describe("drizzle-better-sqlite3 shim", () => {
  it("backs drizzle with env.DB (resolved lazily) and ignores the local client", async () => {
    const { drizzle } = await import("./drizzle-better-sqlite3.js");

    const fakeD1 = { __isD1: true, prepare: () => "stmt" };
    (globalThis as { __creekEnv?: () => unknown }).__creekEnv = () => ({ DB: fakeD1 });

    const localClient = { native: true };
    const db = drizzle(localClient as never, { schema: {} }) as {
      __d1Client: Record<string, unknown>;
      __config: unknown;
    };

    // The user's local better-sqlite3 client is ignored; config flows through.
    expect(db.__config).toEqual({ schema: {} });
    // The D1 client is a lazy proxy that resolves env.DB per property access.
    expect((db.__d1Client as { __isD1: boolean }).__isD1).toBe(true);
    expect(typeof db.__d1Client.prepare).toBe("function");
    expect((db.__d1Client.prepare as () => string)()).toBe("stmt");
  });

  it("throws a helpful error when env.DB is unavailable (deployed, no binding)", async () => {
    const { drizzle } = await import("./drizzle-better-sqlite3.js");
    (globalThis as { __creekEnv?: () => unknown }).__creekEnv = () => ({});
    const db = drizzle({} as never, {}) as { __d1Client: Record<string, unknown> };
    expect(() => db.__d1Client.prepare).toThrow(/D1 binding `env\.DB` is unavailable/);
  });

  it("explains the build-time (SSG) case when there is no request env accessor", async () => {
    const { drizzle } = await import("./drizzle-better-sqlite3.js");
    // No __creekEnv (afterEach deleted it) → running outside a request, i.e.
    // Next static generation during build.
    const db = drizzle({} as never, {}) as { __d1Client: Record<string, unknown> };
    expect(() => db.__d1Client.all).toThrow(/static generation/);
    expect(() => db.__d1Client.all).toThrow(/force-dynamic/);
  });

  it("resolves env per access (request-scoped), not once at construction", async () => {
    const { drizzle } = await import("./drizzle-better-sqlite3.js");
    let current: { DB?: unknown } = {};
    (globalThis as { __creekEnv?: () => unknown }).__creekEnv = () => current;
    const db = drizzle({} as never, {}) as { __d1Client: Record<string, unknown> };

    // No binding yet → throws.
    expect(() => db.__d1Client.prepare).toThrow();
    // Binding appears on a later request → resolves without rebuilding.
    current = { DB: { tag: "req-2", prepare: () => "ok" } };
    expect((db.__d1Client.prepare as () => string)()).toBe("ok");
  });
});

describe("prisma-adapter-better-sqlite3 shim", () => {
  it("exposes provider synchronously and ignores the local config", async () => {
    const { PrismaBetterSqlite3 } = await import("./prisma-adapter-better-sqlite3.js");
    // Constructed at module scope, before any request env exists.
    const adapter = new PrismaBetterSqlite3({ url: "file:./dev.db" });
    expect(adapter.provider).toBe("sqlite");
    expect(adapter.adapterName).toBe("@prisma/adapter-d1");
  });

  it("connects against env.DB lazily (at first query, not construction)", async () => {
    const { PrismaBetterSqlite3 } = await import("./prisma-adapter-better-sqlite3.js");
    const adapter = new PrismaBetterSqlite3({ url: "file:./dev.db" });

    const fakeD1 = { tag: "d1" };
    (globalThis as { __creekEnv?: () => unknown }).__creekEnv = () => ({ DB: fakeD1 });

    const conn = adapter.connect() as { kind: string; db: unknown };
    expect(conn.kind).toBe("d1-adapter");
    expect(conn.db).toBe(fakeD1);

    const shadow = adapter.connectToShadowDb() as { kind: string };
    expect(shadow.kind).toBe("d1-shadow");
  });

  it("throws a helpful error when env.DB is unavailable at connect() (deployed, no binding)", async () => {
    const { PrismaBetterSqlite3 } = await import("./prisma-adapter-better-sqlite3.js");
    const adapter = new PrismaBetterSqlite3({ url: "file:./dev.db" });
    (globalThis as { __creekEnv?: () => unknown }).__creekEnv = () => ({});
    expect(() => adapter.connect()).toThrow(/D1 binding `env\.DB` is unavailable/);
  });

  it("explains the build-time (SSG) case when there is no request env accessor", async () => {
    const { PrismaBetterSqlite3 } = await import("./prisma-adapter-better-sqlite3.js");
    const adapter = new PrismaBetterSqlite3({ url: "file:./dev.db" });
    // No __creekEnv → build-time (static generation) query.
    expect(() => adapter.connect()).toThrow(/static generation/);
    expect(() => adapter.connect()).toThrow(/force-dynamic/);
  });
});

describe("better-sqlite3 stub", () => {
  it("constructs but refuses queries (swap uses D1 instead)", async () => {
    const { default: Database } = await import("./better-sqlite3-stub.js");
    const dbInst = new Database();
    expect(dbInst).toBeInstanceOf(Database);
    expect(() => dbInst.prepare()).toThrow(/not available on Workers/);
    // Lifecycle no-ops don't throw.
    expect(() => dbInst.exec()).not.toThrow();
    expect(() => dbInst.close()).not.toThrow();
  });
});

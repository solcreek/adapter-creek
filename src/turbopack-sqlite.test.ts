import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTurbopackSqliteDrivers, isTurbopackBuild, turbopackSqliteError } from "./turbopack-sqlite";

let distDir: string;

beforeEach(() => {
  distDir = mkdtempSync(path.join(tmpdir(), "adapter-creek-turbopack-sqlite-"));
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const file = path.join(distDir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A Turbopack server build: the runtime chunk plus one route chunk with `code`. */
function turbopackBuild(code: string): void {
  write("server/chunks/[turbopack]_runtime.js", "/* turbopack runtime */");
  write("server/chunks/[root-of-the-server]__0sw487e._.js", code);
}

// As Next 16.2.3's Turbopack emits a route that imports better-sqlite3.
const EXTERNAL = 'e.x("better-sqlite3-90e2652d1716b047",()=>require("better-sqlite3-90e2652d1716b047"))';

describe("isTurbopackBuild", () => {
  it("recognises the Turbopack runtime chunk, in chunks/ or below it", async () => {
    write("server/chunks/123.js", "");
    expect(await isTurbopackBuild(distDir)).toBe(false);
    write("server/chunks/ssr/[turbopack]_runtime.js", "");
    expect(await isTurbopackBuild(distDir)).toBe(true);
  });
});

describe("findTurbopackSqliteDrivers", () => {
  it("finds better-sqlite3 as a hashed Turbopack external", async () => {
    turbopackBuild(EXTERNAL);
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual(["better-sqlite3"]);
  });

  it("finds a driver bundled as modules of the package", async () => {
    turbopackBuild('"[project]/node_modules/better-sqlite3/lib/database.js [app-route] (ecmascript)"');
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual(["better-sqlite3"]);
  });

  it("finds the external through either half of Turbopack's external call", async () => {
    turbopackBuild('e.x("better-sqlite3-90e2652d1716b047",()=>null)');
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual(["better-sqlite3"]);
    turbopackBuild('const m = require("better-sqlite3-90e2652d1716b047");');
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual(["better-sqlite3"]);
  });

  it("finds a plain require of the package", async () => {
    turbopackBuild('module.exports = require("better-sqlite3");');
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual(["better-sqlite3"]);
  });

  it("finds the Prisma adapter alongside the driver it loads, in a nested chunk", async () => {
    write("server/chunks/[turbopack]_runtime.js", "");
    write(
      "server/chunks/ssr/[root-of-the-server]__a._.js",
      `e.x("@prisma/adapter-better-sqlite3-0123456789abcdef",()=>require("@prisma/adapter-better-sqlite3-0123456789abcdef"));${EXTERNAL}`,
    );
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual(["better-sqlite3", "@prisma/adapter-better-sqlite3"]);
  });

  it("ignores a webpack or Rspack build, which has no Turbopack runtime", async () => {
    // The webpack aliases already swapped the driver; any mention is the shim.
    write("server/chunks/123.js", EXTERNAL);
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual([]);
  });

  it("ignores a Turbopack build without the drivers", async () => {
    turbopackBuild('e.x("@prisma/adapter-d1-0123456789abcdef",()=>require("@prisma/adapter-d1-0123456789abcdef"))');
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual([]);
  });

  it("ignores mentions that are not the driver itself", async () => {
    turbopackBuild(
      [
        'const config = { driver: "better-sqlite3" };', // a value in application code
        'const id = "better-sqlite3-deadbeef";', // a hash-shaped value, not an external
        '"[project]/node_modules/drizzle-orm/better-sqlite3/driver.js"', // another package's subpath
        "// install better-sqlite3 for local development",
      ].join("\n"),
    );
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual([]);
  });

  it("ignores source maps and other non-JS files", async () => {
    turbopackBuild("export {};");
    write("server/chunks/[root-of-the-server]__0sw487e._.js.map", JSON.stringify({ sourcesContent: [EXTERNAL] }));
    write("server/app/api/db/route.js.nft.json", JSON.stringify({ files: ["../node_modules/better-sqlite3/lib/index.js"] }));
    expect(await findTurbopackSqliteDrivers(distDir)).toEqual([]);
  });

  it("finds nothing without a server directory", async () => {
    expect(await findTurbopackSqliteDrivers(path.join(distDir, "missing"))).toEqual([]);
  });
});

describe("turbopackSqliteError", () => {
  it("names the drivers, the webpack build, and that direct use is unsupported", () => {
    expect(turbopackSqliteError(["better-sqlite3", "@prisma/adapter-better-sqlite3"]).message).toBe(
      "[Creek Adapter] This Turbopack build contains better-sqlite3 and @prisma/adapter-better-sqlite3. " +
        "The adapter runs the Prisma and Drizzle better-sqlite3 adapters on D1 through webpack aliases, " +
        "which Turbopack does not apply, so every database route would fail on Workers. Build with " +
        "`next build --webpack`; `creek deploy` runs it for you. Code that calls better-sqlite3 directly " +
        "is not supported on Workers.",
    );
  });
});

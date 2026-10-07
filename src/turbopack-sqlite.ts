/**
 * Find a native SQLite driver in a Turbopack build's server output.
 *
 * The adapter swaps local SQLite drivers for D1 through webpack aliases (see
 * `webpack()` in index.ts). A Turbopack build never applies them, so a project
 * that imports `better-sqlite3` (directly, or through
 * `@prisma/adapter-better-sqlite3` or `drizzle-orm/better-sqlite3`) gets the
 * native driver in its server chunks, and every database route fails on
 * Workers ("Dynamic require of .../better_sqlite3.node is not supported").
 *
 * This reads the build's output rather than predicting from package.json, so
 * it does not depend on where the dependency is declared, the directory the
 * build ran from, or bundler environment variables:
 * - a Turbopack build is one with a `[turbopack]_runtime.js` server chunk,
 *   which webpack and Rspack builds never emit;
 * - a driver is present when a server chunk loads it as a Turbopack external
 *   (`e.x("better-sqlite3-<hash>", () => require("better-sqlite3-<hash>"))`),
 *   requires it, or bundles one of its modules
 *   (`[project]/node_modules/better-sqlite3/…`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const DRIVERS = ["better-sqlite3", "@prisma/adapter-better-sqlite3"] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const DRIVER_PATTERNS = DRIVERS.map((name) => {
  const n = escapeRegExp(name);
  // Turbopack's external call `.x("<name>-<hash>"`, a require of the package
  // (hashed or not), or a path into the package's own directory. A quoted
  // name, hashed or not, is not enough on its own: application code can hold
  // it as a value.
  const id = `["']${n}(?:-[0-9a-f]{8,})?["']`;
  return { name, pattern: new RegExp(`\\.x\\(${id}|require\\(${id}\\)|node_modules/${n}/`) };
});

async function* serverChunks(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* serverChunks(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

/** Whether `distDir` holds a Turbopack build. */
export async function isTurbopackBuild(distDir: string): Promise<boolean> {
  for await (const file of serverChunks(path.join(distDir, "server", "chunks"))) {
    if (path.basename(file) === "[turbopack]_runtime.js") return true;
  }
  return false;
}

/**
 * The native SQLite drivers a Turbopack build's server chunks contain, in
 * DRIVERS order; empty for a webpack or Rspack build, or a Turbopack build
 * without them.
 */
export async function findTurbopackSqliteDrivers(distDir: string): Promise<string[]> {
  if (!(await isTurbopackBuild(distDir))) return [];
  const found = new Set<string>();
  for await (const file of serverChunks(path.join(distDir, "server"))) {
    const code = await fs.readFile(file, "utf-8");
    for (const { name, pattern } of DRIVER_PATTERNS) {
      if (!found.has(name) && pattern.test(code)) found.add(name);
    }
    if (found.size === DRIVERS.length) break;
  }
  return DRIVERS.filter((name) => found.has(name));
}

/** The build error for a Turbopack build that contains `drivers`. */
export function turbopackSqliteError(drivers: string[]): Error {
  return new Error(
    `[Creek Adapter] This Turbopack build contains ${drivers.join(" and ")}. The adapter swaps ` +
      "SQLite for D1 through webpack aliases, which Turbopack does not apply, so every database " +
      "route would fail on Workers. Build with `next build --webpack`; `creek deploy` runs it for you.",
  );
}

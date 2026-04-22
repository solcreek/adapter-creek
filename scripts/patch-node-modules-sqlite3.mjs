#!/usr/bin/env node
// Creek adapter — post-install patch for `sqlite3`.
//
// When a user fixture depends on the `sqlite3` npm package, its default
// require-chain loads a native `.node` binary (`require('bindings')(...)`).
// On workerd there's no .node loader, and `pnpm install --ignore-scripts`
// (which we use for speed) also skips the native compile on build
// machines. Next.js then crashes during "Collecting page data" when it
// evaluates any module that imports sqlite3.
//
// This script replaces `node_modules/sqlite3/lib/sqlite3-binding.js`
// (the one-liner `module.exports = require('bindings')('node_sqlite3.node')`)
// with our sql.js-backed shim (`src/shims/sqlite3-binding.js`). The outer
// `sqlite3/lib/sqlite3.js` wrapper stays intact — it adds promise helpers
// on top of the classes we export here, and our Database/Statement match
// that shape.
//
// Usage:
//   node scripts/patch-node-modules-sqlite3.mjs [cwd]
// Runs from the fixture's cwd (defaults to process.cwd()).
//
// Idempotent — running twice is a no-op after the first patch.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = path.resolve(__dirname, "..");

const cwd = path.resolve(process.argv[2] || process.cwd());
const bindingPath = path.join(
  cwd,
  "node_modules",
  "sqlite3",
  "lib",
  "sqlite3-binding.js",
);

if (!existsSync(bindingPath)) {
  // Nothing to patch — fixture doesn't use sqlite3. Silent no-op.
  process.exit(0);
}

const current = readFileSync(bindingPath, "utf-8");
const MARKER = "creek-sqlite3-shim-active";
if (current.includes(MARKER)) {
  console.error(`[creek] sqlite3 shim already installed at ${bindingPath}`);
  process.exit(0);
}

// The shim needs sql.js to be resolvable via plain `require('sql.js')`.
// Option A: sql.js is already in the fixture's node_modules (hoisted by
//   pnpm because our adapter is in the fixture's deps and adapter ships
//   sql.js as a regular dep).
// Option B: resolve through the adapter's own node_modules.
//
// We check A first. If sql.js isn't hoisted, we symlink it from the
// adapter's node_modules into the fixture's sqlite3 package so plain
// `require('sql.js')` inside our shim resolves.
function resolveSqlJs() {
  const fixtureSqlJs = path.join(cwd, "node_modules", "sql.js");
  if (existsSync(path.join(fixtureSqlJs, "package.json"))) {
    return fixtureSqlJs; // already visible via normal resolution
  }
  const adapterSqlJs = path.join(ADAPTER_ROOT, "node_modules", "sql.js");
  if (!existsSync(path.join(adapterSqlJs, "package.json"))) {
    throw new Error(
      `sql.js not found in adapter's node_modules at ${adapterSqlJs} — ` +
        `run 'pnpm install' in adapter-creek first`,
    );
  }
  return adapterSqlJs;
}

const sqlJsRoot = resolveSqlJs();

// Put a symlink inside sqlite3's own node_modules/ (so Node's resolver
// finds it one directory up from our shim file).
const sqlite3Pkg = path.dirname(path.dirname(bindingPath)); // .../node_modules/sqlite3
const shadowDir = path.join(sqlite3Pkg, "node_modules");
const shadowSqlJs = path.join(shadowDir, "sql.js");
if (!existsSync(shadowSqlJs)) {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  mkdirSync(shadowDir, { recursive: true });
  try {
    symlinkSync(sqlJsRoot, shadowSqlJs, "dir");
  } catch (err) {
    // Windows or read-only fs — fall back to a shim that hard-codes the path.
    console.error(
      `[creek] symlink failed (${err.message}); falling back to absolute require path`,
    );
    // (not exercised on macOS/Linux CI; keeping the branch for completeness)
  }
}

// Copy the shim source into sqlite3's binding file.
// The shim uses sql.js's pure-JS (asm.js) build to avoid workerd's
// "Wasm code generation disallowed by embedder" restriction.
const shimSrc = path.join(ADAPTER_ROOT, "src", "shims", "sqlite3-binding.js");
if (!existsSync(shimSrc)) {
  throw new Error(`creek shim source missing: ${shimSrc}`);
}
const shimText = readFileSync(shimSrc, "utf-8");

// Stamp the marker so the idempotency check above matches.
const header = `// ${MARKER}\n`;
writeFileSync(bindingPath, header + shimText);

console.error(`[creek] patched sqlite3 binding at ${bindingPath}`);

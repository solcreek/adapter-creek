import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { NextAdapter } from "next";
import { handleBuild } from "./build.js";

/**
 * Detect the monorepo root by walking up looking for workspace markers.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (
      existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      existsSync(path.join(dir, "turbo.json"))
    ) {
      return dir;
    }
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/**
 * Detect direct dependencies whose `.js` entry files contain JSX.
 *
 * Turbopack at the pinned Next.js canary has a regression where it fails
 * to parse JSX inside `.js` files shipped by a workspace-linked / third-
 * party package (exit message: `Expected ';', got 'ident'`). The
 * documented fix is to add the package to `transpilePackages` so Next.js
 * runs SWC over it. Vanilla `next build` fails identically on these
 * fixtures without our adapter — but user apps don't get to edit their
 * own `next.config.js` just because we say so, so we auto-inject.
 *
 * Scope: only DIRECT deps. Transitive deps are either already transpiled
 * by their publisher (the common case) or reachable through the direct
 * dep we pick up. Walking all of node_modules would be slow and catch
 * unrelated packages.
 *
 * Detection: we resolve each dep's entry file (`package.json#exports["."]`
 * or `main`) and heuristically look for JSX with strong React hints.
 * False positives cost a little build time (Next.js transpiles an
 * already-ES-code package); false negatives are the status quo. The
 * heuristic is conservative — we require BOTH a JSX construct AND a
 * React signal ('use client' / react import / createElement) to claim
 * a package needs transpile.
 */
function detectPackagesNeedingTranspile(projectDir: string): string[] {
  let projectPkg: Record<string, unknown>;
  try {
    projectPkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf-8"));
  } catch {
    return [];
  }

  const directDeps = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const map = projectPkg[field];
    if (map && typeof map === "object") {
      for (const name of Object.keys(map as Record<string, string>)) directDeps.add(name);
    }
  }
  if (directDeps.size === 0) return [];

  // Don't ever try to transpile Next.js itself or the React runtimes —
  // they're pre-bundled and transpilePackages on them would be an
  // expensive no-op at best, a breakage at worst.
  const SKIP = new Set([
    "next", "react", "react-dom", "react-server-dom-webpack",
    "react-dom/server", "scheduler", "@next/routing", "@next/swc",
    "@solcreek/adapter-creek",
  ]);

  const needsTranspile: string[] = [];

  for (const dep of directDeps) {
    if (SKIP.has(dep)) continue;
    // Ignore subpath-qualified entries that aren't real packages (shouldn't
    // show up in dependencies, but be defensive).
    if (dep.includes("/") && !dep.startsWith("@")) continue;

    // Locate the package root via direct node_modules path. Can't use
    // `require.resolve(dep + '/package.json')` — Node's resolver honors
    // the `exports` field and most packages don't expose `./package.json`.
    // pnpm's flat node_modules layout hoists a symlink at
    // `node_modules/<dep>` for every direct + hoisted dep, so this works
    // across npm, yarn, pnpm.
    const pkgRoot = path.join(projectDir, "node_modules", dep);
    const pkgJsonPath = path.join(pkgRoot, "package.json");
    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    } catch {
      continue;
    }

    // Skip packages that declare themselves ES (module field points at
    // .mjs) AND ship no .js siblings — transpile wouldn't kick in for
    // them anyway. We still process packages whose `main` is a .js.
    const entryCandidates = collectEntryFiles(pkgJson, pkgRoot);
    if (entryCandidates.length === 0) continue;

    for (const entry of entryCandidates) {
      try {
        const content = readFileSync(entry, "utf-8");
        if (looksLikeJsxInJs(content, entry)) {
          needsTranspile.push(dep);
          break; // one hit is enough; move to next package
        }
      } catch {}
    }
  }

  return needsTranspile;
}

/**
 * Pick the `.js` entry file(s) for a package. Only files that end in `.js`
 * (and not `.mjs` / `.cjs`) are eligible — the others are either module-
 * specific formats (where Turbopack's JSX-in-JS bug doesn't apply) or
 * already indicate transpilation happened upstream.
 */
function collectEntryFiles(pkgJson: Record<string, unknown>, pkgRoot: string): string[] {
  const candidates: string[] = [];
  const tryAdd = (rel: unknown) => {
    if (typeof rel !== "string") return;
    if (!rel.endsWith(".js")) return;
    const abs = path.join(pkgRoot, rel.startsWith("./") ? rel.slice(2) : rel);
    try {
      if (statSync(abs).isFile()) candidates.push(abs);
    } catch {}
  };

  tryAdd(pkgJson.main);
  // `exports` can be a string, or a nested conditional object. We walk
  // the "." entry's import/require/default branches.
  const exports_ = pkgJson.exports as unknown;
  if (typeof exports_ === "string") {
    tryAdd(exports_);
  } else if (exports_ && typeof exports_ === "object") {
    const rootExport = (exports_ as Record<string, unknown>)["."] ?? exports_;
    if (typeof rootExport === "string") {
      tryAdd(rootExport);
    } else if (rootExport && typeof rootExport === "object") {
      for (const cond of ["default", "import", "require", "node", "browser"]) {
        tryAdd((rootExport as Record<string, unknown>)[cond]);
      }
    }
  }
  return [...new Set(candidates)];
}

/**
 * Heuristic: a `.js` file looks like it contains JSX if it has at least
 * one JSX-ish token AND at least one React signal. Both conditions keeps
 * false positives low (e.g. plain TS generics `function f<T>()` without
 * React imports won't trigger).
 */
function looksLikeJsxInJs(content: string, filePath: string): boolean {
  if (!filePath.endsWith(".js")) return false;
  const head = content.slice(0, 20_000); // cap scan cost

  const JSX_HINTS = [
    /return\s*\(\s*</,              // return (<...
    /return\s+<[A-Za-z]/,           // return <Tag or <Component
    /=>\s*<[A-Za-z]/,               // arrow => <...
    /\bcreateElement\s*\(/,         // raw createElement
  ];
  const hasJsxHint = JSX_HINTS.some((re) => re.test(head));
  if (!hasJsxHint) return false;

  const REACT_HINTS = [
    /['"]use client['"]/,
    /from\s+['"]react['"]/,
    /require\s*\(\s*['"]react['"]\s*\)/,
    /\bReact\.createElement\b/,
  ];
  return REACT_HINTS.some((re) => re.test(head));
}

const cacheHandlerPath = fileURLToPath(new URL("./cache-handler.js", import.meta.url));

const adapter: NextAdapter = {
  name: "adapter-creek",

  modifyConfig(config, { phase }) {
    if (phase !== "phase-production-build") return config;

    const projectDir = process.cwd();
    const repoRoot = findRepoRoot(projectDir);
    const isMonorepo = repoRoot !== projectDir;
    const installedCacheHandlerPath = path.join(
      projectDir,
      "node_modules",
      "@solcreek",
      "adapter-creek",
      "dist",
      "cache-handler.js",
    );
    const resolvedCacheHandlerPath = existsSync(installedCacheHandlerPath)
      ? installedCacheHandlerPath
      : cacheHandlerPath;

    // Auto-add any direct dep that ships JSX in `.js` to transpilePackages.
    // Works around a Turbopack regression where JSX inside `.js` files from
    // a workspace-linked / third-party package fails to parse with
    // `Expected ';', got 'ident'`. The documented upstream fix is exactly
    // `transpilePackages: [pkg]`; doing this here means user apps don't
    // have to know about it.
    const detected = detectPackagesNeedingTranspile(projectDir);
    const existing = Array.isArray(config.transpilePackages) ? config.transpilePackages : [];
    const transpilePackages = detected.length > 0
      ? [...new Set([...existing, ...detected])]
      : existing;
    if (detected.length > 0) {
      console.log(
        `  [Creek Adapter] auto-transpile: ${JSON.stringify(detected)} (JSX in .js entry)`,
      );
    }

    return {
      ...config,
      // Disable memory cache — CF Workers doesn't have persistent fs.
      // The runtime cache handler is inlined in the worker entry (CreekCacheHandler).
      cacheMaxMemorySize: 0,
      // Cap maxPostponedStateSize so Next.js's zlib inflate (5x this) stays
      // under workerd's 128MB max output length. Default is 100MB → 500MB
      // decompressed → workerd RangeError. 20MB compressed → 100MB decompressed
      // → safely under limit. Real PPR fallback shells are typically ≤ a few
      // KB anyway, so this cap is purely defensive.
      experimental: {
        ...(config.experimental ?? {}),
        maxPostponedStateSize: "20mb",
      },
      // Skip TypeScript type checking during build — CF Workers adapter
      // builds run `next build` where TS errors block the build. Type
      // checking should happen before deployment, not during bundling.
      typescript: { ...config.typescript, ignoreBuildErrors: true },
      ...(transpilePackages.length > 0 && { transpilePackages }),
      // Monorepo: set tracing root so Next.js traces deps from repo root
      ...(isMonorepo && {
        outputFileTracingRoot: repoRoot,
      }),
    };
  },

  async onBuildComplete(ctx) {
    await handleBuild(ctx);
  },
};

export default adapter;

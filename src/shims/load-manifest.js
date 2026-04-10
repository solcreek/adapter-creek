// Shim for next/dist/server/load-manifest.external.js
// Reads manifests from globalThis.__MANIFESTS (embedded at build time by the adapter).

const cache = new Map();

// Manifests that Next.js loads with `handleMissing: true` or that are
// conditionally generated and may not exist in every build. Returning {} for
// these matches the upstream Node fs behavior — without this, dynamic routes
// 500 when the build-time glob scan didn't pick them up.
//
// Source: next/dist/server/route-modules/route-module.ts
// Aligned with opennextjs-cloudflare#1151 + #1160.
const KNOWN_OPTIONAL_MANIFESTS = new Set([
  "react-loadable-manifest",          // Turbopack: only routes with dynamic imports
  "subresource-integrity-manifest",   // only when experimental.sri configured
  "server-reference-manifest",        // App Router only
  "dynamic-css-manifest",             // Pages Router + Webpack only
  "fallback-build-manifest",          // only for /_error
  "prefetch-hints",                   // Next 16.2+
  "_client-reference-manifest",       // optional for static metadata routes (evalManifest)
]);

function isKnownOptional(manifestPath) {
  // Compare against the basename without trailing extension. Some Next.js
  // constants omit the extension (e.g. SUBRESOURCE_INTEGRITY_MANIFEST), so we
  // strip .json / .js before matching.
  const base = manifestPath.split("/").pop() || manifestPath;
  const stripped = base.replace(/\.(json|js)$/, "");
  return KNOWN_OPTIONAL_MANIFESTS.has(stripped);
}

function findInManifests(path) {
  const manifests = globalThis.__MANIFESTS;
  if (!manifests) return undefined;

  // Direct match
  if (manifests[path]) return manifests[path];

  // Match by .next/ relative tail — handles path prefix differences
  // Requested: //.next/routes-manifest.json
  // Available: /Users/.../apps/www/.next/routes-manifest.json
  const tail = path.includes(".next/")
    ? ".next/" + path.split(".next/").pop()
    : path.split("/").pop();

  for (const [key, val] of Object.entries(manifests)) {
    const keyTail = key.includes(".next/")
      ? ".next/" + key.split(".next/").pop()
      : key.split("/").pop();
    if (tail === keyTail) return val;
  }

  return undefined;
}

function loadManifest(path, shouldCache = true, _cache = cache, skipParse = false, handleMissing) {
  const cached = shouldCache && cache.get(path);
  if (cached) return cached;

  const content = findInManifests(path);

  if (content === undefined) {
    if (handleMissing || isKnownOptional(path)) {
      const result = {};
      if (shouldCache) cache.set(path, result);
      return result;
    }
    throw new Error(`[Creek] Manifest not found: ${path}`);
  }

  let manifest = skipParse ? content : JSON.parse(content);
  if (shouldCache) cache.set(path, manifest);
  return manifest;
}

function evalManifest(path, shouldCache = true, _cache = cache, handleMissing) {
  const cached = shouldCache && cache.get(path);
  if (cached) return cached;

  const content = findInManifests(path);

  if (content === undefined) {
    if (handleMissing || isKnownOptional(path)) {
      const result = {};
      if (shouldCache) cache.set(path, result);
      return result;
    }
    throw new Error(`[Creek] Manifest not found for eval: ${path}`);
  }

  let contextObject = {};
  try {
    contextObject = JSON.parse(content);
  } catch {
    // JS manifests (e.g., _buildManifest.js) — extract JSON via regex.
    // CF Workers blocks new Function() (CSP), so we parse the assignment
    // pattern: self.__BUILD_MANIFEST = {...}
    try {
      const jsonMatch = content.match(/=\s*(\{[\s\S]*\})\s*[;\n]/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[1]);
        for (const [key, val] of Object.entries(data)) {
          contextObject[key] = val;
        }
      }
    } catch {}
  }

  if (shouldCache) cache.set(path, contextObject);
  return contextObject;
}

function loadManifestFromRelativePath({ projectDir, distDir, manifest, shouldCache, cache: c, skipParse, handleMissing, useEval }) {
  const manifestPath = (projectDir || "") + "/" + (distDir || ".next") + "/" + manifest;
  if (useEval) return evalManifest(manifestPath, shouldCache, c, handleMissing);
  return loadManifest(manifestPath, shouldCache, c, skipParse, handleMissing);
}

function clearManifestCache(path) {
  return cache.delete(path);
}

module.exports = { loadManifest, evalManifest, loadManifestFromRelativePath, clearManifestCache };

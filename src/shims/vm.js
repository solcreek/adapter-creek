// vm shim for CF Workers.
// CF Workers disallows new Function() from strings (CSP).
// Instead of executing code, we extract data from embedded manifests.

export function runInNewContext(code, context = {}) {
  // Next.js uses this to evaluate _buildManifest.js which sets
  // self.__BUILD_MANIFEST = {...}. Extract the JSON from the code.
  try {
    // Try to extract JSON object from JS code patterns:
    // self.__BUILD_MANIFEST = {...}
    // self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()
    const jsonMatch = code.match(/=\s*(\{[\s\S]*\})\s*[;\n]/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      // Assign to context as self.* or globalThis.*
      for (const [key, val] of Object.entries(data)) {
        context[key] = val;
      }
      return context;
    }
  } catch {}

  // Fallback: try to extract from embedded manifests
  if (typeof globalThis.__MANIFESTS !== "undefined") {
    for (const [, val] of Object.entries(globalThis.__MANIFESTS)) {
      if (val === code) {
        try { return JSON.parse(val); } catch {}
      }
    }
  }

  return context;
}

export function runInThisContext(code) {
  return runInNewContext(code, {});
}

export function createContext(sandbox = {}) {
  return sandbox;
}

export class Script {
  constructor(code) { this._code = code; }
  runInNewContext(context = {}) { return runInNewContext(this._code, context); }
  runInThisContext() { return runInThisContext(this._code); }
}

export default { runInNewContext, runInThisContext, createContext, Script };

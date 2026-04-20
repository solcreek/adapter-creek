// Minimal fs shim for CF Workers — Next.js server needs basic fs operations
// for manifest loading and incremental cache. We provide no-ops since
// manifests are embedded and cache uses DO (Phase 2).
const noop = () => {};
const noopSync = () => undefined;

// Binary files in __USER_FILES are base64-encoded with a sentinel prefix
// so readFile callers (e.g. next/og node-runtime routes reading font
// files) receive real Uint8Array/Buffer bytes instead of a UTF-8 string.
const BINARY_SENTINEL = "__CREEK_B64__";

function decodeBase64(b64) {
  // CF Workers and Node.js both support atob; the result is a binary
  // string that we map to a Uint8Array byte-by-byte.
  const binStr = atob(b64);
  const out = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i);
  return out;
}

function maybeDecodeBinary(value, enc) {
  if (typeof value !== "string" || !value.startsWith(BINARY_SENTINEL)) {
    return value;
  }
  const bytes = decodeBase64(value.slice(BINARY_SENTINEL.length));
  if (!enc) return bytes;
  if (enc === "utf8" || enc === "utf-8" || enc === "UTF-8") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (enc === "base64") return value.slice(BINARY_SENTINEL.length);
  if (typeof enc === "object" && enc.encoding) return maybeDecodeBinary(value, enc.encoding);
  return bytes;
}

function normalizePath(filePath) {
  return String(filePath).replace(/\\/g, "/");
}

function trimLeadingSlashes(filePath) {
  return normalizePath(filePath).replace(/^\/+/, "");
}

function directoryCandidates(dirPath) {
  const normalized = trimLeadingSlashes(dirPath).replace(/\/+$/, "");
  const candidates = [normalized];
  for (const marker of ["node_modules/", ".next/"]) {
    const index = normalized.lastIndexOf(marker);
    if (index > 0) candidates.push(normalized.slice(index));
  }
  return [...new Set(candidates.filter(Boolean))];
}

function relativeToEmbeddedDirectory(key, dirPath) {
  const normalizedKey = trimLeadingSlashes(key);
  for (const candidate of directoryCandidates(dirPath)) {
    if (normalizedKey.startsWith(candidate + "/")) {
      return normalizedKey.slice(candidate.length + 1);
    }
    const marker = "/" + candidate + "/";
    const index = normalizedKey.lastIndexOf(marker);
    if (index !== -1) {
      return normalizedKey.slice(index + marker.length);
    }
  }
  return undefined;
}

function listUserFilesInDirectory(dirPath) {
  const files = globalThis.__USER_FILES;
  if (!files) return [];
  const entries = new Set();
  for (const key in files) {
    const relative = relativeToEmbeddedDirectory(key, dirPath);
    if (!relative) continue;
    const entry = relative.split("/")[0];
    if (entry) entries.add(entry);
  }
  return [...entries];
}

function isUserFilesDirectory(filePath) {
  return listUserFilesInDirectory(filePath).length > 0;
}

function joinPath(dirPath, entry) {
  return normalizePath(dirPath).replace(/\/+$/, "") + "/" + entry;
}

// Look up a path in __USER_FILES (user-side text files like data.json that
// route handlers read via fs.readFileSync). Embedded keys are paths relative
// to outputFileTracingRoot; runtime requests come through process.cwd()
// joined with a relative path. We do bidirectional suffix matching so both
// single-app and monorepo setups resolve correctly.
function findInUserFiles(filePath) {
  const files = globalThis.__USER_FILES;
  if (!files) return undefined;
  const requestedPath = normalizePath(filePath);
  if (files[requestedPath] !== undefined) return files[requestedPath];
  // Normalize the requested path to a relative form for comparison.
  const requestedTail = trimLeadingSlashes(requestedPath);
  for (const key in files) {
    const normalizedKey = normalizePath(key);
    // Embedded key is a suffix of the requested path:
    //   key  = "app/dashboard/data.json"
    //   req  = "/app/dashboard/data.json"  (cwd "/" + relative)
    if (requestedPath.endsWith("/" + normalizedKey) || requestedPath === normalizedKey) return files[key];
    // Requested tail is a suffix of the embedded key (monorepo case):
    //   key  = "apps/www/app/data.json"
    //   req  = "/app/data.json"  (page used a project-relative path)
    if (normalizedKey.endsWith("/" + requestedTail) || normalizedKey === requestedTail) return files[key];
  }
  // Last-resort: match on basename for bundled sibling assets whose
  // request path is derived from `fileURLToPath(new URL('./X', import.meta.url))`
  // and ends up with a chunk-relative path that shares nothing with the
  // embedded `node_modules/...` key except the filename. Only applies to
  // binary assets (wasm / fonts / images) and TypeScript's default lib
  // declaration files. The latter may be requested as bare `lib.es5.d.ts`
  // because the bundled TypeScript module has no meaningful __filename.
  // Fixes next/og node-runtime `fs.readFileSync` of bundled wasm/ttf and
  // twoslash loading `typescript/lib/lib.*.d.ts` in Workers.
  const reqBase = requestedPath.split("/").pop() || "";
  if (/\.(wasm|ttf|otf|woff2?)$/i.test(reqBase) || /^lib\..*\.d\.ts$/i.test(reqBase)) {
    for (const key in files) {
      if (normalizePath(key).split("/").pop() === reqBase) return files[key];
    }
  }
  return undefined;
}

export const existsSync = (filePath) => {
  if (findInUserFiles(filePath) !== undefined) return true;
  if (isUserFilesDirectory(filePath)) return true;
  if (typeof globalThis.__MANIFESTS === "undefined") return false;
  for (const key of Object.keys(globalThis.__MANIFESTS)) {
    if (key === filePath || key.endsWith(filePath)) return true;
    if (filePath.includes(".next/")) {
      const tail = ".next/" + filePath.split(".next/").pop();
      const keyTail = key.includes(".next/") ? ".next/" + key.split(".next/").pop() : "";
      if (tail === keyTail) return true;
    }
  }
  return false;
};
export const readFileSync = (filePath, enc) => {
  // Try reading from embedded manifests
  if (typeof globalThis.__MANIFESTS !== "undefined") {
    for (const [key, val] of Object.entries(globalThis.__MANIFESTS)) {
      if (key === filePath || key.endsWith(filePath)) return val;
      // Match by .next/ relative tail — handles different path prefixes
      // e.g. /bundle/.next/routes-manifest.json → .next/routes-manifest.json
      if (filePath.includes(".next/")) {
        const tail = ".next/" + filePath.split(".next/").pop();
        const keyTail = key.includes(".next/") ? ".next/" + key.split(".next/").pop() : "";
        if (tail === keyTail) return val;
      }
      // Last resort: match by filename
      if (filePath.split("/").pop() === key.split("/").pop()) return val;
    }
  }
  // Then try user-side data files (data.json, fixtures, fonts, etc.).
  // Binary files are stored as base64 with a sentinel prefix — decode
  // them lazily based on the caller's requested encoding.
  const userContent = findInUserFiles(filePath);
  if (userContent !== undefined) return maybeDecodeBinary(userContent, enc);
  // Throw ENOENT like real fs — Next.js loadManifest relies on this
  // to distinguish between missing and empty files.
  const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
  err.code = "ENOENT";
  throw err;
};
export const writeFileSync = noop;
export const mkdirSync = noop;
export const unlinkSync = noop;
export const readdirSync = (dirPath, options) => {
  const entries = listUserFilesInDirectory(dirPath);
  if (options && typeof options === "object" && options.withFileTypes) {
    return entries.map((name) => ({
      name,
      isFile: () => findInUserFiles(joinPath(dirPath, name)) !== undefined,
      isDirectory: () => isUserFilesDirectory(joinPath(dirPath, name)),
      isSymbolicLink: () => false,
    }));
  }
  return entries;
};
export const realpathSync = Object.assign((filePath) => String(filePath), {
  native: (filePath) => String(filePath),
});
export const statSync = (filePath) => {
  const userContent = findInUserFiles(filePath);
  const fileExists = userContent !== undefined;
  const directoryExists = !fileExists && isUserFilesDirectory(filePath);
  const exists = fileExists || directoryExists;
  return {
    isFile: () => fileExists,
    isDirectory: () => directoryExists,
    isSymbolicLink: () => false,
    mtime: new Date(),
    size: fileExists ? (maybeDecodeBinary(userContent, "utf8")?.length || 0) : 0,
  };
};
export const accessSync = noop;
export const createReadStream = () => { throw new Error("fs.createReadStream not available in CF Workers"); };
export const createWriteStream = () => { throw new Error("fs.createWriteStream not available in CF Workers"); };

// readAll is used by Turbopack app-route runtime
export const readAll = readFileSync;

export const promises = {
  readFile: async (filePath, enc) => readFileSync(filePath, enc),
  readAll: async (filePath, enc) => readFileSync(filePath, enc),
  writeFile: async () => {},
  mkdir: async () => {},
  readdir: async (dirPath, options) => readdirSync(dirPath, options),
  stat: async (filePath) => statSync(filePath),
  access: async () => {},
  unlink: async () => {},
  rm: async () => {},
};

export default {
  existsSync, readFileSync, readAll, writeFileSync, mkdirSync, unlinkSync,
  readdirSync, realpathSync, statSync, accessSync, createReadStream, createWriteStream,
  promises,
};

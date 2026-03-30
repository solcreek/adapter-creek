// Minimal fs shim for CF Workers — Next.js server needs basic fs operations
// for manifest loading and incremental cache. We provide no-ops since
// manifests are embedded and cache uses DO (Phase 2).
const noop = () => {};
const noopSync = () => undefined;

export const existsSync = () => false;
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
  return "";
};
export const writeFileSync = noop;
export const mkdirSync = noop;
export const unlinkSync = noop;
export const readdirSync = () => [];
export const statSync = () => ({
  isFile: () => false,
  isDirectory: () => false,
  mtime: new Date(0),
  size: 0,
});
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
  readdir: async () => [],
  stat: async () => statSync(),
  access: async () => {},
  unlink: async () => {},
  rm: async () => {},
};

export default {
  existsSync, readFileSync, readAll, writeFileSync, mkdirSync, unlinkSync,
  readdirSync, statSync, accessSync, createReadStream, createWriteStream,
  promises,
};

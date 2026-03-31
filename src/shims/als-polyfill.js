// AsyncLocalStorage polyfill — must be imported FIRST.
// Sets globalThis.AsyncLocalStorage before any Next.js code evaluates.
// CF Workers has AsyncLocalStorage via node:async_hooks but not on globalThis.
import { AsyncLocalStorage } from "node:async_hooks";
if (!globalThis.AsyncLocalStorage) {
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
}

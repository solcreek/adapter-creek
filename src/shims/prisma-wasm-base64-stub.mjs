// Creek build-time stub for Prisma 7's query-compiler base64 module
// (`@prisma/client/runtime/query_compiler_*.sqlite.wasm-base64.mjs`).
//
// The generated Prisma client loads its compiler as
// `new WebAssembly.Module(decodeBase64(wasm))`. On Workers we precompile the
// real compiler WASM at build time and the worker-entry WebAssembly.Module
// patch swaps it in BY BYTE LENGTH — the decoded bytes' *content* is never
// used. So shipping the real ~4.7MB base64 string in the bundle is pure dead
// weight (the compiler is already present as a CompiledWasm module).
//
// This stub replaces that string with a tiny sentinel: 8000 base64 chars of
// "A" decode to exactly 6000 zero bytes. build.ts registers the precompiled
// compiler under that sentinel length, so the client's
// `new WebAssembly.Module(<6000 bytes>)` resolves to the real module while the
// bundle carries ~8KB instead of ~4.7MB. The decoded length here is the single
// source of truth — build.ts reads it from this module.
export const wasm = "A".repeat(8000);
export default wasm;

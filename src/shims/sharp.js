// sharp shim for Cloudflare Workers.
//
// `@vercel/og/index.node.js` tries `(await import("sharp")).default` and,
// if truthy, uses sharp to rasterize satori's SVG output to PNG. sharp
// relies on native `.node` bindings (libvips) that workerd cannot load,
// so the real module half-loads and ends up non-callable — the caller
// then throws `TypeError: sharp is not a function`.
//
// Returning `default: undefined` makes getSharp() return undefined and
// @vercel/og falls back to its built-in resvg.wasm path, which is already
// bundled as a CompiledWasm module and works natively on workerd.
export default undefined;

// An edge function's wasm import: webpack binds it to a `wasm_<hash>` global.
import wasm from "./add.wasm?module";
const instance$ = WebAssembly.instantiate(wasm);
export async function increment(a) {
  const { exports } = await instance$;
  return exports.add_one(a);
}

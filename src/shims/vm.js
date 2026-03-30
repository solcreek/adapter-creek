// Minimal node:vm shim for CF Workers.
// Next.js uses vm.runInNewContext for evaluating JS manifests.

export function runInNewContext(code, context = {}) {
  const fn = new Function(...Object.keys(context), code);
  fn(...Object.values(context));
  return context;
}

export function runInThisContext(code) {
  return new Function(code)();
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

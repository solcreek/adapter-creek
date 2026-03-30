// No-op critters shim for CF Workers.
// Next.js bundles critters for CSS inlining optimization.
// Not needed at runtime on CF Workers — CSS is served as static assets.
export default class Critters {
  constructor() {}
  process(html) { return html; }
}

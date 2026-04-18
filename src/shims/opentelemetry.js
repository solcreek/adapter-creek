// Minimal @opentelemetry/api shim for CF Workers
// Next.js uses it for tracing but it's not required for functionality.

const NOOP = () => {};
// NOOP_SPAN must be usable by Next.js (has methods like isRecording/end)
// but must NOT be serializable by React RSC. React only serializes
// enumerable own properties — so we use non-enumerable properties.
const NOOP_SPAN = Object.create(null);
Object.defineProperties(NOOP_SPAN, {
  setAttribute: { value: () => NOOP_SPAN },
  setAttributes: { value: () => NOOP_SPAN },
  addEvent: { value: () => NOOP_SPAN },
  setStatus: { value: () => NOOP_SPAN },
  updateName: { value: () => NOOP_SPAN },
  end: { value: NOOP },
  isRecording: { value: () => false },
  recordException: { value: NOOP },
  spanContext: { value: () => ({ traceId: "", spanId: "", traceFlags: 0 }) },
});
const NOOP_TRACER = {
  startSpan: () => NOOP_SPAN,
  startActiveSpan: (name, ...args) => {
    const fn = args[args.length - 1];
    if (typeof fn === "function") return fn(NOOP_SPAN);
    return NOOP_SPAN;
  },
};
const NOOP_TRACER_PROVIDER = { getTracer: () => NOOP_TRACER };
const NOOP_CONTEXT_MANAGER = {
  active: () => ROOT_CONTEXT,
  with: (ctx, fn) => fn(),
  bind: (ctx, target) => target,
  enable: NOOP, disable: NOOP,
};

// Context objects need getValue/setValue/deleteValue per OpenTelemetry API.
// setValue + deleteValue must return a NEW context with the key's value
// set/removed — not mutate in place, and not return the same empty ROOT_CONTEXT
// (or the tracer code calling \`trace.setSpan(ctx, span)\` would get a
// context that still doesn't contain the span).
function _makeContext(store) {
  return {
    getValue: (key) => store.get(key),
    setValue: (key, value) => {
      const next = new Map(store);
      next.set(key, value);
      return _makeContext(next);
    },
    deleteValue: (key) => {
      const next = new Map(store);
      next.delete(key);
      return _makeContext(next);
    },
  };
}
export const ROOT_CONTEXT = _makeContext(new Map());
export const defaultTextMapGetter = { get: () => undefined, keys: () => [] };
export const defaultTextMapSetter = { set: NOOP };
export const INVALID_SPANID = "";
export const INVALID_TRACEID = "";
export const INVALID_SPAN_CONTEXT = { traceId: "", spanId: "", traceFlags: 0 };

// \`trace\` and \`context\` also have to cooperate across @opentelemetry/api
// copies via the same globalThis symbol that \`propagation\` uses below.
// Next.js's tracer.js imports the trace API through our shim; when the
// user's instrumentation runs \`NodeTracerProvider.register()\`, it writes
// the real tracer provider and context manager into
// \`globalThis[Symbol.for("opentelemetry.js.api.1")]\` via its own api
// copy. Without delegating here, Next.js's render path keeps calling
// NOOP_TRACER.startSpan + context.active()=ROOT_CONTEXT, so no real span
// is ever present in the context passed to \`propagation.inject\`. Result:
// the user's propagator sees no span and falls back to
// \`"invariant"\` for \`my-parent-span-id\`, failing the regex assertion
// \`/<meta name="my-parent-span-id" content="[a-f0-9]{16}">/\`. Reading
// from the shared global recovers the real tracer + context manager and
// gives the propagator a real span to read.
const CONTEXT_API_KEY = Symbol.for("opentelemetry.context");
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");
function _getGlobalTracerProvider() {
  return _otelGlobal().trace ?? null;
}
function _getGlobalContextManager() {
  return _otelGlobal().context ?? null;
}
export const trace = {
  getTracer: (...args) => {
    const g = _getGlobalTracerProvider();
    if (g && typeof g.getTracer === "function") {
      try { return g.getTracer(...args); } catch {}
    }
    return NOOP_TRACER;
  },
  getTracerProvider: () => _getGlobalTracerProvider() ?? NOOP_TRACER_PROVIDER,
  setGlobalTracerProvider: (p) => { _otelGlobal().trace = p; return p; },
  // getSpan(ctx): read the SPAN key from the context object — the same
  // pattern sdk-trace-base uses. Falls back to undefined when the context
  // is our empty ROOT_CONTEXT.
  getSpan: (ctx) => {
    if (ctx && typeof ctx.getValue === "function") {
      const s = ctx.getValue(SPAN_KEY);
      if (s) return s;
    }
    return undefined;
  },
  getActiveSpan: () => {
    const ctx = _callActiveContext();
    if (ctx && typeof ctx.getValue === "function") return ctx.getValue(SPAN_KEY);
    return undefined;
  },
  setSpan: (ctx, span) => (ctx || ROOT_CONTEXT).setValue(SPAN_KEY, span),
  deleteSpan: (ctx) => (ctx || ROOT_CONTEXT).deleteValue(SPAN_KEY),
  setSpanContext: (ctx) => ctx || ROOT_CONTEXT,
  // getSpanContext: read span from context, return its spanContext() result.
  // User propagators rely on \`trace.getSpanContext(ctx)?.spanId\` to fill
  // their my-parent-span-id meta tag — without this, they fall back to
  // the literal string "invariant".
  getSpanContext: (ctx) => {
    const span = trace.getSpan(ctx);
    if (span && typeof span.spanContext === "function") {
      try { return span.spanContext(); } catch {}
    }
    return undefined;
  },
  isSpanContextValid: (sc) => !!sc && typeof sc.traceId === "string" && sc.traceId.length > 0,
};

function _callActiveContext() {
  const mgr = _getGlobalContextManager();
  if (mgr && typeof mgr.active === "function") {
    try { return mgr.active(); } catch {}
  }
  return ROOT_CONTEXT;
}
export const context = {
  active: () => _callActiveContext(),
  with: (ctx, fn, thisArg, ...args) => {
    const mgr = _getGlobalContextManager();
    if (mgr && typeof mgr.with === "function") {
      try { return mgr.with(ctx, fn, thisArg, ...args); } catch {}
    }
    return fn.call(thisArg, ...args);
  },
  bind: (ctx, target) => {
    const mgr = _getGlobalContextManager();
    if (mgr && typeof mgr.bind === "function") {
      try { return mgr.bind(ctx, target); } catch {}
    }
    return target;
  },
  setGlobalContextManager: (mgr) => { _otelGlobal().context = mgr; return mgr; },
  disable: () => { delete _otelGlobal().context; },
};

// Propagation must be functional (not NOOP) for user instrumentation to
// work — Next.js's server render calls \`propagation.inject(ctx, carrier,
// setter)\` when \`experimental.clientTraceMetadata\` is configured, and
// expects the user's propagator (set by \`NodeTracerProvider.register({
// propagator })\`) to emit the \`<meta name="...">\` tags.
//
// Delicate: \`@opentelemetry/api\` is loaded as multiple copies in the
// bundle — one compiled into \`next/\`, one Turbopack-bundled from the
// user's \`node_modules\`, and this shim (aliased for bare-specifier
// imports at wrangler time). Their code agrees on a shared singleton by
// writing propagator/context/tracer onto
// \`globalThis[Symbol.for("opentelemetry.js.api.<major>")].propagation\`.
// If this shim's propagation used a module-local variable, the user's
// \`setGlobalPropagator\` call on their bundled api would never reach
// this shim's \`inject\` — which is the codepath Next.js actually calls
// through. Writing/reading via the same global symbol keeps every copy
// in sync.
// Fixes e2e/opentelemetry/client-trace-metadata (5 tests).
const OTEL_GLOBAL_KEY = Symbol.for("opentelemetry.js.api.1");
function _otelGlobal() {
  let g = globalThis[OTEL_GLOBAL_KEY];
  if (!g) {
    g = { version: "1.9.0" };
    globalThis[OTEL_GLOBAL_KEY] = g;
  }
  return g;
}
function _getPropagator() {
  return _otelGlobal().propagation ?? null;
}
export const propagation = {
  inject: (ctx, carrier, setter) => {
    const p = _getPropagator();
    if (p && typeof p.inject === "function") {
      try { p.inject(ctx, carrier, setter); } catch {}
    }
  },
  extract: (ctx, carrier, getter) => {
    const p = _getPropagator();
    if (p && typeof p.extract === "function") {
      try { return p.extract(ctx, carrier, getter); } catch {}
    }
    return ctx;
  },
  fields: () => {
    const p = _getPropagator();
    if (p && typeof p.fields === "function") {
      try { return p.fields(); } catch {}
    }
    return [];
  },
  setGlobalPropagator: (p) => {
    _otelGlobal().propagation = p;
    return propagation;
  },
  disable: () => { delete _otelGlobal().propagation; },
};

export const diag = {
  setLogger: NOOP, disable: NOOP,
  createComponentLogger: () => diag,
  verbose: NOOP, debug: NOOP, info: NOOP, warn: NOOP, error: NOOP,
};

export function createContextKey(name) { return Symbol(name); }

export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const TraceFlags = { NONE: 0, SAMPLED: 1 };

export default {
  trace, context, propagation, diag, createContextKey,
  ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags,
  defaultTextMapGetter, defaultTextMapSetter,
  INVALID_SPANID, INVALID_TRACEID, INVALID_SPAN_CONTEXT,
};

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

// Context objects need getValue/setValue/deleteValue per OpenTelemetry API
export const ROOT_CONTEXT = {
  getValue: () => undefined,
  setValue: (key, value) => ROOT_CONTEXT,
  deleteValue: () => ROOT_CONTEXT,
};
export const defaultTextMapGetter = { get: () => undefined, keys: () => [] };
export const defaultTextMapSetter = { set: NOOP };
export const INVALID_SPANID = "";
export const INVALID_TRACEID = "";
export const INVALID_SPAN_CONTEXT = { traceId: "", spanId: "", traceFlags: 0 };

export const trace = {
  getTracer: () => NOOP_TRACER,
  getTracerProvider: () => NOOP_TRACER_PROVIDER,
  setGlobalTracerProvider: () => NOOP_TRACER_PROVIDER,
  getSpan: () => undefined,
  getActiveSpan: () => undefined,
  setSpan: (ctx) => ctx || ROOT_CONTEXT,
  deleteSpan: (ctx) => ctx || ROOT_CONTEXT,
  setSpanContext: (ctx) => ctx || ROOT_CONTEXT,
  isSpanContextValid: () => false,
};

export const context = {
  active: () => ROOT_CONTEXT,
  with: (ctx, fn) => fn(),
  bind: (ctx, target) => target,
  setGlobalContextManager: NOOP,
  disable: NOOP,
};

export const propagation = {
  inject: NOOP, extract: (ctx) => ctx,
  setGlobalPropagator: NOOP, disable: NOOP,
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

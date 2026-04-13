// Minimal node:http shim for CF Workers.
// Plain objects with the minimum API surface that Next.js handler needs.
// Does NOT extend from node:stream (CF Workers stream compat may be incomplete).

import { EventEmitter } from "node:events";

export class IncomingMessage extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket || { encrypted: true, remoteAddress: "127.0.0.1", address: () => ({ port: 443 }), end() {}, destroy() {} };
    this.connection = this.socket;
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = true;
    this.headers = {};
    this.rawHeaders = [];
    this.trailers = {};
    this.rawTrailers = [];
    this.method = "GET";
    this.url = "/";
    this.statusCode = null;
    this.statusMessage = null;
    this.aborted = false;
    this.upgrade = false;
    this.readable = true;
    this._body = null;
    this._bodyConsumed = false;
    // Node.js Readable state — some Next.js code checks this directly.
    this._readableState = { ended: false, endEmitted: false, flowing: null };
    // Buffer chunks until a listener is attached.
    // push() may be called before the handler adds "data" listeners.
    this._bufferedChunks = [];
    this._ended = false;
    this._flowing = false;
  }
  // Readable stream interface (minimal)
  read() {
    if (this._bufferedChunks.length > 0) return this._bufferedChunks.shift();
    return null;
  }
  push(chunk) {
    if (chunk === null) {
      this._ended = true;
      this.complete = true;
      this._readableState.ended = true;
      if (this._flowing) {
        this._readableState.endEmitted = true;
        this.emit("end");
      }
      return;
    }
    if (this._flowing) {
      this.emit("data", chunk);
    } else {
      this._bufferedChunks.push(chunk);
    }
  }
  // Flush buffered data when listeners are ready
  _startFlowing() {
    if (this._flowing) return;
    this._flowing = true;
    this._readableState.flowing = true;
    while (this._bufferedChunks.length > 0) {
      this.emit("data", this._bufferedChunks.shift());
    }
    if (this._ended) {
      this._readableState.endEmitted = true;
      this.emit("end");
    }
  }
  on(event, fn) {
    super.on(event, fn);
    // When a "data" listener is attached, start flowing
    if (event === "data" && !this._flowing) {
      queueMicrotask(() => this._startFlowing());
    }
    return this;
  }
  addListener(event, fn) { return this.on(event, fn); }
  pipe(dest) {
    this.on("data", (chunk) => dest.write(chunk));
    this.on("end", () => { if (dest.end) dest.end(); });
    return dest;
  }
  unpipe() {}
  resume() { this._startFlowing(); return this; }
  pause() { return this; }
  setEncoding() { return this; }
  setTimeout() { return this; }
  destroy() { this.emit("close"); return this; }
  [Symbol.asyncIterator]() {
    const self = this;
    // Drain both currently-buffered chunks AND any chunks that arrive
    // via subsequent push() calls. Use a pull-based queue with a
    // resolver so we wake up the awaiting consumer exactly when new
    // data arrives or end is reached. This replaces an older
    // implementation that went through on("data"/"end") events with a
    // queueMicrotask + _startFlowing dance — on workerd the microtask
    // timing was unreliable for bodyParser:false handlers that iterate
    // the request body directly (they would hang forever).
    const queue = [];
    let ended = false;
    let resolver = null;
    const notify = () => {
      if (resolver) {
        const r = resolver;
        resolver = null;
        r();
      }
    };
    // Seed the queue with any pre-buffered chunks. Clear the shim's
    // buffer so a later push() goes straight into our queue.
    for (const chunk of self._bufferedChunks) queue.push(chunk);
    self._bufferedChunks = [];
    self._flowing = true;
    self._readableState.flowing = true;
    if (self._ended) {
      ended = true;
      self._readableState.endEmitted = true;
    }
    // Replace push() so later chunks land in our queue. Keep the null
    // sentinel semantics for end-of-stream.
    const origPush = self.push.bind(self);
    self.push = (chunk) => {
      if (chunk === null) {
        ended = true;
        self._ended = true;
        self.complete = true;
        self._readableState.ended = true;
        self._readableState.endEmitted = true;
        notify();
        return;
      }
      queue.push(chunk);
      notify();
    };
    return {
      async next() {
        if (queue.length === 0 && !ended) {
          await new Promise((r) => { resolver = r; });
        }
        if (queue.length > 0) return { done: false, value: queue.shift() };
        return { done: true, value: undefined };
      }
    };
  }
}

export class ServerResponse extends EventEmitter {
  constructor(req) {
    super();
    this.req = req;
    this.statusCode = 200;
    this.statusMessage = "";
    this.headersSent = false;
    this.finished = false;
    this.writable = true;
    this.sendDate = true;
    this._headers = {};
    this._headerNames = {};
    this.socket = req?.socket || { encrypted: true, remoteAddress: "127.0.0.1" };
    this.connection = this.socket;
  }
  setHeader(name, value) { this._headers[name.toLowerCase()] = value; this._headerNames[name.toLowerCase()] = name; }
  appendHeader(name, value) {
    const key = name.toLowerCase();
    const existing = this._headers[key];
    if (existing === undefined) {
      this._headers[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      this._headers[key] = [existing, value];
    }
    this._headerNames[key] = name;
  }
  getHeader(name) { return this._headers[name.toLowerCase()]; }
  getHeaders() { return { ...this._headers }; }
  getHeaderNames() { return Object.keys(this._headers); }
  hasHeader(name) { return name.toLowerCase() in this._headers; }
  removeHeader(name) { delete this._headers[name.toLowerCase()]; delete this._headerNames[name.toLowerCase()]; }
  writeHead(code, msg, hdrs) {
    this.statusCode = code;
    if (typeof msg === "string") this.statusMessage = msg;
    else if (typeof msg === "object") hdrs = msg;
    if (hdrs) {
      for (const [k, v] of Object.entries(hdrs)) {
        // Array values (e.g., Set-Cookie) should be stored as-is
        if (Array.isArray(v)) {
          this._headers[k.toLowerCase()] = v;
          this._headerNames[k.toLowerCase()] = k;
        } else {
          this.setHeader(k, v);
        }
      }
    }
    this.headersSent = true;
    return this;
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    this.emit("data", chunk);
    if (cb) cb();
    return true;
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = null; }
    if (typeof encoding === "function") { cb = encoding; encoding = null; }
    if (chunk) this.emit("data", chunk);
    this.finished = true;
    this.writable = false;
    this.emit("finish");
    this.emit("close");
    if (cb) cb();
    return this;
  }
  get writableEnded() { return this.finished; }
  get writableFinished() { return this.finished; }
  flushHeaders() { this.headersSent = true; }
  assignSocket() {}
  detachSocket() {}
  writeContinue() {}
  writeProcessing() {}
  setTimeout() { return this; }
  addTrailers() {}
  cork() {}
  uncork() {}
  // Writable interface stubs
  destroy() { return this; }
}

export function createServer() { throw new Error("http.createServer not available in CF Workers"); }
export function request() { throw new Error("http.request not available in CF Workers"); }
export function get() { throw new Error("http.get not available in CF Workers"); }

export const METHODS = ["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"];
export const STATUS_CODES = { 200:"OK",201:"Created",204:"No Content",301:"Moved Permanently",302:"Found",304:"Not Modified",400:"Bad Request",401:"Unauthorized",403:"Forbidden",404:"Not Found",500:"Internal Server Error" };

export default { IncomingMessage, ServerResponse, createServer, request, get, METHODS, STATUS_CODES };

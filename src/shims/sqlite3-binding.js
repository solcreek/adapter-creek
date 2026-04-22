// Creek adapter — sqlite3 native-binding replacement.
//
// The upstream `sqlite3` package loads a .node binary via require('bindings').
// workerd has no .node loader, and Next.js's build-time static analysis
// (which evaluates user modules to collect page config) also can't load it
// when `pnpm install --ignore-scripts` skipped sqlite3's post-install build.
//
// Our patcher (`scripts/patch-node-modules-sqlite3.mjs`) replaces
// `node_modules/sqlite3/lib/sqlite3-binding.js` with this file. The outer
// `sqlite3/lib/sqlite3.js` wrapper stays intact — it decorates the classes
// we export here with promise helpers and parameter normalization, so we
// only need to match the binding surface, not the full user-facing API.
//
// Backend: sql.js (WASM SQLite). Works at build-time (Node) and runtime
// (workerd) without a native binary.

'use strict';

// ---------------------------------------------------------------------------
// Constants — copied from SQLite's sqlite3.h.
//   * OPEN_*  — open flags (passed as `mode` to `new Database`)
//   * Plain names like READONLY / ERROR are SQLite result codes.
// ---------------------------------------------------------------------------

// Open flags
exports.OPEN_READONLY        = 0x00000001;
exports.OPEN_READWRITE       = 0x00000002;
exports.OPEN_CREATE          = 0x00000004;
exports.OPEN_DELETEONCLOSE   = 0x00000008;
exports.OPEN_EXCLUSIVE       = 0x00000010;
exports.OPEN_AUTOPROXY       = 0x00000020;
exports.OPEN_URI             = 0x00000040;
exports.OPEN_MEMORY          = 0x00000080;
exports.OPEN_MAIN_DB         = 0x00000100;
exports.OPEN_TEMP_DB         = 0x00000200;
exports.OPEN_TRANSIENT_DB    = 0x00000400;
exports.OPEN_MAIN_JOURNAL    = 0x00000800;
exports.OPEN_TEMP_JOURNAL    = 0x00001000;
exports.OPEN_SUBJOURNAL      = 0x00002000;
exports.OPEN_SUPER_JOURNAL   = 0x00004000;
exports.OPEN_NOMUTEX         = 0x00008000;
exports.OPEN_FULLMUTEX       = 0x00010000;
exports.OPEN_SHAREDCACHE     = 0x00020000;
exports.OPEN_PRIVATECACHE    = 0x00040000;
exports.OPEN_WAL             = 0x00080000;
exports.OPEN_NOFOLLOW        = 0x01000000;

// Result codes
exports.OK         = 0;
exports.ERROR      = 1;
exports.INTERNAL   = 2;
exports.PERM       = 3;
exports.ABORT      = 4;
exports.BUSY       = 5;
exports.LOCKED     = 6;
exports.NOMEM      = 7;
exports.READONLY   = 8;
exports.INTERRUPT  = 9;
exports.IOERR      = 10;
exports.CORRUPT    = 11;
exports.NOTFOUND   = 12;
exports.FULL       = 13;
exports.CANTOPEN   = 14;
exports.PROTOCOL   = 15;
exports.EMPTY      = 16;
exports.SCHEMA     = 17;
exports.TOOBIG     = 18;
exports.CONSTRAINT = 19;
exports.MISMATCH   = 20;
exports.MISUSE     = 21;
exports.NOLFS      = 22;
exports.AUTH       = 23;
exports.FORMAT     = 24;
exports.RANGE      = 25;
exports.NOTADB     = 26;
exports.NOTICE     = 27;
exports.WARNING    = 28;
exports.ROW        = 100;
exports.DONE       = 101;

exports.VERSION        = '3.46.1-creek-shim';
exports.SOURCE_ID      = '0000000000000000000000000000000000000000';
exports.VERSION_NUMBER = 3046001;

// ---------------------------------------------------------------------------
// sql.js bootstrap — resolved lazily + once per process.
// ---------------------------------------------------------------------------

// sql.js's Emscripten bootstrap detects its environment by reading
// `globalThis.document?.currentScript?.src` and `self.location.href`.
// In workerd `self.location` is undefined — accessing `.href` throws.
// Stub a minimal location so the detection code falls through.
function ensureSqlJsGlobals() {
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  if (typeof globalThis.self.location === 'undefined') {
    try { globalThis.self.location = { href: '' }; }
    catch { globalThis.location = globalThis.location || { href: '' }; }
  }
}

let _SQL;
let _SQL_LOADING;
function loadSqlJs() {
  if (_SQL) return Promise.resolve(_SQL);
  if (_SQL_LOADING) return _SQL_LOADING;
  _SQL_LOADING = (async () => {
    ensureSqlJsGlobals();
    // Use the asm.js build, not the default WASM one. workerd disallows
    // runtime `WebAssembly.instantiate(bytes)` ("Wasm code generation
    // disallowed by embedder"); only statically-imported CompiledWasm
    // modules load. The asm.js variant is pure JavaScript (~1.3MB) and
    // sidesteps that restriction entirely. Node/build-time works the
    // same with either.
    const initSqlJs = require('sql.js/dist/sql-asm.js');
    _SQL = await initSqlJs();
    return _SQL;
  })();
  return _SQL_LOADING;
}

// ---------------------------------------------------------------------------
// Database class — async-ready facade over sql.js.
// sqlite3's real Database opens asynchronously via libuv and fires the
// constructor callback when ready. We keep the same shape: the constructor
// returns synchronously, and `_ready` resolves when the underlying sql.js
// instance exists.
// ---------------------------------------------------------------------------

const EventEmitter = require('events').EventEmitter;

function extractCallback(args) {
  if (args.length && typeof args[args.length - 1] === 'function') {
    return args.pop();
  }
  return null;
}

class Database extends EventEmitter {
  constructor(filename, mode, cb) {
    super();
    if (typeof mode === 'function') { cb = mode; mode = undefined; }
    this.filename = filename;
    this.mode = mode;
    this.open = false;
    this._db = null;
    this._ready = this._init()
      .then(() => {
        this.open = true;
        this.emit('open');
        if (cb) cb.call(this, null);
      })
      .catch((err) => {
        this.emit('error', err);
        if (cb) cb.call(this, err);
        else throw err; // match sqlite3 behaviour when no cb
      });
  }

  async _init() {
    const SQL = await loadSqlJs();
    if (!this.filename || this.filename === ':memory:') {
      this._db = new SQL.Database();
      return;
    }
    // Read the file via node:fs — this runs at build-time (getStaticProps
    // evaluation) or in sandboxed runtimes that still expose `node:fs`
    // (nodejs_compat on workerd). If fs is unavailable (pure workerd
    // runtime path), users should migrate to env.DB (D1) — the future
    // Phase C step extends this shim to route through D1 bindings.
    const fs = require('node:fs');
    const bytes = fs.readFileSync(this.filename);
    this._db = new SQL.Database(new Uint8Array(bytes));
  }

  _rowsFromStmt(stmt) {
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  }

  _firstRowFromStmt(stmt) {
    return stmt.step() ? stmt.getAsObject() : undefined;
  }

  all(sql, ...rest) {
    const cb = extractCallback(rest);
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    this._ready
      .then(() => {
        const stmt = this._db.prepare(sql);
        try {
          if (params.length) stmt.bind(params);
          const rows = this._rowsFromStmt(stmt);
          if (cb) cb.call(this, null, rows);
        } finally {
          stmt.free();
        }
      })
      .catch((err) => {
        if (cb) cb.call(this, err);
        else this.emit('error', err);
      });
    return this;
  }

  get(sql, ...rest) {
    const cb = extractCallback(rest);
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    this._ready
      .then(() => {
        const stmt = this._db.prepare(sql);
        try {
          if (params.length) stmt.bind(params);
          const row = this._firstRowFromStmt(stmt);
          if (cb) cb.call(this, null, row);
        } finally {
          stmt.free();
        }
      })
      .catch((err) => {
        if (cb) cb.call(this, err);
        else this.emit('error', err);
      });
    return this;
  }

  run(sql, ...rest) {
    const cb = extractCallback(rest);
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    const self = this;
    this._ready
      .then(() => {
        const stmt = self._db.prepare(sql);
        try {
          if (params.length) stmt.bind(params);
          stmt.step();
          // Real sqlite3 sets lastID / changes on the callback's `this`.
          const ctx = { lastID: 0, changes: self._db.getRowsModified?.() ?? 0 };
          if (cb) cb.call(ctx, null);
        } finally {
          stmt.free();
        }
      })
      .catch((err) => {
        if (cb) cb.call(self, err);
        else self.emit('error', err);
      });
    return this;
  }

  each(sql, ...rest) {
    // sqlite3's `each(sql, [params], rowCb, completeCb)` — both callbacks optional
    const callbacks = [];
    while (rest.length && typeof rest[rest.length - 1] === 'function') {
      callbacks.unshift(rest.pop());
    }
    const [rowCb, completeCb] = callbacks;
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    this._ready
      .then(() => {
        const stmt = this._db.prepare(sql);
        try {
          if (params.length) stmt.bind(params);
          let n = 0;
          while (stmt.step()) {
            n += 1;
            if (rowCb) rowCb.call(this, null, stmt.getAsObject());
          }
          if (completeCb) completeCb.call(this, null, n);
        } finally {
          stmt.free();
        }
      })
      .catch((err) => {
        if (rowCb) rowCb.call(this, err);
        if (completeCb) completeCb.call(this, err, 0);
      });
    return this;
  }

  exec(sql, cb) {
    this._ready
      .then(() => {
        this._db.exec(sql);
        if (cb) cb.call(this, null);
      })
      .catch((err) => {
        if (cb) cb.call(this, err);
        else this.emit('error', err);
      });
    return this;
  }

  prepare(sql, ...rest) {
    const cb = extractCallback(rest);
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    return new Statement(this, sql, params, cb);
  }

  serialize(cb) {
    // Our backend is already sync-serialized (sql.js is single-threaded).
    // Real sqlite3 uses this to batch queued operations; the wrapper lib
    // just calls cb immediately then relies on FIFO ordering, so we
    // match that.
    if (typeof cb === 'function') cb.call(this);
    return this;
  }

  parallelize(cb) {
    if (typeof cb === 'function') cb.call(this);
    return this;
  }

  configure(_option, _value) {
    // Accept-and-ignore: `busyTimeout`, `limit`, etc. Meaningless for sql.js.
    return this;
  }

  loadExtension(_path, cb) {
    const err = new Error('sqlite3 extension loading unsupported by creek shim');
    if (cb) cb.call(this, err);
    else this.emit('error', err);
    return this;
  }

  close(cb) {
    this._ready
      .then(() => {
        try {
          if (this._db) this._db.close();
          this.open = false;
          this.emit('close');
          if (cb) cb.call(this, null);
        } catch (err) {
          if (cb) cb.call(this, err);
          else this.emit('error', err);
        }
      });
    return this;
  }

  interrupt() { /* no-op */ }
  wait() { /* no-op */ }
}

// Real sqlite3 exposes verbose/cached on the module exports. Some code
// does `sqlite3.verbose()` — in the original package this returns the
// same module with extra stack-trace debugging. We stub it to a no-op
// that returns ourselves so chaining works.
// Handled by the outer sqlite3.js wrapper, but a defensive no-op here
// helps when code imports the binding directly.
Database.verbose = function verbose() { return module.exports; };

// ---------------------------------------------------------------------------
// Statement — represents a prepared statement. sqlite3's Statement class
// is an EventEmitter and exposes run/all/get/each/reset/finalize.
// ---------------------------------------------------------------------------

class Statement extends EventEmitter {
  constructor(database, sql, boundParams, cb) {
    super();
    this._db = database;
    this._sql = sql;
    this._boundParams = boundParams || [];
    this._stmt = null;
    this._ready = database._ready
      .then(() => {
        this._stmt = database._db.prepare(sql);
        if (this._boundParams.length) this._stmt.bind(this._boundParams);
        if (cb) cb.call(this, null);
      })
      .catch((err) => {
        if (cb) cb.call(this, err);
        else this.emit('error', err);
      });
  }

  bind(...rest) {
    const cb = extractCallback(rest);
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    this._ready
      .then(() => {
        this._stmt.bind(params);
        if (cb) cb.call(this, null);
      })
      .catch((err) => {
        if (cb) cb.call(this, err);
        else this.emit('error', err);
      });
    return this;
  }

  reset(cb) {
    this._ready
      .then(() => {
        this._stmt.reset();
        if (cb) cb.call(this, null);
      })
      .catch((err) => {
        if (cb) cb.call(this, err);
        else this.emit('error', err);
      });
    return this;
  }

  finalize(cb) {
    this._ready
      .then(() => {
        try {
          if (this._stmt) this._stmt.free();
          if (cb) cb.call(this, null);
        } catch (err) {
          if (cb) cb.call(this, err);
          else this.emit('error', err);
        }
      });
    return this;
  }

  all(...rest) {
    const cb = extractCallback(rest);
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    this._ready
      .then(() => {
        if (params.length) this._stmt.bind(params);
        const rows = [];
        while (this._stmt.step()) rows.push(this._stmt.getAsObject());
        this._stmt.reset();
        if (cb) cb.call(this, null, rows);
      })
      .catch((err) => {
        if (cb) cb.call(this, err);
        else this.emit('error', err);
      });
    return this;
  }

  get(...rest) {
    const cb = extractCallback(rest);
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    this._ready
      .then(() => {
        if (params.length) this._stmt.bind(params);
        const row = this._stmt.step() ? this._stmt.getAsObject() : undefined;
        this._stmt.reset();
        if (cb) cb.call(this, null, row);
      })
      .catch((err) => {
        if (cb) cb.call(this, err);
        else this.emit('error', err);
      });
    return this;
  }

  run(...rest) {
    const cb = extractCallback(rest);
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    const self = this;
    this._ready
      .then(() => {
        if (params.length) self._stmt.bind(params);
        self._stmt.step();
        self._stmt.reset();
        const ctx = { lastID: 0, changes: self._db._db.getRowsModified?.() ?? 0 };
        if (cb) cb.call(ctx, null);
      })
      .catch((err) => {
        if (cb) cb.call(self, err);
        else self.emit('error', err);
      });
    return this;
  }

  each(...rest) {
    const callbacks = [];
    while (rest.length && typeof rest[rest.length - 1] === 'function') {
      callbacks.unshift(rest.pop());
    }
    const [rowCb, completeCb] = callbacks;
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    this._ready
      .then(() => {
        if (params.length) this._stmt.bind(params);
        let n = 0;
        while (this._stmt.step()) {
          n += 1;
          if (rowCb) rowCb.call(this, null, this._stmt.getAsObject());
        }
        this._stmt.reset();
        if (completeCb) completeCb.call(this, null, n);
      })
      .catch((err) => {
        if (rowCb) rowCb.call(this, err);
        if (completeCb) completeCb.call(this, err, 0);
      });
    return this;
  }
}

// ---------------------------------------------------------------------------
// Backup — sqlite3 supports online backups; sql.js doesn't. Stub a class
// that throws when used. Most test/build paths never touch this.
// ---------------------------------------------------------------------------

class Backup extends EventEmitter {
  constructor() {
    super();
    throw new Error('sqlite3 Backup API unsupported by creek shim');
  }
}

exports.Database  = Database;
exports.Statement = Statement;
exports.Backup    = Backup;

// Some callers read `sqlite3.cached` — the outer sqlite3.js wrapper
// installs `cached.Database`, so we don't need to provide it here.

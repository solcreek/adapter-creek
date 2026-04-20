// Shim for next/dist/server/node-environment-extensions/fast-set-immediate.
//
// Next's cache-components renderer relies on "fast immediates": setImmediate()
// calls made during a runInSequentialTasks stage must flush before the next
// setTimeout(0) stage. workerd's event loop can run the next timeout first,
// which cuts PPR static RSC boundaries before cached content has resolved.
//
// Keep the behavior scoped to Next's explicit capture window. Outside
// DANGEROUSLY_runPendingImmediatesAfterCurrentTask(), setImmediate stays native.
const ORIGINALS_KEY = Symbol.for("creek.fast-set-immediate.originals");
const INTERNALS = Symbol.for("creek.fast-set-immediate.internals");

const originals = globalThis[ORIGINALS_KEY] || (globalThis[ORIGINALS_KEY] = {
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  nextTick: globalThis.process?.nextTick,
});

const originalSetImmediate =
  typeof originals.setImmediate === "function"
    ? originals.setImmediate.bind(globalThis)
    : (callback, ...args) => setTimeout(callback, 0, ...args);
const originalClearImmediate =
  typeof originals.clearImmediate === "function"
    ? originals.clearImmediate.bind(globalThis)
    : clearTimeout;
const originalNextTick =
  typeof originals.nextTick === "function"
    ? originals.nextTick.bind(globalThis.process)
    : (callback, ...args) => queueMicrotask(() => callback(...args));

let currentExecution = null;
let pendingNextTicks = 0;
let installed = false;

class CreekImmediate {
  constructor() {
    this[INTERNALS] = {
      hasRef: true,
      nativeImmediate: null,
      queueItem: null,
    };
  }

  hasRef() {
    const internals = this[INTERNALS];
    if (internals.queueItem) return internals.hasRef;
    if (internals.nativeImmediate?.hasRef) return internals.nativeImmediate.hasRef();
    return false;
  }

  ref() {
    const internals = this[INTERNALS];
    if (internals.queueItem) internals.hasRef = true;
    else internals.nativeImmediate?.ref?.();
    return this;
  }

  unref() {
    const internals = this[INTERNALS];
    if (internals.queueItem) internals.hasRef = false;
    else internals.nativeImmediate?.unref?.();
    return this;
  }

  _onImmediate() {}

  [Symbol.dispose]() {
    const internals = this[INTERNALS];
    if (internals.queueItem) {
      const item = internals.queueItem;
      internals.queueItem = null;
      clearQueueItem(item);
    } else if (internals.nativeImmediate) {
      if (typeof internals.nativeImmediate[Symbol.dispose] === "function") {
        internals.nativeImmediate[Symbol.dispose]();
      } else {
        originalClearImmediate(internals.nativeImmediate);
      }
    }
  }
}

function install() {
  if (installed) return;
  installed = true;

  globalThis.setImmediate = patchedSetImmediate;
  globalThis.clearImmediate = patchedClearImmediate;
  if (globalThis.process && typeof globalThis.process.nextTick === "function") {
    globalThis.process.nextTick = patchedNextTick;
  }

  // Best effort for consumers that import from node:timers. Avoid touching
  // node:timers/promises because that namespace is frozen in Workers.
  try {
    const nodeTimers = require("node:timers");
    nodeTimers.setImmediate = patchedSetImmediate;
    nodeTimers.clearImmediate = patchedClearImmediate;
  } catch {}
}

export function DANGEROUSLY_runPendingImmediatesAfterCurrentTask() {
  if (currentExecution !== null) {
    expectNoPendingImmediates();
  }
  const execution = {
    queuedImmediates: [],
    abandoned: false,
  };
  currentExecution = execution;
  scheduleWorkAfterNextTicksAndMicrotasks(execution);
}

export function expectNoPendingImmediates() {
  if (currentExecution === null) return;

  const execution = currentExecution;
  drainReadyImmediatesSynchronously(execution);

  if (currentExecution === execution) {
    scheduleQueuedImmediatesAsNative(execution);
    currentExecution = null;
  }
}

export { install, originalSetImmediate as unpatchedSetImmediate };

function scheduleWorkAfterNextTicksAndMicrotasks(execution) {
  queueMicrotask(() => {
    originalNextTick(() => {
      if (currentExecution !== execution || execution.abandoned) return;
      if (pendingNextTicks > 0) {
        scheduleWorkAfterNextTicksAndMicrotasks(execution);
        return;
      }
      performWork(execution);
    });
  });
}

function performWork(execution) {
  if (currentExecution !== execution || execution.abandoned) return;

  const queueItem = takeNextActiveQueueItem(execution);
  if (!queueItem) {
    if (currentExecution === execution) currentExecution = null;
    return;
  }

  runQueueItem(queueItem);
  scheduleWorkAfterNextTicksAndMicrotasks(execution);
}

function drainReadyImmediatesSynchronously(execution) {
  for (let i = 0; i < 1000; i++) {
    const queueItem = takeNextActiveQueueItem(execution);
    if (!queueItem) return;
    runQueueItem(queueItem);
  }
}

function runQueueItem(queueItem) {
  const { callback, args, immediateObject } = queueItem;
  immediateObject[INTERNALS].queueItem = null;
  clearQueueItem(queueItem);

  try {
    callback(...args);
  } catch (err) {
    queueMicrotask(() => {
      throw err;
    });
  }
}

function bindCurrentAsyncStores(callback) {
  const stores = [];
  const bag = globalThis.__CREEK_ALS;
  if (bag && typeof bag === "object") {
    for (const als of Object.values(bag)) {
      if (
        als &&
        typeof als.getStore === "function" &&
        typeof als.run === "function"
      ) {
        const store = als.getStore();
        if (store !== undefined) stores.push([als, store]);
      }
    }
  }
  if (stores.length === 0) return callback;

  return (...args) => {
    let invoke = () => callback(...args);
    for (let i = stores.length - 1; i >= 0; i--) {
      const [als, store] = stores[i];
      const next = invoke;
      invoke = () => als.run(store, next);
    }
    return invoke();
  };
}

function takeNextActiveQueueItem(execution) {
  while (execution.queuedImmediates.length > 0) {
    const item = execution.queuedImmediates.shift();
    if (!item.isCleared) return item;
  }
  return null;
}

function clearQueueItem(item) {
  item.isCleared = true;
  item.callback = null;
  item.args = null;
  item.immediateObject = null;
}

function scheduleQueuedImmediatesAsNative(execution) {
  execution.abandoned = true;
  for (const queueItem of execution.queuedImmediates) {
    if (queueItem.isCleared) continue;
    const nativeImmediate = originalSetImmediate(queueItem.callback, ...queueItem.args);
    const internals = queueItem.immediateObject[INTERNALS];
    internals.queueItem = null;
    internals.nativeImmediate = nativeImmediate;
    if (!internals.hasRef) nativeImmediate?.unref?.();
    clearQueueItem(queueItem);
  }
  execution.queuedImmediates.length = 0;
}

function patchedNextTick(callback, ...args) {
  if (currentExecution === null || typeof callback !== "function") {
    return originalNextTick(callback, ...args);
  }

  pendingNextTicks++;
  return originalNextTick(() => {
    pendingNextTicks--;
    try {
      callback(...args);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  });
}

function patchedSetImmediate(callback, ...args) {
  if (currentExecution === null) {
    return originalSetImmediate(callback, ...args);
  }

  if (typeof callback !== "function") {
    return originalSetImmediate(callback, ...args);
  }

  const immediateObject = new CreekImmediate();
  const queueItem = {
    isCleared: false,
    callback: bindCurrentAsyncStores(callback),
    args,
    immediateObject,
  };
  immediateObject[INTERNALS].queueItem = queueItem;
  currentExecution.queuedImmediates.push(queueItem);
  return immediateObject;
}

function patchedClearImmediate(immediateObject) {
  if (
    immediateObject &&
    typeof immediateObject === "object" &&
    Object.prototype.hasOwnProperty.call(immediateObject, INTERNALS)
  ) {
    immediateObject[Symbol.dispose]();
    return;
  }
  return originalClearImmediate(immediateObject);
}

install();

// OpenClaw may register the same plugin module into more than one runtime
// registry in a single process. Plugin services only start for the Gateway
// registry, so hook closures must not capture registration-local engine state.

const BRIDGE_RUNTIME_STATE_KEY = Symbol.for(
  "openclaw.langfuse-bridge.runtime-state",
);

function runtimeState() {
  let state = globalThis[BRIDGE_RUNTIME_STATE_KEY];
  if (!state) {
    state = { engine: null, owner: null };
    Object.defineProperty(globalThis, BRIDGE_RUNTIME_STATE_KEY, {
      configurable: true,
      value: state,
    });
  }
  return state;
}

/** Publish the engine owned by the currently active Gateway service. */
export function publishBridgeEngine(owner, engine) {
  const state = runtimeState();
  state.owner = owner;
  state.engine = engine;
}

/** Return whether a service still owns the process-wide hook destination. */
export function ownsBridgeEngine(owner) {
  return runtimeState().owner === owner;
}

/**
 * Release the hook destination only when it is still owned by this service.
 * This prevents a stale service stop during reload from clearing a newer
 * service's engine.
 */
export function releaseBridgeEngine(owner) {
  const state = runtimeState();
  if (state.owner !== owner) return false;
  state.owner = null;
  state.engine = null;
  return true;
}

/** Dispatch through the live process-wide engine at hook invocation time. */
export function dispatchBridgeHook(name, event, ctx) {
  return runtimeState().engine?.handleHook(name, event, ctx);
}

/** Reset only the singleton owned by this module's Symbol.for key. */
export function resetBridgeRuntimeStateForTest() {
  delete globalThis[BRIDGE_RUNTIME_STATE_KEY];
}

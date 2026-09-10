import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchBridgeHook,
  ownsBridgeEngine,
  publishBridgeEngine,
  releaseBridgeEngine,
  resetBridgeRuntimeStateForTest,
} from "./bridge-runtime-state.js";

afterEach(() => resetBridgeRuntimeStateForTest());

test("hooks from another module registration dispatch to the Gateway service engine", async () => {
  const calls = [];
  const gatewayOwner = Symbol("gateway-service");
  // Query strings force two ESM evaluations, modeling OpenClaw loading the
  // plugin into separate runtime registries. Symbol.for keeps their state
  // shared even though their module-local functions are distinct.
  const gatewayRegistration = await import(
    "./bridge-runtime-state.js?registration=gateway"
  );
  const sandboxRegistration = await import(
    "./bridge-runtime-state.js?registration=sandbox"
  );
  gatewayRegistration.publishBridgeEngine(gatewayOwner, {
    handleHook(...args) {
      calls.push(args);
    },
  });

  // These callbacks model a second scoped/Sandbox registry registration. They
  // resolve the engine when invoked instead of capturing registration state.
  const scopedToolHook = (event, ctx) =>
    sandboxRegistration.dispatchBridgeHook("after_tool_call", event, ctx);
  const scopedLlmHook = (event, ctx) =>
    sandboxRegistration.dispatchBridgeHook("llm_output", event, ctx);

  const toolEvent = { toolCallId: "tool-1", result: "ok" };
  const llmEvent = { runId: "run-1", assistantTexts: ["done"] };
  const ctx = { runId: "run-1", sessionId: "session-1" };
  scopedToolHook(toolEvent, ctx);
  scopedLlmHook(llmEvent, ctx);

  assert.deepEqual(calls, [
    ["after_tool_call", toolEvent, ctx],
    ["llm_output", llmEvent, ctx],
  ]);
});

test("a hook registered before service start resolves the engine lazily", () => {
  const calls = [];
  const hook = (event) => dispatchBridgeHook("before_tool_call", event, {});

  hook({ toolCallId: "before-start" });
  assert.deepEqual(calls, []);

  publishBridgeEngine(Symbol("service"), {
    handleHook(...args) {
      calls.push(args);
    },
  });
  const event = { toolCallId: "after-start" };
  hook(event);

  assert.deepEqual(calls, [["before_tool_call", event, {}]]);
});

test("a stale service cannot clear a newer service engine", () => {
  const oldOwner = Symbol("old-service");
  const newOwner = Symbol("new-service");
  const calls = [];
  publishBridgeEngine(oldOwner, { handleHook() {} });
  publishBridgeEngine(newOwner, {
    handleHook(...args) {
      calls.push(args);
    },
  });

  assert.equal(ownsBridgeEngine(oldOwner), false);
  assert.equal(ownsBridgeEngine(newOwner), true);
  assert.equal(releaseBridgeEngine(oldOwner), false);

  dispatchBridgeHook("llm_input", { runId: "run-2" }, {});
  assert.equal(calls.length, 1);
  assert.equal(releaseBridgeEngine(newOwner), true);
  assert.equal(ownsBridgeEngine(newOwner), false);
  assert.equal(dispatchBridgeHook("llm_input", {}, {}), undefined);
});

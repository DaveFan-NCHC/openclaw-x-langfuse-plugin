import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowsConversationAccess,
  CONVERSATION_HOOKS,
  registerBridgeHooks,
  TOOL_AND_SUBAGENT_HOOKS,
} from "./plugin-lifecycle.js";

test("registers all hooks without reading the registration config snapshot", () => {
  const registered = [];
  registerBridgeHooks({
    config: {},
    on(name, handler) {
      registered.push({ name, handler });
    },
  });

  assert.deepEqual(
    registered.map(({ name }) => name),
    [...TOOL_AND_SUBAGENT_HOOKS, ...CONVERSATION_HOOKS],
  );
  assert.ok(registered.every(({ handler }) => typeof handler === "function"));
});

test("does not register conversation hooks when content capture is disabled", () => {
  const registered = [];
  registerBridgeHooks(
    {
      on(name) {
        registered.push(name);
      },
    },
    { captureConversationContent: false },
  );

  assert.deepEqual(registered, TOOL_AND_SUBAGENT_HOOKS);
});

test("reads conversation access from live config using case-insensitive plugin IDs", () => {
  const config = {
    plugins: {
      entries: {
        "Langfuse-Bridge": {
          hooks: { allowConversationAccess: true },
        },
      },
    },
  };

  assert.equal(allowsConversationAccess(config, "langfuse-bridge"), true);
  assert.equal(allowsConversationAccess(config, "other-plugin"), false);
});

test("requires the permission to be the boolean true", () => {
  const config = {
    plugins: {
      entries: {
        "langfuse-bridge": {
          hooks: { allowConversationAccess: "true" },
        },
      },
    },
  };

  assert.equal(allowsConversationAccess(config, "langfuse-bridge"), false);
});

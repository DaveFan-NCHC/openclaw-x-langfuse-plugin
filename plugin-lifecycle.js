import { dispatchBridgeHook } from "./bridge-runtime-state.js";

export const TOOL_AND_SUBAGENT_HOOKS = [
  "before_tool_call",
  "after_tool_call",
  "subagent_spawned",
  "subagent_ended",
];

export const CONVERSATION_HOOKS = [
  "before_agent_run",
  "llm_input",
  "llm_output",
  "before_agent_finalize",
  "agent_end",
];

/**
 * Read the permission from the live Gateway config. OpenClaw matches plugin IDs
 * case-insensitively, so mirror that behavior instead of relying on an exact
 * object-property lookup.
 */
export function allowsConversationAccess(config, pluginId) {
  const entries = config?.plugins?.entries;
  if (!entries || typeof entries !== "object" || typeof pluginId !== "string") {
    return false;
  }

  const normalizedPluginId = pluginId.toLowerCase();
  const entry = Object.entries(entries).find(
    ([candidateId]) => candidateId.toLowerCase() === normalizedPluginId,
  )?.[1];
  return entry?.hooks?.allowConversationAccess === true;
}

/**
 * Always offer every hook to OpenClaw. Its registry owns the authoritative
 * hook policy and will reject conversation hooks when access was not granted.
 */
export function registerBridgeHooks(api, { captureConversationContent = true } = {}) {
  const hookNames = captureConversationContent
    ? [...TOOL_AND_SUBAGENT_HOOKS, ...CONVERSATION_HOOKS]
    : TOOL_AND_SUBAGENT_HOOKS;
  for (const hookName of hookNames) {
    api.on(hookName, (event, ctx) => {
      dispatchBridgeHook(hookName, event, ctx);
    });
  }
}

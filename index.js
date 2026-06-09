// openclaw-langfuse-bridge
//
// Forwards OpenClaw's internal diagnostics bus to Langfuse. It registers a
// background service, subscribes to the diagnostics event stream via
// `ctx.internalDiagnostics.onEvent`, and translates `model.usage` (and
// `model.call.error`) events into Langfuse traces/generations.
//
// This mirrors how the bundled `@openclaw/diagnostics-otel` plugin consumes
// the same bus, so the wiring is known-good rather than guessed.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Langfuse } from "langfuse";
import { handleEvent } from "./mapping.js";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

/**
 * Resolve effective config from the plugin's scoped config block
 * (openclaw.json -> plugins.entries["langfuse-bridge"].config) with
 * environment-variable fallbacks.
 */
function resolveConfig(pluginConfig) {
  const cfg = pluginConfig ?? {};
  return {
    publicKey: cfg.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: cfg.secretKey ?? process.env.LANGFUSE_SECRET_KEY,
    baseUrl: cfg.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL,
  };
}

function createLangfuseBridgeService(getPluginConfig) {
  /** @type {import("langfuse").Langfuse | null} */
  let lf = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  return {
    id: "langfuse-bridge",

    async start(ctx) {
      const { publicKey, secretKey, baseUrl } = resolveConfig(
        getPluginConfig(),
      );

      if (!publicKey || !secretKey) {
        ctx.logger.warn(
          "langfuse-bridge: missing publicKey/secretKey (set plugin config or LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY); not starting",
        );
        return;
      }

      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error(
          "langfuse-bridge: internal diagnostics capability unavailable; not starting",
        );
        return;
      }

      lf = new Langfuse({ publicKey, secretKey, baseUrl });

      unsubscribe = subscribe((evt) => handleEvent(lf, evt, ctx.logger));

      ctx.logger.info(
        `langfuse-bridge: subscribed to diagnostics; exporting model usage to ${baseUrl}`,
      );
    },

    async stop() {
      try {
        unsubscribe?.();
      } finally {
        unsubscribe = null;
      }
      if (lf) {
        try {
          await lf.shutdownAsync();
        } catch {
          // best-effort flush on shutdown
        }
        lf = null;
      }
    },
  };
}

export default definePluginEntry({
  id: "langfuse-bridge",
  name: "Langfuse Bridge",
  description: "Forwards OpenClaw model usage diagnostics to Langfuse",
  register(api) {
    api.registerService(createLangfuseBridgeService(() => api.pluginConfig));
  },
});

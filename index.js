// openclaw-langfuse-bridge
//
// Forwards OpenClaw's internal diagnostics bus to Langfuse. It registers a
// background service, subscribes to the diagnostics event stream, and
// translates `model.usage` (and `model.call.error`) events into Langfuse
// traces/generations.
//
// Built on the Langfuse v5 SDK, which is OpenTelemetry-based. To avoid touching
// OpenClaw's own global OTel setup (the bundled `diagnostics-otel` service), we
// run the Langfuse SpanProcessor inside a dedicated, isolated TracerProvider and
// register it via `setLangfuseTracerProvider`. The Langfuse tracing helpers then
// emit through our provider only; OpenClaw's global provider is untouched.
//
// Subscription note: we subscribe via the public `onInternalDiagnosticEvent`
// SDK export rather than `ctx.internalDiagnostics.onEvent`. The latter is a
// privileged capability the runtime injects only for the bundled
// `diagnostics-otel`/`diagnostics-prometheus` services (it carries captured
// prompt/response private data); third-party plugins never receive it. The
// public listener provides trace structure, timing, usage, and status. Typed
// plugin hooks provide raw I/O when the operator explicitly grants access.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  onInternalDiagnosticEvent,
  isDiagnosticsEnabled,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  setLangfuseTracerProvider,
} from "@langfuse/tracing";
import { createTraceEngine } from "./tracer.js";
import { makeTranscriptResolvers } from "./transcript.js";
import {
  dispatchBridgeHook,
  ownsBridgeEngine,
  publishBridgeEngine,
  releaseBridgeEngine,
} from "./bridge-runtime-state.js";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

// How often the idle reaper ends dangling observations (orphaned by dropped
// start/complete events). Kept well under the engine's TTL.
const REAPER_INTERVAL_MS = 60_000;

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
    captureConversationContent: cfg.captureConversationContent !== false,
    captureToolContent: cfg.captureToolContent !== false,
    transcriptFallback: cfg.transcriptFallback !== false,
    maxContentBytes:
      typeof cfg.maxContentBytes === "number" ? cfg.maxContentBytes : 64_000,
  };
}

function createLangfuseBridgeService(getPluginConfig, conversationHooksEnabled) {
  // A unique token prevents an older service instance from clearing a newer
  // engine when Gateway plugin reload lifecycles overlap.
  const owner = Symbol("langfuse-bridge-service");
  /** @type {import("@opentelemetry/sdk-trace-node").NodeTracerProvider | null} */
  let provider = null;
  /** @type {import("@langfuse/otel").LangfuseSpanProcessor | null} */
  let spanProcessor = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {ReturnType<typeof createTraceEngine> | null} */
  let engine = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let reaper = null;
  /** @type {ReturnType<typeof makeTranscriptResolvers> | null} */
  let transcriptResolvers = null;

  return {
    id: "langfuse-bridge",

    async start(ctx) {
      const config = resolveConfig(getPluginConfig());
      const { publicKey, secretKey, baseUrl } = config;

      if (!publicKey || !secretKey) {
        ctx.logger.warn(
          "langfuse-bridge: missing publicKey/secretKey (set plugin config or LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY); not starting",
        );
        return;
      }

      if (!isDiagnosticsEnabled(ctx.config)) {
        ctx.logger.warn(
          "langfuse-bridge: diagnostics are disabled (config.diagnostics.enabled === false); no events will be emitted, not starting",
        );
        return;
      }

      // Isolated OTel pipeline: our SpanProcessor lives on a dedicated provider,
      // and we point the Langfuse tracing helpers at it. This keeps us off the
      // global tracer provider that OpenClaw's diagnostics-otel may own.
      spanProcessor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });
      provider = new NodeTracerProvider({ spanProcessors: [spanProcessor] });
      setLangfuseTracerProvider(provider);

      const tracing = { startObservation };

      // Hooks are authoritative. Session/trajectory parsing is a bounded,
      // once-per-run fallback only when a hook did not provide a field.
      transcriptResolvers = config.transcriptFallback
        ? makeTranscriptResolvers(ctx.stateDir, ctx.logger)
        : null;

      engine = createTraceEngine(tracing, {
        logger: ctx.logger,
        resolveContent: transcriptResolvers?.resolveContent,
        resolveToolIO: transcriptResolvers?.resolveToolIO,
        conversationHooksEnabled,
        captureConversationContent: config.captureConversationContent,
        captureToolContent: config.captureToolContent,
        maxContentBytes: config.maxContentBytes,
      });
      publishBridgeEngine(owner, engine);

      // `onInternalDiagnosticEvent` invokes the listener as
      // (event, metadata) => void. We only need the event body; the engine
      // ignores unrelated event types and catches its own errors, so it never
      // throws into the bus.
      unsubscribe = onInternalDiagnosticEvent((evt) => {
        if (ownsBridgeEngine(owner)) engine?.handle(evt);
      });

      // Idle reaper: ends observations orphaned by dropped start/complete events
      // (these event types are async-queued and droppable under load). Unref'd
      // so it never keeps the process alive.
      reaper = setInterval(() => {
        if (ownsBridgeEngine(owner)) engine?.sweep();
      }, REAPER_INTERVAL_MS);
      reaper.unref?.();

      ctx.logger.info(
        `langfuse-bridge: subscribed to diagnostics; exporting nested run traces to ${baseUrl}`,
      );
    },

    async stop() {
      try {
        unsubscribe?.();
      } finally {
        unsubscribe = null;
      }
      if (reaper) {
        clearInterval(reaper);
        reaper = null;
      }
      // End any still-open observations before the provider shuts down.
      try {
        engine?.flushAll();
      } catch {
        // best-effort flush of in-flight observations
      }
      const releasedCurrentEngine = releaseBridgeEngine(owner);
      engine = null;
      transcriptResolvers?.clear();
      transcriptResolvers = null;
      // Restore the default (global) provider for the Langfuse helpers.
      if (releasedCurrentEngine) setLangfuseTracerProvider(null);
      if (spanProcessor) {
        try {
          await spanProcessor.forceFlush();
        } catch {
          // best-effort flush on shutdown
        }
      }
      if (provider) {
        try {
          await provider.shutdown();
        } catch {
          // best-effort shutdown
        }
      }
      spanProcessor = null;
      provider = null;
    },
  };
}

export default definePluginEntry({
  id: "langfuse-bridge",
  name: "Langfuse Bridge",
  description: "Correlates OpenClaw hooks and diagnostics in Langfuse",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const conversationAllowed =
      api.config?.plugins?.entries?.[api.id]?.hooks?.allowConversationAccess === true;
    const conversationHooksEnabled =
      config.captureConversationContent && conversationAllowed;

    // Tool and subagent lifecycle hooks do not expose raw conversation content
    // and remain available even when conversation access was not granted.
    for (const hookName of [
      "before_tool_call",
      "after_tool_call",
      "subagent_spawned",
      "subagent_ended",
    ]) {
      api.on(hookName, (event, ctx) => {
        dispatchBridgeHook(hookName, event, ctx);
      });
    }

    if (conversationHooksEnabled) {
      for (const hookName of [
        "before_agent_run",
        "llm_input",
        "llm_output",
        "before_agent_finalize",
        "agent_end",
      ]) {
        api.on(hookName, (event, ctx) => {
          dispatchBridgeHook(hookName, event, ctx);
        });
      }
    } else if (config.captureConversationContent) {
      api.logger.warn(
        "langfuse-bridge: raw conversation hooks are disabled; set plugins.entries.langfuse-bridge.hooks.allowConversationAccess=true to capture agent/generation input and output (tool and subagent lifecycle hooks remain active)",
      );
    }

    api.registerService(
      createLangfuseBridgeService(() => api.pluginConfig, conversationHooksEnabled),
    );
  },
});

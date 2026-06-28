// Pure mapping from OpenClaw diagnostic events to Langfuse observations.
//
// Built on the Langfuse v5 (OpenTelemetry) SDK. The only tracing primitive is
// `startObservation`, dependency-injected as a `tracing` object so this module
// can be unit-tested without a real OTel provider or a running gateway.
//
// Grouping: each model event becomes a root observation (its own trace), tagged
// with the OpenClaw session id so a conversation's turns group together in
// Langfuse's Sessions view. This is the v5 "observations-first" model — unlike
// the v3 bridge, which coalesced a session into one trace. We keep each turn as
// a root span because Langfuse only promotes trace-level fields (name,
// sessionId, input/output) from a trace's root span.
//
// Trace-level fields are written straight onto the root OTel span via
// `setAttribute` (the keys below). We deliberately avoid `propagateAttributes`,
// which relies on a global OTel context manager we don't register (to stay off
// the global OTel state OpenClaw's diagnostics-otel owns).

// Langfuse OTel attribute keys (from @langfuse/core LangfuseOtelSpanAttributes).
const TRACE_NAME = "langfuse.trace.name";
const TRACE_SESSION_ID = "session.id";

/** Drop undefined/null values so we never send empty fields to Langfuse. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** Write trace-level name/sessionId onto an observation's root OTel span. */
function setTraceFields(obs, name, sessionId) {
  const span = obs?.otelSpan;
  if (!span || typeof span.setAttribute !== "function") return;
  if (name !== undefined && name !== null) span.setAttribute(TRACE_NAME, name);
  if (sessionId !== undefined && sessionId !== null) {
    span.setAttribute(TRACE_SESSION_ID, sessionId);
  }
}

/**
 * Map a `model.usage` diagnostic event to a Langfuse generation. The generation
 * is the root of its own trace, tagged with the session id for grouping.
 *
 * DiagnosticUsageEvent: { type:"model.usage", ts, sessionId?, sessionKey?,
 * channel?, agentId?, provider?, model?, usage:{input,output,cacheRead,
 * cacheWrite,promptTokens,total}, context?:{limit,used}, costUsd?, durationMs? }
 */
export function forwardUsage(tracing, evt, content) {
  const sessionId = evt.sessionId ?? evt.sessionKey;
  const usage = evt.usage ?? {};

  const startTime = typeof evt.ts === "number" ? new Date(evt.ts) : undefined;
  const endTime =
    startTime && typeof evt.durationMs === "number"
      ? new Date(evt.ts + evt.durationMs)
      : undefined;

  const gen = tracing.startObservation(
    evt.model ?? "model.usage",
    compact({
      model: evt.model,
      input: content?.input,
      output: content?.output,
      usageDetails: compact({
        input: usage.input,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        total: usage.total,
      }),
      costDetails:
        typeof evt.costUsd === "number" ? { totalCost: evt.costUsd } : undefined,
      metadata: compact({
        channel: evt.channel,
        agentId: evt.agentId,
        provider: evt.provider,
        promptTokens: usage.promptTokens,
        contextLimit: evt.context?.limit,
        contextUsed: evt.context?.used,
        durationMs: evt.durationMs,
      }),
    }),
    compact({ asType: "generation", startTime }),
  );

  setTraceFields(gen, evt.channel ?? "openclaw", sessionId);

  // Mirror the turn's IO onto the trace so it shows at the trace level too.
  const traceIO = compact({ input: content?.input, output: content?.output });
  if (Object.keys(traceIO).length > 0) gen.setTraceIO(traceIO);

  gen.end(endTime);
}

/**
 * Map a `model.call.error` diagnostic event to a Langfuse error observation.
 * Modeled as a span (not an `event`, which auto-ends before we can attach
 * trace-level fields) carrying ERROR level + failure metadata.
 */
export function forwardError(tracing, evt) {
  const sessionId = evt.sessionId ?? evt.sessionKey;

  const span = tracing.startObservation(
    "model.call.error",
    compact({
      level: "ERROR",
      statusMessage: evt.errorCategory ?? evt.failureKind,
      metadata: compact({
        provider: evt.provider,
        model: evt.model,
        errorCategory: evt.errorCategory,
        failureKind: evt.failureKind,
        durationMs: evt.durationMs,
        callId: evt.callId,
        runId: evt.runId,
      }),
    }),
    compact({
      asType: "span",
      startTime: typeof evt.ts === "number" ? new Date(evt.ts) : undefined,
    }),
  );

  setTraceFields(span, evt.channel ?? "openclaw", sessionId);
  span.end();
}

/**
 * Dispatch a single diagnostic event. Unknown event types are ignored.
 * Returns true if the event was handled (useful for tests).
 */
export function handleEvent(tracing, evt, logger, resolveContent) {
  try {
    switch (evt?.type) {
      case "model.usage": {
        let content;
        if (typeof resolveContent === "function") {
          try {
            content = resolveContent(evt);
          } catch {
            content = undefined; // content is best-effort; never block usage
          }
        }
        forwardUsage(tracing, evt, content);
        return true;
      }
      case "model.call.error":
        forwardError(tracing, evt);
        return true;
      default:
        return false;
    }
  } catch (err) {
    logger?.error?.(
      `langfuse-bridge: handler failed (${evt?.type}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

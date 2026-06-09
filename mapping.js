// Pure mapping from OpenClaw diagnostic events to Langfuse calls.
//
// Kept dependency-injected (the Langfuse client is passed in) so it can be
// unit-tested without a real Langfuse instance or a running gateway.

/** Drop undefined/null values so we never send empty fields to Langfuse. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Map a `model.usage` diagnostic event to a Langfuse generation, grouped under
 * a trace keyed by the OpenClaw session so multiple model calls in one session
 * land on the same trace.
 *
 * DiagnosticUsageEvent: { type:"model.usage", ts, sessionId?, sessionKey?,
 * channel?, agentId?, provider?, model?, usage:{input,output,cacheRead,
 * cacheWrite,promptTokens,total}, context?:{limit,used}, costUsd?, durationMs? }
 */
export function forwardUsage(lf, evt) {
  const sessionId = evt.sessionId ?? evt.sessionKey;
  const usage = evt.usage ?? {};

  const trace = lf.trace(
    compact({
      id: sessionId,
      sessionId,
      name: evt.channel ?? "openclaw",
      metadata: compact({
        channel: evt.channel,
        agentId: evt.agentId,
        provider: evt.provider,
      }),
    }),
  );

  const startTime = typeof evt.ts === "number" ? new Date(evt.ts) : undefined;
  const endTime =
    startTime && typeof evt.durationMs === "number"
      ? new Date(evt.ts + evt.durationMs)
      : undefined;

  trace.generation(
    compact({
      name: evt.model ?? "model.usage",
      model: evt.model,
      startTime,
      endTime,
      usageDetails: compact({
        input: usage.input,
        output: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        total: usage.total,
      }),
      costDetails:
        typeof evt.costUsd === "number" ? { total: evt.costUsd } : undefined,
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
  );
}

/** Map a `model.call.error` diagnostic event to a Langfuse error event. */
export function forwardError(lf, evt) {
  const sessionId = evt.sessionId ?? evt.sessionKey;
  const trace = lf.trace(
    compact({ id: sessionId, sessionId, name: evt.channel ?? "openclaw" }),
  );
  trace.event(
    compact({
      name: "model.call.error",
      level: "ERROR",
      statusMessage: evt.errorCategory ?? evt.failureKind,
      startTime: typeof evt.ts === "number" ? new Date(evt.ts) : undefined,
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
  );
}

/**
 * Dispatch a single diagnostic event. Unknown event types are ignored.
 * Returns true if the event was handled (useful for tests).
 */
export function handleEvent(lf, evt, logger) {
  try {
    switch (evt?.type) {
      case "model.usage":
        forwardUsage(lf, evt);
        return true;
      case "model.call.error":
        forwardError(lf, evt);
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

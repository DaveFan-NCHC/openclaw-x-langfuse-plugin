// Pure mapping helpers: translate OpenClaw diagnostic events into the shapes the
// Langfuse v5 (OpenTelemetry) SDK expects. These functions hold no state and do
// no I/O, so they can be unit-tested in isolation. The stateful nesting of
// observations into per-run traces lives in `tracer.js`.

// Langfuse OTel attribute keys (from @langfuse/core LangfuseOtelSpanAttributes).
export const TRACE_NAME = "langfuse.trace.name";
export const TRACE_SESSION_ID = "session.id";

/** Drop undefined/null values so we never send empty fields to Langfuse. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const SENSITIVE_KEY_RE =
  /(?:authorization|proxy-authorization|api[-_]?key|secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|^token$|password|passwd|cookie|credential|private[-_]?key)/i;
const IMAGE_KEY_RE = /^(?:image|image_url|imageUrl|thumbnail|data)$/i;
const IMAGE_TYPE_RE = /^(?:image|image_url|input_image|output_image)$/i;
const BASE64_RE = /^[A-Za-z0-9+/=_-]+$/;

function redactString(value) {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /\b(authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|password|passwd|secret|credential)\b(\s*[=:]\s*)([^\s,;&]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]");
}

function looksLikeBase64(value) {
  const compactValue = value.replace(/\s/g, "");
  return compactValue.length >= 512 && BASE64_RE.test(compactValue);
}

/**
 * Return a size-bounded, credential-redacted clone suitable for Langfuse.
 * Hook values are raw host data, so binary/image bodies are represented by a
 * marker and never serialized. The input object is never mutated.
 */
export function sanitizeContent(value, maxBytes = 64_000) {
  if (value === undefined || value === null) return value;
  const limit = Number.isFinite(maxBytes) ? Math.max(256, Math.floor(maxBytes)) : 64_000;
  const seen = new WeakSet();

  function visit(current, key, depth) {
    if (current === undefined || current === null) return current;
    if (SENSITIVE_KEY_RE.test(key ?? "")) return "[REDACTED]";
    if (Buffer.isBuffer(current)) return `[OMITTED_BINARY ${current.byteLength} bytes]`;
    if (ArrayBuffer.isView(current)) {
      return `[OMITTED_BINARY ${current.byteLength} bytes]`;
    }
    if (current instanceof ArrayBuffer) {
      return `[OMITTED_BINARY ${current.byteLength} bytes]`;
    }
    if (typeof current === "string") {
      if (/^data:image\//i.test(current) || (IMAGE_KEY_RE.test(key ?? "") && looksLikeBase64(current))) {
        return "[OMITTED_IMAGE]";
      }
      if (looksLikeBase64(current)) return "[OMITTED_BASE64]";
      return redactString(current);
    }
    if (typeof current === "number" || typeof current === "boolean") return current;
    if (typeof current === "bigint") return String(current);
    if (typeof current !== "object") return String(current);
    if (depth >= 12) return "[OMITTED_MAX_DEPTH]";
    if (seen.has(current)) return "[OMITTED_CIRCULAR]";
    seen.add(current);

    if (Array.isArray(current)) {
      const out = current.slice(0, 256).map((item) => visit(item, "", depth + 1));
      if (current.length > 256) out.push(`[OMITTED ${current.length - 256} ITEMS]`);
      return out;
    }

    if (IMAGE_TYPE_RE.test(String(current.type ?? ""))) {
      return { type: current.type, content: "[OMITTED_IMAGE]" };
    }
    const out = {};
    for (const [childKey, childValue] of Object.entries(current).slice(0, 256)) {
      out[childKey] = visit(childValue, childKey, depth + 1);
    }
    if (Object.keys(current).length > 256) out.__truncated__ = "[OMITTED_FIELDS]";
    return out;
  }

  const sanitized = visit(value, "", 0);
  const truncate = (text) => {
    const suffix = "…[TRUNCATED]";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    return `${Buffer.from(text)
      .subarray(0, Math.max(0, limit - suffixBytes))
      .toString("utf8")}${suffix}`;
  };
  if (typeof sanitized === "string") {
    return Buffer.byteLength(sanitized, "utf8") <= limit
      ? sanitized
      : truncate(sanitized);
  }
  let encoded;
  try {
    encoded = JSON.stringify(sanitized);
  } catch {
    return "[OMITTED_UNSERIALIZABLE]";
  }
  if (Buffer.byteLength(encoded, "utf8") <= limit) return sanitized;
  return truncate(encoded);
}

/** Extract text from common OpenClaw/LLM message content shapes. */
export function messageText(message) {
  const msg = message?.message ?? message;
  if (!msg || typeof msg !== "object") return undefined;
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return undefined;
  const parts = [];
  for (const block of msg.content) {
    if (typeof block === "string") parts.push(block);
    else if (
      block &&
      (block.type === "text" || block.type === "output_text" || block.type === "input_text") &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Find the last non-empty assistant answer without returning tool/thinking data. */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]?.message ?? messages[i];
    if (msg?.role !== "assistant") continue;
    const text = messageText(msg)?.trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * Write trace-level name/sessionId onto an observation's root OTel span. We set
 * these straight on the span (rather than via `propagateAttributes`, which needs
 * a global OTel context manager we deliberately don't register) so Langfuse
 * promotes them to the trace. Only meaningful on a trace's root observation.
 */
export function setTraceFields(obs, name, sessionId) {
  const span = obs?.otelSpan;
  if (!span || typeof span.setAttribute !== "function") return;
  if (name !== undefined && name !== null) span.setAttribute(TRACE_NAME, name);
  if (sessionId !== undefined && sessionId !== null) {
    span.setAttribute(TRACE_SESSION_ID, sessionId);
  }
}

// Tool names whose work is retrieval/search — these become Langfuse `retriever`
// observations so RAG steps render distinctly from ordinary tool calls. Matched
// case-insensitively as a substring of the tool name.
const RETRIEVER_NAME_RE =
  /(search|retriev|rag\b|vector|embed|semantic|lookup|recall|knowledge|grep|memory|index|web[_-]?fetch|fetch[_-]?url|find)/i;

/**
 * Classify a tool by name into a Langfuse observation type: "retriever" for
 * retrieval/search/RAG tools, "tool" otherwise. The toolSource ("mcp", "core",
 * etc.) is not used for classification but is carried in metadata.
 */
export function classifyToolType(toolName) {
  return typeof toolName === "string" && RETRIEVER_NAME_RE.test(toolName)
    ? "retriever"
    : "tool";
}

/** Map an OpenClaw usage object to Langfuse usageDetails (snake_case keys). */
export function usageDetails(usage = {}) {
  return compact({
    input: usage.input,
    output: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    total: usage.total,
  });
}

/** Convert an epoch-ms timestamp to a Date, or undefined. */
export function toDate(ms) {
  return typeof ms === "number" ? new Date(ms) : undefined;
}

/** Attributes for a `generation` observation built from a model.call event. */
export function generationAttributes(evt) {
  return compact({
    model: evt.model,
    metadata: compact({
      provider: evt.provider,
      api: evt.api,
      transport: evt.transport,
      callId: evt.callId,
      runId: evt.runId,
      contextTokenBudget: evt.contextTokenBudget,
      contextWindowSource: evt.contextWindowSource,
    }),
  });
}

/** Attributes for a `tool`/`retriever` observation from a tool.execution event. */
export function toolAttributes(evt) {
  return compact({
    metadata: compact({
      toolSource: evt.toolSource,
      toolOwner: evt.toolOwner,
      toolCallId: evt.toolCallId,
      runId: evt.runId,
      paramsSummary: evt.paramsSummary,
    }),
  });
}

/** Attributes for the per-run root observation. */
export function runAttributes(evt) {
  return compact({
    metadata: compact({
      runId: evt.runId,
      provider: evt.provider,
      model: evt.model,
      trigger: evt.trigger,
      channel: evt.channel,
    }),
  });
}

/** Attributes for a `context.assembled` observation. */
export function contextAttributes(evt) {
  return compact({
    metadata: compact({
      runId: evt.runId,
      messageCount: evt.messageCount,
      historyTextChars: evt.historyTextChars,
      systemPromptChars: evt.systemPromptChars,
      promptChars: evt.promptChars,
      promptImages: evt.promptImages,
      contextTokenBudget: evt.contextTokenBudget,
    }),
  });
}

/**
 * Human-readable one-line summary of a `context.assembled` event's sizes, used
 * as the observation's `output` so the row isn't blank. The event carries only
 * counts (no text), so this surfaces the numbers that are otherwise buried in
 * metadata. Returns undefined when there's nothing to summarize.
 */
export function contextSummary(evt) {
  const parts = [];
  const add = (label, v) => {
    if (typeof v === "number") parts.push(`${label}=${v}`);
  };
  add("messages", evt.messageCount);
  add("promptChars", evt.promptChars);
  add("systemPromptChars", evt.systemPromptChars);
  add("historyTextChars", evt.historyTextChars);
  add("promptImages", evt.promptImages);
  add("historyImageBlocks", evt.historyImageBlocks);
  add("tokenBudget", evt.contextTokenBudget);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Attributes for an ERROR observation (model.call.error / tool.execution.error). */
export function errorAttributes(evt) {
  return compact({
    level: "ERROR",
    statusMessage: evt.errorCategory ?? evt.failureKind ?? evt.deniedReason,
    metadata: compact({
      provider: evt.provider,
      model: evt.model,
      errorCategory: evt.errorCategory,
      errorCode: evt.errorCode,
      failureKind: evt.failureKind,
      callId: evt.callId,
      runId: evt.runId,
      toolCallId: evt.toolCallId,
    }),
  });
}

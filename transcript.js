// Bounded transcript fallback for fields not captured by OpenClaw hooks.
// Canonical session JSONL is preferred; legacy trajectory data is last-resort
// only because its arrays (including messagesSnapshot) are capped at 64 items.

import { openSync, readSync, readFileSync, statSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { lastAssistantText, messageText } from "./mapping.js";

// Cap how much of a (potentially long-lived) transcript we read; we only need
// the tail (most recent turn) and a small head (the session's first prompt).
const MAX_READ_BYTES = 2_000_000;
const HEAD_READ_BYTES = 256_000;

/** Resolve OpenClaw's state dir: ctx.stateDir, then env, then ~/.openclaw. */
export function resolveStateDir(stateDir) {
  if (typeof stateDir === "string" && stateDir.length > 0) return stateDir;
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR;
  return path.join(homedir(), ".openclaw");
}

/** Path to a session's trajectory transcript. */
export function trajectoryPath(stateDir, agentId, sessionId) {
  return path.join(
    resolveStateDir(stateDir),
    "agents",
    agentId || "main",
    "sessions",
    `${sessionId}.trajectory.jsonl`,
  );
}

/** Path to OpenClaw's canonical id/parentId session transcript. */
export function sessionPath(stateDir, agentId, sessionId) {
  return path.join(
    resolveStateDir(stateDir),
    "agents",
    agentId || "main",
    "sessions",
    `${sessionId}.jsonl`,
  );
}

/** Read a byte window of a file as UTF-8 text. `from: "head" | "tail"`. */
function readWindow(file, maxBytes, from) {
  const { size } = statSync(file);
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const start = from === "tail" ? size - maxBytes : 0;
    const bytes = readSync(fd, buf, 0, maxBytes, start);
    return buf.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Extract a prompt/response from a single parsed trajectory entry. */
function entryIO(obj) {
  const data = obj?.data;
  if (!data) return {};
  if (obj.type === "model.completed") {
    const io = {};
    if (typeof data.finalPromptText === "string") io.input = data.finalPromptText;
    if (Array.isArray(data.assistantTexts) && data.assistantTexts.length > 0) {
      io.output = data.assistantTexts.join("\n");
    }
    return io;
  }
  if (obj.type === "prompt.submitted" && typeof data.prompt === "string") {
    return { input: data.prompt };
  }
  return {};
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null; // tolerate a truncated boundary line from a windowed read
  }
}

function parsedLines(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const row = parseLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** Flatten a tool-result `content` value (string | array of text blocks) to text. */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block.text === "string") parts.push(block.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

/**
 * Pure: extract per-tool input/output from trajectory JSONL text, keyed by the
 * tool call id (which matches the `toolCallId` on `tool.execution.*` diagnostic
 * events). As a legacy fallback only, we inspect the last available
 * `model.completed.messagesSnapshot`. OpenClaw caps this array at 64 entries,
 * so callers must treat missing calls/results as unavailable, not absent.
 *
 * In the snapshot, tool inputs live on assistant `toolCall` blocks
 * ({ id, name, arguments }) and tool outputs live on `toolResult` messages
 * ({ toolCallId, toolName, content, isError }). Returns a plain object
 * { [toolCallId]: { name, input, output, isError } } or null when none found.
 */
export function extractToolIO(text) {
  const lines = text.split("\n");
  let snapshot;
  // Walk forward; keep the latest snapshot (cumulative, so last wins).
  for (const line of lines) {
    const obj = parseLine(line);
    if (obj?.type === "model.completed" && Array.isArray(obj?.data?.messagesSnapshot)) {
      snapshot = obj.data.messagesSnapshot;
    }
  }
  if (!snapshot) return null;

  const byId = {};
  const ensure = (id) => (byId[id] ??= {});
  for (const msg of snapshot) {
    if (!msg || typeof msg !== "object") continue;
    // Tool outputs: dedicated toolResult messages.
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
      const entry = ensure(msg.toolCallId);
      const out = contentToText(msg.content);
      if (out !== undefined) entry.output = out;
      if (typeof msg.toolName === "string") entry.name ??= msg.toolName;
      if (typeof msg.isError === "boolean") entry.isError = msg.isError;
      continue;
    }
    // Tool inputs: assistant toolCall content blocks.
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      const entry = ensure(block.id);
      if (typeof block.name === "string") entry.name = block.name;
      if (block.arguments !== undefined) {
        entry.input =
          typeof block.arguments === "string"
            ? block.arguments
            : JSON.stringify(block.arguments);
      }
    }
  }
  return Object.keys(byId).length > 0 ? byId : null;
}

/**
 * Pure: extract turn content from trajectory JSONL text. Returns
 * { input, output, sessionInput } where `input`/`output` are the latest turn
 * (for the generation) and `sessionInput` is the first prompt in the text (for
 * trace-level aggregation). Returns null when nothing usable is found.
 */
export function extractContent(text) {
  const lines = text.split("\n");
  let input;
  let output;
  let sessionInput;
  for (const line of lines) {
    const obj = parseLine(line);
    if (!obj) continue;
    const io = entryIO(obj);
    if (io.input !== undefined) {
      input = io.input;
      if (sessionInput === undefined) sessionInput = io.input;
    }
    if (io.output !== undefined) output = io.output;
  }
  if (input === undefined && output === undefined) return null;
  const out = {};
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (sessionInput !== undefined) out.sessionInput = sessionInput;
  return out;
}

/**
 * Resolve the active branch of a canonical session JSONL transcript. Session
 * rows form an id/parentId tree; following the newest leaf prevents abandoned
 * retry branches from being mixed into the current conversation. Windowed
 * reads may omit an older parent, in which case the available suffix is used.
 */
export function extractSessionMessages(text) {
  const rows = parsedLines(text);
  const messageRows = rows.filter((row) => {
    const msg = row?.message ?? row;
    return msg && typeof msg === "object" && typeof msg.role === "string";
  });
  if (messageRows.length === 0) return [];

  const byId = new Map();
  for (const row of messageRows) if (typeof row.id === "string") byId.set(row.id, row);
  if (byId.size === 0) return messageRows.map((row) => row?.message ?? row);

  const branch = [];
  const visited = new Set();
  let row = messageRows.at(-1);
  while (row && !visited.has(row)) {
    visited.add(row);
    branch.push(row?.message ?? row);
    row = typeof row.parentId === "string" ? byId.get(row.parentId) : undefined;
  }
  return branch.reverse();
}

/** Extract the latest user prompt and assistant answer from session JSONL. */
export function extractSessionContent(text) {
  const messages = extractSessionMessages(text);
  let input;
  let sessionInput;
  for (const msg of messages) {
    if (msg?.role !== "user") continue;
    const textValue = messageText(msg)?.trim();
    if (!textValue) continue;
    input = textValue;
    sessionInput ??= textValue;
  }
  const output = lastAssistantText(messages);
  if (input === undefined && output === undefined) return null;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(sessionInput !== undefined ? { sessionInput } : {}),
  };
}

/** Extract tool calls/results from canonical session JSONL, keyed by call id. */
export function extractSessionToolIO(text) {
  const messages = extractSessionMessages(text);
  const byId = {};
  const ensure = (id) => (byId[id] ??= {});
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const resultId = msg.toolCallId ?? msg.tool_call_id;
    if (
      (msg.role === "toolResult" || msg.role === "tool" || msg.type === "tool_result") &&
      typeof resultId === "string"
    ) {
      const entry = ensure(resultId);
      const output = contentToText(msg.content ?? msg.result);
      if (output !== undefined) entry.output = output;
      if (typeof msg.toolName === "string") entry.name ??= msg.toolName;
      if (typeof msg.name === "string") entry.name ??= msg.name;
      if (typeof msg.isError === "boolean") entry.isError = msg.isError;
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || !["toolCall", "tool_use"].includes(block.type)) continue;
      const id = block.id ?? block.toolCallId;
      if (typeof id !== "string") continue;
      const entry = ensure(id);
      if (typeof block.name === "string") entry.name = block.name;
      const args = block.arguments ?? block.input;
      if (args !== undefined) {
        entry.input = typeof args === "string" ? args : JSON.stringify(args);
      }
    }
  }
  return Object.keys(byId).length > 0 ? byId : null;
}

/** Read the trajectory text for an event's session (whole file, or tail window
 * for long sessions). Returns { tailText, headText } or null. Never throws. */
function readTrajectoryText(stateDir, evt, logger) {
  try {
    const sessionId = evt?.sessionId ?? evt?.sessionKey;
    if (!sessionId) return null;
    const file = trajectoryPath(stateDir, evt?.agentId, sessionId);
    const { size } = statSync(file);
    if (size <= MAX_READ_BYTES) {
      const whole = readFileSync(file, "utf8");
      return { tailText: whole, headText: whole };
    }
    return {
      tailText: readWindow(file, MAX_READ_BYTES, "tail"),
      headText: readWindow(file, HEAD_READ_BYTES, "head"),
    };
  } catch (err) {
    // File may not exist yet or be mid-write; this is best-effort.
    logger?.debug?.(
      `langfuse-bridge: could not read transcript (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }
}

function readSessionText(stateDir, evt, logger) {
  try {
    const sessionId = evt?.sessionId ?? evt?.sessionKey;
    if (!sessionId) return null;
    const file = sessionPath(stateDir, evt?.agentId, sessionId);
    return readWindow(file, MAX_READ_BYTES, "tail");
  } catch (err) {
    logger?.debug?.(
      `langfuse-bridge: could not read session fallback (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }
}

/**
 * Shared, bounded fallback cache. A run is parsed at most once across root,
 * generation, and tool enrichment. Canonical session JSONL wins; trajectory is
 * consulted only for fields absent from it and is never treated as complete.
 */
export function makeTranscriptResolvers(stateDir, logger, opts = {}) {
  const maxEntries = opts.maxEntries ?? 512;
  const includeTrajectory = opts.includeTrajectory !== false;
  const cache = new Map();

  function cacheKey(evt) {
    return (
      evt?.runId ??
      evt?.trace?.traceId ??
      `${evt?.agentId ?? "main"}:${evt?.sessionId ?? evt?.sessionKey ?? "unknown"}`
    );
  }

  function resolve(evt) {
    const key = cacheKey(evt);
    if (cache.has(key)) return cache.get(key);

    const sessionText = readSessionText(stateDir, evt, logger);
    let content = sessionText ? extractSessionContent(sessionText) : null;
    let toolIO = sessionText ? extractSessionToolIO(sessionText) : null;

    if (includeTrajectory && (!content || !toolIO)) {
      const trajectory = readTrajectoryText(stateDir, evt, logger);
      if (trajectory) {
        content ??= extractContent(trajectory.tailText);
        toolIO ??= extractToolIO(trajectory.tailText);
        if (content && trajectory.headText !== trajectory.tailText) {
          const head = extractContent(trajectory.headText);
          content = { ...content, sessionInput: head?.sessionInput ?? content.sessionInput };
        }
      }
    }

    const value = { content, toolIO };
    cache.set(key, value);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return value;
  }

  return {
    resolveContent: (evt) => resolve(evt).content,
    resolveToolIO: (evt) => resolve(evt).toolIO,
    clear: () => cache.clear(),
  };
}

/**
 * Build a content resolver bound to a state dir. Returns a function that reads
 * the session transcript and returns
 * { input, output, sessionInput } or null. Never throws.
 */
export function makeContentResolver(stateDir, logger) {
  return makeTranscriptResolvers(stateDir, logger).resolveContent;
}

/**
 * Build a tool-I/O resolver bound to a state dir. Returns a function that reads
 * the session transcript and returns the
 * per-tool I/O map { [toolCallId]: { name, input, output, isError } } or null.
 * latest active branch. Never throws.
 */
export function makeToolIOResolver(stateDir, logger) {
  return makeTranscriptResolvers(stateDir, logger).resolveToolIO;
}

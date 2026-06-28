// Best-effort capture of prompt/response content for a model.usage event.
//
// OpenClaw does not deliver prompt/completion text to third-party plugins (the
// `model.usage` diagnostic carries usage/cost only; message content is private
// data handed exclusively to bundled diagnostics services). To still populate
// the Langfuse generation's input/output, we read OpenClaw's per-session
// trajectory transcript, which records each turn's `model.completed` entry with
// `finalPromptText` (input) and `assistantTexts` (output).
//
// This is intentionally best-effort: any failure (file missing, not yet
// flushed, format change) returns null and never blocks usage forwarding.

import { openSync, readSync, readFileSync, statSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
 * Build a content resolver bound to a state dir. Returns a function that, given
 * a model.usage event, reads the session transcript and returns
 * { input, output, sessionInput } or null. Never throws.
 */
export function makeContentResolver(stateDir, logger) {
  return (evt) => {
    try {
      const sessionId = evt?.sessionId ?? evt?.sessionKey;
      if (!sessionId) return null;
      const file = trajectoryPath(stateDir, evt?.agentId, sessionId);
      const { size } = statSync(file);
      if (size <= MAX_READ_BYTES) {
        // Whole file: one pass yields current turn + true first prompt.
        return extractContent(readFileSync(file, "utf8"));
      }
      // Long session: take current turn from the tail, first prompt from the head.
      const tail = extractContent(readWindow(file, MAX_READ_BYTES, "tail"));
      if (!tail) return null;
      const head = extractContent(readWindow(file, HEAD_READ_BYTES, "head"));
      return { ...tail, sessionInput: head?.sessionInput ?? tail.input };
    } catch (err) {
      // File may not exist yet or be mid-write; this is best-effort.
      logger?.debug?.(
        `langfuse-bridge: could not read transcript content (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
  };
}

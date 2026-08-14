import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractSessionContent,
  extractSessionMessages,
  extractSessionToolIO,
  makeTranscriptResolvers,
  sessionPath,
} from "./transcript.js";

function sessionRows(messageCount = 70) {
  const rows = [];
  let parentId;
  const push = (message) => {
    const id = `row-${rows.length + 1}`;
    rows.push({ id, ...(parentId ? { parentId } : {}), message });
    parentId = id;
  };
  for (let i = 0; i < messageCount; i += 1) {
    push({ role: "user", content: `prompt ${i}` });
    push({ role: "assistant", content: `answer ${i}` });
  }
  push({
    role: "assistant",
    content: [{ type: "toolCall", id: "tc-new", name: "search", arguments: { q: "latest" } }],
  });
  push({
    role: "toolResult",
    toolCallId: "tc-new",
    toolName: "search",
    content: [{ type: "text", text: "latest result" }],
    isError: false,
  });
  push({ role: "assistant", content: "final answer after tool" });
  return rows;
}

test("canonical session JSONL preserves latest I/O beyond 64 messages", () => {
  const text = `${sessionRows().map((row) => JSON.stringify(row)).join("\n")}\n`;
  assert.deepEqual(extractSessionContent(text), {
    input: "prompt 69",
    output: "final answer after tool",
    sessionInput: "prompt 0",
  });
  assert.deepEqual(extractSessionToolIO(text), {
    "tc-new": {
      name: "search",
      input: '{"q":"latest"}',
      output: "latest result",
      isError: false,
    },
  });
});

test("session parser follows the newest id/parentId branch", () => {
  const rows = [
    { id: "u", message: { role: "user", content: "question" } },
    { id: "abandoned", parentId: "u", message: { role: "assistant", content: "abandoned" } },
    { id: "retry", parentId: "u", message: { role: "assistant", content: "accepted" } },
  ];
  const messages = extractSessionMessages(rows.map(JSON.stringify).join("\n"));
  assert.deepEqual(messages.map((message) => message.content), ["question", "accepted"]);
});

test("session parser tolerates a partial JSONL line", () => {
  const text = [
    JSON.stringify({ id: "u", message: { role: "user", content: "complete" } }),
    '{"id":"partial","parentId":"u","message":',
  ].join("\n");
  assert.deepEqual(extractSessionContent(text), {
    input: "complete",
    sessionInput: "complete",
  });
});

test("shared transcript fallback parses each run once", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "langfuse-transcript-"));
  try {
    const file = sessionPath(stateDir, "main", "session-1");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${sessionRows(1).map(JSON.stringify).join("\n")}\n`);
    const resolvers = makeTranscriptResolvers(stateDir, undefined, { includeTrajectory: false });
    const evt = { runId: "run-1", agentId: "main", sessionId: "session-1" };

    assert.equal(resolvers.resolveContent(evt).input, "prompt 0");
    writeFileSync(
      file,
      `${JSON.stringify({ id: "new", message: { role: "user", content: "changed on disk" } })}\n`,
    );
    assert.ok(resolvers.resolveToolIO(evt)["tc-new"], "same run uses the cached parse");
    assert.equal(
      resolvers.resolveContent({ ...evt, runId: "run-2" }).input,
      "changed on disk",
      "a different run may parse the session again",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

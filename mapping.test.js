import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compact,
  classifyToolType,
  usageDetails,
  toolAttributes,
  contextSummary,
  errorAttributes,
  sanitizeContent,
  lastAssistantText,
} from "./mapping.js";

test("compact drops undefined and null", () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: 0, e: "" }), {
    a: 1,
    d: 0,
    e: "",
  });
});

test("classifyToolType: retrieval/search tools become retriever", () => {
  for (const name of [
    "vector_search",
    "rag",
    "semantic_lookup",
    "knowledge_base",
    "web_fetch",
    "grep",
    "memory_recall",
  ]) {
    assert.equal(classifyToolType(name), "retriever", name);
  }
  for (const name of ["edit", "bash", "write_file", "send_message", undefined]) {
    assert.equal(classifyToolType(name), "tool", String(name));
  }
});

test("usageDetails maps OpenClaw usage to snake_case, dropping empties", () => {
  assert.deepEqual(
    usageDetails({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 }),
    { input: 10, output: 5, cache_read: 2, cache_write: 1, total: 18 },
  );
  assert.deepEqual(usageDetails({ input: 3 }), { input: 3 });
  assert.deepEqual(usageDetails(), {});
});

test("toolAttributes carries source/owner/paramsSummary", () => {
  const attrs = toolAttributes({
    toolSource: "mcp",
    toolOwner: "my-server",
    toolCallId: "tc1",
    paramsSummary: { kind: "object" },
  });
  assert.equal(attrs.metadata.toolSource, "mcp");
  assert.deepEqual(attrs.metadata.paramsSummary, { kind: "object" });
});

test("contextSummary formats present size fields and skips missing ones", () => {
  assert.equal(
    contextSummary({ messageCount: 5, promptChars: 64, systemPromptChars: 30753, contextTokenBudget: 1048576 }),
    "messages=5 · promptChars=64 · systemPromptChars=30753 · tokenBudget=1048576",
  );
  assert.equal(contextSummary({ messageCount: 0 }), "messages=0");
  assert.equal(contextSummary({}), undefined);
});

test("errorAttributes sets ERROR level + status from category/kind/denied", () => {
  assert.equal(errorAttributes({ errorCategory: "timeout" }).level, "ERROR");
  assert.equal(errorAttributes({ errorCategory: "timeout" }).statusMessage, "timeout");
  assert.equal(errorAttributes({ deniedReason: "policy" }).statusMessage, "policy");
});

test("sanitizeContent redacts credentials, omits images/binary, and does not mutate", () => {
  const original = {
    token: "super-secret-token",
    headers: { Authorization: "Bearer abcdefghijklmnop" },
    prompt: "use api_key=abcdefghijklmnop",
    image: `data:image/png;base64,${"A".repeat(1024)}`,
    bytes: Buffer.from("secret bytes"),
  };
  const sanitized = sanitizeContent(original, 10_000);
  assert.equal(sanitized.token, "[REDACTED]");
  assert.equal(sanitized.headers.Authorization, "[REDACTED]");
  assert.match(sanitized.prompt, /\[REDACTED\]/);
  assert.equal(sanitized.image, "[OMITTED_IMAGE]");
  assert.match(sanitized.bytes, /OMITTED_BINARY/);
  assert.equal(original.token, "super-secret-token");
});

test("sanitizeContent enforces the configured byte bound", () => {
  const sanitized = sanitizeContent("long content: ".repeat(1000), 512);
  assert.ok(Buffer.byteLength(sanitized, "utf8") <= 512);
  assert.match(sanitized, /TRUNCATED/);
});

test("lastAssistantText ignores tool-only blocks and unwraps message rows", () => {
  assert.equal(
    lastAssistantText([
      { role: "assistant", content: [{ type: "toolCall", id: "x" }] },
      { message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    ]),
    "answer",
  );
});

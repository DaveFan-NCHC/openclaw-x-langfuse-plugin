import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, handleEvent } from "./mapping.js";

/** Fake Langfuse client that records trace()/generation()/event() calls. */
function fakeLangfuse() {
  const traces = [];
  return {
    traces,
    trace(args) {
      const generations = [];
      const events = [];
      traces.push({ args, generations, events });
      return {
        generation: (g) => generations.push(g),
        event: (e) => events.push(e),
      };
    },
  };
}

test("compact drops undefined and null", () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: 0, e: "" }), {
    a: 1,
    d: 0,
    e: "",
  });
});

test("model.usage maps to a Langfuse generation with usage + cost", () => {
  const lf = fakeLangfuse();
  const evt = {
    type: "model.usage",
    ts: 1_700_000_000_000,
    seq: 1,
    sessionId: "sess-abc",
    channel: "imessage",
    agentId: "agent-1",
    provider: "anthropic",
    model: "claude-opus-4-8",
    usage: {
      input: 1200,
      output: 340,
      cacheRead: 50,
      cacheWrite: 10,
      promptTokens: 1250,
      total: 1540,
    },
    context: { limit: 200000, used: 1540 },
    costUsd: 0.0123,
    durationMs: 4200,
  };

  const handled = handleEvent(lf, evt, console);
  assert.equal(handled, true);
  assert.equal(lf.traces.length, 1);

  const trace = lf.traces[0];
  assert.equal(trace.args.id, "sess-abc");
  assert.equal(trace.args.sessionId, "sess-abc");
  assert.equal(trace.args.name, "imessage");
  assert.deepEqual(trace.args.metadata, {
    channel: "imessage",
    agentId: "agent-1",
    provider: "anthropic",
  });

  assert.equal(trace.generations.length, 1);
  const gen = trace.generations[0];
  assert.equal(gen.name, "claude-opus-4-8");
  assert.equal(gen.model, "claude-opus-4-8");
  assert.deepEqual(gen.usageDetails, {
    input: 1200,
    output: 340,
    cache_read: 50,
    cache_write: 10,
    total: 1540,
  });
  assert.deepEqual(gen.costDetails, { total: 0.0123 });
  assert.ok(gen.startTime instanceof Date);
  assert.equal(gen.startTime.getTime(), 1_700_000_000_000);
  assert.equal(gen.endTime.getTime(), 1_700_000_000_000 + 4200);
  assert.equal(gen.metadata.contextLimit, 200000);
  assert.equal(gen.metadata.promptTokens, 1250);
});

test("model.usage falls back to sessionKey and tolerates missing fields", () => {
  const lf = fakeLangfuse();
  const evt = {
    type: "model.usage",
    sessionKey: "key-xyz",
    usage: { input: 5, output: 7 },
  };
  assert.equal(handleEvent(lf, evt, console), true);
  const trace = lf.traces[0];
  assert.equal(trace.args.id, "key-xyz");
  assert.equal(trace.args.name, "openclaw");
  const gen = trace.generations[0];
  assert.equal(gen.name, "model.usage");
  assert.equal("model" in gen, false); // undefined model dropped
  assert.equal("costDetails" in gen, false); // no cost -> omitted
  assert.equal("startTime" in gen, false); // no ts -> omitted
  assert.deepEqual(gen.usageDetails, { input: 5, output: 7 });
});

test("model.call.error maps to a Langfuse error event", () => {
  const lf = fakeLangfuse();
  const evt = {
    type: "model.call.error",
    ts: 1_700_000_000_000,
    sessionId: "sess-err",
    provider: "openai",
    model: "gpt-x",
    errorCategory: "timeout",
    failureKind: "timeout",
    durationMs: 30000,
    callId: "call-9",
    runId: "run-9",
  };
  assert.equal(handleEvent(lf, evt, console), true);
  const trace = lf.traces[0];
  assert.equal(trace.events.length, 1);
  const e = trace.events[0];
  assert.equal(e.name, "model.call.error");
  assert.equal(e.level, "ERROR");
  assert.equal(e.statusMessage, "timeout");
  assert.equal(e.metadata.errorCategory, "timeout");
  assert.equal(e.metadata.callId, "call-9");
});

test("unknown event types are ignored", () => {
  const lf = fakeLangfuse();
  assert.equal(handleEvent(lf, { type: "webhook.received" }, console), false);
  assert.equal(handleEvent(lf, undefined, console), false);
  assert.equal(lf.traces.length, 0);
});

test("handler never throws on malformed events", () => {
  const lf = {
    trace() {
      throw new Error("boom");
    },
  };
  // Should be caught internally and reported via logger, not thrown.
  let logged = "";
  const logger = { error: (m) => (logged = m) };
  assert.equal(handleEvent(lf, { type: "model.usage" }, logger), false);
  assert.match(logged, /handler failed/);
});

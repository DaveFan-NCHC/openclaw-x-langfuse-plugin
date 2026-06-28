import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, handleEvent } from "./mapping.js";
import { extractContent, trajectoryPath } from "./transcript.js";

/**
 * Fake tracing surface mirroring the injected @langfuse/tracing helper.
 * Records startObservation calls — including the root OTel span attributes set
 * via `otelSpan.setAttribute` — so the mapping can be asserted without a real
 * OTel provider.
 */
function fakeTracing() {
  const observations = [];
  return {
    observations,
    startObservation(name, attributes, opts) {
      const spanAttrs = {};
      const obs = {
        name,
        attributes,
        opts,
        spanAttrs,
        traceIO: undefined,
        ended: false,
        endTime: undefined,
        otelSpan: {
          setAttribute(k, v) {
            spanAttrs[k] = v;
          },
        },
      };
      observations.push(obs);
      return {
        otelSpan: obs.otelSpan,
        setTraceIO(io) {
          obs.traceIO = io;
          return this;
        },
        update(u) {
          Object.assign(obs.attributes, u);
          return this;
        },
        end(t) {
          obs.ended = true;
          obs.endTime = t;
        },
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
  const t = fakeTracing();
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

  assert.equal(handleEvent(t, evt, console), true);
  assert.equal(t.observations.length, 1);
  const gen = t.observations[0];

  assert.equal(gen.opts.asType, "generation");
  assert.equal("parentSpanContext" in gen.opts, false); // root span -> own trace
  // trace-level fields set straight on the root span
  assert.equal(gen.spanAttrs["langfuse.trace.name"], "imessage");
  assert.equal(gen.spanAttrs["session.id"], "sess-abc");

  assert.equal(gen.name, "claude-opus-4-8");
  assert.equal(gen.attributes.model, "claude-opus-4-8");
  assert.deepEqual(gen.attributes.usageDetails, {
    input: 1200,
    output: 340,
    cache_read: 50,
    cache_write: 10,
    total: 1540,
  });
  assert.deepEqual(gen.attributes.costDetails, { totalCost: 0.0123 });
  assert.ok(gen.opts.startTime instanceof Date);
  assert.equal(gen.opts.startTime.getTime(), 1_700_000_000_000);
  assert.ok(gen.endTime instanceof Date);
  assert.equal(gen.endTime.getTime(), 1_700_000_000_000 + 4200);
  assert.equal(gen.attributes.metadata.contextLimit, 200000);
  assert.equal(gen.attributes.metadata.promptTokens, 1250);
  assert.equal(gen.ended, true);
});

test("model.usage falls back to sessionKey and tolerates missing fields", () => {
  const t = fakeTracing();
  const evt = {
    type: "model.usage",
    sessionKey: "key-xyz",
    usage: { input: 5, output: 7 },
  };
  assert.equal(handleEvent(t, evt, console), true);
  const gen = t.observations[0];
  assert.equal(gen.spanAttrs["session.id"], "key-xyz");
  assert.equal(gen.spanAttrs["langfuse.trace.name"], "openclaw");
  assert.equal(gen.name, "model.usage");
  assert.equal("model" in gen.attributes, false); // undefined model dropped
  assert.equal("costDetails" in gen.attributes, false); // no cost -> omitted
  assert.equal("startTime" in gen.opts, false); // no ts -> omitted
  assert.deepEqual(gen.attributes.usageDetails, { input: 5, output: 7 });
});

test("model.call.error maps to an ERROR observation", () => {
  const t = fakeTracing();
  const evt = {
    type: "model.call.error",
    ts: 1_700_000_000_000,
    sessionId: "sess-err",
    channel: "telegram",
    provider: "openai",
    model: "gpt-x",
    errorCategory: "timeout",
    failureKind: "timeout",
    durationMs: 30000,
    callId: "call-9",
    runId: "run-9",
  };
  assert.equal(handleEvent(t, evt, console), true);
  assert.equal(t.observations.length, 1);
  const e = t.observations[0];
  assert.equal(e.name, "model.call.error");
  assert.equal(e.opts.asType, "span");
  assert.equal(e.attributes.level, "ERROR");
  assert.equal(e.attributes.statusMessage, "timeout");
  assert.equal(e.attributes.metadata.errorCategory, "timeout");
  assert.equal(e.attributes.metadata.callId, "call-9");
  assert.equal(e.spanAttrs["langfuse.trace.name"], "telegram");
  assert.equal(e.spanAttrs["session.id"], "sess-err");
  assert.equal(e.ended, true);
});

test("unknown event types are ignored", () => {
  const t = fakeTracing();
  assert.equal(handleEvent(t, { type: "webhook.received" }, console), false);
  assert.equal(handleEvent(t, undefined, console), false);
  assert.equal(t.observations.length, 0);
});

test("model.usage attaches resolved input/output content to the generation", () => {
  const t = fakeTracing();
  const evt = {
    type: "model.usage",
    sessionId: "sess-content",
    model: "claude-opus-4-8",
    usage: { input: 1, output: 2 },
  };
  const resolveContent = (e) => {
    assert.equal(e.sessionId, "sess-content");
    return { input: "what is 2+2?", output: "4", sessionInput: "hello" };
  };
  assert.equal(handleEvent(t, evt, console, resolveContent), true);
  const gen = t.observations[0];
  // Generation carries the turn IO; the trace mirrors it (root span).
  assert.equal(gen.attributes.input, "what is 2+2?");
  assert.equal(gen.attributes.output, "4");
  assert.deepEqual(gen.traceIO, { input: "what is 2+2?", output: "4" });
});

test("trace IO mirrors the turn input/output", () => {
  const t = fakeTracing();
  const evt = { type: "model.usage", sessionId: "s", usage: { input: 1 } };
  handleEvent(t, evt, console, () => ({ input: "q", output: "a" }));
  assert.deepEqual(t.observations[0].traceIO, { input: "q", output: "a" });
});

test("model.usage omits input/output when no resolver / no content", () => {
  const t = fakeTracing();
  const evt = { type: "model.usage", sessionId: "s", usage: { input: 1 } };
  handleEvent(t, evt, console); // no resolver
  const gen = t.observations[0];
  assert.equal("input" in gen.attributes, false);
  assert.equal("output" in gen.attributes, false);
  assert.equal(gen.traceIO, undefined); // setTraceIO not called when no content
});

test("content resolver failures never break usage forwarding", () => {
  const t = fakeTracing();
  const evt = { type: "model.usage", sessionId: "s", usage: { input: 1 } };
  const boom = () => {
    throw new Error("transcript read failed");
  };
  assert.equal(handleEvent(t, evt, console, boom), true);
  const gen = t.observations[0];
  assert.deepEqual(gen.attributes.usageDetails, { input: 1 });
  assert.equal("input" in gen.attributes, false);
});

test("extractContent reads the last model.completed turn", () => {
  const text = [
    JSON.stringify({ type: "prompt.submitted", data: { prompt: "old prompt" } }),
    JSON.stringify({
      type: "model.completed",
      data: { finalPromptText: "old prompt", assistantTexts: ["old answer"] },
    }),
    JSON.stringify({ type: "prompt.submitted", data: { prompt: "new prompt" } }),
    JSON.stringify({
      type: "model.completed",
      data: { finalPromptText: "new prompt", assistantTexts: ["line1", "line2"] },
    }),
    "", // trailing newline
  ].join("\n");
  assert.deepEqual(extractContent(text), {
    input: "new prompt",
    output: "line1\nline2",
    sessionInput: "old prompt", // first prompt in the session
  });
});

test("extractContent tolerates a truncated leading line and falls back to prompt.submitted", () => {
  const text = [
    '{"type":"model.compl', // truncated (windowed read) -> skipped
    JSON.stringify({ type: "prompt.submitted", data: { prompt: "only prompt" } }),
  ].join("\n");
  assert.deepEqual(extractContent(text), {
    input: "only prompt",
    sessionInput: "only prompt",
  });
});

test("extractContent returns null when nothing usable", () => {
  assert.equal(extractContent("\n\nnot json\n"), null);
});

test("trajectoryPath builds <stateDir>/agents/<agentId>/sessions/<id>.trajectory.jsonl", () => {
  assert.equal(
    trajectoryPath("/state", "main", "abc"),
    "/state/agents/main/sessions/abc.trajectory.jsonl",
  );
  assert.equal(
    trajectoryPath("/state", undefined, "abc"),
    "/state/agents/main/sessions/abc.trajectory.jsonl",
  );
});

test("handler never throws on malformed events", () => {
  const t = fakeTracing();
  // Force startObservation to throw; handleEvent should catch + log, not throw.
  t.startObservation = () => {
    throw new Error("boom");
  };
  let logged = "";
  const logger = { error: (m) => (logged = m) };
  assert.equal(handleEvent(t, { type: "model.usage" }, logger), false);
  assert.match(logged, /handler failed/);
});

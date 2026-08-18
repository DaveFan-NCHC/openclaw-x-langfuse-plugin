import { test } from "node:test";
import assert from "node:assert/strict";
import { createTraceEngine } from "./tracer.js";

/**
 * Fake tracing surface that records a full observation tree. Each observation
 * supports the methods the engine uses: child `startObservation`, `update`,
 * `setTraceIO`, `end`, and `otelSpan.setAttribute`. `all` holds every created
 * observation with `parent`/`children` links so the tree can be asserted.
 */
function fakeTracing() {
  const all = [];
  function make(name, attributes, opts, parent) {
    const spanAttrs = {};
    const node = {
      name,
      attributes: { ...attributes },
      opts: opts ?? {},
      parent,
      children: [],
      spanAttrs,
      traceIO: undefined,
      ended: false,
      endCalls: 0,
      endTime: undefined,
      ignoredUpdates: [],
    };
    all.push(node);
    const handle = {
      otelSpan: {
        setAttribute(k, v) {
          if (node.ended) {
            node.ignoredUpdates.push({ [k]: v });
            return;
          }
          spanAttrs[k] = v;
        },
      },
      startObservation(n, a, o) {
        const child = make(n, a, o, node);
        node.children.push(child);
        return child.handle;
      },
      update(u) {
        if (node.ended) {
          node.ignoredUpdates.push(u);
          return handle;
        }
        // Mirror the real SDK: metadata merges additively across updates; other
        // attributes (including name) overwrite.
        const { metadata, ...rest } = u ?? {};
        Object.assign(node.attributes, rest);
        if (rest.name !== undefined) node.name = rest.name;
        if (metadata) node.attributes.metadata = { ...node.attributes.metadata, ...metadata };
        return handle;
      },
      setTraceIO(io) {
        if (node.ended) {
          node.ignoredUpdates.push({ traceIO: io });
          return handle;
        }
        node.traceIO = io;
        return handle;
      },
      end(t) {
        node.endCalls += 1;
        if (node.ended) return;
        node.ended = true;
        node.endTime = t;
      },
    };
    node.handle = handle;
    return node;
  }
  return {
    all,
    roots: () => all.filter((n) => n.parent === null),
    byName: (n) => all.find((o) => o.name === n),
    startObservation(name, attrs, opts) {
      return make(name, attrs, opts, null).handle;
    },
  };
}

/** Build an engine whose deferred finalize is captured so tests can run it
 * explicitly (mirrors setImmediate firing after the synchronous event burst). */
function makeEngine(t, opts = {}) {
  const deferred = [];
  const engine = createTraceEngine(t, { defer: (fn) => deferred.push(fn), ...opts });
  const flushDeferred = () => {
    while (deferred.length) deferred.shift()();
  };
  return {
    engine,
    flushDeferred,
    feed(events) {
      for (const e of events) engine.handle(e);
      flushDeferred(); // run safety-net finalizers
    },
  };
}

// A full webchat turn, modeled on a real capture: every event shares one W3C
// traceId; model.usage has no runId, arrives AFTER run.completed, and hangs off
// the harness span (not the run). Tool args/results land in the trajectory only
// at turn end, so the tool's I/O is resolved at model.usage/finalize time.
const TRACE = "c09b6e7a5c25";
function runSequence() {
  return [
    { type: "run.started", ts: 1000, runId: "r1", sessionId: "s1", channel: "webchat", trace: { traceId: TRACE, spanId: "RUN", parentSpanId: "HARNESS" } },
    { type: "context.assembled", ts: 1010, runId: "r1", messageCount: 5, channel: "webchat", trace: { traceId: TRACE, spanId: "CTX", parentSpanId: "RUN" } },
    { type: "tool.execution.started", ts: 1100, runId: "r1", toolName: "web_search", toolCallId: "tc1", toolSource: "core", trace: { traceId: TRACE, spanId: "T1", parentSpanId: "RUN" } },
    { type: "tool.execution.completed", ts: 1200, runId: "r1", toolName: "web_search", toolCallId: "tc1", durationMs: 100, trace: { traceId: TRACE, spanId: "T1", parentSpanId: "RUN" } },
    { type: "run.completed", ts: 1400, runId: "r1", sessionId: "s1", channel: "webchat", durationMs: 400, outcome: "completed", trace: { traceId: TRACE, spanId: "RUN", parentSpanId: "HARNESS" } },
    { type: "model.usage", ts: 1410, durationMs: 400, sessionId: "s1", agentId: "main", channel: "webchat", model: "claude-opus-4-8", provider: "anthropic", usage: { input: 100, output: 50, total: 150 }, costUsd: 0.002, trace: { traceId: TRACE, spanId: "USAGE", parentSpanId: "HARNESS" } },
  ];
}

const ioResolver = () => ({
  tc1: { name: "web_search", input: '{"q":"x"}', output: "result text", isError: false },
});

test("run.completed finalizes with conversation hooks enabled when agent_end is missing", () => {
  const t = fakeTracing();
  const { engine, flushDeferred } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "r-no-end", sessionId: "s-no-end", trace: { traceId: "T-NO-END" } };

  engine.handle({ type: "run.started", ts: 10, ...ctx });
  engine.handle({ type: "run.completed", ts: 20, outcome: "completed", ...ctx });
  assert.equal(t.roots()[0].ended, false, "finalization remains deferred");

  flushDeferred();
  assert.equal(t.roots()[0].ended, true);
  assert.equal(t.roots()[0].endCalls, 1);
});

test("agent_end before run.completed preserves I/O and finalizes only once", () => {
  const t = fakeTracing();
  const { engine, flushDeferred } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "r-agent-first", sessionId: "s-agent-first", trace: { traceId: "T-AGENT-FIRST" } };

  engine.handleHook("before_agent_run", { prompt: "question", messages: [] }, ctx);
  engine.handleHook(
    "agent_end",
    { success: true, messages: [{ role: "assistant", content: "answer" }] },
    ctx,
  );
  assert.equal(t.roots()[0].ended, false, "agent_end does not own run completion");

  engine.handle({ type: "run.completed", ts: 20, outcome: "completed", ...ctx });
  flushDeferred();

  assert.deepEqual(t.roots()[0].traceIO, { input: "question", output: "answer" });
  assert.equal(t.roots()[0].endCalls, 1);
});

test("agent_end in the run.completed deferred window preserves I/O and finalizes only once", () => {
  const t = fakeTracing();
  const { engine, flushDeferred } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "r-run-first", sessionId: "s-run-first", trace: { traceId: "T-RUN-FIRST" } };

  engine.handleHook("before_agent_run", { prompt: "question", messages: [] }, ctx);
  engine.handle({ type: "run.completed", ts: 20, outcome: "completed", ...ctx });
  engine.handleHook(
    "agent_end",
    { success: true, messages: [{ role: "assistant", content: "answer" }] },
    ctx,
  );
  flushDeferred();

  assert.deepEqual(t.roots()[0].traceIO, { input: "question", output: "answer" });
  assert.equal(t.roots()[0].endCalls, 1);
});

test("run.completed keeps its existing finalize behavior when conversation hooks are disabled", () => {
  const t = fakeTracing();
  const { engine, flushDeferred } = makeEngine(t, { conversationHooksEnabled: false });
  const ctx = { runId: "r-disabled", sessionId: "s-disabled", trace: { traceId: "T-DISABLED" } };

  engine.handle({ type: "run.started", ts: 10, ...ctx });
  engine.handle({ type: "run.completed", ts: 20, outcome: "completed", ...ctx });
  flushDeferred();

  assert.equal(t.roots()[0].ended, true);
  assert.equal(t.roots()[0].endCalls, 1);
});

test("a normally completed trace finalizes before any TTL sweep", () => {
  let clock = 1_000;
  const t = fakeTracing();
  const { engine, flushDeferred } = makeEngine(t, {
    conversationHooksEnabled: true,
    now: () => clock,
    ttlMs: 5 * 60_000,
  });
  const ctx = { runId: "r-no-sweep", sessionId: "s-no-sweep", trace: { traceId: "T-NO-SWEEP" } };

  engine.handle({ type: "run.started", ts: clock, ...ctx });
  engine.handle({ type: "run.completed", ts: clock + 10, outcome: "completed", ...ctx });
  flushDeferred();

  assert.equal(t.roots()[0].ended, true, "deferred completion does not wait for the TTL reaper");
  clock += 5 * 60_000;
  engine.sweep();
  assert.equal(t.roots()[0].endCalls, 1, "a later sweep cannot finalize the root again");
});

test("a full turn builds one trace with everything under a single root", () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {
    resolveContent: () => ({ input: "q", output: "a", sessionInput: "q" }),
    resolveToolIO: ioResolver,
  });
  feed(runSequence());

  const roots = t.roots();
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.equal(root.opts.asType, "agent");
  assert.equal(root.name, "webchat");
  assert.equal(root.spanAttrs["langfuse.trace.name"], "webchat");
  assert.equal(root.spanAttrs["session.id"], "s1");
  assert.equal(root.ended, true);
  assert.deepEqual(root.traceIO, { input: "q", output: "a" });

  const kinds = root.children.map((c) => c.opts.asType).sort();
  assert.deepEqual(kinds, ["generation", "retriever", "span"]);
  for (const c of root.children) assert.equal(c.parent, root);

  // context.assembled carries a readable size summary instead of blank I/O.
  const ctx = t.byName("context.assembled");
  assert.equal(ctx.attributes.output, "messages=5");
});

test("the generation (model.usage, post-run.completed) nests under the run's trace", () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {
    resolveContent: () => ({ input: "q", output: "a", sessionInput: "q" }),
  });
  feed(runSequence());

  assert.equal(t.roots().length, 1); // not orphaned into its own trace
  const gens = t.all.filter((o) => o.opts.asType === "generation");
  assert.equal(gens.length, 1);
  const gen = gens[0];
  assert.equal(gen.parent, t.roots()[0]); // <- the bug this fixes
  assert.equal(gen.attributes.model, "claude-opus-4-8");
  assert.deepEqual(gen.attributes.usageDetails, { input: 100, output: 50, total: 150 });
  assert.deepEqual(gen.attributes.costDetails, { totalCost: 0.002 });
  assert.equal(gen.attributes.input, "q");
  assert.equal(gen.opts.startTime.getTime(), 1010);
  assert.equal(gen.endTime.getTime(), 1410);
  assert.equal(gen.ended, true);
});

test("tool I/O is enriched from the trajectory at finalize, not at tool-terminal", () => {
  const t = fakeTracing();
  let calledAtTerminal = false;
  const { engine, feed } = makeEngine(t, {
    resolveToolIO: () => {
      // The real bug: at tool.execution.completed the trajectory isn't written
      // yet. Assert we don't end the tool with empty I/O before finalize.
      return ioResolver();
    },
  });
  // Feed everything up to (but not including) model.usage / finalize.
  const seq = runSequence();
  const beforeUsage = seq.slice(0, seq.indexOf(seq.find((e) => e.type === "model.usage")));
  for (const e of beforeUsage) engine.handle(e);
  const retr = t.all.find((o) => o.opts.asType === "retriever");
  assert.ok(retr, "retriever created on tool.execution.started");
  assert.equal(retr.ended, false, "tool stays OPEN until the trajectory is written");
  assert.equal(retr.attributes.input, undefined, "no premature empty I/O");

  // Now finalize via model.usage.
  feed(seq);
  assert.equal(retr.ended, true);
  assert.equal(retr.attributes.input, '{"q":"x"}');
  assert.equal(retr.attributes.output, "result text");
  assert.ok(!calledAtTerminal);
});

test("RAG/search tools become retriever observations", () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, { resolveToolIO: ioResolver });
  feed(runSequence());
  const ret = t.all.find((o) => o.opts.asType === "retriever");
  assert.ok(ret);
  assert.equal(ret.name, "web_search");
  assert.equal(ret.attributes.metadata.toolSource, "core");
  assert.equal(ret.parent, t.roots()[0]);
});

test("non-search tools become tool observations", () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {});
  feed([
    { type: "run.started", ts: 1, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "tt", spanId: "RUN" } },
    { type: "tool.execution.started", ts: 2, runId: "r1", toolName: "edit", toolCallId: "tcE", trace: { traceId: "tt", spanId: "TE", parentSpanId: "RUN" } },
    { type: "tool.execution.completed", ts: 3, runId: "r1", toolName: "edit", toolCallId: "tcE", durationMs: 1, trace: { traceId: "tt", spanId: "TE", parentSpanId: "RUN" } },
    { type: "run.completed", ts: 4, runId: "r1", sessionId: "s", channel: "webchat", outcome: "completed", trace: { traceId: "tt", spanId: "RUN" } },
  ]);
  const edit = t.byName("edit");
  assert.equal(edit.opts.asType, "tool");
  assert.equal(edit.parent, t.roots()[0]);
  assert.equal(edit.ended, true); // ended by the deferred finalize
});

test("events sharing a traceId join one trace even with no run.started", () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, {});
  feed([
    { type: "tool.execution.started", ts: 10, runId: "r1", toolName: "web_search", toolCallId: "tc", channel: "webchat", trace: { traceId: "T", spanId: "TE", parentSpanId: "RUN" } },
    { type: "tool.execution.completed", ts: 20, runId: "r1", toolName: "web_search", toolCallId: "tc", durationMs: 10, trace: { traceId: "T", spanId: "TE", parentSpanId: "RUN" } },
    { type: "model.usage", ts: 30, sessionId: "s", channel: "webchat", model: "m", usage: { input: 1, output: 2 }, trace: { traceId: "T", spanId: "U", parentSpanId: "HARNESS" } },
  ]);
  const roots = t.roots();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, "webchat");
  const kinds = roots[0].children.map((c) => c.opts.asType).sort();
  assert.deepEqual(kinds, ["generation", "retriever"]);
});

test("an orphan tool.execution.completed (no run) synthesizes and ends a span", () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, { resolveToolIO: () => ({ x: { input: "i", output: "o" } }) });
  feed([{ type: "tool.execution.completed", ts: 500, toolName: "search_web", toolCallId: "x", durationMs: 40 }]);
  const ret = t.byName("search_web");
  assert.ok(ret);
  assert.equal(ret.opts.asType, "retriever");
  assert.equal(ret.ended, true); // no trace to wait on -> enriched + ended now
  assert.equal(ret.attributes.input, "i");
  assert.equal(ret.opts.startTime.getTime(), 500 - 40);
});

test("model.usage with no traceId falls back to a standalone generation root", () => {
  const t = fakeTracing();
  const { feed } = makeEngine(t, { resolveContent: () => ({ input: "hi", output: "yo" }) });
  feed([{ type: "model.usage", ts: 700, sessionId: "sX", model: "m", usage: { input: 1, output: 2 } }]);
  const roots = t.roots();
  assert.equal(roots.length, 1);
  const gen = roots[0];
  assert.equal(gen.opts.asType, "generation");
  assert.equal(gen.spanAttrs["session.id"], "sX");
  assert.deepEqual(gen.traceIO, { input: "hi", output: "yo" });
  assert.equal(gen.ended, true);
});

test("the reaper finalizes/ends observations idle past the TTL", () => {
  let clock = 0;
  const t = fakeTracing();
  const engine = createTraceEngine(t, { now: () => clock, ttlMs: 1000, defer: () => {} });
  engine.handle({ type: "run.started", ts: 0, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "T", spanId: "RUN" } });
  engine.handle({ type: "tool.execution.started", ts: 1, runId: "r1", toolName: "edit", toolCallId: "tc", trace: { traceId: "T", spanId: "TE", parentSpanId: "RUN" } });
  const root = t.roots()[0];
  assert.equal(root.ended, false);
  clock = 2000;
  engine.sweep();
  assert.equal(root.ended, true);
  assert.equal(t.byName("edit").ended, true);
});

test("flushAll ends every live observation", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, { defer: () => {} });
  engine.handle({ type: "run.started", ts: 0, runId: "r1", sessionId: "s", channel: "webchat", trace: { traceId: "T", spanId: "RUN" } });
  engine.handle({ type: "tool.execution.started", ts: 1, runId: "r1", toolName: "edit", toolCallId: "tc", trace: { traceId: "T", spanId: "TE", parentSpanId: "RUN" } });
  assert.ok(t.all.some((o) => !o.ended));
  engine.flushAll();
  assert.ok(t.all.every((o) => o.ended));
});

test("handler never throws and reports failures", () => {
  const t = fakeTracing();
  t.startObservation = () => {
    throw new Error("boom");
  };
  let logged = "";
  const engine = createTraceEngine(t, { logger: { error: (m) => (logged = m) }, defer: () => {} });
  assert.equal(engine.handle({ type: "run.started", ts: 0, runId: "r", trace: { traceId: "T" } }), false);
  assert.match(logged, /handler failed/);
});

test("unknown event types are ignored", () => {
  const t = fakeTracing();
  const engine = createTraceEngine(t, { defer: () => {} });
  assert.equal(engine.handle({ type: "webhook.received" }), false);
  assert.equal(engine.handle(undefined), false);
  assert.equal(t.all.length, 0);
});

test("hooks remain authoritative after more than 64 session messages", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, {
    conversationHooksEnabled: true,
    resolveContent: () => ({ input: "stale trajectory prompt", output: "stale answer" }),
    resolveToolIO: () => ({ tc65: { input: "stale args", output: "stale result" } }),
  });
  const ctx = {
    runId: "r65",
    sessionId: "s65",
    channel: "webchat",
    trace: { traceId: "T65" },
  };
  engine.handleHook(
    "before_agent_run",
    { prompt: "message 65", messages: Array.from({ length: 70 }, (_, i) => ({ role: "user", content: `m${i}` })) },
    ctx,
  );
  engine.handleHook("before_tool_call", { toolName: "search", toolCallId: "tc65", params: { q: "fresh" } }, ctx);
  engine.handle({ type: "tool.execution.completed", ts: 20, runId: "r65", toolName: "search", toolCallId: "tc65", trace: { traceId: "T65" } });
  engine.handleHook("after_tool_call", { toolName: "search", toolCallId: "tc65", result: { hits: ["new"] } }, ctx);
  engine.handleHook("llm_input", {
    runId: "r65", sessionId: "s65", provider: "p", model: "m", prompt: "message 65",
    historyMessages: Array.from({ length: 70 }, (_, i) => ({ role: "user", content: `m${i}` })), imagesCount: 0,
  }, ctx);
  engine.handleHook("llm_output", {
    runId: "r65", sessionId: "s65", provider: "p", model: "m", assistantTexts: ["fresh answer"],
  }, ctx);
  engine.handle({ type: "model.usage", ts: 30, model: "m", usage: { input: 10, output: 2 }, trace: { traceId: "T65" } });
  engine.handleHook("agent_end", { runId: "r65", success: true, messages: [{ role: "assistant", content: "fresh answer" }] }, ctx);
  feed([]);

  assert.deepEqual(t.roots()[0].traceIO, { input: "message 65", output: "fresh answer" });
  const tool = t.byName("search");
  assert.deepEqual(tool.attributes.input, { q: "fresh" });
  assert.deepEqual(tool.attributes.output, { hits: ["new"] });
  const generation = t.all.find((node) => node.opts.asType === "generation");
  assert.equal(generation.attributes.input.historyMessages.length, 70);
  assert.equal(generation.attributes.output, "fresh answer");
});

test("parallel tool hooks pair independently by toolCallId", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "rp", sessionId: "sp", trace: { traceId: "TP" } };
  engine.handleHook("before_tool_call", { toolName: "search_a", toolCallId: "a", params: { q: "A" } }, ctx);
  engine.handleHook("before_tool_call", { toolName: "search_b", toolCallId: "b", params: { q: "B" } }, ctx);
  engine.handle({ type: "tool.execution.completed", ts: 20, runId: "rp", toolName: "search_b", toolCallId: "b", trace: { traceId: "TP" } });
  engine.handle({ type: "tool.execution.completed", ts: 21, runId: "rp", toolName: "search_a", toolCallId: "a", trace: { traceId: "TP" } });
  engine.handleHook("after_tool_call", { toolName: "search_b", toolCallId: "b", result: "result B" }, ctx);
  engine.handleHook("after_tool_call", { toolName: "search_a", toolCallId: "a", result: "result A" }, ctx);

  assert.equal(t.all.filter((node) => ["tool", "retriever"].includes(node.opts.asType)).length, 2);
  assert.deepEqual(t.byName("search_a").attributes.input, { q: "A" });
  assert.equal(t.byName("search_a").attributes.output, "result A");
  assert.deepEqual(t.byName("search_b").attributes.input, { q: "B" });
  assert.equal(t.byName("search_b").attributes.output, "result B");
});

test("late hooks enrich an existing diagnostic tool without duplication", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const diag = { runId: "rl", toolName: "edit", toolCallId: "late", trace: { traceId: "TL" } };
  engine.handle({ type: "tool.execution.completed", ts: 20, durationMs: 5, ...diag });
  engine.handle({ type: "tool.execution.started", ts: 15, ...diag });
  engine.handleHook("before_tool_call", { toolName: "edit", toolCallId: "late", params: { path: "a.txt" } }, diag);
  engine.handleHook("after_tool_call", { toolName: "edit", toolCallId: "late", result: "ok" }, diag);

  const tools = t.all.filter((node) => node.opts.asType === "tool");
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].attributes.input, { path: "a.txt" });
  assert.equal(tools[0].attributes.output, "ok");
  assert.equal(tools[0].ended, true);
});

test("blocked and failed tools are ERROR observations", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "re", sessionId: "se", trace: { traceId: "TE" } };
  engine.handleHook("before_tool_call", { toolName: "bash", toolCallId: "failed", params: { command: "false" } }, ctx);
  engine.handleHook("after_tool_call", { toolName: "bash", toolCallId: "failed", error: "exit 1", durationMs: 4 }, ctx);
  engine.handle({ type: "tool.execution.blocked", ts: 10, runId: "re", toolName: "write", toolCallId: "blocked", deniedReason: "policy", trace: { traceId: "TE" } });
  engine.handle({ type: "run.completed", ts: 11, runId: "re", outcome: "blocked", trace: { traceId: "TE" } });
  engine.handleHook("agent_end", { runId: "re", success: false, error: "blocked", messages: [] }, ctx);
  feed([]);

  assert.equal(t.byName("bash").attributes.level, "ERROR");
  assert.equal(t.byName("write").attributes.level, "ERROR");
  assert.equal(t.byName("write").ended, true);
  assert.equal(t.roots()[0].attributes.level, "ERROR");
});

test("model.usage can update a hook generation after the diagnostic root is finalized", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "ru", sessionId: "su", trace: { traceId: "TU" } };

  engine.handle({ type: "run.started", ts: 10, ...ctx });
  engine.handleHook("llm_input", { model: "m", prompt: "q", historyMessages: [] }, ctx);
  engine.handleHook("agent_end", {
    success: true,
    messages: [{ role: "assistant", content: "a" }],
  }, ctx);
  assert.equal(t.roots()[0].ended, false, "agent_end cannot terminate a diagnostic run");
  engine.handleHook("llm_output", {
    model: "m",
    assistantTexts: ["a"],
    usage: { input: 1, output: 1 },
  }, ctx);
  engine.handle({ type: "run.completed", ts: 20, outcome: "completed", ...ctx });
  feed([]);

  const root = t.roots()[0];
  const generation = t.all.find((node) => node.opts.asType === "generation");
  assert.equal(root.ended, true);
  assert.equal(generation.ended, false, "usage/cost diagnostic still owns generation completion");

  engine.handle({
    type: "model.usage",
    ts: 25,
    model: "m",
    usage: { input: 10, output: 5 },
    costUsd: 0.25,
    trace: { traceId: "TU" },
  });

  assert.deepEqual(generation.attributes.usageDetails, { input: 10, output: 5 });
  assert.deepEqual(generation.attributes.costDetails, { totalCost: 0.25 });
  assert.equal(generation.ended, true);
  assert.equal(generation.ignoredUpdates.length, 0);
});

test("after_tool_call enriches but diagnostic terminal owns status, timing, and end", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "rt", sessionId: "st", trace: { traceId: "TT" } };

  engine.handleHook(
    "before_tool_call",
    { toolName: "edit", toolCallId: "tc", params: { path: "a.txt" } },
    ctx,
  );
  engine.handleHook(
    "after_tool_call",
    { toolName: "edit", toolCallId: "tc", result: "partial result" },
    ctx,
  );
  const tool = t.byName("edit");
  assert.equal(tool.ended, false);

  engine.handle({
    type: "tool.execution.error",
    ts: 50,
    durationMs: 12,
    errorCategory: "runtime",
    toolName: "edit",
    toolCallId: "tc",
    ...ctx,
  });
  assert.equal(tool.ended, false, "a reversed diagnostic start can still enrich the tool");
  engine.handle({
    type: "tool.execution.started",
    ts: 38,
    toolName: "edit",
    toolCallId: "tc",
    toolSource: "core",
    ...ctx,
  });

  assert.equal(tool.attributes.level, "ERROR");
  assert.equal(tool.attributes.metadata.durationMs, 12);
  assert.equal(tool.endTime.getTime(), 50);
  assert.equal(tool.ended, true);
  assert.equal(tool.ignoredUpdates.length, 0);
});

test("a tool stays open across root finalization until its delayed after hook arrives", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "rdelay", sessionId: "sdelay", trace: { traceId: "TDELAY" } };

  engine.handleHook(
    "before_tool_call",
    { toolName: "search", toolCallId: "delayed", params: { q: "fresh" } },
    ctx,
  );
  engine.handle({
    type: "tool.execution.started",
    ts: 10,
    toolName: "search",
    toolCallId: "delayed",
    ...ctx,
  });
  engine.handle({
    type: "tool.execution.completed",
    ts: 20,
    durationMs: 10,
    toolName: "search",
    toolCallId: "delayed",
    ...ctx,
  });
  engine.handle({ type: "run.completed", ts: 30, outcome: "completed", ...ctx });
  engine.handleHook("agent_end", { success: true, messages: [] }, ctx);
  feed([]);

  const tool = t.byName("search");
  assert.equal(t.roots()[0].ended, true);
  assert.equal(tool.ended, false);

  engine.handleHook(
    "after_tool_call",
    { toolName: "search", toolCallId: "delayed", result: "fresh result" },
    ctx,
  );
  assert.equal(tool.attributes.output, "fresh result");
  assert.equal(tool.endTime.getTime(), 20);
  assert.equal(tool.ended, true);
  assert.equal(tool.ignoredUpdates.length, 0);
});

test("an empty llm_output consumes its own generation slot", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "rempty", sessionId: "sempty", trace: { traceId: "TEMPTY" } };

  engine.handleHook("llm_input", { model: "m", prompt: "first", historyMessages: [] }, ctx);
  engine.handleHook("llm_output", { model: "m", assistantTexts: [] }, ctx);
  engine.handleHook("llm_input", { model: "m", prompt: "second", historyMessages: [] }, ctx);
  engine.handleHook("llm_output", { model: "m", assistantTexts: ["answer"] }, ctx);
  engine.handle({
    type: "model.usage",
    ts: 30,
    model: "m",
    usage: { input: 4, output: 1 },
    trace: { traceId: "TEMPTY" },
  });

  const generations = t.all.filter((node) => node.opts.asType === "generation");
  assert.equal(generations.length, 2);
  assert.equal(generations[0].attributes.input.prompt, "first");
  assert.equal(generations[0].attributes.output, undefined);
  assert.equal(generations[1].attributes.input.prompt, "second");
  assert.equal(generations[1].attributes.output, "answer");
});

test("failed agent_end does not reuse an assistant response from an earlier turn", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "rf", sessionId: "sf", trace: { traceId: "TF" } };
  const history = [{ role: "assistant", content: "old answer" }];

  engine.handleHook("before_agent_run", { prompt: "new question", messages: history }, ctx);
  engine.handle({ type: "run.completed", ts: 10, outcome: "error", ...ctx });
  engine.handleHook("agent_end", { success: false, error: "aborted", messages: history }, ctx);
  feed([]);

  const root = t.roots()[0];
  assert.deepEqual(root.traceIO, { input: "new question" });
  assert.equal(root.attributes.metadata.noAnswer, true);
  assert.equal(root.attributes.level, "ERROR");
});

test("delegation llm output stays on its generation and does not become root output", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, {
    conversationHooksEnabled: true,
    resolveContent: () => ({ input: "old question", output: "old answer" }),
  });
  const ctx = { runId: "r-no-answer", sessionId: "s-no-answer", trace: { traceId: "T-NO-ANSWER" } };
  const history = [{ role: "assistant", content: "old answer" }];

  engine.handleHook("before_agent_run", { prompt: "delegate this", messages: history }, ctx);
  engine.handleHook(
    "llm_output",
    { model: "m", assistantTexts: ["task passed to subagent"] },
    ctx,
  );
  // Usage commonly races ahead of agent_end and must not commit stale fallback I/O.
  engine.handle({
    type: "model.usage",
    ts: 8,
    model: "m",
    usage: { input: 2, output: 0 },
    ...ctx,
  });
  engine.handle({ type: "run.completed", ts: 10, outcome: "completed", ...ctx });
  engine.handleHook("agent_end", { success: true, messages: history }, ctx);
  feed([]);

  const root = t.roots()[0];
  assert.deepEqual(root.traceIO, { input: "delegate this" });
  assert.equal(root.attributes.output, undefined);
  assert.equal(root.attributes.metadata.noAnswer, true);
  assert.equal(root.ended, true);
  const generation = t.all.find((node) => node.opts.asType === "generation");
  assert.equal(generation.attributes.output, "task passed to subagent");
});

test("missing agent_end still permits root output fallback", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, {
    conversationHooksEnabled: true,
    resolveContent: () => ({ input: "fallback input", output: "fallback answer" }),
  });
  const ctx = { runId: "r-missing-end", sessionId: "s-missing-end", trace: { traceId: "T-MISSING-END" } };

  engine.handleHook("before_agent_run", { prompt: "hook input", messages: [] }, ctx);
  engine.handle({ type: "run.completed", ts: 10, outcome: "completed", ...ctx });
  feed([]);

  assert.deepEqual(t.roots()[0].traceIO, {
    input: "hook input",
    output: "fallback answer",
  });
});

test("multiple llm hook pairs create separate generations", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "rm", sessionId: "sm", trace: { traceId: "TM" } };
  for (const [prompt, answer, usage] of [
    ["first", "tool plan", { input: 5, output: 2 }],
    ["second", "final answer", { input: 8, output: 3 }],
  ]) {
    engine.handleHook("llm_input", { runId: "rm", sessionId: "sm", provider: "p", model: "m", prompt, historyMessages: [], imagesCount: 0 }, ctx);
    engine.handleHook("llm_output", { runId: "rm", sessionId: "sm", provider: "p", model: "m", assistantTexts: [answer], usage }, ctx);
  }
  engine.handleHook("agent_end", { runId: "rm", success: true, messages: [{ role: "assistant", content: "final answer" }] }, ctx);
  const generations = t.all.filter((node) => node.opts.asType === "generation");
  assert.equal(generations.length, 2);
  assert.equal(generations[0].ended, false, "agent_end defers close until usage can arrive");
  engine.handle({ type: "model.usage", ts: 50, model: "m", usage: { input: 13, output: 5 }, costUsd: 0.1, trace: { traceId: "TM" } });
  feed([]);

  assert.equal(generations[0].attributes.input.prompt, "first");
  assert.equal(generations[0].attributes.output, "tool plan");
  assert.equal(generations[1].attributes.input.prompt, "second");
  assert.equal(generations[1].attributes.output, "final answer");
  assert.deepEqual(generations[0].attributes.usageDetails, { input: 5, output: 2 });
  assert.deepEqual(generations[1].attributes.costDetails, { totalCost: 0.1 });
  assert.ok(generations.every((generation) => generation.ended));
});

test("model.usage arriving before llm hooks does not create a duplicate generation", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = { runId: "ro", sessionId: "so", trace: { traceId: "TO" } };
  engine.handle({ type: "model.usage", ts: 20, model: "m", usage: { input: 2, output: 1 }, costUsd: 0.01, trace: { traceId: "TO" } });
  engine.handleHook("llm_input", { runId: "ro", sessionId: "so", provider: "p", model: "m", prompt: "late input", historyMessages: [], imagesCount: 0 }, ctx);
  engine.handleHook("llm_output", { runId: "ro", sessionId: "so", provider: "p", model: "m", assistantTexts: ["late output"] }, ctx);
  engine.handleHook("agent_end", { runId: "ro", success: true, messages: [{ role: "assistant", content: "late output" }] }, ctx);
  feed([]);

  const generations = t.all.filter((node) => node.opts.asType === "generation");
  assert.equal(generations.length, 1);
  assert.equal(generations[0].attributes.input.prompt, "late input");
  assert.equal(generations[0].attributes.output, "late output");
  assert.deepEqual(generations[0].attributes.costDetails, { totalCost: 0.01 });
});

test("disabling conversation capture leaves conversation IO empty but tool hooks work", () => {
  const t = fakeTracing();
  const { engine, feed } = makeEngine(t, {
    captureConversationContent: false,
    captureToolContent: true,
    resolveContent: () => ({ input: "must not leak", output: "must not leak" }),
  });
  const ctx = { runId: "rd", sessionId: "sd", trace: { traceId: "TD" } };
  engine.handle({ type: "run.started", ts: 1, ...ctx });
  engine.handleHook("before_tool_call", { toolName: "edit", toolCallId: "d", params: { value: 1 } }, ctx);
  engine.handleHook("after_tool_call", { toolName: "edit", toolCallId: "d", result: "done" }, ctx);
  engine.handle({ type: "model.usage", ts: 2, model: "m", usage: { input: 1, output: 1 }, ...ctx });
  engine.handle({ type: "run.completed", ts: 3, ...ctx });
  feed([]);

  assert.equal(t.roots()[0].traceIO, undefined);
  assert.equal(t.all.find((node) => node.opts.asType === "generation").attributes.input, undefined);
  assert.deepEqual(t.byName("edit").attributes.input, { value: 1 });
});

test("different runs sharing one trace keep independent agent I/O", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const mainCtx = {
    runId: "run-main",
    sessionId: "session-main",
    sessionKey: "agent:main:main",
    trace: { traceId: "TRACE-SHARED", spanId: "MAIN-HARNESS" },
  };
  const childCtx = {
    runId: "run-child",
    sessionId: "session-child",
    sessionKey: "agent:main:subagent:child",
    trace: { traceId: "TRACE-SHARED", spanId: "CHILD-HARNESS" },
  };

  engine.handleHook("before_agent_run", { prompt: "original user question", messages: [] }, mainCtx);
  engine.handleHook("before_agent_run", { prompt: "delegated child task", messages: [] }, childCtx);
  engine.handleHook(
    "agent_end",
    { success: true, messages: [{ role: "assistant", content: "child answer" }] },
    childCtx,
  );
  engine.handleHook(
    "agent_end",
    { success: true, messages: [{ role: "assistant", content: "main answer" }] },
    mainCtx,
  );

  const agents = t.all.filter((node) => node.opts.asType === "agent");
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map((node) => node.traceIO), [
    { input: "original user question", output: "main answer" },
    { input: "delegated child task", output: "child answer" },
  ]);
});

test("repeated before_agent_run for one run preserves its initial user input", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const ctx = {
    runId: "run-repeated-input",
    sessionId: "session-repeated-input",
    trace: { traceId: "TRACE-REPEATED-INPUT" },
  };

  engine.handleHook("before_agent_run", { prompt: "original user input", messages: [] }, ctx);
  engine.handleHook(
    "before_agent_run",
    { prompt: "internal continuation input", messages: [] },
    ctx,
  );

  assert.deepEqual(t.roots()[0].traceIO, { input: "original user input" });
});

test("a child run completion cannot finalize another run sharing its trace", () => {
  const t = fakeTracing();
  const { engine, flushDeferred } = makeEngine(t, { conversationHooksEnabled: true });
  const main = {
    runId: "run-parent",
    sessionId: "session-parent",
    trace: { traceId: "TRACE-LIFECYCLE", spanId: "PARENT-RUN" },
  };
  const child = {
    runId: "run-child",
    sessionId: "session-child",
    trace: { traceId: "TRACE-LIFECYCLE", spanId: "CHILD-RUN" },
  };

  engine.handle({ type: "run.started", ts: 1, ...main });
  engine.handle({ type: "run.started", ts: 2, ...child });
  engine.handle({ type: "run.completed", ts: 3, outcome: "completed", ...child });
  flushDeferred();

  const [parentAgent, childAgent] = t.all.filter((node) => node.opts.asType === "agent");
  assert.equal(parentAgent.ended, false);
  assert.equal(childAgent.ended, true);
  assert.equal(childAgent.endCalls, 1);

  engine.handle({ type: "run.completed", ts: 4, outcome: "completed", ...main });
  flushDeferred();
  assert.equal(parentAgent.ended, true);
  assert.equal(parentAgent.endCalls, 1);
});

test("subagent lifecycle links child I/O without changing parent trace I/O", () => {
  const t = fakeTracing();
  const { engine, flushDeferred } = makeEngine(t, { conversationHooksEnabled: true });
  const parentCtx = {
    runId: "run-parent-linked",
    sessionId: "session-parent-linked",
    sessionKey: "agent:main:parent",
    trace: { traceId: "TRACE-LINKED", spanId: "PARENT-HARNESS" },
  };
  const childCtx = {
    runId: "run-child-linked",
    sessionId: "session-child-linked",
    sessionKey: "agent:main:subagent:linked",
    trace: { traceId: "TRACE-LINKED", spanId: "CHILD-HARNESS" },
  };

  engine.handleHook("before_agent_run", { prompt: "user request", messages: [] }, parentCtx);
  engine.handleHook(
    "subagent_spawned",
    {
      runId: childCtx.runId,
      childSessionKey: childCtx.sessionKey,
      agentId: "main",
      label: "research",
      mode: "run",
    },
    { requesterSessionKey: parentCtx.sessionKey },
  );
  engine.handleHook("before_agent_run", { prompt: "research this", messages: [] }, childCtx);
  engine.handleHook(
    "agent_end",
    { success: true, messages: [{ role: "assistant", content: "research result" }] },
    childCtx,
  );
  engine.handleHook(
    "subagent_ended",
    {
      runId: childCtx.runId,
      targetSessionKey: childCtx.sessionKey,
      reason: "subagent-complete",
      outcome: "ok",
    },
    {},
  );
  engine.handle({ type: "run.completed", ts: 20, outcome: "completed", ...childCtx });
  flushDeferred();

  const parent = t.roots()[0];
  const child = parent.children.find((node) => node.opts.asType === "agent");
  assert.ok(child);
  assert.equal(child.attributes.metadata.subagent, true);
  assert.equal(child.attributes.metadata.parentRunId, parentCtx.runId);
  assert.equal(child.attributes.input, "research this");
  assert.equal(child.attributes.output, "research result");
  assert.deepEqual(parent.traceIO, { input: "user request" });
  assert.equal(parent.ended, false);
  assert.equal(child.ended, true);
});

test("late subagent_spawned enriches an existing child without duplication", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const parentCtx = {
    runId: "run-parent-late",
    sessionKey: "agent:main:late-parent",
    trace: { traceId: "TRACE-LATE-SUBAGENT", spanId: "PARENT" },
  };
  const childCtx = {
    runId: "run-child-late",
    sessionKey: "agent:main:subagent:late",
    trace: { traceId: "TRACE-LATE-SUBAGENT", spanId: "CHILD" },
  };

  engine.handleHook("before_agent_run", { prompt: "user input", messages: [] }, parentCtx);
  engine.handleHook("before_agent_run", { prompt: "late child task", messages: [] }, childCtx);
  engine.handleHook(
    "subagent_spawned",
    {
      runId: childCtx.runId,
      childSessionKey: childCtx.sessionKey,
      agentId: "main",
      label: "late",
      mode: "run",
    },
    { requesterSessionKey: parentCtx.sessionKey },
  );

  const agents = t.all.filter((node) => node.opts.asType === "agent");
  assert.equal(agents.length, 2);
  assert.equal(agents[0].traceIO.input, "user input");
  assert.equal(agents[1].traceIO.input, "late child task");
  assert.equal(agents[1].attributes.metadata.subagent, true);
  assert.equal(agents[1].attributes.metadata.parentRunId, parentCtx.runId);
});

test("subagent failure marks only the child observation as ERROR", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const parentCtx = {
    runId: "run-error-parent",
    sessionKey: "agent:main:error-parent",
    trace: { traceId: "TRACE-SUBAGENT-ERROR", spanId: "PARENT" },
  };
  const childCtx = {
    runId: "run-error-child",
    sessionKey: "agent:main:subagent:error",
    trace: { traceId: "TRACE-SUBAGENT-ERROR", spanId: "CHILD" },
  };
  engine.handleHook("before_agent_run", { prompt: "user input", messages: [] }, parentCtx);
  engine.handleHook(
    "subagent_spawned",
    {
      runId: childCtx.runId,
      childSessionKey: childCtx.sessionKey,
      agentId: "main",
      mode: "run",
    },
    { requesterSessionKey: parentCtx.sessionKey },
  );
  engine.handleHook("before_agent_run", { prompt: "failing child task", messages: [] }, childCtx);
  engine.handleHook(
    "subagent_ended",
    {
      runId: childCtx.runId,
      targetSessionKey: childCtx.sessionKey,
      reason: "subagent-error",
      outcome: "error",
      error: "child failed",
    },
    {},
  );

  const parent = t.roots()[0];
  const child = parent.children.find((node) => node.opts.asType === "agent");
  assert.equal(parent.attributes.level, undefined);
  assert.equal(child.attributes.level, "ERROR");
  assert.equal(child.attributes.statusMessage, "child failed");
  assert.equal(child.attributes.metadata.subagentOutcome, "error");
});

test("parallel subagents sharing a trace keep separate generations and answers", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const parentCtx = {
    runId: "run-parallel-parent",
    sessionKey: "agent:main:parallel-parent",
    trace: { traceId: "TRACE-PARALLEL-AGENTS", spanId: "PARENT" },
  };
  engine.handleHook("before_agent_run", { prompt: "compare two sources", messages: [] }, parentCtx);

  for (const suffix of ["a", "b"]) {
    const childCtx = {
      runId: `run-parallel-${suffix}`,
      sessionId: `session-parallel-${suffix}`,
      sessionKey: `agent:main:subagent:${suffix}`,
      trace: { traceId: "TRACE-PARALLEL-AGENTS", spanId: `CHILD-${suffix}` },
    };
    engine.handleHook(
      "subagent_spawned",
      {
        runId: childCtx.runId,
        childSessionKey: childCtx.sessionKey,
        agentId: "main",
        label: suffix,
        mode: "run",
      },
      { requesterSessionKey: parentCtx.sessionKey },
    );
    engine.handleHook("before_agent_run", { prompt: `task ${suffix}`, messages: [] }, childCtx);
    engine.handleHook(
      "llm_input",
      { model: "m", prompt: `task ${suffix}`, historyMessages: [] },
      childCtx,
    );
    engine.handleHook(
      "llm_output",
      { model: "m", assistantTexts: [`answer ${suffix}`] },
      childCtx,
    );
    engine.handleHook(
      "agent_end",
      { success: true, messages: [{ role: "assistant", content: `answer ${suffix}` }] },
      childCtx,
    );
  }

  const childAgents = t.all.filter(
    (node) => node.opts.asType === "agent" && node.attributes.metadata.subagent,
  );
  assert.equal(childAgents.length, 2);
  assert.deepEqual(childAgents.map((node) => node.attributes.input), ["task a", "task b"]);
  assert.deepEqual(childAgents.map((node) => node.attributes.output), ["answer a", "answer b"]);
  assert.deepEqual(
    childAgents.map((node) => node.children.filter((child) => child.opts.asType === "generation").length),
    [1, 1],
  );
  assert.deepEqual(t.roots()[0].traceIO, { input: "compare two sources" });
});

test("trace-only usage selects the matching run and stays standalone when ambiguous", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const mainCtx = {
    runId: "run-usage-main",
    sessionId: "session-usage-main",
    trace: { traceId: "TRACE-USAGE-MULTI", spanId: "MAIN-HARNESS" },
  };
  const childCtx = {
    runId: "run-usage-child",
    sessionId: "session-usage-child",
    trace: { traceId: "TRACE-USAGE-MULTI", spanId: "CHILD-HARNESS" },
  };
  engine.handle({
    type: "run.started",
    ts: 1,
    ...mainCtx,
    trace: { traceId: "TRACE-USAGE-MULTI", spanId: "MAIN-RUN", parentSpanId: "MAIN-HARNESS" },
  });
  engine.handle({
    type: "run.started",
    ts: 2,
    ...childCtx,
    trace: { traceId: "TRACE-USAGE-MULTI", spanId: "CHILD-RUN", parentSpanId: "CHILD-HARNESS" },
  });
  engine.handleHook("llm_input", { model: "m", prompt: "main", historyMessages: [] }, mainCtx);
  engine.handleHook("llm_output", { model: "m", assistantTexts: ["main answer"] }, mainCtx);
  engine.handleHook("llm_input", { model: "m", prompt: "child", historyMessages: [] }, childCtx);
  engine.handleHook("llm_output", { model: "m", assistantTexts: ["child answer"] }, childCtx);

  engine.handle({
    type: "model.usage",
    ts: 10,
    model: "m",
    usage: { input: 11, output: 1 },
    trace: { traceId: "TRACE-USAGE-MULTI", spanId: "MAIN-USAGE", parentSpanId: "MAIN-HARNESS" },
  });
  engine.handle({
    type: "model.usage",
    ts: 11,
    model: "m",
    usage: { input: 22, output: 2 },
    trace: { traceId: "TRACE-USAGE-MULTI", spanId: "CHILD-USAGE", parentSpanId: "CHILD-HARNESS" },
  });
  engine.handle({
    type: "model.usage",
    ts: 12,
    model: "ambiguous",
    usage: { input: 99, output: 9 },
    trace: { traceId: "TRACE-USAGE-MULTI", spanId: "UNKNOWN" },
  });

  const mainGeneration = t.all.find(
    (node) => node.opts.asType === "generation" && node.attributes.input?.prompt === "main",
  );
  const childGeneration = t.all.find(
    (node) => node.opts.asType === "generation" && node.attributes.input?.prompt === "child",
  );
  assert.deepEqual(mainGeneration.attributes.usageDetails, { input: 11, output: 1 });
  assert.deepEqual(childGeneration.attributes.usageDetails, { input: 22, output: 2 });
  const standalone = t.roots().find(
    (node) => node.opts.asType === "generation" && node.name === "ambiguous",
  );
  assert.ok(standalone);
  assert.deepEqual(standalone.attributes.usageDetails, { input: 99, output: 9 });
});

test("trace-only usage with a different session cannot contaminate the lone known run", () => {
  const t = fakeTracing();
  const { engine } = makeEngine(t, { conversationHooksEnabled: true });
  const mainCtx = {
    runId: "run-known-session",
    sessionId: "session-known",
    trace: { traceId: "TRACE-SESSION-MISMATCH", spanId: "KNOWN" },
  };
  engine.handleHook("llm_input", { model: "m", prompt: "known input", historyMessages: [] }, mainCtx);
  engine.handleHook("llm_output", { model: "m", assistantTexts: ["known output"] }, mainCtx);

  engine.handle({
    type: "model.usage",
    ts: 10,
    sessionId: "session-other",
    model: "other-session-model",
    usage: { input: 7, output: 3 },
    trace: { traceId: "TRACE-SESSION-MISMATCH", spanId: "OTHER" },
  });

  const knownGeneration = t.all.find(
    (node) => node.opts.asType === "generation" && node.attributes.input?.prompt === "known input",
  );
  assert.equal(knownGeneration.attributes.usageDetails, undefined);
  const standalone = t.roots().find(
    (node) => node.opts.asType === "generation" && node.name === "other-session-model",
  );
  assert.ok(standalone);
  assert.deepEqual(standalone.attributes.usageDetails, { input: 7, output: 3 });
});

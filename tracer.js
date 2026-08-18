// Correlates OpenClaw diagnostic events (structure/timing/usage) with typed
// plugin hooks (raw conversation and tool I/O). Hook and diagnostic delivery
// are intentionally treated as independent, reorderable streams.

import {
  compact,
  setTraceFields,
  classifyToolType,
  usageDetails,
  toDate,
  toolAttributes,
  runAttributes,
  contextAttributes,
  contextSummary,
  errorAttributes,
  sanitizeContent,
  lastAssistantText,
  messageText,
} from "./mapping.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 5000;

function sessionOf(evt) {
  return evt?.sessionId ?? evt?.sessionKey;
}

function traceIdOf(evt) {
  return evt?.trace?.traceId ?? evt?.traceId;
}

function mergeHookEvent(event, ctx, now) {
  return {
    ...ctx,
    ...event,
    runId: event?.runId ?? ctx?.runId,
    sessionId: event?.sessionId ?? ctx?.sessionId,
    sessionKey: event?.sessionKey ?? ctx?.sessionKey,
    agentId: event?.agentId ?? ctx?.agentId,
    channel: event?.channel ?? ctx?.channel ?? ctx?.messageProvider,
    trace: event?.trace ?? ctx?.trace,
    ts: event?.ts ?? now(),
  };
}

function toolKey(evt) {
  if (evt?.toolCallId) {
    const scope = evt?.runId ?? traceIdOf(evt) ?? sessionOf(evt) ?? "orphan";
    return `tool:${scope}:${evt.toolCallId}`;
  }
  return evt?.runId && evt?.toolName ? `tool:${evt.runId}:${evt.toolName}` : undefined;
}

function outputFromLlmEvent(evt) {
  if (Array.isArray(evt?.assistantTexts) && evt.assistantTexts.length > 0) {
    return evt.assistantTexts.length === 1 ? evt.assistantTexts[0] : evt.assistantTexts;
  }
  return messageText(evt?.lastAssistant);
}

/**
 * Create the stateful correlation engine. `handle` accepts diagnostic events;
 * `handleHook` accepts OpenClaw typed hooks.
 */
export function createTraceEngine(tracing, opts = {}) {
  const {
    logger,
    resolveContent,
    resolveToolIO,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    defer = (fn) => setImmediate(fn),
    conversationHooksEnabled = false,
    captureConversationContent = true,
    captureToolContent = true,
    maxContentBytes = 64_000,
  } = opts;

  const live = new Set();
  const rootsByTrace = new Map();
  const rootsByRun = new Map();
  const toolsByKey = new Map();
  const generationsByRun = new Map();
  const subagentsByRun = new Map();
  const subagentsBySession = new Map();

  function clean(value) {
    return sanitizeContent(value, maxContentBytes);
  }

  function touch(entry) {
    if (entry) entry.lastMs = now();
    return entry;
  }

  function register(entry) {
    live.add(entry);
    if (live.size > maxEntries) evictOldest();
    return entry;
  }

  function forget(entry) {
    live.delete(entry);
    for (const traceId of entry.traceIds ?? []) {
      const roots = rootsByTrace.get(traceId);
      roots?.delete(entry);
      if (roots?.size === 0) rootsByTrace.delete(traceId);
    }
    if (entry.runId && rootsByRun.get(entry.runId) === entry) rootsByRun.delete(entry.runId);
    for (const key of entry.toolKeys ?? []) {
      if (toolsByKey.get(key) === entry) toolsByKey.delete(key);
    }
    entry.parentRoot?.children.delete(entry);
  }

  function endEntry(entry, endTimeMs, keep = false) {
    if (!entry || entry.ended) return;
    entry.ended = true;
    try {
      entry.obs.end(toDate(endTimeMs));
    } catch {
      // Never throw into OpenClaw's event or hook runners.
    }
    if (!keep) forget(entry);
  }

  function evictOldest() {
    let oldest;
    for (const entry of live) {
      if (!oldest || entry.lastMs < oldest.lastMs) oldest = entry;
    }
    if (!oldest) return;
    if (oldest.ended) forget(oldest);
    else if (oldest.kind === "root") {
      finalizeTrace(oldest);
      if (oldest.ended) forget(oldest);
    }
    else endEntry(oldest, now());
  }

  function addTraceRoot(traceId, root) {
    if (!traceId) return;
    let roots = rootsByTrace.get(traceId);
    if (!roots) {
      roots = new Set();
      rootsByTrace.set(traceId, roots);
    }
    roots.add(root);
    root.traceIds.add(traceId);
  }

  function recordTraceContext(root, evt) {
    const tid = traceIdOf(evt);
    if (tid) {
      root.traceId ??= tid;
      addTraceRoot(tid, root);
    }
    if (evt?.trace?.spanId) root.traceSpanIds.add(evt.trace.spanId);
    if (evt?.trace?.parentSpanId) root.traceParentSpanIds.add(evt.trace.parentSpanId);
  }

  function rootMatchesSession(root, evt) {
    const eventIds = [evt?.sessionId, evt?.sessionKey].filter(Boolean);
    if (eventIds.length === 0) return false;
    const rootIds = [root.ctx.sessionId, root.ctx.sessionKey].filter(Boolean);
    return eventIds.some((id) => rootIds.includes(id));
  }

  function rootMatchesTraceContext(root, evt) {
    const spanId = evt?.trace?.spanId;
    const parentSpanId = evt?.trace?.parentSpanId;
    return Boolean(
      (spanId &&
        (root.traceSpanIds.has(spanId) || root.traceParentSpanIds.has(spanId))) ||
        (parentSpanId &&
          (root.traceSpanIds.has(parentSpanId) ||
            root.traceParentSpanIds.has(parentSpanId))),
    );
  }

  function traceCandidates(traceId) {
    return [...(rootsByTrace.get(traceId) ?? [])].filter((root) => live.has(root));
  }

  function resolveTraceOnlyRoot(evt) {
    const tid = traceIdOf(evt);
    if (!tid) return null;
    const candidates = traceCandidates(tid);
    if (candidates.length === 0) return null;

    const sessionMatches = candidates.filter((root) => rootMatchesSession(root, evt));
    if (sessionMatches.length === 1) return sessionMatches[0];
    let scoped = sessionMatches.length > 1 ? sessionMatches : candidates;
    if (sessionOf(evt) && sessionMatches.length === 0) {
      // A known, different session is evidence of another run, not permission
      // to attach to the only root currently observed for this trace.
      scoped = candidates.filter((root) => !sessionOf(root.ctx));
      if (scoped.length === 0) return null;
    }

    const traceMatches = scoped.filter((root) => rootMatchesTraceContext(root, evt));
    if (traceMatches.length === 1) return traceMatches[0];
    if (scoped.length === 1) return scoped[0];
    return null;
  }

  function findRootBySession(sessionKey, excludeRunId) {
    if (!sessionKey) return null;
    const candidates = [...new Set(rootsByRun.values())]
      .filter(
        (root) =>
          root.runId !== excludeRunId &&
          (root.ctx.sessionKey === sessionKey || root.ctx.sessionId === sessionKey),
      )
      .sort((a, b) => Number(a.ended) - Number(b.ended) || b.lastMs - a.lastMs);
    return candidates[0] ?? null;
  }

  function subagentInfoFor(evt) {
    return (
      (evt?.runId && subagentsByRun.get(evt.runId)) ||
      (evt?.sessionKey && subagentsBySession.get(evt.sessionKey)) ||
      (evt?.sessionId && subagentsBySession.get(evt.sessionId)) ||
      (evt?.childSessionKey && subagentsBySession.get(evt.childSessionKey)) ||
      (evt?.targetSessionKey && subagentsBySession.get(evt.targetSessionKey))
    );
  }

  function refreshRoot(root, evt) {
    recordTraceContext(root, evt);
    if (evt?.runId && root.runId && evt.runId !== root.runId) {
      logger?.warn?.(
        `langfuse-bridge: refused to merge run ${evt.runId} into ${root.runId}`,
      );
      return;
    }
    if (evt?.runId && !root.runId) {
      root.runId = evt.runId;
      root.ctx.runId = evt.runId;
      rootsByRun.set(evt.runId, root);
      generationsByRun.set(evt.runId, root.generations);
    }
    if (!root.named && evt?.channel) {
      root.named = true;
      try {
        root.obs.update({ name: evt.channel });
        if (!root.parentRoot) setTraceFields(root.obs, evt.channel, undefined);
      } catch {
        // best-effort
      }
    }
    if (!root.sessioned && sessionOf(evt)) {
      root.sessioned = true;
      if (!root.parentRoot) setTraceFields(root.obs, undefined, sessionOf(evt));
    }
    root.ctx.sessionId ??= evt?.sessionId;
    root.ctx.sessionKey ??= evt?.sessionKey;
    root.ctx.agentId ??= evt?.agentId;
    root.ctx.runId ??= evt?.runId;
    root.ctx.trace ??= evt?.trace;
    touch(root);
  }

  function ensureRoot(evt, preferredParent) {
    const tid = traceIdOf(evt);
    const runId = evt?.runId;
    const existingTraceCandidates = !runId && tid ? traceCandidates(tid) : [];
    let root = runId ? rootsByRun.get(runId) : resolveTraceOnlyRoot(evt);
    if (root) {
      refreshRoot(root, evt);
      return root;
    }
    if (!runId && existingTraceCandidates.length > 0) {
      // The trace contains multiple runs and this event lacks enough identity
      // to select one. Returning no root is safer than inventing an agent root
      // that future trace-only events could incorrectly adopt.
      return null;
    }

    // A trace-only diagnostic can arrive before the first event carrying its
    // runId. Adopt only an unassigned, unambiguous root; never merge two known
    // runs merely because OpenClaw propagated the same W3C traceId.
    if (runId && tid) {
      const adoptable = traceCandidates(tid).filter(
        (candidate) =>
          !candidate.runId &&
          (!sessionOf(evt) ||
            !sessionOf(candidate.ctx) ||
            rootMatchesSession(candidate, evt)),
      );
      if (adoptable.length === 1) {
        root = adoptable[0];
        refreshRoot(root, evt);
        return root;
      }
    }
    if (!tid && !runId) return null;

    const subagent = subagentInfoFor(evt);
    const mappedParent =
      preferredParent ??
      (subagent?.parentRunId && rootsByRun.get(subagent.parentRunId)) ??
      findRootBySession(subagent?.requesterSessionKey, runId);
    const parentRoot =
      mappedParent && !mappedParent.ended ? mappedParent : undefined;

    const name = evt?.channel ?? "openclaw run";
    const observationOptions = compact({ asType: "agent", startTime: toDate(evt?.ts) });
    const obs = parentRoot
      ? parentRoot.obs.startObservation(name, runAttributes(evt), observationOptions)
      : tracing.startObservation(name, runAttributes(evt), observationOptions);
    if (!parentRoot) setTraceFields(obs, name, sessionOf(evt));
    root = register({
      obs,
      kind: "root",
      parentRoot,
      traceId: tid,
      traceIds: new Set(),
      traceSpanIds: new Set(),
      traceParentSpanIds: new Set(),
      runId,
      named: Boolean(evt?.channel),
      sessioned: Boolean(sessionOf(evt)),
      ctx: {
        runId,
        trace: evt?.trace,
        sessionId: evt?.sessionId,
        sessionKey: evt?.sessionKey,
        agentId: evt?.agentId,
      },
      children: new Set(),
      generations: [],
      runCompleted: false,
      agentEnded: false,
      conversationOutputResolved: false,
      llmOutputCandidate: undefined,
      delegatedToSubagent: false,
      finalizeScheduled: false,
      inputSet: false,
      outputSet: false,
      traceIO: {},
      lastMs: now(),
      ended: false,
    });
    recordTraceContext(root, evt);
    parentRoot?.children.add(root);
    if (runId) {
      rootsByRun.set(runId, root);
      generationsByRun.set(runId, root.generations);
    }
    if (subagent) updateSubagentMetadata(root, subagent);
    return root;
  }

  function createChild(evt, root, { name, asType, attributes, startMs }) {
    const options = compact({ asType, startTime: toDate(startMs ?? evt?.ts) });
    const obs = root
      ? root.obs.startObservation(name, attributes, options)
      : tracing.startObservation(name, attributes, options);
    if (!root) setTraceFields(obs, evt?.channel ?? "openclaw", sessionOf(evt));
    const entry = register({
      obs,
      kind: asType,
      root,
      traceId: traceIdOf(evt),
      runId: evt?.runId,
      lastMs: now(),
      ended: false,
    });
    root?.children.add(entry);
    return entry;
  }

  function probe(root) {
    return {
      ...root.ctx,
      trace: root.ctx.trace ?? (root.traceId ? { traceId: root.traceId } : undefined),
    };
  }

  function updateSubagentMetadata(root, info) {
    if (!root || !info) return;
    root.subagent = info;
    try {
      root.obs.update({
        metadata: compact({
          subagent: true,
          childSessionKey: info.childSessionKey,
          requesterSessionKey: info.requesterSessionKey,
          parentRunId: info.parentRunId,
          label: info.label,
          mode: info.mode,
          subagentOutcome: info.outcome,
          subagentReason: info.reason,
        }),
      });
    } catch {
      // best-effort
    }
  }

  function updateRootIO(root, io, overwrite = false) {
    if (!root || !io) return;
    const patch = {};
    if (io.input !== undefined && (overwrite || !root.inputSet)) {
      patch.input = clean(io.input);
      root.traceIO.input = patch.input;
      root.inputSet = true;
    }
    if (io.output !== undefined && (overwrite || !root.outputSet)) {
      patch.output = clean(io.output);
      root.traceIO.output = patch.output;
      root.outputSet = true;
    }
    if (Object.keys(patch).length === 0) return;
    try {
      root.obs.update(patch);
      // Nested subagent observations own their observation I/O, but must not
      // rewrite the Langfuse trace-level I/O owned by the initiating root.
      if (!root.parentRoot) root.obs.setTraceIO?.({ ...root.traceIO });
    } catch {
      // best-effort
    }
  }

  function fallbackContent(root) {
    if (
      !captureConversationContent ||
      !root ||
      typeof resolveContent !== "function"
    ) return undefined;
    try {
      return resolveContent(probe(root));
    } catch {
      return undefined;
    }
  }

  function unresolvedRootFallback(root) {
    const content = fallbackContent(root);
    if (!content) return undefined;
    return compact({
      input: !root.inputSet ? content.input : undefined,
      // An agent_end hook with no current-turn assistant message is an
      // authoritative no-answer result. Session/trajectory fallbacks are not
      // turn-bounded and could otherwise reuse an older assistant response.
      output:
        !root.outputSet && !root.conversationOutputResolved
          ? content.output
          : undefined,
    });
  }

  function fallbackToolIO(root, toolCallId) {
    if (!toolCallId || typeof resolveToolIO !== "function") return undefined;
    try {
      return resolveToolIO(root ? probe(root) : {})?.[toolCallId];
    } catch {
      return undefined;
    }
  }

  function applyToolIO(entry, io, overwrite = false) {
    if (!entry || !io) return;
    const patch = {};
    if (captureToolContent && io.input !== undefined && (overwrite || !entry.inputSet)) {
      patch.input = clean(io.input);
      entry.inputSet = true;
    }
    if (captureToolContent && io.output !== undefined && (overwrite || !entry.outputSet)) {
      patch.output = clean(io.output);
      entry.outputSet = true;
    }
    if (io.isError) {
      patch.level = "ERROR";
      entry.isError = true;
    }
    if (Object.keys(patch).length === 0) return;
    try {
      entry.obs.update(patch);
    } catch {
      // best-effort
    }
  }

  function ensureTool(evt, source) {
    const key = toolKey(evt);
    let entry = key ? toolsByKey.get(key) : undefined;
    if (!entry && evt?.toolCallId) {
      for (const candidate of new Set(toolsByKey.values())) {
        if (candidate.toolCallId !== evt.toolCallId) continue;
        if (candidate.runId && evt.runId && candidate.runId !== evt.runId) continue;
        if (candidate.traceId && traceIdOf(evt) && candidate.traceId !== traceIdOf(evt)) continue;
        entry = candidate;
        break;
      }
    }
    if (entry) {
      if (entry.root && evt?.toolName === "sessions_spawn") {
        entry.root.delegatedToSubagent = true;
      }
      if (key) {
        entry.toolKeys.add(key);
        toolsByKey.set(key, entry);
      }
      return touch(entry);
    }
    const root = ensureRoot(evt);
    if (root && evt?.toolName === "sessions_spawn") {
      root.delegatedToSubagent = true;
    }
    const asType = classifyToolType(evt?.toolName);
    entry = createChild(evt, root, {
      name: evt?.toolName ?? asType,
      asType,
      attributes: toolAttributes(evt),
      startMs:
        typeof evt?.durationMs === "number" && source === "diagnostic-terminal"
          ? evt.ts - evt.durationMs
          : evt?.ts,
    });
    entry.toolCallId = evt?.toolCallId;
    entry.toolKeys = new Set();
    entry.inputSet = false;
    entry.outputSet = false;
    if (key) {
      entry.toolKeys.add(key);
      toolsByKey.set(key, entry);
    }
    return entry;
  }

  function generationList(runId, root) {
    if (root) {
      if (runId) generationsByRun.set(runId, root.generations);
      return root.generations;
    }
    if (!runId) return [];
    let list = generationsByRun.get(runId);
    if (!list) {
      list = [];
      generationsByRun.set(runId, list);
    }
    return list;
  }

  function createGeneration(evt, root, attributes = {}, startMs = evt?.ts) {
    const entry = createChild(evt, root, {
      name: evt?.model ?? "model",
      asType: "generation",
      attributes: compact({
        model: evt?.model,
        ...attributes,
        metadata: compact({ provider: evt?.provider, runId: evt?.runId }),
      }),
      startMs,
    });
    entry.inputSet = attributes.input !== undefined;
    entry.outputSet = attributes.output !== undefined;
    entry.outputEventReceived = attributes.output !== undefined;
    entry.diagnosticCompleted = false;
    const list = generationList(evt?.runId, root);
    entry.sequence = list.length + 1;
    list.push(entry);
    return entry;
  }

  function generationForOutput(evt, root) {
    const list = generationList(evt?.runId, root);
    const match = list.find((entry) => !entry.outputEventReceived && !entry.ended);
    return match ?? createGeneration(evt, root);
  }

  function finishTool(entry, root) {
    if (!entry || entry.ended || !entry.diagnosticTerminal) return;
    // Async diagnostics normally preserve started -> terminal ordering, but a
    // delayed/dropped start must not let a terminal hook close the span before
    // a late started event can enrich it. run.completed is the bounded fallback.
    if (!entry.diagnosticStarted && root && !root.runCompleted) return;
    applyToolIO(entry, fallbackToolIO(root, entry.toolCallId));
    endEntry(entry, entry.completedMs ?? now(), true);
  }

  function finishGeneration(entry) {
    if (!entry || entry.ended || !entry.diagnosticCompleted) return;
    if (entry.expectsHookIO && (!entry.inputSet || !entry.outputEventReceived)) return;
    endEntry(entry, entry.diagnosticCompletedMs ?? entry.completedMs ?? now());
  }

  function finishRootChildren(root) {
    for (const child of [...root.children]) {
      if (child.ended) continue;
      if (child.kind === "tool" || child.kind === "retriever") {
        // Tool diagnostics own status and end timing. When hooks participated,
        // keep the observation open until both streams have reached terminal.
        if (!child.diagnosticTerminal) continue;
        if (child.hookStarted && !child.hookTerminal) continue;
        finishTool(child, root);
      } else if (child.kind === "generation") {
        // A root may end before the outer model.usage event. Do not close a
        // hook-created generation until that diagnostic has supplied usage/cost.
        finishGeneration(child);
      }
    }
  }

  function finalizeTrace(root) {
    if (!root || root.ended) return;
    // llm_output is reliable enough to retain as a late-finalization fallback,
    // but it can describe the handoff text of a sessions_spawn run. Promote it
    // only after the run has been classified as a normal, non-delegating turn.
    if (
      !root.outputSet &&
      root.llmOutputCandidate !== undefined &&
      !root.delegatedToSubagent
    ) {
      updateRootIO(root, { output: root.llmOutputCandidate });
    }
    if (!root.inputSet || (!root.outputSet && !root.conversationOutputResolved)) {
      updateRootIO(root, unresolvedRootFallback(root));
    }
    finishRootChildren(root);
    endEntry(root, root.endMs ?? now(), true);
  }

  // Diagnostic event handlers ------------------------------------------------

  function onRunStarted(evt) {
    ensureRoot(evt);
  }

  function onRunCompleted(evt) {
    const root = ensureRoot(evt);
    if (!root) return;
    root.runCompleted = true;
    root.endMs = evt.ts;
    try {
      root.obs.update({
        metadata: compact({ outcome: evt.outcome, durationMs: evt.durationMs }),
        ...(evt.outcome === "error" ? { level: "ERROR" } : {}),
      });
    } catch {
      // best-effort
    }
    if (!root.finalizeScheduled) {
      root.finalizeScheduled = true;
      defer(() => finalizeTrace(root));
    }
  }

  function onModelUsage(evt) {
    const root = ensureRoot(evt);
    const candidates = root ? generationList(root.runId, root) : generationList(evt?.runId);
    let entry = candidates.findLast((candidate) => !candidate.ended);
    let content;
    if (!entry) {
      const expectsHookIO = conversationHooksEnabled && Boolean(root || evt?.runId);
      // When raw hooks are enabled, model.usage can arrive before agent_end.
      // Do not let a session-wide fallback commit an older turn's output in
      // that window; root finalization will apply fallback only if completion
      // hooks never resolve the output.
      if (root) {
        if (!expectsHookIO) content = unresolvedRootFallback(root);
      } else if (captureConversationContent) {
        try {
          content = resolveContent?.(evt);
        } catch {
          content = undefined;
        }
      }
      entry = createGeneration(
        evt,
        root,
        expectsHookIO
          ? {}
          : compact({ input: content?.input, output: content?.output }),
        typeof evt.durationMs === "number" ? evt.ts - evt.durationMs : evt.ts,
      );
      entry.syntheticUsage = expectsHookIO;
      entry.expectsHookIO = expectsHookIO;
      entry.completedMs = evt.ts;
    }

    const aggregateUsage = usageDetails(evt.usage);
    const usagePatch = !entry.hookUsageSet || candidates.length <= 1 ? aggregateUsage : undefined;
    try {
      entry.obs.update(
        compact({
          model: evt.model,
          usageDetails: usagePatch,
          costDetails:
            typeof evt.costUsd === "number" ? { totalCost: evt.costUsd } : undefined,
          metadata: compact({
            provider: evt.provider,
            promptTokens: evt.usage?.promptTokens,
            contextLimit: evt.context?.limit,
            contextUsed: evt.context?.used,
            durationMs: evt.durationMs,
            ...(candidates.length > 1 ? { turnUsage: aggregateUsage } : {}),
          }),
        }),
      );
    } catch {
      // best-effort
    }

    if (root) updateRootIO(root, content);
    else {
      const io = compact({ input: content?.input, output: content?.output });
      if (Object.keys(io).length > 0) entry.obs.setTraceIO?.(io);
    }

    const turnGenerations = candidates.length > 0 ? candidates : [entry];
    for (const generation of turnGenerations) {
      generation.diagnosticCompleted = true;
      generation.diagnosticCompletedMs = evt.ts;
      finishGeneration(generation);
    }
  }

  function onModelCallError(evt) {
    const root = ensureRoot(evt);
    endEntry(
      createChild(evt, root, {
        name: "model.call.error",
        asType: "span",
        attributes: errorAttributes(evt),
      }),
      evt.ts,
    );
  }

  function onToolStarted(evt) {
    const entry = ensureTool(evt, "diagnostic-start");
    entry.diagnosticStarted = true;
    try {
      entry.obs.update(toolAttributes(evt));
    } catch {
      // best-effort
    }
    if (entry.diagnosticTerminal && entry.hookTerminal) finishTool(entry, entry.root);
  }

  function onToolTerminal(evt) {
    const entry = ensureTool(evt, "diagnostic-terminal");
    const root = entry.root ?? ensureRoot(evt);
    const isError = evt.type === "tool.execution.error" || evt.type === "tool.execution.blocked";
    entry.completedMs = evt.ts;
    entry.diagnosticTerminal = true;
    entry.isError ||= isError;
    try {
      entry.obs.update(
        compact({
          level: isError ? "ERROR" : undefined,
          statusMessage: evt.errorCategory ?? evt.deniedReason ?? evt.reason,
          metadata: compact({
            durationMs: evt.durationMs,
            errorCategory: evt.errorCategory,
            errorCode: evt.errorCode,
            deniedReason: evt.deniedReason,
          }),
        }),
      );
    } catch {
      // best-effort
    }
    if (isError) applyToolIO(entry, { isError: true });
    if (entry.hookTerminal || (!entry.hookStarted && root?.runCompleted)) {
      finishTool(entry, root);
    } else if (!root) {
      defer(() => {
        if (!entry.hookStarted) finishTool(entry, null);
      });
    }
  }

  function onContextAssembled(evt) {
    const root = ensureRoot(evt);
    endEntry(
      createChild(evt, root, {
        name: "context.assembled",
        asType: "span",
        attributes: compact({ ...contextAttributes(evt), output: contextSummary(evt) }),
      }),
      evt.ts,
    );
  }

  function rememberSubagent(info) {
    if (!info) return;
    info.lastMs = now();
    if (info.runId) subagentsByRun.set(info.runId, info);
    if (info.childSessionKey) subagentsBySession.set(info.childSessionKey, info);
  }

  function onSubagentSpawned(evt) {
    const childSessionKey = evt.childSessionKey ?? evt.sessionKey;
    const existing =
      (evt.runId && subagentsByRun.get(evt.runId)) ||
      (childSessionKey && subagentsBySession.get(childSessionKey));
    const parentRoot = findRootBySession(evt.requesterSessionKey, evt.runId);
    if (parentRoot) {
      parentRoot.delegatedToSubagent = true;
      touch(parentRoot);
    }
    const info = {
      ...existing,
      runId: evt.runId ?? existing?.runId,
      childSessionKey: childSessionKey ?? existing?.childSessionKey,
      requesterSessionKey: evt.requesterSessionKey ?? existing?.requesterSessionKey,
      parentRunId: parentRoot?.runId ?? existing?.parentRunId,
      agentId: evt.agentId ?? existing?.agentId,
      label: evt.label ?? existing?.label,
      mode: evt.mode ?? existing?.mode,
      resolvedModel: evt.resolvedModel ?? existing?.resolvedModel,
      resolvedProvider: evt.resolvedProvider ?? existing?.resolvedProvider,
    };
    rememberSubagent(info);

    // Do not synthesize the child observation here. Its first agent/diagnostic
    // event owns the real start time and can use the relationship just stored.
    // If that event raced ahead, enrich the already-created observation.
    const root =
      (info.runId && rootsByRun.get(info.runId)) ||
      findRootBySession(info.childSessionKey);
    updateSubagentMetadata(root, info);
  }

  function onSubagentEnded(evt) {
    const childSessionKey = evt.targetSessionKey ?? evt.childSessionKey ?? evt.sessionKey;
    const existing =
      (evt.runId && subagentsByRun.get(evt.runId)) ||
      (childSessionKey && subagentsBySession.get(childSessionKey));
    const parentRoot = findRootBySession(existing?.requesterSessionKey, evt.runId);
    const info = {
      ...existing,
      runId: evt.runId ?? existing?.runId,
      childSessionKey: childSessionKey ?? existing?.childSessionKey,
      parentRunId: existing?.parentRunId ?? parentRoot?.runId,
      outcome: evt.outcome ?? existing?.outcome,
      reason: evt.reason ?? existing?.reason,
      error: evt.error ?? existing?.error,
      ended: true,
      endedAt: evt.endedAt ?? existing?.endedAt,
    };
    rememberSubagent(info);

    const root =
      (info.runId && rootsByRun.get(info.runId)) ||
      findRootBySession(info.childSessionKey) ||
      ensureRoot(
        {
          ...evt,
          runId: info.runId,
          sessionKey: info.childSessionKey,
        },
        parentRoot,
      );
    updateSubagentMetadata(root, info);
    if (root && (info.outcome === "error" || info.outcome === "timeout" || info.error)) {
      try {
        root.obs.update({
          level: "ERROR",
          statusMessage: info.error ? clean(info.error) : info.outcome,
        });
      } catch {
        // best-effort
      }
    }
    // The child run's diagnostic run.completed remains authoritative for its
    // observation end time. subagent_ended contributes relationship/status only.
  }

  // Typed hook handlers ------------------------------------------------------

  function onBeforeAgentRun(evt) {
    const root = ensureRoot(evt);
    if (!root || !captureConversationContent) return;
    root.agentStartMessageCount = Array.isArray(evt.messages) ? evt.messages.length : undefined;
    updateRootIO(root, { input: evt.prompt });
    try {
      root.obs.update({
        metadata: compact({
          hookInputCaptured: true,
          historyMessageCount: Array.isArray(evt.messages) ? evt.messages.length : undefined,
          hasSystemPrompt: typeof evt.systemPrompt === "string",
        }),
      });
    } catch {
      // best-effort
    }
  }

  function onLlmInput(evt) {
    const root = ensureRoot(evt);
    if (!captureConversationContent) return;
    const list = generationList(evt.runId, root);
    let entry = list.find(
      (item) => !item.ended && !item.inputSet && (item.syntheticOutput || item.syntheticUsage),
    );
    const input = clean(
      compact({
        systemPrompt: evt.systemPrompt,
        prompt: evt.prompt,
        historyMessages: evt.historyMessages,
        tools: evt.tools,
        imagesCount: evt.imagesCount,
      }),
    );
    if (!entry) entry = createGeneration(evt, root, { input });
    else {
      entry.inputSet = true;
      entry.syntheticOutput = false;
      entry.syntheticUsage = false;
      try {
        entry.obs.update({ input });
      } catch {
        // best-effort
      }
      finishGeneration(entry);
    }
    entry.expectsHookIO = true;
    updateRootIO(root, { input: evt.prompt });
  }

  function onLlmOutput(evt) {
    const root = ensureRoot(evt);
    if (!captureConversationContent) return;
    const entry = generationForOutput(evt, root);
    entry.expectsHookIO = true;
    const output = outputFromLlmEvent(evt);
    entry.outputSet = output !== undefined;
    entry.outputEventReceived = true;
    entry.syntheticOutput = !entry.inputSet;
    entry.completedMs = evt.ts;
    entry.hookUsageSet = evt.usage !== undefined;
    try {
      entry.obs.update(
        compact({
          output: output !== undefined ? clean(output) : undefined,
          model: evt.model,
          usageDetails: evt.usage ? usageDetails(evt.usage) : undefined,
          metadata: compact({
            provider: evt.provider,
            resolvedRef: evt.resolvedRef,
            harnessId: evt.harnessId,
          }),
        }),
      );
    } catch {
      // best-effort
    }
    finishGeneration(entry);
    const finalText = Array.isArray(evt.assistantTexts)
      ? evt.assistantTexts.filter((text) => typeof text === "string" && text.trim()).at(-1)
      : messageText(evt.lastAssistant);
    if (root && finalText) root.llmOutputCandidate = clean(finalText);
  }

  function onBeforeAgentFinalize(evt) {
    const root = ensureRoot(evt);
    if (!root || !captureConversationContent) return;
    const output =
      (typeof evt.lastAssistantMessage === "string" && evt.lastAssistantMessage.trim()) ||
      lastAssistantText(evt.messages);
    if (output) updateRootIO(root, { output }, true);
  }

  function onAgentEnd(evt) {
    const root = ensureRoot(evt);
    if (!root) return;
    root.agentEnded = true;
    let output;
    if (captureConversationContent && evt.success !== false && !root.outputSet) {
      const messages = Array.isArray(evt.messages) ? evt.messages : [];
      const currentTurnMessages =
        Number.isInteger(root.agentStartMessageCount) &&
        messages.length >= root.agentStartMessageCount
        ? messages.slice(root.agentStartMessageCount)
        : messages;
      output = lastAssistantText(currentTurnMessages);
    }
    if (output) updateRootIO(root, { output }, true);
    if (captureConversationContent) root.conversationOutputResolved = true;
    try {
      root.obs.update({
        ...(evt.success === false ? { level: "ERROR", statusMessage: clean(evt.error) } : {}),
        metadata: compact({
          success: evt.success,
          durationMs: evt.durationMs,
          noAnswer: !root.outputSet,
          aborted: evt.success === false && /abort|cancel|stop/i.test(evt.error ?? ""),
        }),
      });
    } catch {
      // best-effort
    }
    // run.completed remains authoritative for the root end timestamp. Agent
    // hooks only make its I/O complete; they never end a run on their own.
    if (root.runCompleted) defer(() => finalizeTrace(root));
  }

  function onBeforeToolCall(evt) {
    const entry = ensureTool(evt, "hook-before");
    entry.hookStarted = true;
    if (captureToolContent) applyToolIO(entry, { input: evt.params }, true);
    try {
      entry.obs.update({
        metadata: compact({
          toolCallId: evt.toolCallId,
          runId: evt.runId,
          ioSource: captureToolContent ? "hook" : undefined,
        }),
      });
    } catch {
      // best-effort
    }
  }

  function onAfterToolCall(evt) {
    const entry = ensureTool(evt, "hook-after");
    entry.hookTerminal = true;
    entry.hookCompletedMs = evt.ts;
    const isError = Boolean(evt.error);
    if (captureToolContent) {
      applyToolIO(
        entry,
        {
          input: evt.params,
          output: evt.result !== undefined ? evt.result : evt.error,
          isError,
        },
        true,
      );
    } else if (isError) {
      applyToolIO(entry, { isError: true });
    }
    try {
      entry.obs.update(
        compact({
          level: isError ? "ERROR" : undefined,
          statusMessage: isError ? clean(evt.error) : undefined,
          metadata: compact({ durationMs: evt.durationMs }),
        }),
      );
    } catch {
      // best-effort
    }
    if (entry.diagnosticTerminal) finishTool(entry, entry.root);
  }

  function handle(evt) {
    try {
      switch (evt?.type) {
        case "run.started":
          onRunStarted(evt);
          return true;
        case "run.completed":
          onRunCompleted(evt);
          return true;
        case "model.call.error":
          onModelCallError(evt);
          return true;
        case "model.usage":
          onModelUsage(evt);
          return true;
        case "tool.execution.started":
          onToolStarted(evt);
          return true;
        case "tool.execution.completed":
        case "tool.execution.error":
        case "tool.execution.blocked":
          onToolTerminal(evt);
          return true;
        case "context.assembled":
          onContextAssembled(evt);
          return true;
        default:
          return false;
      }
    } catch (err) {
      logger?.error?.(
        `langfuse-bridge: diagnostic handler failed (${evt?.type}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  function handleHook(name, event, ctx) {
    const evt = mergeHookEvent(event, ctx, now);
    try {
      switch (name) {
        case "subagent_spawned":
          onSubagentSpawned(evt);
          return true;
        case "subagent_ended":
          onSubagentEnded(evt);
          return true;
        case "before_agent_run":
          onBeforeAgentRun(evt);
          return true;
        case "llm_input":
          onLlmInput(evt);
          return true;
        case "llm_output":
          onLlmOutput(evt);
          return true;
        case "before_agent_finalize":
          onBeforeAgentFinalize(evt);
          return true;
        case "agent_end":
          onAgentEnd(evt);
          return true;
        case "before_tool_call":
          onBeforeToolCall(evt);
          return true;
        case "after_tool_call":
          onAfterToolCall(evt);
          return true;
        default:
          return false;
      }
    } catch (err) {
      logger?.error?.(
        `langfuse-bridge: hook handler failed (${name}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  function sweep(nowMs = now()) {
    const cutoff = nowMs - ttlMs;
    for (const entry of [...live]) {
      if (entry.lastMs >= cutoff) continue;
      if (entry.ended) forget(entry);
      else if (entry.kind === "root") finalizeTrace(entry);
      else endEntry(entry, entry.completedMs ?? nowMs);
    }
    for (const [runId, entries] of generationsByRun) {
      const retained = entries.filter((entry) => live.has(entry));
      if (retained.length > 0) generationsByRun.set(runId, retained);
      else generationsByRun.delete(runId);
    }
    for (const info of new Set([
      ...subagentsByRun.values(),
      ...subagentsBySession.values(),
    ])) {
      const childRoot = info.runId ? rootsByRun.get(info.runId) : undefined;
      if (info.lastMs >= cutoff || (childRoot && !childRoot.ended)) continue;
      if (info.runId && subagentsByRun.get(info.runId) === info) {
        subagentsByRun.delete(info.runId);
      }
      if (
        info.childSessionKey &&
        subagentsBySession.get(info.childSessionKey) === info
      ) {
        subagentsBySession.delete(info.childSessionKey);
      }
    }
  }

  function flushAll() {
    for (const entry of [...live]) {
      if (entry.kind === "root" && !entry.ended) finalizeTrace(entry);
    }
    const time = now();
    for (const entry of [...live]) {
      if (entry.ended) forget(entry);
      else endEntry(entry, entry.completedMs ?? time);
    }
    generationsByRun.clear();
    subagentsByRun.clear();
    subagentsBySession.clear();
  }

  return { handle, handleHook, sweep, flushAll };
}

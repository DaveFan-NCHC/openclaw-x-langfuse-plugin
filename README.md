# openclaw-x-langfuse-plugin

Correlate [OpenClaw](https://openclaw.ai) hooks and diagnostics in
[Langfuse](https://langfuse.com).

The plugin registers a background service that subscribes to OpenClaw's internal
diagnostics bus and reconstructs each turn as a **nested Langfuse trace**: one
root per turn (grouped by the W3C trace id OpenClaw stamps on every event), with
a child observation for every model call, tool call, and retrieval step in it.
Traces are tagged with the OpenClaw session id so a conversation's turns group
together in Langfuse's Sessions view.

Crucially, **tool calls and RAG/retrieval steps appear as their own
observations** (`tool` and `retriever` types) nested under the run — so you can
see the retrieval that fed a generation instead of the context just appearing in
the next prompt out of nowhere.

Built on the Langfuse **v5 SDK** (OpenTelemetry-based), so traces appear in
Langfuse's new observations-first ("fast") UI. The Langfuse `SpanProcessor` runs
on a dedicated, isolated OTel `TracerProvider` (`setLangfuseTracerProvider`) so
it never touches the global OpenTelemetry state OpenClaw's bundled
`diagnostics-otel` service owns.

It subscribes via the public `onInternalDiagnosticEvent` SDK export. (The
`ctx.internalDiagnostics.onEvent` capability is privileged — the runtime injects
it only for the bundled `diagnostics-otel`/`diagnostics-prometheus` services, so
third-party plugins never receive it.) The public listener delivers the
`run.*`, `model.usage`, `tool.execution.*`, `context.assembled`, and
`model.call.error` event bodies this bridge maps (minus private message content
— see below).

## Install

```bash
openclaw plugins install openclaw-x-langfuse-plugin
```

OpenClaw resolves through ClawHub first and falls back to npm. For local
development, install from a path with `--link`:

```bash
openclaw plugins install ./openclaw-x-langfuse-plugin --link
```

## Configure

Enable the plugin and provide Langfuse credentials in `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["langfuse-bridge"],
    "entries": {
      "langfuse-bridge": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "publicKey": "pk-lf-...",
          "secretKey": "sk-lf-...",
          "baseUrl": "https://cloud.langfuse.com"
        }
      }
    }
  }
}
```

Credentials may also be supplied via environment variables, which take effect
when the corresponding config field is absent:

| Config field | Environment fallback   | Default                        |
| ------------ | ---------------------- | ------------------------------ |
| `publicKey`  | `LANGFUSE_PUBLIC_KEY`  | —                              |
| `secretKey`  | `LANGFUSE_SECRET_KEY`  | —                              |
| `baseUrl`    | `LANGFUSE_BASE_URL`    | `https://cloud.langfuse.com`   |

Raw agent/generation I/O is available only when
`plugins.entries.langfuse-bridge.hooks.allowConversationAccess` is explicitly
`true`. Without it, the plugin still starts and tool hooks still capture tool
I/O; OpenClaw diagnostic events continue to provide trace structure, usage,
cost, timing, and status.

Content capture can be constrained independently:

| Config field                  | Default | Effect |
| ----------------------------- | ------- | ------ |
| `captureConversationContent`  | `true`  | Capture agent and generation prompt/response content. |
| `captureToolContent`          | `true`  | Capture tool arguments and results. |
| `transcriptFallback`          | `true`  | Use bounded session JSONL, then legacy trajectory, only for missing hook fields. |
| `maxContentBytes`             | `64000` | Maximum sanitized bytes per input/output field. |

Then restart the gateway:

```bash
openclaw gateway restart
```

If `publicKey`/`secretKey` are missing, the service logs a warning and does not
start — it never blocks the gateway.

## What gets sent

Each OpenClaw turn becomes one Langfuse trace (keyed by the shared W3C trace id),
named after the channel, with `session.id` set to the OpenClaw session id so a
conversation's turns group in the Sessions view. Under that root:

- **Turn root** (`agent`) — anchored by `run.started`/`run.completed`, with
  `outcome` and `durationMs`. Its trace-level input/output mirror the turn's
  prompt from `before_agent_run` and final response from `agent_end` or
  `before_agent_finalize`. (OpenClaw's per-event span parents are inconsistent
  — `model.usage` hangs off the harness span while tools hang off the run span —
  so children are attached directly to this one root rather than reconstructing
  that internal chain.)
- **Generation** — one observation per `llm_input`/`llm_output` hook pair.
  `model.usage` supplements it with `usageDetails`, aggregate turn usage,
  `costDetails.totalCost` (USD), timing, and provider metadata; it does not
  supply prompt/response content.
- **Tool / Retriever** — one observation per `tool.execution.*`, named after the
  tool. Retrieval/search tools (vector search, RAG, grep, web fetch, memory
  recall, …) are classified as Langfuse `retriever` observations; everything else
  is a `tool`. Carries `toolSource`, `paramsSummary`, duration, and — when
  recoverable — arguments from `before_tool_call` and result/error from
  `after_tool_call` as input/output. Calls are paired by `toolCallId`, including
  parallel and out-of-order delivery.
- **Context** — `context.assembled` becomes a short span with message/prompt
  size metadata.
- **Errors** — `model.call.error` becomes an ERROR observation with the failure
  category/kind.

Raw hook content is sanitized before export: credential/token/header fields are
redacted, images/base64/binary are omitted, and each input/output is size
bounded. Hook handlers never log full content or mutate OpenClaw payloads.

If a hook field is unavailable, the bridge can parse the canonical per-session
`<sessionId>.jsonl` transcript once per run, then consult the legacy trajectory
as a final fallback. The trajectory `messagesSnapshot` is not considered a
complete conversation because OpenClaw truncates arrays to 64 entries. If no
content is available, the observation is still forwarded with empty I/O.

### Robustness

OpenClaw delivers hooks and `tool.execution.*` events asynchronously
(they're queued and can be dropped under heavy load), while `run.*` and
`model.usage` are synchronous — so `run.completed` reaches the bridge *before*
its own tool events, and `model.usage` arrives *after* it. The engine handles
this with `traceId`, `runId`, `toolCallId`, `sessionId`, and `sessionKey`
indexes. A terminal event received before its start/hook enriches the same
observation rather than creating a duplicate, and an idle reaper closes any
observation orphaned by a dropped terminal event.

## How it works

```js
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, setLangfuseTracerProvider } from "@langfuse/tracing";
import { createTraceEngine } from "./tracer.js";

let engine;
api.on("before_tool_call", (event, ctx) =>
  engine?.handleHook("before_tool_call", event, ctx));
api.on("after_tool_call", (event, ctx) =>
  engine?.handleHook("after_tool_call", event, ctx));
// Conversation hooks are registered the same way when access is allowed.

api.registerService({
  id: "langfuse-bridge",
  start(ctx) {
    // Isolated OTel pipeline -> never touches OpenClaw's global tracer provider.
    const provider = new NodeTracerProvider({
      spanProcessors: [new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl })],
    });
    setLangfuseTracerProvider(provider);

    // The engine groups observations into one trace per turn, keyed by the W3C
    // trace id OpenClaw stamps on every event, and attaches model.usage /
    // tool.execution.* / context.assembled as children of that turn root.
    engine = createTraceEngine({ startObservation }, { /* resolvers */ });
    const unsubscribe = onInternalDiagnosticEvent((evt) => engine.handle(evt));
    setInterval(() => engine.sweep(), 60_000).unref(); // reap orphans
  },
});
```

## License

MIT

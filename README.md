# openclaw-x-langfuse-plugin

Forward [OpenClaw](https://openclaw.ai) model-usage diagnostics to
[Langfuse](https://langfuse.com).

The plugin registers a background service that subscribes to OpenClaw's internal
diagnostics bus and translates `model.usage` events into Langfuse generations
(token usage + cost), tagged with the OpenClaw session id so a conversation's
turns group together in Langfuse's Sessions view. `model.call.error` events are
forwarded as Langfuse error observations.

Built on the Langfuse **v5 SDK** (OpenTelemetry-based), so traces appear in
Langfuse's new observations-first ("fast") UI in real time. The Langfuse
`SpanProcessor` runs on a dedicated, isolated OTel `TracerProvider`
(`setLangfuseTracerProvider`) so it never touches the global OpenTelemetry state
OpenClaw's bundled `diagnostics-otel` service owns.

It subscribes via the public `onInternalDiagnosticEvent` SDK export. (The
`ctx.internalDiagnostics.onEvent` capability is privileged — the runtime injects
it only for the bundled `diagnostics-otel`/`diagnostics-prometheus` services, so
third-party plugins never receive it.) The public listener delivers the same
`model.usage` event bodies this bridge maps.

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

Then restart the gateway:

```bash
openclaw gateway restart
```

If `publicKey`/`secretKey` are missing, the service logs a warning and does not
start — it never blocks the gateway.

## What gets sent

For each `model.usage` diagnostic event:

- **Trace** — one root generation per turn, named after the channel, with
  `session.id` set to the OpenClaw session id so a conversation's turns group in
  the Sessions view.
- **Generation** — `model`, `usageDetails` (`input`, `output`, `cache_read`,
  `cache_write`, `total`), `costDetails.totalCost` (USD), start/end time from the
  event timestamp and duration, plus provider/channel/agent metadata.
- **Generation input/output** — the turn's prompt and response text. OpenClaw
  does not deliver message content to third-party plugins, so this is recovered
  best-effort from the per-session trajectory transcript
  (`<stateDir>/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl`). If the
  transcript is unavailable, usage/cost are still forwarded with empty
  input/output.

## How it works

```js
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, setLangfuseTracerProvider } from "@langfuse/tracing";

api.registerService({
  id: "langfuse-bridge",
  start(ctx) {
    // Isolated OTel pipeline -> never touches OpenClaw's global tracer provider.
    const provider = new NodeTracerProvider({
      spanProcessors: [new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl })],
    });
    setLangfuseTracerProvider(provider);

    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "model.usage") {
        const gen = startObservation(evt.model, { model: evt.model, usageDetails, costDetails }, { asType: "generation" });
        gen.otelSpan.setAttribute("session.id", evt.sessionId); // group by session
        gen.end();
      }
    });
  },
});
```

> Note: `model.usage` is emitted on OpenClaw's reply/delivery path (channel
> messages, webchat/TUI turns) — not on direct `openclaw agent` CLI runs, which
> use the embedded runner and don't emit it.

## License

MIT

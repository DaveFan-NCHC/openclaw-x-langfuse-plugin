# openclaw-x-langfuse-plugin

Forward [OpenClaw](https://openclaw.ai) model-usage diagnostics to
[Langfuse](https://langfuse.com).

The plugin registers a background service that subscribes to OpenClaw's internal
diagnostics bus and translates `model.usage` events into Langfuse generations
(token usage + cost), grouped into a trace per OpenClaw session. `model.call.error`
events are forwarded as Langfuse error events.

It uses the same diagnostics surface (`ctx.internalDiagnostics.onEvent`) that the
bundled `@openclaw/diagnostics-otel` plugin uses, so the event wiring is the
supported one rather than a guess.

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

- **Trace** — id and `sessionId` set to the OpenClaw session id (so a session's
  calls coalesce into one trace), named after the channel.
- **Generation** — `model`, `usageDetails` (`input`, `output`, `cache_read`,
  `cache_write`, `total`), `costDetails.total` (USD), start/end time from the
  event timestamp and duration, plus provider/channel/agent metadata.

No prompt or completion content is captured; only usage, cost, and timing
metadata cross the bridge.

## How it works

```js
api.registerService({
  id: "langfuse-bridge",
  start(ctx) {
    const unsubscribe = ctx.internalDiagnostics.onEvent((evt) => {
      if (evt.type === "model.usage") {
        // -> langfuse trace.generation({ model, usageDetails, costDetails })
      }
    });
  },
});
```

## License

MIT

// Drive a REAL chat turn through the running gateway via OpenClaw's own
// GatewayChatClient (the same client the TUI/webchat use). This routes through
// getReply -> runReplyAgent, which emits the `model.usage` diagnostic the
// langfuse-bridge plugin forwards.
//
// Run: node scripts/send-chat.mjs <sessionKey> <message>

import { GatewayChatClient } from "/usr/local/lib/node_modules/openclaw/dist/gateway-chat-BzLkGOHy.js";

const sessionKey = process.argv[2] ?? `livetest-${Date.now()}`;
const message = process.argv[3] ?? "Reply with exactly one word: livehello";

const client = await GatewayChatClient.connect({});
client.onEvent = (e) => {
  if (e?.event && /reply|assistant|run\.(completed|error)|error/i.test(String(e.event))) {
    console.log("[event]", e.event);
  }
};
client.onDisconnected = (r) => console.log("[disconnected]", r);
client.start();
await client.waitForReady();
console.log("connected; sending chat on sessionKey:", sessionKey);

const { runId } = await client.sendChat({
  sessionKey,
  message,
  deliver: false,
  timeoutMs: 90000,
});
console.log("sent runId:", runId);

// Give the gateway time to run the model turn + emit model.usage.
await new Promise((r) => setTimeout(r, 30000));
client.stop();
console.log("done");
process.exit(0);

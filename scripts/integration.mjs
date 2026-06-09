// End-to-end integration check (not shipped in the published package).
//
// Drives the REAL plugin entry (definePluginEntry/registerService/start)
// against the REAL OpenClaw diagnostics bus, with a real Langfuse client
// pointed at a local capture server. Emits a synthetic `model.usage` event and
// asserts that a Langfuse generation reaches the wire.
//
// Run: node scripts/integration.mjs

import http from "node:http";
import { once } from "node:events";
import * as bus from "/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/diagnostic-runtime.js";
import pluginEntry from "../index.js";

const PORT = 3999;

// --- 1. Local capture server standing in for Langfuse ingestion ---------------
const captured = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.includes("/ingestion")) {
      try {
        captured.push(JSON.parse(body));
      } catch {
        captured.push({ raw: body });
      }
    }
    res.writeHead(207, { "content-type": "application/json" });
    res.end(JSON.stringify({ successes: [], errors: [] }));
  });
});
server.listen(PORT);
await once(server, "listening");

// --- 2. Register the real plugin and start its service ------------------------
let service = null;
const fakeApi = {
  pluginConfig: {
    publicKey: "pk-lf-integration",
    secretKey: "sk-lf-integration",
    baseUrl: `http://localhost:${PORT}`,
  },
  registerService: (svc) => {
    service = svc;
  },
};

// definePluginEntry returns a module descriptor with register(api).
pluginEntry.register(fakeApi);
if (!service) throw new Error("FAIL: plugin did not register a service");
if (service.id !== "langfuse-bridge")
  throw new Error(`FAIL: unexpected service id ${service.id}`);

// ctx wired to the REAL diagnostics bus, exactly as the gateway provides it.
const ctx = {
  config: {},
  stateDir: "/tmp",
  logger: {
    info: (m) => console.log("[info]", m),
    warn: (m) => console.log("[warn]", m),
    error: (m) => console.log("[error]", m),
  },
  internalDiagnostics: {
    onEvent: bus.onInternalDiagnosticEvent,
    emit: bus.emitDiagnosticEvent,
  },
};

await service.start(ctx);

// --- 3. Emit a synthetic model.usage event through the real bus ---------------
bus.emitTrustedDiagnosticEvent({
  type: "model.usage",
  ts: Date.now(),
  seq: 1,
  sessionId: "integration-session",
  channel: "imessage",
  agentId: "agent-1",
  provider: "anthropic",
  model: "claude-opus-4-8",
  usage: { input: 1200, output: 340, cacheRead: 50, total: 1540 },
  context: { limit: 200000, used: 1540 },
  costUsd: 0.0123,
  durationMs: 4200,
});

// Allow the listener to run, then flush Langfuse via the service's stop().
await new Promise((r) => setTimeout(r, 100));
await service.stop();
await new Promise((r) => setTimeout(r, 200));
server.close();

// --- 4. Assert a generation reached the wire ----------------------------------
const batchItems = captured.flatMap((c) => c.batch ?? []);
const types = batchItems.map((i) => i.type);
const gen = batchItems.find(
  (i) =>
    (i.type === "generation-create" || i.type === "observation-create") &&
    i.body?.model === "claude-opus-4-8",
);

console.log("\n--- captured ingestion item types ---");
console.log(types.length ? types.join(", ") : "(none)");

if (!gen) {
  console.error(
    "\nFAIL: no Langfuse generation for the emitted model.usage event reached the wire.",
  );
  console.error(JSON.stringify(captured, null, 2).slice(0, 2000));
  process.exit(1);
}

console.log("\n--- generation body ---");
console.log(
  JSON.stringify(
    {
      model: gen.body.model,
      usageDetails: gen.body.usageDetails,
      costDetails: gen.body.costDetails,
      metadata: gen.body.metadata,
    },
    null,
    2,
  ),
);

const ok =
  gen.body.usageDetails?.input === 1200 &&
  gen.body.usageDetails?.output === 340 &&
  gen.body.costDetails?.total === 0.0123;

if (!ok) {
  console.error("\nFAIL: generation reached the wire but fields are wrong.");
  process.exit(1);
}

console.log(
  "\nPASS: real diagnostics bus -> plugin service -> Langfuse generation on the wire, fields correct.",
);
process.exit(0);

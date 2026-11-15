// Offline acceptance harness: the REAL pinned @opencode/ai v2.2.5 native
// Responses provider serializes requests, the REAL Broker (capabilities,
// parser, server) admits/rejects them, and a scripted fake upstream replaces
// Cloudflare. OpenCode Core is NOT available as a package, so the Core steps
// (context hook -> tool definitions, model/http hooks, identity dispatch,
// model-over-provider compatibility merge) are emulated by ./harness.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ai, LanguageModel, ToolDefinition } from "@opencode/ai";
import { Host } from "@opencode/plugin/host";
import { createCapabilityStore } from "../../src/broker/capabilities.mjs";
import { parseBrokerRequest } from "../../src/broker/policy.mjs";
import { createCloudflareUpstream } from "../../src/broker/upstream.mjs";
import { createBrokerServer } from "../../src/broker/server.mjs";
import { createFakeCore } from "./harness.mjs";

export const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/guest");
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${"0".repeat(32)}/offline-gw`;
const encoder = new TextEncoder();

export const sse = (events) => events.map((o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`).join("");
export const completed = (id = "resp_x") => ({ type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
export const textEvents = (text = "gateway-ok", { reasoning } = {}) => [
  { type: "response.created", response: { id: "resp_t" } },
  ...(reasoning ? reasoningEvents(reasoning) : []),
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: text },
  { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
  completed("resp_t"),
];
export const reasoningEvents = (enc) => [
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: enc } },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "think" }], encrypted_content: enc } },
];
export const functionCallEvents = ({ name = "read_file", namespace = "guest", callId = "call_m2", args = '{"path":"fixture.txt"}', enc = "ENC-M2==" } = {}) => {
  const item = { type: "function_call", id: "fc_1", call_id: callId, name, ...(namespace === undefined ? {} : { namespace }), arguments: "" };
  return [
    { type: "response.created", response: { id: "resp_f" } },
    ...reasoningEvents(enc),
    { type: "response.output_item.added", output_index: 1, item },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: args },
    { type: "response.output_item.done", output_index: 1, item: { ...item, arguments: args, status: "completed" } },
    completed("resp_f"),
  ];
};

/** Real Broker on 127.0.0.1:0 with a scripted fake Cloudflare upstream. */
export async function startBroker() {
  const store = createCapabilityStore();
  const { token, id } = store.issue({
    sandboxID: "offline-guest", model: "gpt-6-luna", ttlMs: 60_000, maxCalls: 100, maxCallsPerWindow: 100, windowMs: 1000,
    maxConcurrent: 2, maxRequestBytes: 256 * 1024, maxResponseBytes: 256 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxRequestDurationMs: 10_000,
  });
  const inbound = []; // raw serialized SDK bodies as received by the Broker
  const upstream = []; // SIWC bodies the Broker would send to Cloudflare
  const script = [];
  const fetchImpl = async (url, init) => {
    upstream.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const text = script.shift() ?? sse(textEvents());
    return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(text)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const server = createBrokerServer({
    capabilities: store,
    parseRequest: (args) => {
      inbound.push(JSON.parse(Buffer.from(args.body).toString("utf8")));
      return parseBrokerRequest(args);
    },
    upstream: createCloudflareUpstream({ gatewayBase: GATEWAY, gatewayToken: "OFFLINE-GATEWAY-TOKEN", credentialSource: { getAccessToken: async () => "OFFLINE-HOST-SIWC" }, fetchImpl }),
    limits: { maxBodyBytes: 256 * 1024 },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const brokerURL = `http://127.0.0.1:${server.address().port}/v1`;
  const postRaw = (body) => fetch(`${brokerURL}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return {
    brokerURL, token, id, store, inbound, upstream, script, postRaw,
    stop: () => new Promise((r) => { store.revoke(id); server.close(r); server.closeAllConnections?.(); }),
  };
}

/** Load the Guest plugin by DIRECTORY through the real Host.resolve/Host.load and run its setup. */
export async function loadGuestPlugin(env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const entry = Host.resolve({ directory: GUEST_DIR });
  const mod = await Host.load(entry.server);
  const core = createFakeCore();
  await mod.default.setup(core.ctx);
  return { core, entry };
}

/**
 * One primary turn: Core-emulated context hook + model/http hooks around a REAL
 * native SDK request. Returns the SDK response and the post-hook context map.
 */
export async function runPrimaryTurn(core, { messages, promptCacheKey = "ses_affinity_key", providerID = "oc-cf-aig" }) {
  const rec = core.providers.get(providerID);
  if (!rec) throw new Error("provider not registered");
  const info = rec.provider;
  const mi = rec.models.get("gpt-6-luna");
  const context = {
    sessionID: "ses_offline", agent: "build", model: { id: mi.id, providerID: info.id },
    system: [], messages, options: { maxTokens: mi.limit.output }, tools: core.contextTools(),
  };
  const injected = Object.keys(context.tools);
  await core.runHook("context", context, info.id);
  const pkg = await import(info.package);
  let model = pkg.model(mi.modelID, { baseURL: info.settings.baseURL, apiKey: info.settings.apiKey });
  // Core model-resolver emulation: model compatibility overrides provider compatibility.
  model = LanguageModel.update(model, { compatibility: { ...(info.compatibility ?? {}), ...(mi.compatibility ?? {}) } });
  const modelRequest = { sessionID: "ses_offline", agent: "build", model: context.model, kind: "primary", baseURL: info.settings.baseURL, headers: {} };
  await core.runHook("model.request", modelRequest, info.id);
  if (Object.keys(modelRequest.headers).length) throw new Error("unexpected model.request header mutation");
  const tools = Object.entries(context.tools).map(([name, def]) => new ToolDefinition({ name, description: def.description, inputSchema: def.input }));
  const realFetch = globalThis.fetch;
  const httpRequests = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    httpRequests.push(request.url);
    await core.runHook("http.request", { sessionID: "ses_offline", agent: "build", model: context.model, kind: "primary", request: request.clone() }, info.id);
    return realFetch(request);
  };
  try {
    const response = await ai.generate({ model, messages: context.messages, tools, promptCacheKey, generation: context.options });
    return { response, contextTools: context.tools, injected, httpRequests, model };
  } finally {
    globalThis.fetch = realFetch;
  }
}

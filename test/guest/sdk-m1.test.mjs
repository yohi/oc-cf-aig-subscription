// Step 5 / 5b / 5d (M1) against the REAL pinned @opencode/ai v2.2.5 SDK and the
// REAL Broker with a fake upstream. Runs in its own node:test process (m1 only).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ai, LanguageModel, Message } from "@opencode/ai";
import * as Responses from "@opencode/ai/providers/openai/responses";
import { startBroker, loadGuestPlugin, runPrimaryTurn, sse, textEvents } from "./sdk-harness.mjs";
import { DEFAULT_TOOL_NAMES } from "./harness.mjs";

const broker = await startBroker();
after(() => broker.stop());
assert.equal(process.env.CF_AIG_TOKEN, undefined, "no Host Cloudflare token in the Guest test process");
const { core } = await loadGuestPlugin({ OC_CF_AIG_ACCEPTANCE_MODE: "m1", OC_CF_AIG_BROKER_URL: broker.brokerURL, OC_CF_AIG_BROKER_CAPABILITY: broker.token });

test("M1 setup via real directory loader: provider only, no guest_read_file registration", () => {
  assert.ok(core.providers.has("oc-cf-aig"));
  assert.equal(core.calls.toolTransform, 0);
  assert.equal(core.tools.has("guest_read_file"), false);
});

test("M1-D / 5b / 5d: real SDK body has no tools, no prompt_cache_key, native M1 fields; Broker accepts; gateway-ok", async () => {
  const before = { in: broker.inbound.length, up: broker.upstream.length };
  broker.script.push(sse(textEvents("gateway-ok")));
  const { response, contextTools, injected, httpRequests } = await runPrimaryTurn(core, { messages: [Message.user("say gateway-ok")], promptCacheKey: "affinity-nonempty-123" });
  for (const n of [...DEFAULT_TOOL_NAMES, "arbitrary_extra"]) assert.ok(injected.includes(n), `fixture injected ${n}`);
  assert.deepEqual(contextTools, {}, "context hook output is empty");
  assert.deepEqual(httpRequests, [`${broker.brokerURL}/responses`]);
  assert.equal(broker.inbound.length, before.in + 1);
  const body = broker.inbound.at(-1);
  assert.deepEqual(Object.keys(body).sort(), ["include", "input", "model", "store", "stream"]);
  assert.equal("tools" in body, false, "tools omitted");
  assert.equal("prompt_cache_key" in body, false, "F-001: no prompt_cache_key despite promptCacheKey");
  assert.equal("max_output_tokens" in body, false, "maxTokens suppressed");
  assert.deepEqual(body.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "say gateway-ok" }] }]);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, "gpt-6-luna");
  const serialized = JSON.stringify(body);
  for (const n of [...DEFAULT_TOOL_NAMES, "arbitrary_extra", "guest_read_file", "read_file"]) assert.ok(!serialized.includes(`"${n}"`), `no ${n}`);
  // Broker forwarded a reconstructed SIWC body (fake upstream) and the Guest bearer never left the Broker.
  assert.equal(broker.upstream.length, before.up + 1);
  const up = broker.upstream.at(-1);
  assert.match(up.url, /\/custom-openai-public-probe\/v1\/responses$/);
  assert.equal("tools" in up.body, false);
  assert.equal("prompt_cache_key" in up.body, false);
  assert.ok(!JSON.stringify(up).includes(broker.token), "capability not forwarded upstream");
  assert.equal(response.text, "gateway-ok");
});

test("M1 + real-Core text: a real SDK body plus the Core-observed text:{verbosity:\"low\"} is admitted; other text shapes are 400", async () => {
  broker.script.push(sse(textEvents("gateway-ok")));
  await runPrimaryTurn(core, { messages: [Message.user("say gateway-ok")], promptCacheKey: "affinity-nonempty-123" });
  const sdkBody = structuredClone(broker.inbound.at(-1));
  broker.script.push(sse(textEvents("gateway-ok")));
  const ok = await broker.postRaw({ ...sdkBody, text: { verbosity: "low" } });
  assert.equal(ok.status, 200);
  await ok.text();
  assert.deepEqual(broker.upstream.at(-1).body.text, { verbosity: "low" });
  for (const bad of [{ verbosity: "low", format: { type: "text" } }, { verbosity: "loud" }, {}, null]) {
    const res = await broker.postRaw({ ...sdkBody, text: bad });
    assert.equal(res.status, 400);
    await res.text();
  }
});

test("M1-E: assistant output_text and encrypted reasoning history replay intact", async () => {
  broker.script.push(sse(textEvents("gateway-ok", { reasoning: "ENC-M1-opaque==" })));
  const user1 = Message.user("say gateway-ok");
  const first = await runPrimaryTurn(core, { messages: [user1] });
  assert.equal(first.response.text, "gateway-ok");
  broker.script.push(sse(textEvents("gateway-ok-2")));
  const second = await runPrimaryTurn(core, { messages: [user1, first.response.message, Message.user("again")] });
  assert.equal(second.response.text, "gateway-ok-2");
  const body = broker.inbound.at(-1);
  assert.deepEqual(body.input.map((i) => [i.type, i.role ?? null]), [["message", "user"], ["reasoning", null], ["message", "assistant"], ["message", "user"]]);
  assert.equal(body.input[1].encrypted_content, "ENC-M1-opaque==");
  assert.deepEqual(body.input[1].summary, [{ type: "summary_text", text: "think" }]);
  assert.deepEqual(body.input[2].content, [{ type: "output_text", text: "gateway-ok" }]);
  const up = broker.upstream.at(-1).body;
  assert.equal(up.input[1].encrypted_content, "ENC-M1-opaque==");
  assert.deepEqual(up.input[2].content, [{ type: "output_text", text: "gateway-ok" }]);
});

test("5b control: the same SDK without supportsPromptCacheKey:false emits prompt_cache_key and the Broker 400s (M1 STOP signal)", async () => {
  const before = broker.upstream.length;
  const rec = core.providers.get("oc-cf-aig");
  const raw = Responses.model("gpt-6-luna", { baseURL: rec.provider.settings.baseURL, apiKey: rec.provider.settings.apiKey });
  await assert.rejects(ai.generate({ model: raw, messages: [Message.user("x")], promptCacheKey: "affinity-nonempty-123" }));
  assert.equal(broker.inbound.at(-1).prompt_cache_key, "affinity-nonempty-123");
  assert.equal(broker.upstream.length, before, "no upstream call");
});

test("maxTokens suppression is required: SDK lowers maxTokens to max_output_tokens, which the Broker rejects", async () => {
  const before = broker.upstream.length;
  const rec = core.providers.get("oc-cf-aig");
  let model = Responses.model("gpt-6-luna", { baseURL: rec.provider.settings.baseURL, apiKey: rec.provider.settings.apiKey });
  model = LanguageModel.update(model, { compatibility: { supportsPromptCacheKey: false } });
  await assert.rejects(ai.generate({ model, messages: [Message.user("x")], generation: { maxTokens: 32000 } }));
  assert.equal(broker.inbound.at(-1).max_output_tokens, 32000);
  assert.equal(broker.upstream.length, before);
});

test("5d: other providers' context maps are unchanged and cannot be used as a fallback", async () => {
  const other = { model: { id: "gpt-5", providerID: "openai" }, options: { maxTokens: 1 }, tools: core.contextTools() };
  const keys = Object.keys(other.tools);
  await core.runHook("context", other, "openai");
  assert.deepEqual(Object.keys(other.tools), keys);
  await assert.rejects(core.runHook("model.request", { kind: "primary", model: other.model, headers: {} }, "openai"), /fallback/);
});

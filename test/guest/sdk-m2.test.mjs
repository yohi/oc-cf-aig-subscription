// Step 5 / 5b / 5c / 5d (M2) against the REAL pinned @opencode/ai v2.2.5 SDK and
// the REAL Broker with a fake upstream. Separate node:test process from M1.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Message } from "@opencode/ai";
import { startBroker, loadGuestPlugin, runPrimaryTurn, sse, textEvents, functionCallEvents } from "./sdk-harness.mjs";
import { DEFAULT_TOOL_NAMES } from "./harness.mjs";
import { GUEST_TOOL_DESCRIPTION, READ_FILE_SCHEMA } from "../../src/guest/provider.mjs";

const FIXTURE = "fixture contents: gateway-ok \"quoted\"\n";
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guest-fixture-")));
fs.writeFileSync(path.join(root, "fixture.txt"), FIXTURE);

const broker = await startBroker();
after(() => broker.stop());
const { core } = await loadGuestPlugin({
  OC_CF_AIG_ACCEPTANCE_MODE: "m2", OC_CF_AIG_BROKER_URL: broker.brokerURL, OC_CF_AIG_BROKER_CAPABILITY: broker.token, OC_CF_AIG_GUEST_FIXTURE_ROOT: root,
});
const EXPECTED_TOOL = { type: "function", name: "read_file", description: GUEST_TOOL_DESCRIPTION, parameters: { ...READ_FILE_SCHEMA, properties: { path: { type: "string" } }, required: ["path"] }, strict: false };

async function firstTurn(sseEvents, prompt = "read fixture.txt") {
  broker.script.push(sse(sseEvents));
  const user = Message.user(prompt);
  const turn = await runPrimaryTurn(core, { messages: [user], promptCacheKey: "affinity-m2" });
  const call = turn.response.events.find((e) => e.type === "tool-call");
  return { user, turn, call };
}

test("M2 setup via real directory loader registers guest_read_file (namespace guest, codemode:false)", () => {
  const t = core.tools.get("guest_read_file");
  assert.ok(t);
  assert.deepEqual(t.options, { namespace: "guest", codemode: false });
});

test("M2-C / 5b / 5c / 5d: sole flat read_file strict:false -> Broker guest/read_file -> Guest-only execution -> full replay", async () => {
  const start = { in: broker.inbound.length, up: broker.upstream.length };
  const { user, turn, call } = await firstTurn(functionCallEvents({ callId: "call_m2_exact", enc: "ENC-M2-opaque==" }));
  // Context hook output: exactly read_file, same definition object as the registry entry.
  for (const n of [...DEFAULT_TOOL_NAMES, "arbitrary_extra", "guest_read_file"]) assert.ok(turn.injected.includes(n));
  assert.deepEqual(Object.keys(turn.contextTools), ["read_file"]);
  assert.equal(turn.contextTools.read_file, core.definitions.get("guest_read_file"));
  // Actual serialized native SDK body.
  const body = broker.inbound.at(-1);
  assert.deepEqual(body.tools, [EXPECTED_TOOL]);
  assert.equal(body.tools[0].strict, false);
  assert.equal("prompt_cache_key" in body, false);
  assert.equal("max_output_tokens" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["include", "input", "model", "store", "stream", "tools"]);
  const serialized = JSON.stringify(body);
  for (const n of [...DEFAULT_TOOL_NAMES, "arbitrary_extra", "guest_read_file"]) assert.ok(!serialized.includes(`"${n}"`), `no ${n}`);
  // Broker projection to SIWC namespace guest / leaf read_file with strict:false preserved.
  const up = broker.upstream.at(-1).body;
  assert.deepEqual(up.tools, [{ type: "namespace", name: "guest", description: "Sandbox-local tools", tools: [EXPECTED_TOOL] }]);
  // Native SDK decoded the namespaced call; Guest-only dispatch by definition identity.
  assert.deepEqual({ name: call.name, namespace: call.namespace, id: call.id, input: call.input }, { name: "read_file", namespace: "guest", id: "call_m2_exact", input: { path: "fixture.txt" } });
  const exec = await core.dispatch(turn.contextTools, call);
  assert.equal(exec.id, "guest_read_file");
  assert.deepEqual(exec.result, { content: FIXTURE });
  // Replay: exact call_id/arguments/output, reasoning + order preserved; Broker restores namespace guest upstream.
  broker.script.push(sse(textEvents("gateway-ok")));
  const second = await runPrimaryTurn(core, {
    messages: [user, turn.response.message, Message.tool({ id: call.id, name: call.name, namespace: call.namespace, result: { type: "text", value: exec.result.content }, providerMetadata: call.providerMetadata })],
  });
  assert.equal(second.response.text, "gateway-ok");
  const replay = broker.inbound.at(-1).input;
  assert.deepEqual(replay.map((i) => i.type), ["message", "reasoning", "function_call", "function_call_output"]);
  assert.equal(replay[1].encrypted_content, "ENC-M2-opaque==");
  assert.deepEqual(replay[2], { type: "function_call", id: "fc_1", call_id: "call_m2_exact", name: "read_file", namespace: "guest", arguments: '{"path":"fixture.txt"}' });
  assert.deepEqual(replay[3], { type: "function_call_output", call_id: "call_m2_exact", output: FIXTURE });
  const upReplay = broker.upstream.at(-1).body.input;
  assert.equal(upReplay[2].namespace, "guest");
  assert.equal(upReplay[2].call_id, "call_m2_exact");
  assert.equal(upReplay[2].arguments, '{"path":"fixture.txt"}');
  assert.equal(upReplay[3].output, FIXTURE, "tool output byte-for-byte");
  assert.equal(upReplay[1].encrypted_content, "ENC-M2-opaque==");
  assert.equal(broker.inbound.length - start.in, 2);
  assert.equal(broker.upstream.length - start.up, 2);
});

test("5c: native history function_call without namespace is projected to SIWC namespace guest", async () => {
  const user = Message.user("read fixture.txt");
  const assistant = Message.make({ role: "assistant", content: [{ type: "tool-call", id: "call_nons", name: "read_file", input: { path: "fixture.txt" } }] });
  const tool = Message.tool({ id: "call_nons", name: "read_file", result: { type: "text", value: FIXTURE } });
  broker.script.push(sse(textEvents("gateway-ok")));
  const turn = await runPrimaryTurn(core, { messages: [user, assistant, tool] });
  assert.equal(turn.response.text, "gateway-ok");
  const fc = broker.inbound.at(-1).input.find((i) => i.type === "function_call");
  assert.equal("namespace" in fc, false, "native history omits namespace");
  assert.equal(broker.upstream.at(-1).body.input.find((i) => i.type === "function_call").namespace, "guest");
});

test("functionCallEvents defaults omitted namespace but omits explicitly undefined namespace", () => {
  const itemOf = (events) => events.find((event) => event.type === "response.output_item.done" && event.item.type === "function_call").item;
  const omitted = itemOf(functionCallEvents());
  const explicitUndefined = itemOf(functionCallEvents({ namespace: undefined }));
  assert.equal(omitted.namespace, "guest");
  assert.equal(Object.hasOwn(explicitUndefined, "namespace"), false);
});

test("5c negatives: unknown, dotted or foreign-namespace calls never execute (Guest or Host)", async () => {
  for (const [label, events] of [
    ["unknown bash", functionCallEvents({ name: "bash", namespace: undefined, callId: "call_bad1" })],
    ["foreign namespace", functionCallEvents({ namespace: "host", callId: "call_bad2" })],
    ["dotted name", functionCallEvents({ name: "guest.read_file", namespace: undefined, callId: "call_bad3" })],
    ["built-in read", functionCallEvents({ name: "read", namespace: undefined, callId: "call_bad4" })],
  ]) {
    const { turn, call } = await firstTurn(events);
    assert.ok(call, label);
    await assert.rejects(core.dispatch(turn.contextTools, call), /dispatch/, label);
  }
});

test("5c negatives: mismatched call_id in replay is rejected by the Broker before upstream", async () => {
  const { user, turn, call } = await firstTurn(functionCallEvents({ callId: "call_good" }));
  const exec = await core.dispatch(turn.contextTools, call);
  const before = broker.upstream.length;
  await assert.rejects(runPrimaryTurn(core, {
    messages: [user, turn.response.message, Message.tool({ id: "call_other", name: "read_file", namespace: "guest", result: { type: "text", value: exec.result.content } })],
  }));
  assert.equal(broker.upstream.length, before);
});

test("5b negatives: strict:true, omitted strict and unknown tool fields on the real SDK body are 400 before upstream", async () => {
  await firstTurn(functionCallEvents({ callId: "call_shape" }));
  const base = broker.inbound.findLast((b) => Array.isArray(b.tools));
  const before = broker.upstream.length;
  const variants = [
    (b) => { b.tools[0].strict = true; },
    (b) => { delete b.tools[0].strict; },
    (b) => { b.tools[0].strict = null; },
    (b) => { b.tools[0].extra = 1; },
    (b) => { b.tools[0].parameters.additionalProperties = true; },
    (b) => { b.tools.push({ ...b.tools[0], name: "bash" }); },
    (b) => { b.prompt_cache_key = "present"; },
  ];
  for (const mutate of variants) {
    const body = structuredClone(base);
    mutate(body);
    const res = await broker.postRaw(body);
    assert.equal(res.status, 400, mutate.toString());
    await res.text();
  }
  assert.equal(broker.upstream.length, before);
  const ok = await broker.postRaw(base);
  assert.equal(ok.status, 200);
  await ok.text();
});

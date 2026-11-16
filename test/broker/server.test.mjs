import { test } from "node:test";
import net from "node:net";
import assert from "node:assert/strict";
import { createCapabilityStore } from "../../src/broker/capabilities.mjs";
import { parseBrokerRequest } from "../../src/broker/policy.mjs";
import { createCloudflareUpstream } from "../../src/broker/upstream.mjs";
import { createBrokerServer } from "../../src/broker/server.mjs";

const MODEL = "gpt-6-luna";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/my-gw`;
const SCHEMA = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
const encoder = new TextEncoder();

const flatTool = () => ({ type: "function", name: "read_file", description: "Read a file", parameters: structuredClone(SCHEMA), strict: false });
const userMsg = (text = "gateway-ok") => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const m1a = (extra = {}) => ({ model: MODEL, input: [userMsg()], include: ["reasoning.encrypted_content"], stream: true, ...extra });
const reasoning = () => ({ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "opaque-ENC==" });
const call = (extra = {}) => ({ type: "function_call", name: "read_file", call_id: "call_test", arguments: '{"path":"fixture.txt"}', ...extra });
const callOut = (id = "call_test") => ({ type: "function_call_output", call_id: id, output: "file body" });
const m2Body = (callExtra = {}) => ({
  model: MODEL,
  instructions: "be brief",
  input: [userMsg("read it"), reasoning(), call(callExtra), callOut()],
  tools: [flatTool()],
  include: ["reasoning.encrypted_content"],
  stream: true,
});

const sseEvent = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
const OK_EVENTS = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_text.delta", delta: "gateway-ok" },
  { type: "response.completed", response: { id: "resp_1" } },
];
const okText = () => OK_EVENTS.map(sseEvent).join("");

function sseResponse(text, { hang = false, status = 200, onCancel } = {}) {
  const stream = new ReadableStream({
    start(c) {
      if (text) c.enqueue(encoder.encode(text));
      if (!hang) c.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

async function eventually(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

async function harness({ respond, cap = {}, limits = {} } = {}) {
  const store = createCapabilityStore();
  const { token, id } = store.issue({
    sandboxID: "sbx-1", model: MODEL, ttlMs: 60_000, maxCalls: 1000, maxCallsPerWindow: 1000, windowMs: 1000,
    maxConcurrent: 4, maxRequestBytes: 64 * 1024, maxResponseBytes: 64 * 1024, maxTotalBytes: 10 * 1024 * 1024,
    maxRequestDurationMs: 10_000, ...cap,
  });
  const releases = { count: 0 };
  const capabilities = {
    ...store,
    authorize(a) {
      const p = store.authorize(a);
      return { signal: p.signal, chargeResponse: (b) => p.chargeResponse(b), release() { releases.count++; p.release(); } };
    },
  };
  const fetches = [];
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return respond ? respond(url, init) : sseResponse(okText());
  };
  const upstream = createCloudflareUpstream({
    gatewayBase: GATEWAY, gatewayToken: "HOST-GATEWAY-TOKEN",
    credentialSource: { getAccessToken: async () => "HOST-SIWC-TOKEN" }, fetchImpl,
  });
  const server = createBrokerServer({
    capabilities, parseRequest: parseBrokerRequest, upstream,
    limits: { maxBodyBytes: 64 * 1024, maxHeaderBytes: 4096, ...limits },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, { headers = {}, raw, auth = true, signal } = {}) =>
    fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? JSON.stringify(body),
      signal,
    });
  return { base, token, id, store, fetches, releases, post, close: () => server.closeAllConnections?.() ?? server.close(), server,
    done: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

async function outcome(res) {
  let text = "";
  let errored = false;
  try { text = await res.text(); } catch { errored = true; }
  const success = res.status === 200 && !errored && text.includes("response.completed");
  return { status: res.status, text, errored, success };
}

async function expectRejected(h, body, status, opts) {
  const before = h.fetches.length;
  const res = await h.post(body, opts);
  const text = await res.text();
  assert.equal(res.status, status, `${JSON.stringify(body)?.slice(0, 200)} -> ${res.status} ${text}`);
  assert.equal(h.fetches.length, before, "no upstream request on rejection");
  assert.ok(!text.includes(h.token));
}

// ---------- routes ----------

test("routes: health, models auth, method/path restrictions", async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(`${h.base}/health`)).status, 200);
    assert.equal((await fetch(`${h.base}/v1/models`)).status, 401);
    const models = await fetch(`${h.base}/v1/models`, { headers: { authorization: `Bearer ${h.token}` } });
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json()).data.map((m) => m.id), [MODEL]);
    assert.equal((await h.post(m1a(), { auth: false })).status, 401);
    assert.equal((await h.post(m1a(), { headers: { authorization: "Bearer forged" } })).status, 401);
    assert.equal((await fetch(`${h.base}/v1/other`, { headers: { authorization: `Bearer ${h.token}` } })).status, 404);
    assert.equal((await fetch(`${h.base}/v1/responses`, { method: "PUT", headers: { authorization: `Bearer ${h.token}` } })).status, 405);
    assert.equal(h.fetches.length, 0);
  } finally { await h.done(); }
});

// ---------- M1-A ----------

for (const [label, extra] of [["store absent", {}], ["store:false", { store: false }]]) {
  test(`M1-A native wire accepted (${label}); upstream rebuilt with Host-only credentials`, async () => {
    const h = await harness();
    try {
      const res = await h.post(m1a(extra), { headers: { "user-agent": "opencode/2.2.5" } });
      const out = await outcome(res);
      assert.ok(out.success, out.text);
      assert.ok(out.text.includes("gateway-ok"));
      assert.equal(h.fetches.length, 1);
      const f = h.fetches[0];
      assert.equal(f.url, `${GATEWAY}/custom-openai-public-probe/v1/responses`);
      assert.equal(f.body.store, false);
      assert.equal(f.body.stream, true);
      assert.deepEqual(f.body.include, ["reasoning.encrypted_content"]);
      assert.deepEqual(f.body.input, [userMsg()]);
      assert.equal(f.body.tools, undefined);
      const hd = Object.fromEntries(new Headers(f.init.headers));
      assert.equal(hd.authorization, "Bearer HOST-SIWC-TOKEN");
      assert.equal(hd["cf-aig-authorization"], "Bearer HOST-GATEWAY-TOKEN");
      assert.equal(hd["cf-aig-no-wholesale"], "true");
      assert.equal(hd["cf-aig-collect-log-payload"], "false");
      assert.equal(hd["cf-aig-skip-cache"], "true");
      assert.ok(!JSON.stringify(hd).includes(h.token));
      assert.ok(!("user-agent" in hd) || !hd["user-agent"].includes("opencode"));
      await eventually(() => assert.equal(h.releases.count, 1));
    } finally { await h.done(); }
  });
}

test("M1-A include may be absent", async () => {
  const h = await harness();
  try {
    const { include, ...rest } = m1a();
    assert.ok((await outcome(await h.post(rest))).success);
    assert.equal(h.fetches[0].body.include, undefined);
  } finally { await h.done(); }
});

// ---------- M1-B ----------

test("M1-B full history preserved in original order (developer, assistant metadata, opaque reasoning)", async () => {
  const h = await harness();
  try {
    const input = [
      { type: "message", role: "developer", content: "dev rules" },
      userMsg("hello"),
      reasoning(),
      { type: "message", role: "assistant", id: "msg_1", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "hi there" }] },
      { type: "message", role: "user", id: "u2", status: "completed", content: [{ type: "input_text", text: "again" }] },
      { type: "reasoning", summary: [], encrypted_content: null },
    ];
    const res = await h.post({ ...m1a(), input });
    assert.ok((await outcome(res)).success);
    assert.deepEqual(h.fetches[0].body.input, input);
  } finally { await h.done(); }
});

// ---------- M2-A / 5c ----------

for (const [label, extra] of [["namespace omitted", {}], ["namespace guest", { namespace: "guest" }]]) {
  test(`M2-A flat read_file projected to SIWC namespace guest; history canonicalized (${label})`, async () => {
    const h = await harness();
    try {
      const body = m2Body(extra);
      const res = await h.post(body);
      assert.ok((await outcome(res)).success);
      const up = h.fetches[0].body;
      assert.deepEqual(up.tools, [{
        type: "namespace", name: "guest", description: "Sandbox-local tools",
        tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: SCHEMA, strict: false }],
      }]);
      assert.equal(up.tools[0].tools[0].strict, false);
      assert.deepEqual(up.input, [userMsg("read it"), reasoning(), call({ namespace: "guest" }), callOut()]);
      assert.equal(up.input[1].encrypted_content, "opaque-ENC==");
      assert.equal(up.instructions, "be brief");
      assert.equal(up.store, false);
      assert.equal(up.stream, true);
    } finally { await h.done(); }
  });
}

test("M2 function_call with optional id preserved byte-for-byte", async () => {
  const h = await harness();
  try {
    const body = m2Body({ id: "fc_9" });
    assert.ok((await outcome(await h.post(body))).success);
    assert.equal(h.fetches[0].body.input[2].id, "fc_9");
    assert.equal(h.fetches[0].body.input[2].arguments, '{"path":"fixture.txt"}');
    assert.equal(h.fetches[0].body.input[3].output, "file body");
  } finally { await h.done(); }
});

// ---------- negatives (Step 5, 5b, 5c) ----------

const negatives = [
  ["bare shorthand", () => m1a({ input: [{ role: "user", content: "hi" }] }), 400],
  ["user string content", () => m1a({ input: [{ type: "message", role: "user", content: "hi" }] }), 400],
  ["user content missing text", () => m1a({ input: [{ type: "message", role: "user", content: [{ type: "input_text" }] }] }), 400],
  ["user content output_text", () => m1a({ input: [{ type: "message", role: "user", content: [{ type: "output_text", text: "x" }] }] }), 400],
  ["user empty content", () => m1a({ input: [{ type: "message", role: "user", content: [] }] }), 400],
  ["user image content", () => m1a({ input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "x" }] }] }), 400],
  ["assistant input_text", () => m1a({ input: [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "x" }] }] }), 400],
  ["assistant string content", () => m1a({ input: [{ type: "message", role: "assistant", content: "x" }] }), 400],
  ["assistant bad phase", () => m1a({ input: [{ type: "message", role: "assistant", phase: "x", content: [{ type: "output_text", text: "x" }] }] }), 400],
  ["explicit system message", () => m1a({ input: [{ type: "message", role: "system", content: "x" }] }), 400],
  ["developer array content", () => m1a({ input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "x" }] }] }), 400],
  ["unknown item type", () => m1a({ input: [{ type: "item_reference", id: "x" }] }), 400],
  ["unknown message key", () => m1a({ input: [{ ...userMsg(), extra: 1 }] }), 400],
  ["reasoning missing summary", () => m1a({ input: [userMsg(), { type: "reasoning", encrypted_content: "x" }] }), 400],
  ["reasoning bad encrypted_content type", () => m1a({ input: [userMsg(), { type: "reasoning", summary: [], encrypted_content: 5 }] }), 400],
  ["empty input", () => m1a({ input: [] }), 400],
  ["non-array input", () => m1a({ input: "hi" }), 400],
  ["arbitrary include", () => m1a({ include: ["message.output_text.logprobs"] }), 400],
  ["empty include", () => m1a({ include: [] }), 400],
  ["extended include", () => m1a({ include: ["reasoning.encrypted_content", "x"] }), 400],
  ["previous_response_id", () => m1a({ previous_response_id: "resp_1" }), 400],
  ["store:true", () => m1a({ store: true }), 400],
  ["stream:false", () => m1a({ stream: false }), 400],
  ["stream missing", () => { const b = m1a(); delete b.stream; return b; }, 400],
  ["max_output_tokens", () => m1a({ max_output_tokens: 10 }), 400],
  ["temperature", () => m1a({ temperature: 0 }), 400],
  ["parallel_tool_calls", () => m1a({ parallel_tool_calls: false }), 400],
  ["stream_options", () => m1a({ stream_options: { include_obfuscation: false } }), 400],
  ["metadata", () => m1a({ metadata: {} }), 400],
  ["unknown key", () => m1a({ whatever: 1 }), 400],
  ["unknown model", () => m1a({ model: "gpt-5" }), 400],
  ["missing model", () => { const b = m1a(); delete b.model; return b; }, 400],
  ["hosted tool", () => m1a({ tools: [{ type: "web_search" }] }), 400],
  ["custom tool", () => m1a({ tools: [{ type: "custom", name: "x" }] }), 400],
  ["unknown function", () => ({ ...m2Body(), tools: [{ ...flatTool(), name: "bash" }] }), 400],
  ["two tools", () => ({ ...m2Body(), tools: [flatTool(), flatTool()] }), 400],
  ["call_id mismatch", () => ({ ...m2Body(), input: [userMsg(), call(), callOut("call_other")] }), 400],
  ["lost call_id (output without call)", () => m1a({ input: [userMsg(), callOut()] }), 400],
  ["call without output", () => ({ ...m2Body(), input: [userMsg(), call()] }), 400],
  ["duplicate call_id", () => ({ ...m2Body(), input: [userMsg(), call(), call(), callOut()] }), 400],
  ["duplicate output", () => ({ ...m2Body(), input: [userMsg(), call(), callOut(), callOut()] }), 400],
  ["missing call_id", () => { const c = call(); delete c.call_id; return { ...m2Body(), input: [userMsg(), c, callOut()] }; }, 400],
  ["output before call", () => ({ ...m2Body(), input: [userMsg(), callOut(), call()] }), 400],
  ["dotted name guest.read_file", () => ({ ...m2Body(), input: [userMsg(), call({ name: "guest.read_file" }), callOut()] }), 400],
  ["foreign namespace", () => m2Body({ namespace: "other" }), 400],
  ["unknown call name", () => m2Body({ name: "bash" }), 400],
  ["call bad arguments schema", () => m2Body({ arguments: '{"path":1}' }), 400],
  ["call extra arguments", () => m2Body({ arguments: '{"path":"a","x":1}' }), 400],
  ["call non-JSON arguments", () => m2Body({ arguments: "nope" }), 400],
  ["tool strict:true", () => ({ ...m2Body(), tools: [{ ...flatTool(), strict: true }] }), 400],
  ["tool strict missing", () => { const t = flatTool(); delete t.strict; return { ...m2Body(), tools: [t] }; }, 400],
  ["tool strict null", () => ({ ...m2Body(), tools: [{ ...flatTool(), strict: null }] }), 400],
  ["tool strict string", () => ({ ...m2Body(), tools: [{ ...flatTool(), strict: "false" }] }), 400],
  ["tool unknown key", () => ({ ...m2Body(), tools: [{ ...flatTool(), foo: 1 }] }), 400],
  ["tool different schema", () => ({ ...m2Body(), tools: [{ ...flatTool(), parameters: { type: "object", properties: { path: { type: "string" }, x: { type: "string" } }, required: ["path"], additionalProperties: false } }] }), 400],
  ["tool relaxed schema", () => ({ ...m2Body(), tools: [{ ...flatTool(), parameters: { type: "object" } }] }), 400],
  ["tool already namespaced", () => ({ ...m2Body(), tools: [{ type: "namespace", name: "guest", description: "x", tools: [flatTool()] }] }), 400],
  ["tool dotted name", () => ({ ...m2Body(), tools: [{ ...flatTool(), name: "guest.read_file" }] }), 400],
  ["prompt_cache_key present", () => m1a({ prompt_cache_key: "abc" }), 400],
  ["prompt_cache_key empty string", () => m1a({ prompt_cache_key: "" }), 400],
  ["tool_choice", () => m2Body() && { ...m2Body(), tool_choice: "auto" }, 400],
  // Real Core v2.2.5 sends text:{verbosity:"low"}; only that exact shape is admitted.
  ["text verbosity unknown enum", () => m1a({ text: { verbosity: "extreme" } }), 400],
  ["text verbosity wrong type", () => m1a({ text: { verbosity: 1 } }), 400],
  ["text verbosity null", () => m1a({ text: { verbosity: null } }), 400],
  ["text empty object", () => m1a({ text: {} }), 400],
  ["text unknown key", () => m1a({ text: { verbosity: "low", extra: true } }), 400],
  ["text format json_schema", () => m1a({ text: { verbosity: "low", format: { type: "json_schema", name: "x", schema: {} } } }), 400],
  ["text format only", () => m1a({ text: { format: { type: "text" } } }), 400],
  ["text null", () => m1a({ text: null }), 400],
  ["text array", () => m1a({ text: [{ verbosity: "low" }] }), 400],
  ["text string", () => m1a({ text: "low" }), 400],
  ["max_output_tokens still rejected with text", () => m1a({ text: { verbosity: "low" }, max_output_tokens: 10 }), 400],
  ["prompt_cache_key still rejected with text", () => m1a({ text: { verbosity: "low" }, prompt_cache_key: "k" }), 400],
];

for (const [label, build, status] of negatives) {
  test(`negative: ${label} -> ${status} before upstream`, async () => {
    const h = await harness();
    try {
      await expectRejected(h, build(), status);
      await eventually(() => assert.equal(h.releases.count, 1));
    } finally { await h.done(); }
  });
}

test("negative: invalid JSON, non-object body, wrong content-type -> 400", async () => {
  const h = await harness();
  try {
    await expectRejected(h, null, 400, { raw: "{nope" });
    await expectRejected(h, null, 400, { raw: "[]" });
    await expectRejected(h, null, 400, { raw: "null" });
    await expectRejected(h, m1a(), 400, { headers: { "content-type": "text/plain" } });
  } finally { await h.done(); }
});

test("negative: oversize body -> 413 (hard cap and capability cap) before upstream", async () => {
  const h = await harness({ cap: { maxRequestBytes: 2000 } });
  try {
    await expectRejected(h, m1a({ input: [userMsg("x".repeat(3000))] }), 413); // capability cap
    await expectRejected(h, m1a({ input: [userMsg("x".repeat(100_000))] }), 413); // hard cap
  } finally { await h.done(); }
});

test("negative: injected Guest headers and oversize headers never reach upstream", async () => {
  const h = await harness();
  try {
    for (const hd of [
      { "cf-aig-authorization": "Bearer evil" },
      { "cf-aig-skip-cache": "false" },
      { "x-api-key": "sk-evil" },
      { cookie: "a=b" },
      { "x-forwarded-host": "evil.example" },
      { "x-target-url": "https://evil.example" },
    ]) {
      await expectRejected(h, m1a(), 400, { headers: hd });
    }
    await expectRejected(h, m1a(), 413, { headers: { "x-padding": "a".repeat(5000) } });
  } finally { await h.done(); }
});

// ---------- F-001 A/B positives ----------

test("real-Core text:{verbosity} is admitted and rebuilt from validated content only", async () => {
  for (const verbosity of ["low", "medium", "high"]) {
    const h = await harness();
    try {
      const text = { verbosity };
      assert.ok((await outcome(await h.post(m1a({ text })))).success, verbosity);
      assert.deepEqual(h.fetches[0].body.text, { verbosity });
      assert.notEqual(h.fetches[0].body.text, text);
      assert.deepEqual(Object.keys(h.fetches[0].body).sort(), ["include", "input", "model", "store", "stream", "text"].sort());
    } finally { await h.done(); }
  }
});

test("text absent -> no text sent upstream", async () => {
  const h = await harness();
  try {
    assert.ok((await outcome(await h.post(m1a()))).success);
    assert.ok(!("text" in h.fetches[0].body));
  } finally { await h.done(); }
});

test("F-001 A-positive: no prompt_cache_key admitted; B-positive exact strict:false tool admitted", async () => {
  const h = await harness();
  try {
    const body = m2Body();
    assert.ok(!("prompt_cache_key" in body));
    assert.ok((await outcome(await h.post(body))).success);
    assert.ok(!("prompt_cache_key" in h.fetches[0].body));
  } finally { await h.done(); }
});

// ---------- SSE (Step 8) ----------

test("SSE success: function_call delta + completed + clean EOF", async () => {
  const text = [
    { type: "response.created", response: {} },
    { type: "response.output_item.done", item: { type: "function_call", name: "read_file", namespace: "guest", call_id: "call_1", arguments: "{\"path\":\"a\"}" } },
    { type: "response.completed", response: {} },
  ].map(sseEvent).join("");
  const h = await harness({ respond: () => sseResponse(text) });
  try {
    const out = await outcome(await h.post(m2Body()));
    assert.ok(out.success);
    assert.ok(out.text.includes('"call_id":"call_1"'));
    await eventually(() => assert.equal(h.releases.count, 1));
  } finally { await h.done(); }
});

const failures = {
  "response.failed": () => sseResponse(sseEvent(OK_EVENTS[0]) + sseEvent({ type: "response.failed", response: {} }), { hang: true }),
  "response.incomplete": () => sseResponse(sseEvent(OK_EVENTS[0]) + sseEvent({ type: "response.incomplete", response: {} }), { hang: true }),
  "error event": () => sseResponse(sseEvent(OK_EVENTS[0]) + sseEvent({ type: "error", message: "x" }), { hang: true }),
  "invalid framing (non-JSON data)": () => sseResponse("event: response.created\ndata: not-json\n\n"),
  "event without type": () => sseResponse('data: {"a":1}\n\n'),
  "unknown field line": () => sseResponse('bogus line\n\n'),
  "premature EOF (no completed)": () => sseResponse(sseEvent(OK_EVENTS[0]) + sseEvent(OK_EVENTS[1])),
  "premature EOF mid-event": () => sseResponse(sseEvent(OK_EVENTS[0]) + 'event: response.completed\ndata: {"type":"resp'),
  "trailing data after completed": () => sseResponse(okText() + sseEvent(OK_EVENTS[1])),
  "upstream 401": () => new Response("denied", { status: 401 }),
  "upstream 403": () => new Response("denied", { status: 403 }),
  "upstream 429": () => new Response("slow", { status: 429 }),
  "upstream 500": () => new Response("boom", { status: 500 }),
  "upstream 503": () => new Response("boom", { status: 503 }),
};

for (const [label, respond] of Object.entries(failures)) {
  test(`SSE failure: ${label} -> not success, upstream aborted, Permit released once`, async () => {
    const h = await harness({ respond });
    try {
      const res = await h.post(m1a()).catch(() => null); // a reset before headers also counts as failure
      const out = res ? await outcome(res) : { success: false, text: "" };
      assert.equal(out.success, false, out.text);
      assert.ok(!out.text.includes("response.failed") && !out.text.includes("response.incomplete"));
      assert.ok(!out.text.includes("denied") && !out.text.includes("boom"), "upstream bodies are not leaked");
      assert.equal(h.fetches.length, 1, "no retry / fallback");
      await eventually(() => assert.equal(h.fetches[0].init.signal.aborted, true));
      await eventually(() => assert.equal(h.releases.count, 1));
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(h.releases.count, 1);
      assert.equal(h.store.describe()[0].active, 0);
    } finally { await h.done(); }
  });
}

test("SSE failure: response byte quota exceeded -> aborted, released once", async () => {
  const h = await harness({ cap: { maxResponseBytes: 80 }, respond: () => sseResponse(okText()) });
  try {
    const out = await outcome(await h.post(m1a()));
    assert.equal(out.success, false);
    await eventually(() => assert.equal(h.fetches[0].init.signal.aborted, true));
    await eventually(() => assert.equal(h.releases.count, 1));
  } finally { await h.done(); }
});

test("SSE failure: request duration limit aborts a hung stream", async () => {
  const h = await harness({ cap: { maxRequestDurationMs: 100 }, respond: () => sseResponse(sseEvent(OK_EVENTS[0]), { hang: true }) });
  try {
    const out = await outcome(await h.post(m1a()));
    assert.equal(out.success, false);
    await eventually(() => assert.equal(h.fetches[0].init.signal.aborted, true));
    await eventually(() => assert.equal(h.releases.count, 1));
    assert.equal(h.store.describe()[0].active, 0);
  } finally { await h.done(); }
});

test("stalled non-reading client + duration/revoke abort closes the connection and releases Permit", async () => {
  for (const mode of ["duration", "revoke"]) {
    const big = sseEvent(OK_EVENTS[0]) + sseEvent({ type: "response.output_text.delta", delta: "x".repeat(8 * 1024 * 1024) });
    const h = await harness({
      cap: { maxRequestDurationMs: mode === "duration" ? 300 : 10_000, maxResponseBytes: 64 * 1024 * 1024 },
      respond: () => sseResponse(big, { hang: true }),
    });
    const body = JSON.stringify(m1a());
    const sock = net.connect(h.server.address().port, "127.0.0.1");
    sock.pause();
    sock.on("error", () => {});
    sock.write(`POST /v1/responses HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\nauthorization: Bearer ${h.token}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    try {
      await eventually(() => assert.equal(h.fetches.length, 1));
      await new Promise((r) => setTimeout(r, 100));
      if (mode === "revoke") h.store.revoke(h.id);
      await eventually(() => assert.equal(h.releases.count, 1), 3000);
      await eventually(() => assert.equal(h.store.describe()[0].active, 0));
      await eventually(() => assert.equal(h.fetches[0].init.signal.aborted, true));
      const conns = () => new Promise((resolve) => h.server.getConnections((_, n) => resolve(n)));
      for (let i = 0; i < 100 && (await conns()) !== 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(await conns(), 0, "server closed the stalled connection");
    } finally { sock.destroy(); await h.done(); }
  }
});

test("SSE failure: client abort aborts upstream and releases Permit once", async () => {
  let cancelled = false;
  const h = await harness({ respond: () => sseResponse(sseEvent(OK_EVENTS[0]), { hang: true, onCancel: () => { cancelled = true; } }) });
  try {
    const ac = new AbortController();
    const res = await h.post(m1a(), { signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    await reader.read().catch(() => {});
    await eventually(() => assert.equal(h.fetches[0].init.signal.aborted, true));
    await eventually(() => assert.equal(h.releases.count, 1));
    await eventually(() => assert.equal(cancelled, true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.releases.count, 1);
  } finally { await h.done(); }
});

test("revoking the capability mid-stream aborts upstream and releases once", async () => {
  const h = await harness({ respond: () => sseResponse(sseEvent(OK_EVENTS[0]), { hang: true }) });
  try {
    const res = await h.post(m1a());
    const reader = res.body.getReader();
    await reader.read();
    h.store.revoke(h.id);
    await reader.read().catch(() => {});
    await eventually(() => assert.equal(h.fetches[0].init.signal.aborted, true));
    await eventually(() => assert.equal(h.releases.count, 1));
  } finally { await h.done(); }
});

test("SSE framing accepts CRLF, comments and split chunks", async () => {
  const text = okText().replaceAll("\n", "\r\n");
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(": keepalive\r\n\r\n"));
      for (let i = 0; i < text.length; i += 7) c.enqueue(encoder.encode(text.slice(i, i + 7)));
      c.close();
    },
  });
  const h = await harness({ respond: () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
  try {
    const out = await outcome(await h.post(m1a()));
    assert.ok(out.success, out.text);
    await eventually(() => assert.equal(h.releases.count, 1));
  } finally { await h.done(); }
});

// ---------- capability limits at the HTTP layer ----------

test("HTTP: expired/revoked/exhausted capability rejected; calls budget enforced", async () => {
  const h = await harness({ cap: { maxCalls: 2 } });
  try {
    assert.ok((await outcome(await h.post(m1a()))).success);
    assert.ok((await outcome(await h.post(m1a()))).success);
    const third = await h.post(m1a());
    assert.equal(third.status, 429);
    await third.text();
    h.store.revoke(h.id);
    assert.equal((await h.post(m1a())).status, 401);
  } finally { await h.done(); }
});

// ---------- upstream unit ----------

test("createCloudflareUpstream validates gatewayBase and never forwards redirects", async () => {
  const cred = { getAccessToken: async () => "t" };
  for (const bad of [
    "http://gateway.ai.cloudflare.com/v1/" + ACCOUNT + "/gw",
    "https://evil.example/v1/" + ACCOUNT + "/gw",
    "https://gateway.ai.cloudflare.com/v1/SHORT/gw",
    `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/gw/extra`,
    `https://gateway.ai.cloudflare.com/v1/${ACCOUNT.toUpperCase()}/gw`,
    `https://user@gateway.ai.cloudflare.com/v1/${ACCOUNT}/gw`,
    `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/gw?x=1`,
    `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/.`,
    `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/..`,
  ]) {
    assert.throws(() => createCloudflareUpstream({ gatewayBase: bad, gatewayToken: "g", credentialSource: cred, fetchImpl: async () => {} }), undefined, bad);
  }
  assert.throws(() => createCloudflareUpstream({ gatewayBase: GATEWAY, gatewayToken: "", credentialSource: cred, fetchImpl: async () => {} }));
  assert.throws(() => createCloudflareUpstream({ gatewayBase: GATEWAY, gatewayToken: "a\r\nx: y", credentialSource: cred, fetchImpl: async () => {} }));
  let init;
  const up = createCloudflareUpstream({ gatewayBase: GATEWAY, gatewayToken: "g", credentialSource: cred, fetchImpl: async (u, i) => { init = i; return new Response("x"); } });
  await up({ model: MODEL, input: [userMsg()], stream: true, store: false }, new AbortController().signal);
  assert.equal(init.redirect, "manual");
  assert.equal(init.method, "POST");
});

test("credentialSource failure propagates and no fetch happens (no fallback)", async () => {
  let fetched = false;
  const up = createCloudflareUpstream({
    gatewayBase: GATEWAY, gatewayToken: "g",
    credentialSource: { getAccessToken: async () => { throw new Error("refresh failed"); } },
    fetchImpl: async () => { fetched = true; return new Response("x"); },
  });
  await assert.rejects(up({ model: MODEL, input: [userMsg()], stream: true, store: false }, new AbortController().signal));
  assert.equal(fetched, false);
});

test("credentialSource failure surfaces as 502 and releases Permit once", async () => {
  const store = createCapabilityStore();
  const { token } = store.issue({ sandboxID: "s", model: MODEL, ttlMs: 1e5, maxCalls: 5, maxCallsPerWindow: 5, windowMs: 1000, maxConcurrent: 1, maxRequestBytes: 1e5, maxResponseBytes: 1e5, maxTotalBytes: 1e6, maxRequestDurationMs: 1e4 });
  const up = createCloudflareUpstream({ gatewayBase: GATEWAY, gatewayToken: "g", credentialSource: { getAccessToken: async () => { throw new Error("SECRET-DETAIL"); } }, fetchImpl: async () => new Response("x") });
  const server = createBrokerServer({ capabilities: store, parseRequest: parseBrokerRequest, upstream: up, limits: { maxBodyBytes: 65536, maxHeaderBytes: 4096 } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(m1a()) });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.ok(!text.includes("SECRET-DETAIL"));
    // concurrency slot (maxConcurrent:1) was released
    const res2 = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(m1a()) });
    assert.equal(res2.status, 502);
    await res2.text();
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

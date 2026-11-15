import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { Host } from "@opencode/plugin/host";
import { Model, Provider } from "@opencode/plugin";
import {
  PROVIDER_ID, MODEL_ID, PROVIDER_PACKAGE, GUEST_NAMESPACE, GUEST_TOOL, GUEST_TOOL_ID, READ_FILE_SCHEMA,
  parseAcceptanceMode, validateBrokerURL, validateCapability, buildProviderInfo, buildModelInfo,
  createFixtureReader, applyPrimaryToolAllowlist, registerGuestProvider, setupGuest,
} from "../../src/guest/provider.mjs";
import { createFakeCore, envProxy, TEST_CAPABILITY, DEFAULT_TOOL_NAMES } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GUEST_DIR = path.join(ROOT, "src/guest");
const BROKER_URL = "http://127.0.0.1:49187/v1";

function fixtureRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guest-fixture-"));
  fs.writeFileSync(path.join(dir, "fixture.txt"), "fixture body\n");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "nested.txt"), "nested");
  return fs.realpathSync(dir);
}

const guestEnv = (extra = {}) => ({
  OC_CF_AIG_ACCEPTANCE_MODE: "m1",
  OC_CF_AIG_BROKER_URL: BROKER_URL,
  OC_CF_AIG_BROKER_CAPABILITY: TEST_CAPABILITY,
  ...extra,
});

function contextEvent(core, { providerID = PROVIDER_ID, modelID = MODEL_ID } = {}) {
  return {
    sessionID: "ses_1", agent: "build", model: { id: modelID, providerID },
    system: [], messages: [], options: { maxTokens: 32000 },
    tools: core.contextTools(),
  };
}

// ---------------------------------------------------------------- loader/layout

test("Guest plugin directory holds only index.js + provider.mjs and no nested package.json", () => {
  assert.deepEqual(fs.readdirSync(GUEST_DIR).sort(), ["index.js", "provider.mjs"]);
});

test("real @opencode/plugin Host.resolve picks the Guest directory index.js and loads Plugin.define", async () => {
  const entry = Host.resolve({ directory: GUEST_DIR });
  assert.equal(fileURLToPath(entry.server), path.join(GUEST_DIR, "index.js"));
  const mod = await Host.load(entry.server);
  assert.equal(typeof mod.default?.setup, "function");
  assert.equal(mod.default.id, "oc-cf-aig-guest");
});

test("package.json keeps Host root export, adds optional ./guest import and pins @opencode/ai exactly", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.exports["."], "./src/index.js");
  assert.equal(pkg.exports["./guest"], "./src/guest/index.js");
  assert.equal(pkg.dependencies["@opencode/ai"], "2.2.5");
  assert.equal(pkg.dependencies["@opencode/plugin"], "2.2.5");
  assert.equal(pkg.devDependencies.effect, JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/effect/package.json"), "utf8")).version, "tests import effect directly");
  assert.match(pkg.scripts.check, /node --check src\/guest\/index\.js/);
  assert.match(pkg.scripts.check, /node --check src\/guest\/provider\.mjs/);
  assert.match(pkg.scripts.check, /node --check bin\/guest-launch\.mjs/);
});

test("Guest sources never reference the Host plugin, Host credentials or native OpenAI credentials", () => {
  for (const file of ["index.js", "provider.mjs"]) {
    const src = fs.readFileSync(path.join(GUEST_DIR, file), "utf8");
    for (const forbidden of [/gateway\.mjs/, /registerGateway/, /CF_AIG_TOKEN/, /CF_AIG_BASE/, /OPENAI_API_KEY/, /auth\.json/, /\.integration\b/, /\.credential\b/, /chatgpt-token-sharing/]) {
      assert.doesNotMatch(src, forbidden, `${file} must not match ${forbidden}`);
    }
  }
});

// ---------------------------------------------------------------- provider/model info

test("Provider.Info / Model.Info are exactly the pinned contract and decode with the real v2.2.5 schema", () => {
  const info = buildProviderInfo({ brokerURL: BROKER_URL, capability: TEST_CAPABILITY });
  assert.deepEqual(info, {
    id: "oc-cf-aig", name: "OC2 Host Broker", activation: "enabled", package: "@opencode/ai/providers/openai/responses",
    settings: { baseURL: BROKER_URL, apiKey: TEST_CAPABILITY, transport: "http", encoding: "none" },
  });
  assert.equal(PROVIDER_PACKAGE, "@opencode/ai/providers/openai/responses");
  const model = buildModelInfo();
  assert.deepEqual(model, {
    id: "gpt-6-luna", modelID: "gpt-6-luna", providerID: "oc-cf-aig", name: "gpt-6-luna",
    capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 0 }, cost: [],
    status: "active", enabled: true, limit: { context: 200000, output: 32000 },
    compatibility: { supportsPromptCacheKey: false }, settings: { compaction: { type: "summary" } },
  });
  assert.ok(Object.isFrozen(info) && Object.isFrozen(model) && Object.isFrozen(model.compatibility));
  assert.doesNotThrow(() => Schema.decodeUnknownSync(Provider.Info)(info));
  const decoded = Schema.decodeUnknownSync(Model.Info)(model);
  assert.equal(decoded.compatibility.supportsPromptCacheKey, false);
});

test("Step 1b: model-over-provider compatibility resolves supportsPromptCacheKey to literal false", () => {
  const info = buildProviderInfo({ brokerURL: BROKER_URL, capability: TEST_CAPABILITY });
  const model = buildModelInfo();
  // Provider must not carry a compatibility block that could overwrite the model value.
  assert.equal(info.compatibility, undefined);
  for (const providerCompat of [undefined, {}, { supportsPromptCacheKey: true }]) {
    const resolved = { ...(providerCompat ?? {}), ...model.compatibility };
    assert.equal(resolved.supportsPromptCacheKey, false);
  }
});

// ---------------------------------------------------------------- validators

test("acceptance mode accepts only literal m1/m2", () => {
  assert.equal(parseAcceptanceMode("m1"), "m1");
  assert.equal(parseAcceptanceMode("m2"), "m2");
  for (const bad of [undefined, null, "", "M1", "m3", " m1", "m1\n", "auto", 1]) {
    assert.throws(() => parseAcceptanceMode(bad), /acceptance mode/i, String(bad));
  }
});

test("acceptance mode freezes for the process lifetime", async () => {
  const mod = await import(`../../src/guest/provider.mjs?freeze=${Date.now()}`);
  assert.equal(mod.freezeAcceptanceMode("m1"), "m1");
  assert.equal(mod.freezeAcceptanceMode("m1"), "m1");
  assert.throws(() => mod.freezeAcceptanceMode("m2"), /immutable|frozen/i);
  assert.throws(() => mod.freezeAcceptanceMode(undefined), /acceptance mode/i);
  // setupGuest freezes by default: a second setup with another mode is refused (fail closed).
  const fresh = await import(`../../src/guest/provider.mjs?setup=${Date.now()}`);
  const a = createFakeCore();
  await fresh.setupGuest(a.ctx, guestEnv({ OC_CF_AIG_ACCEPTANCE_MODE: "m1" }));
  assert.ok(a.providers.has(PROVIDER_ID));
  const b = createFakeCore();
  await assert.rejects(fresh.setupGuest(b.ctx, guestEnv({ OC_CF_AIG_ACCEPTANCE_MODE: "m2", OC_CF_AIG_GUEST_FIXTURE_ROOT: fixtureRoot() })), /STOP/);
  assert.equal(b.providers.has(PROVIDER_ID), false);
  await assert.rejects(b.runHook("model.request", { kind: "primary", model: { id: MODEL_ID, providerID: PROVIDER_ID }, headers: {} }, PROVIDER_ID), /refused|blocked/i);
});

test("mode is captured at startup; later env mutation cannot switch m1 to m2", async () => {
  const core = createFakeCore();
  const env = guestEnv({ OC_CF_AIG_ACCEPTANCE_MODE: "m1", OC_CF_AIG_GUEST_FIXTURE_ROOT: fixtureRoot() });
  await setupGuest(core.ctx, env, { freezeMode: parseAcceptanceMode });
  env.OC_CF_AIG_ACCEPTANCE_MODE = "m2";
  assert.deepEqual((await core.runHook("context", contextEvent(core), PROVIDER_ID)).tools, {});
  assert.equal(core.calls.toolTransform, 0);
});

test("Broker URL must be the approved plain-HTTP Broker /v1 origin", () => {
  assert.equal(validateBrokerURL("http://host.docker.internal:49187/v1"), "http://host.docker.internal:49187/v1");
  assert.equal(validateBrokerURL("http://127.0.0.1:49187/v1/"), "http://127.0.0.1:49187/v1");
  for (const bad of [
    undefined, "", "https://api.openai.com/v1", "http://evil.example:1/v1", "http://host.docker.internal/v1",
    "http://host.docker.internal:49187/v2", "http://u:p@127.0.0.1:1/v1", "http://127.0.0.1:1/v1?x=1",
    "http://127.0.0.1:1/v1#f", "https://gateway.ai.cloudflare.com/v1/a/b", "http://localhost:1/v1", "http://127.0.0.1:1/v1/responses",
  ]) assert.throws(() => validateBrokerURL(bad), /broker url/i, String(bad));
});

test("capability must be a Broker-minted ocb_ bearer, never an API key", () => {
  assert.equal(validateCapability(TEST_CAPABILITY), TEST_CAPABILITY);
  for (const bad of [undefined, "", "sk-abc", `sk-${"a".repeat(48)}`, `${TEST_CAPABILITY}\n`, `ocb_${"A".repeat(42)}`, `ocb_${"A".repeat(42)} `, "Bearer x"]) {
    assert.throws(() => validateCapability(bad), /capability/i, String(bad));
  }
});

// ---------------------------------------------------------------- startup fail-closed

test("absent/unknown mode STOPs Guest initialization (setup throws); refusal hooks remain as defense in depth", async () => {
  for (const mode of [undefined, "", "m3", "M2"]) {
    const core = createFakeCore();
    const env = guestEnv({ OC_CF_AIG_ACCEPTANCE_MODE: mode });
    if (mode === undefined) delete env.OC_CF_AIG_ACCEPTANCE_MODE;
    await assert.rejects(setupGuest(core.ctx, env, { freezeMode: parseAcceptanceMode }), /Guest initialization STOP/);
    assert.equal(core.providers.has(PROVIDER_ID), false);
    assert.equal(core.calls.toolTransform, 0);
    for (const providerID of [PROVIDER_ID, "openai", "anthropic"]) {
      await assert.rejects(core.runHook("model.request", { kind: "primary", model: { id: MODEL_ID, providerID }, headers: {} }, providerID), /refused|blocked/i);
      await assert.rejects(core.runHook("http.request", { kind: "primary", model: { id: MODEL_ID, providerID }, request: new Request("http://127.0.0.1:1/v1/responses", { method: "POST" }) }, providerID), /refused|blocked/i);
    }
  }
});

test("invalid Broker URL or capability STOPs Guest initialization in both modes", async () => {
  for (const extra of [{ OC_CF_AIG_BROKER_URL: "https://api.openai.com/v1" }, { OC_CF_AIG_BROKER_CAPABILITY: "sk-test" }, { OC_CF_AIG_BROKER_CAPABILITY: undefined }]) {
    for (const mode of ["m1", "m2"]) {
      const core = createFakeCore();
      await assert.rejects(setupGuest(core.ctx, guestEnv({ OC_CF_AIG_ACCEPTANCE_MODE: mode, ...extra }), { freezeMode: parseAcceptanceMode }), /Guest initialization STOP/);
      assert.equal(core.providers.has(PROVIDER_ID), false);
      await assert.rejects(core.runHook("model.request", { kind: "primary", model: { id: MODEL_ID, providerID: PROVIDER_ID }, headers: {} }, PROVIDER_ID), /refused|blocked/i);
    }
  }
});

test("provider registration failure (pre-existing oc-cf-aig) STOPs Guest initialization", async () => {
  const core = createFakeCore();
  core.providers.set(PROVIDER_ID, { provider: { id: PROVIDER_ID, name: "hostile", activation: "enabled", package: "x" }, models: new Map() });
  await assert.rejects(setupGuest(core.ctx, guestEnv(), { freezeMode: parseAcceptanceMode }), /Guest initialization STOP/);
});

test("real directory-loaded plugin setup throws on missing mode (Plugin init STOP)", async () => {
  const mod = await Host.load(Host.resolve({ directory: GUEST_DIR }).server);
  const saved = process.env.OC_CF_AIG_ACCEPTANCE_MODE;
  delete process.env.OC_CF_AIG_ACCEPTANCE_MODE;
  try {
    await assert.rejects(mod.default.setup(createFakeCore().ctx), /Guest initialization STOP/);
  } finally {
    if (saved !== undefined) process.env.OC_CF_AIG_ACCEPTANCE_MODE = saved;
  }
});

test("Guest setup reads only its own process-local OC_CF_AIG_* variables (no Host OAuth/Cloudflare credentials)", async () => {
  const { env, accessed } = envProxy({ ...guestEnv({ OC_CF_AIG_ACCEPTANCE_MODE: "m2", OC_CF_AIG_GUEST_FIXTURE_ROOT: fixtureRoot() }), CF_AIG_TOKEN: "HOST-SECRET", OPENAI_API_KEY: "sk-host" });
  const core = createFakeCore();
  await setupGuest(core.ctx, env, { freezeMode: parseAcceptanceMode });
  assert.deepEqual([...accessed].sort(), ["OC_CF_AIG_ACCEPTANCE_MODE", "OC_CF_AIG_BROKER_CAPABILITY", "OC_CF_AIG_BROKER_URL", "OC_CF_AIG_GUEST_FIXTURE_ROOT"]);
  assert.deepEqual(core.calls.forbidden, []);
  const settings = core.providers.get(PROVIDER_ID).provider.settings;
  assert.equal(settings.apiKey, TEST_CAPABILITY);
  assert.ok(!JSON.stringify([...core.providers.values()].map((p) => p.provider)).includes("HOST-SECRET"));
});

// ---------------------------------------------------------------- M1-C

test("M1-C: m1 registers only the dedicated provider, never guest_read_file, and the context map is empty", async () => {
  const core = createFakeCore();
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m1" });
  assert.equal(core.calls.toolTransform, 0, "m1 must not call ctx.tool.transform");
  assert.equal(core.tools.has(GUEST_TOOL_ID), false);
  const rec = core.providers.get(PROVIDER_ID);
  assert.deepEqual(rec.provider, buildProviderInfo({ brokerURL: BROKER_URL, capability: TEST_CAPABILITY }));
  assert.deepEqual([...rec.models.keys()], [MODEL_ID]);
  // Existing providers are not edited or used as a fallback.
  assert.deepEqual(core.providers.get("openai").provider.package, "@opencode/ai/providers/openai");
  const ctxHook = core.hooks.find((h) => h.name === "context");
  assert.deepEqual(ctxHook.options, { providerID: PROVIDER_ID });
  const event = await core.runHook("context", contextEvent(core), PROVIDER_ID);
  assert.deepEqual(event.tools, {});
  assert.equal("maxTokens" in event.options, false, "options.maxTokens suppressed for max_output_tokens");
  // Text request may proceed past model.request.
  const req = { kind: "primary", model: { id: MODEL_ID, providerID: PROVIDER_ID }, headers: {} };
  await core.runHook("model.request", req, PROVIDER_ID);
});

test("M1-C: empty map regardless of injected default tools and even a registered guest_read_file", async () => {
  const core = createFakeCore({ preRegister: [{ id: GUEST_TOOL_ID, name: GUEST_TOOL, description: "x", input: READ_FILE_SCHEMA, execute: async () => ({}) }] });
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m1" });
  const event = contextEvent(core);
  for (const n of [...DEFAULT_TOOL_NAMES, GUEST_TOOL_ID, "arbitrary_extra"]) assert.ok(n in event.tools);
  await core.runHook("context", event, PROVIDER_ID);
  assert.deepEqual(event.tools, {});
});

// ---------------------------------------------------------------- M2-B / Step 1c

test("M2-B: m2 registers exactly guest_read_file in namespace guest with codemode:false", async () => {
  const core = createFakeCore();
  const root = fixtureRoot();
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m2", fixtureRoot: root });
  assert.equal(core.calls.toolTransform, 1);
  assert.deepEqual(core.namespaces.get(GUEST_NAMESPACE), { name: "guest", description: "Disposable Sandbox-only tools" });
  const tool = core.tools.get(GUEST_TOOL_ID);
  assert.equal(tool.name, "read_file");
  assert.equal(tool.description, "Read an approved disposable Guest fixture");
  assert.deepEqual(tool.input, READ_FILE_SCHEMA);
  assert.deepEqual(tool.options, { namespace: "guest", codemode: false });
  assert.deepEqual(await tool.execute({ path: "fixture.txt" }, {}), { content: "fixture body\n" });
});

test("Step 1c: m2 context exposes exactly one key read_file with the unchanged original definition identity", async () => {
  const core = createFakeCore();
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m2", fixtureRoot: fixtureRoot() });
  const event = contextEvent(core);
  const original = event.tools[GUEST_TOOL_ID];
  for (const n of [...DEFAULT_TOOL_NAMES, GUEST_TOOL_ID, "arbitrary_extra"]) assert.ok(n in event.tools);
  await core.runHook("context", event, PROVIDER_ID);
  assert.deepEqual(Object.keys(event.tools), ["read_file"]);
  assert.equal(event.tools.read_file, original, "same object reference");
  // Identity mapping dispatches flat read_file to the Guest registry executor guest_read_file.
  const out = await core.dispatch(event.tools, { name: "read_file", namespace: "guest", input: { path: "fixture.txt" } });
  assert.equal(out.id, GUEST_TOOL_ID);
  assert.deepEqual(out.result, { content: "fixture body\n" });
  for (const n of DEFAULT_TOOL_NAMES) await assert.rejects(core.dispatch(event.tools, { name: n, input: {} }), /not exposed/);
});

test("Step 1c: m2 rejects missing tool, pre-existing read_file collision, altered schema and replaced identity", async () => {
  const core = createFakeCore();
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m2", fixtureRoot: fixtureRoot() });
  const missing = contextEvent(core);
  delete missing.tools[GUEST_TOOL_ID];
  await assert.rejects(core.runHook("context", missing, PROVIDER_ID), /guest_read_file/);
  const collision = contextEvent(core);
  collision.tools.read_file = { description: "built-in read", input: READ_FILE_SCHEMA };
  await assert.rejects(core.runHook("context", collision, PROVIDER_ID), /collision/);
  const altered = contextEvent(core);
  altered.tools[GUEST_TOOL_ID] = { description: "Read an approved disposable Guest fixture", input: { type: "object" } };
  await assert.rejects(core.runHook("context", altered, PROVIDER_ID), /schema|identity/);
});

test("Step 1c: m2 without a usable fixture root is M2 BLOCKED (no registration, context fails closed); m1 unaffected", async () => {
  for (const root of [undefined, "relative/dir", "/nonexistent/guest-fixture-root"]) {
    const core = createFakeCore();
    await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m2", fixtureRoot: root });
    assert.equal(core.tools.has(GUEST_TOOL_ID), false);
    await assert.rejects(core.runHook("context", contextEvent(core), PROVIDER_ID), /M2 BLOCKED/);
  }
  const m1 = createFakeCore();
  await registerGuestProvider(m1.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m1" });
  assert.deepEqual((await m1.runHook("context", contextEvent(m1), PROVIDER_ID)).tools, {});
});

test("applyPrimaryToolAllowlist rejects unknown modes fail-closed", () => {
  assert.throws(() => applyPrimaryToolAllowlist({ tools: {} }, "m3"), /acceptance mode/i);
  assert.throws(() => applyPrimaryToolAllowlist({ tools: {} }, undefined), /acceptance mode/i);
});

test("Step 1c: other providers' context maps are untouched and their model requests are refused (no fallback)", async () => {
  const core = createFakeCore();
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m2", fixtureRoot: fixtureRoot() });
  const other = contextEvent(core, { providerID: "openai", modelID: "gpt-5" });
  const before = { ...other.tools };
  await core.runHook("context", other, "openai");
  assert.deepEqual(Object.keys(other.tools), Object.keys(before));
  for (const k of Object.keys(before)) assert.equal(other.tools[k], before[k]);
  assert.equal(other.options.maxTokens, 32000);
  await assert.rejects(core.runHook("model.request", { kind: "primary", model: { id: "gpt-5", providerID: "openai" }, headers: {} }, "openai"), /fallback|refused/i);
});

test("primary context for a non-pinned model id on oc-cf-aig fails closed", async () => {
  const core = createFakeCore();
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m1" });
  await assert.rejects(core.runHook("context", contextEvent(core, { modelID: "gpt-4o" }), PROVIDER_ID), /model/);
});

// ---------------------------------------------------------------- request guards

test("model.request: only primary requests to the pinned Broker with no forbidden headers", async () => {
  const core = createFakeCore();
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m1" });
  const ok = { kind: "primary", model: { id: MODEL_ID, providerID: PROVIDER_ID }, headers: {}, baseURL: BROKER_URL };
  await core.runHook("model.request", ok, PROVIDER_ID);
  for (const kind of ["compaction", "title", "generate"]) {
    await assert.rejects(core.runHook("model.request", { ...ok, kind }, PROVIDER_ID), /primary/);
  }
  await assert.rejects(core.runHook("model.request", { ...ok, baseURL: "https://api.openai.com/v1" }, PROVIDER_ID), /Broker/);
  await assert.rejects(core.runHook("model.request", { ...ok, model: { id: "gpt-4o", providerID: PROVIDER_ID } }, PROVIDER_ID), /model/);
  for (const h of ["cf-aig-authorization", "x-api-key", "OpenAI-Organization", "cookie"]) {
    await assert.rejects(core.runHook("model.request", { ...ok, headers: { [h]: "v" } }, PROVIDER_ID), /header/);
  }
});

test("http.request: the Guest bearer goes only to the Broker /v1/responses (never upstream)", async () => {
  const core = createFakeCore();
  await registerGuestProvider(core.ctx, { brokerURL: BROKER_URL, capability: TEST_CAPABILITY, mode: "m1" });
  const ev = (url, init = {}) => ({ kind: "primary", model: { id: MODEL_ID, providerID: PROVIDER_ID }, request: new Request(url, { method: "POST", ...init, headers: { authorization: `Bearer ${TEST_CAPABILITY}`, "content-type": "application/json", ...(init.headers ?? {}) } }) });
  await core.runHook("http.request", ev(`${BROKER_URL}/responses`), PROVIDER_ID);
  for (const url of ["https://api.openai.com/v1/responses", "https://gateway.ai.cloudflare.com/v1/a/b/custom-openai-public-probe/v1/responses", `${BROKER_URL}/models`, `${BROKER_URL}/responses?x=1`]) {
    await assert.rejects(core.runHook("http.request", ev(url), PROVIDER_ID), /Broker/, url);
  }
  await assert.rejects(core.runHook("http.request", { ...ev(`${BROKER_URL}/responses`), request: new Request(`${BROKER_URL}/responses`, { method: "GET", headers: { authorization: `Bearer ${TEST_CAPABILITY}` } }) }, PROVIDER_ID), /Broker/);
  await assert.rejects(core.runHook("http.request", ev(`${BROKER_URL}/responses`, { headers: { authorization: "Bearer sk-other" } }), PROVIDER_ID), /bearer/i);
  await assert.rejects(core.runHook("http.request", ev(`${BROKER_URL}/responses`, { headers: { "x-api-key": "k" } }), PROVIDER_ID), /header/);
});

// ---------------------------------------------------------------- fixture reader

test("fixture reader confines reads to the disposable fixture root", async () => {
  const root = fixtureRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "guest-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  fs.symlinkSync(outside, path.join(root, "linkdir"));
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(70 * 1024));
  fs.writeFileSync(path.join(root, "bad-utf8.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
  const read = createFixtureReader({ root });
  assert.deepEqual(await read({ path: "fixture.txt" }), { content: "fixture body\n" });
  assert.deepEqual(await read({ path: "sub/nested.txt" }), { content: "nested" });
  for (const bad of [
    { path: "../secret.txt" }, { path: path.join(outside, "secret.txt") }, { path: "sub/../../x" }, { path: "link.txt" },
    { path: "linkdir/secret.txt" }, { path: "sub" }, { path: "big.txt" }, { path: "bad-utf8.bin" }, { path: "a\0b" },
    { path: "" }, { path: "missing.txt" }, { path: 1 }, {}, { path: "fixture.txt", extra: 1 }, null,
  ]) {
    await assert.rejects(read(bad), /fixture/i, JSON.stringify(bad));
  }
  assert.throws(() => createFixtureReader({ root: "relative" }), /fixture root/i);
  assert.throws(() => createFixtureReader({ root: path.join(root, "fixture.txt") }), /fixture root/i);
});

test("fixture reader refuses a FIFO without hanging", async () => {
  const root = fixtureRoot();
  const { execFileSync } = await import("node:child_process");
  execFileSync("mkfifo", [path.join(root, "pipe")]);
  const read = createFixtureReader({ root });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("HANG")), 2000).unref());
  await assert.rejects(Promise.race([read({ path: "pipe" }), timeout]), /fixture/i);
});

test("fixture reader re-checks the opened handle stays under root (intermediate dir swap race)", async () => {
  const root = fixtureRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "guest-outside-"));
  fs.mkdirSync(path.join(outside, "sub"));
  fs.writeFileSync(path.join(outside, "sub", "nested.txt"), "SECRET");
  // Swap sub -> symlink to outside after the component lstat checks but before open.
  const read = createFixtureReader({
    root,
    beforeOpen: () => {
      fs.renameSync(path.join(root, "sub"), path.join(root, "sub.orig"));
      fs.symlinkSync(path.join(outside, "sub"), path.join(root, "sub"));
    },
  });
  await assert.rejects(read({ path: "sub/nested.txt" }), /fixture/i);
});

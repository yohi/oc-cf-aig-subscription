import test from "node:test"
import assert from "node:assert/strict"
import { registerGateway, settingsFromEnv, assertGatewayRequest } from "../src/gateway.mjs"

const env = {
  OC_CF_AIG_HOST_ONLY: "1",
  CF_AIG_BASE: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/subscription-poc`,
  CF_AIG_TOKEN: "cf-test-token",
}
function fakeCtx(credential = { type: "oauth", methodID: "chatgpt-token-sharing" }) {
  const hooks = {}
  const provider = { settings: { transport: "websocket" } }
  return {
    provider, hooks,
    ctx: {
      provider: {
        async transform(cb) {
          cb({
            get: (id) => id === "openai" ? { provider } : undefined,
            update: (_id, fn) => fn(provider),
          })
        },
      },
      integration: {
        connection: {
          active: async () => ({ type: "credential", method: "oauth" }),
          resolve: async () => credential,
        },
      },
      session: { async hook(name, callback, scope) { hooks[name] = { callback, scope } } },
    },
  }
}

test("gateway config pins Cloudflare host and path", () => {
  const settings = settingsFromEnv(env)
  assert.match(settings.endpoint, /custom-openai-public-probe\/v1$/)
  for (const candidate of [
    "https://evil.example/v1/a/g",
    "http://gateway.ai.cloudflare.com/v1/a/g",
    "https://gateway.ai.cloudflare.com.evil/v1/a/g",
    "https://gateway.ai.cloudflare.com/v1/abc/subscription-poc",
    `${env.CF_AIG_BASE}?override=1`,
  ]) assert.throws(() => settingsFromEnv({ ...env, CF_AIG_BASE: candidate }))
  assert.throws(() => settingsFromEnv({ ...env, CF_AIG_TOKEN: "bad\nheader" }))
})

test("host-only opt-in is required", async () => {
  await assert.rejects(registerGateway(fakeCtx().ctx, { ...env, OC_CF_AIG_HOST_ONLY: "" }), /Host-only/)
})

test("native SIWC connects via HTTP with no-wholesale headers", async () => {
  const f = fakeCtx()
  await registerGateway(f.ctx, env)
  assert.equal(f.provider.settings.transport, "http")
  assert.equal(f.provider.settings.encoding, "none")
  assert.deepEqual(f.hooks["model.request"].scope, { providerID: "openai" })
  const event = { headers: {}, baseURL: "https://api.openai.com/v1" }
  await f.hooks["model.request"].callback(event)
  assert.equal(event.headers["cf-aig-no-wholesale"], "true")
  assert.equal(event.headers["cf-aig-collect-log-payload"], "false")
  assert.equal(event.headers["cf-aig-skip-cache"], "true")
  assert.ok(event.baseURL.endsWith("/custom-openai-public-probe/v1"))
  const req = new Request(`${event.baseURL}/responses`, {
    method: "POST",
    headers: { ...event.headers, authorization: "Bearer oauth-test-token" },
  })
  assert.doesNotThrow(() => f.hooks["http.request"].callback({ request: req }))
})

test("API key and legacy OAuth fail closed", async () => {
  for (const credential of [
    { type: "key", key: "sk-test" },
    { type: "oauth", methodID: "chatgpt-browser" },
    null,
  ]) {
    const f = fakeCtx(credential)
    await registerGateway(f.ctx, env)
    await assert.rejects(f.hooks["model.request"].callback({ headers: {} }), /Only native/)
  }
})

test("direct, non-responses and wrong-policy requests are refused", () => {
  const endpoint = settingsFromEnv(env).endpoint
  const headers = {
    authorization: "Bearer token-test",
    "cf-aig-authorization": "Bearer cf-test",
    "cf-aig-no-wholesale": "true",
    "cf-aig-collect-log-payload": "false",
    "cf-aig-skip-cache": "true",
  }
  const req = (url, h = headers) => new Request(url, { method: "POST", headers: h })
  assert.doesNotThrow(() => assertGatewayRequest(req(`${endpoint}/responses`), endpoint))
  for (const url of [
    "https://api.openai.com/v1/responses",
    `${endpoint}/models`,
    `${endpoint}/responses?bypass=true`,
  ]) assert.throws(() => assertGatewayRequest(req(url), endpoint), /blocked/)
  assert.throws(() => assertGatewayRequest(req(`${endpoint}/responses`, { ...headers, authorization: "Bearer sk-test" }), endpoint), /OAuth/)
  assert.throws(() => assertGatewayRequest(req(`${endpoint}/responses`, { ...headers, "x-api-key": "test" }), endpoint), /API-key/)
  assert.throws(() => assertGatewayRequest(req(`${endpoint}/responses`, { ...headers, "cf-aig-no-wholesale": "false" }), endpoint), /policy/)
})

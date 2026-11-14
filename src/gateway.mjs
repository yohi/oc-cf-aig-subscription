/** Fail-closed routing of OpenCode's native SIWC OAuth to Cloudflare AI Gateway. */
export const OPENAI_SIWC_METHOD = "chatgpt-token-sharing"
export const OPENAI_CUSTOM_PROVIDER = "custom-openai-public-probe"

export function settingsFromEnv(env) {
  const raw = env.CF_AIG_BASE
  const token = env.CF_AIG_TOKEN
  if (typeof raw !== "string" || typeof token !== "string" || !token || /[\r\n\s]/.test(token)) {
    throw new Error("Cloudflare Gateway configuration missing or invalid")
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Invalid Cloudflare Gateway base URL")
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "gateway.ai.cloudflare.com" ||
    url.port || url.username || url.password || url.search || url.hash ||
    !/^\/v1\/[a-f0-9]{32}\/[a-z0-9][a-z0-9-]*\/?$/.test(url.pathname)
  ) {
    throw new Error("Cloudflare Gateway base URL does not match the approved host/path")
  }
  const base = url.origin + url.pathname.replace(/\/$/, "")
  return { endpoint: `${base}/${OPENAI_CUSTOM_PROVIDER}/v1`, token }
}

export function assertGatewayRequest(request, endpoint) {
  const url = new URL(request.url)
  const origin = new URL(endpoint)
  if (
    url.origin !== origin.origin ||
    url.pathname !== `${origin.pathname}/responses` ||
    url.search || url.hash ||
    request.method !== "POST"
  ) {
    throw new Error("Non-Gateway or non-Responses model request blocked")
  }
  const auth = request.headers.get("authorization")
  if (!auth || !/^Bearer [^\s]+$/.test(auth) || /^Bearer sk-/i.test(auth)) {
    throw new Error("Expected an OpenAI OAuth bearer, not an API key")
  }
  if (request.headers.has("x-api-key") || request.headers.has("api-key")) {
    throw new Error("API-key authentication forbidden")
  }
  for (const [name, value] of [
    ["cf-aig-no-wholesale", "true"],
    ["cf-aig-collect-log-payload", "false"],
    ["cf-aig-skip-cache", "true"],
  ]) {
    if (request.headers.get(name) !== value) throw new Error(`Missing required Gateway policy: ${name}`)
  }
  if (!/^Bearer [^\s]+$/.test(request.headers.get("cf-aig-authorization") ?? "")) {
    throw new Error("Missing Cloudflare Gateway authorization")
  }
}

export async function registerGateway(ctx, env = process.env) {
  // Explicit opt-in only: this is not an automatic host / Sandbox detector.
  if (env.OC_CF_AIG_HOST_ONLY !== "1") {
    throw new Error("Host-only mode is not enabled; sandbox isolation is not implemented")
  }
  let settings
  try {
    settings = settingsFromEnv(env)
  } catch {
    // Plugin setup must complete so that the scoped rejection hooks remain active.
    // Rethrowing after registration would close the activation scope and remove them.
    const refuse = () => {
      throw new Error("Cloudflare AI Gateway configuration invalid; OpenAI requests blocked")
    }
    await ctx.session.hook("model.request", refuse, { providerID: "openai" })
    await ctx.session.hook("http.request", refuse, { providerID: "openai" })
    return
  }
  const { endpoint, token } = settings

  await ctx.provider.transform((editor) => {
    if (!editor.get("openai")) throw new Error("OpenAI native provider is unavailable")
    editor.update("openai", (provider) => {
      provider.settings = { ...provider.settings, transport: "http", encoding: "none" }
    })
  })

  // Native OpenCode SIWC integration owns OAuth credential lifecycle/refresh.
  await ctx.session.hook("model.request", async (event) => {
    const connection = await ctx.integration.connection.active("openai")
    if (connection?.type !== "credential" || connection.method !== "oauth") {
      throw new Error("Active OpenAI connection is not OAuth; API-key fallback blocked")
    }
    const credential = await ctx.integration.connection.resolve(connection)
    if (credential?.type !== "oauth" || credential.methodID !== OPENAI_SIWC_METHOD) {
      throw new Error("Only native Sign in with ChatGPT is allowed")
    }
    event.baseURL = endpoint
    event.headers["cf-aig-authorization"] = `Bearer ${token}`
    event.headers["cf-aig-no-wholesale"] = "true"
    event.headers["cf-aig-collect-log-payload"] = "false"
    event.headers["cf-aig-skip-cache"] = "true"
  }, { providerID: "openai" })

  // Deny any final request that does not preserve the exact expected route/policy.
  await ctx.session.hook("http.request", (event) => {
    assertGatewayRequest(event.request, endpoint)
  }, { providerID: "openai" })
}

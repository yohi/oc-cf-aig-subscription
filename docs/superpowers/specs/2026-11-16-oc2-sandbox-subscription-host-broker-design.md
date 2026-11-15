# OC2 Sandbox Subscription Gateway — Host Broker Design R0.1.1

- **Status:** DESIGN R0.1 ADOPTED (Owner 2026-11-16 JST) / R0.1.1 LIMITED CORRECTION / IMPLEMENTATION HOLD
- **Date:** 2026-11-16 (JST)
- **Repository:** `yohi/oc-cf-aig-subscription`
- **Baseline:** `feature/subscription-gateway-host-mvp-20261114` @ `05fdf258134e5e9af0d2c01d5fec0529a1b2681b`
- **Owner decisions:** Approach A selected and Design R0.1 adopted (2026-11-16 JST). R0.1.1 limits itself to Review Gate F-001–F-006. Acceptance of corrected wording and **Implementation GO** are separate Owner decisions; neither is inferred. No code/Sandbox/Host/network changes, authentication, PR creation or merge authorized.

## 1. Intent and success

Run OpenCode v2.2.5's agent and tools **inside a disposable Docker Sandbox microVM**, while using ChatGPT Plus SIWC OAuth through Cloudflare AI Gateway without handing the guest OpenAI OAuth access/refresh tokens or `CF_AIG_TOKEN`.

A successful **first milestone** is an OpenCode `gpt-6-luna` request made inside the guest which returns exactly `gateway-ok`, appears as an HTTP 200 `custom-openai-public-probe/v1/responses` request in `subscription-poc`, and demonstrably uses the Host Broker. The end-to-end agent milestone adds a function-tool round trip whose tool executes **inside the guest**, not on the host. No API-key, Cloudflare Unified Billing, direct OpenAI, or legacy Codex fallback is allowed.

Fail-closed behavior and absence of real credentials in the guest are mandatory, not follow-up niceties.

## 2. Known baseline and evidence boundaries

- The existing Host-only plugin verifies native `chatgpt-token-sharing` credentials and injects the Cloudflare headers. It reads the OAuth credential and the Cloudflare token inside its process and is **unsafe to deploy to the guest as-is**.
- User-observed Host OpenCode v2.2.5 run of `openai/gpt-6-luna` returned `gateway-ok`; Cloudflare requests to `custom-openai-public-probe/v1/responses` were visible. Some runs logged HTTP 499; its exact cause and complete SSE/tool support are **not established**.
- Docker's current documentation describes `host.docker.internal` for access from a sandbox to host services and network policy allowing `localhost:<port>`. This path has **not been demonstrated on the target v0.51.0 installation** and must be checked in a disposable sandbox before any substantive integration.
- Docker also offers a host-side credential proxy with sentinel tokens and, for supported services, OAuth. Native support for the precise **SIWC token-sharing + custom Cloudflare gateway** route under the target version is **not established**. Do not assume an existing Docker secret rule solves it.
- The current GitHub branch is a Host-only MVP, not a production-ready subscription proxy.

## 3. Approaches considered and selected

| Approach | Benefit | Limitation | Decision |
| --- | --- | --- | --- |
| **A. Dedicated Host Broker + guest integration** | Explicit trust boundary, can restrict routes, preserve guest tool execution | Extra host process; OAuth renewal, network policy, and capability control required | **Selected by Owner** |
| B. Guest connects to existing Host OpenCode server | Fewer new services | Agent/Tool execution may occur on host; exposes a much broader service surface | Rejected for this goal |
| C. Place OAuth/Gateway credentials in sandbox | Simple setup | Violates no-secrets-in-guest goal | Rejected |
| D. Only Docker's native credential injection | Could eliminate custom Broker | Target version + SIWC + dual headers + token refresh routing unverified | Possible future simplification, not an implementation prerequisite |

## 4. Trust boundaries and topology

```text
[Disposable OC2 Sandbox microVM]                       [Ubuntu Host]
 OpenCode v2.2.5
 Guest provider/adapter
 - no OpenAI OAuth access/refresh tokens
 - no Cloudflare AI Gateway token
 - no host filesystem or Docker socket
 - narrow, short-lived guest capability      -> Docker sandbox policy proxy
                                                -> host.docker.internal:<port>
                                                -> Host Broker (loopback bind)
                                                   - authenticate guest capability
                                                   - validate /v1/responses and model
                                                   - independently acquire/refresh SIWC
                                                   - inject Cloudflare gateway header
                                                   - stream upstream response
                                                -> Cloudflare AI Gateway
                                                   custom-openai-public-probe
                                                -> OpenAI Responses API
```

The sandbox is fully untrusted, including Agent tool output, repository content, user-provided prompts and any program that can call the Broker. Possession of the guest capability authorizes **limited model usage**, not access to actual OAuth/Gateway credentials. A compromised sandbox may still exhaust its **bounded** allowed usage; this is a residual risk.

Never forward a guest-provided `Authorization`, `cf-aig-*`, `x-api-key`, or upstream-target header to OpenAI or Cloudflare. The Broker constructs outbound authentication from host-held values only.

## 5. Components and responsibilities

### 5.1 Guest OpenCode integration

- **Fixed SDK:** OpenCode v2.2.5 native `@opencode/ai@2.2.5`, module `@opencode/ai/providers/openai/responses`; plugin API `@opencode/plugin@2.2.5`. This is the runtime's native Responses SDK, not a separately selected API-key SDK. Keep Host `src/index.js` / `src/gateway.mjs` unchanged.
- **Loading:** Guest-only `src/guest/index.js` exports `Plugin.define({id:"oc-cf-aig-guest",setup(ctx){return registerGuestProvider(ctx,config)}})`; load its absolute **file path** via disposable Guest `opencode.jsonc` `plugins` entry, not the repo's Host-only default entry. Add `package.json` subpath export `"./guest":"./src/guest/index.js"` without replacing `".":"./src/index.js"`. Guest mode `OC_CF_AIG_MODE=guest` only.
- **Registration:** `await ctx.provider.transform(editor => editor.add({info,models:[model]}))`, new provider `oc-cf-aig`. Required `Provider.Info`: `{id:"oc-cf-aig",name:"OC2 Host Broker",activation:"enabled",package:"@opencode/ai/providers/openai/responses",settings:{baseURL:"http://host.docker.internal:<port>/v1",apiKey:<guest-capability>,transport:"http",encoding:"none"}}`. `apiKey` here is only the **bounded Broker bearer** used by the native SDK for `Authorization`, **not an OpenAI API key**; no `OPENAI_API_KEY` or native OpenAI credentials in Guest.
- **Model:** `Model.Info` required fields: `{id:"gpt-6-luna",modelID:"gpt-6-luna",providerID:"oc-cf-aig",name:"gpt-6-luna",capabilities:{tools:true,input:["text"],output:["text"]},variants:[],time:{released:0},cost:[],status:"active",enabled:true,limit:{context:200000,output:32000},settings:{compaction:{type:"summary"}}}`. The `200000/32000` numbers are **OpenCode schema default metadata placeholders**, not a verified model entitlement or security budget. If unavailable in the pinned runtime, STOP; do not choose a new SDK.
- **Guards:** `model.request` and `http.request` hooks scoped to `providerID:"oc-cf-aig"` verify Broker URL, path `/v1/responses`, model and HTTP transport. `http.request.request` is readonly; it cannot be relied on to rewrite the SDK body. Broker performs canonical SIWC projection; Guest preparation must exclude unsupported SDK output or Broker returns 400. Plugin-missing fail-open is countered by independently verified Sandbox egress deny-by-default.
- **Same M1/M2 SDK:** native Responses/SSE serves text and client-side function calls. The Broker wraps admissible flat function/custom tool declarations in namespace `guest`. Returned `function_call` includes `namespace:"guest"`; Guest `http.response` streaming adapter must be shown to preserve SSE and map that call to a local OpenCode tool, whose execution and `function_call_output` remain in Guest. If the pinned SDK cannot support this safely, mark M2 BLOCKED; no Host tool execution.
- **Capability transfer:** Host issues a short-lived test bearer and transfers it **once over stdin/an inherited file descriptor** to a disposable Guest-only launcher `bin/guest-launch.mjs`, which starts OpenCode with process-local `OC_CF_AIG_BROKER_CAPABILITY` and the approved Broker URL. Bearer is readable to compromised Guest code by design, but no **real** OAuth or Cloudflare tokens are supplied. Do not put the bearer in arguments, shell history, Git, logs, image layers, persistent mounts or sandbox config. Verify v0.51.0's non-logging stdin delivery first; if unavailable STOP rather than silently writing a file.

### 5.2 Dedicated Host Broker

- Independent foreground Node.js 22+ process, `127.0.0.1:<port>` only; no new systemd daemon. Docker v0.51.0 Guest `host.docker.internal:<port>` access is UNVERIFIED until Task 1.
- Accept only `GET /health`, bearer-authenticated `GET /v1/models`, bearer-authenticated `POST /v1/responses`; reject arbitrary URL, method, query, path or provider. Construct the upstream destination strictly `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/custom-openai-public-probe/v1/responses`.
- Authenticate by random guest bearer, not self-declared `sandboxID` (management label only absent trusted transport proof). Capability may be reused until expiry/revocation/quota; `maxCalls` limits lifetime admissions, `maxCallsPerWindow/windowMs` limits rate separately; `maxConcurrent` limits active requests.
- Measure **raw actual request body bytes** before parse (per-request `maxRequestBytes`). Meter raw streamed upstream SSE bytes with `permit.chargeResponse(n)` (per-request `maxResponseBytes`), and cumulative request+response bytes across that capability (`maxTotalBytes`). Broker enforces active `ttlMs` and per-call `maxRequestDurationMs`; abort upstream and idempotently `permit.release()` on limit, disconnect, error or completion, with no unbounded buffering.
- All outgoing headers are built by Host allowlist, never forwarded from Guest. Host SIWC `Authorization`, Host `cf-aig-authorization`, `cf-aig-no-wholesale:true`, `cf-aig-collect-log-payload:false`, `cf-aig-skip-cache:true`; no BYOK, alternate provider or Unified Billing fallback. Disable Cloudflare Logpush separately if external payload storage is forbidden.
- Only canonical SIWC body §7 is sent; reject `stream:false`, non-array `input`, `previous_response_id`, unsupported parameters or tools before upstream. **Every upstream call sets `store:false` and `stream:true`.** Return only safe response headers and redacted diagnostic metadata; never log token/body. Broker streams but executes no agent tools.
- Stream is successful only with `response.completed` **and clean completion**. `response.failed`, `response.incomplete`, malformed SSE, premature EOF or cancellation is failure; abort/release without retry/fallback.

### 5.3 Host SIWC credential source

- Official **SIWC dynamic-registration OAuth only**. Persist once a stable Host-specific `ext_agent_host_id = "urn:uuid:<UUIDv4>"` in the Host-only protected store, independent of guest sandboxID. No client secret, API key, or legacy Codex flow.
- **First sign-in:** `GET https://auth.openai.com/api/accounts/authorize` with `client_id=dynamic_agent_client`, fixed `agent_name_hint=OC2 Subscription Broker`, stable `ext_agent_host_id`, `response_type=code`, `resource=https://api.openai.com/v1`, scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, fresh state/nonce/PKCE(S256), and exact `redirect_uri=http://127.0.0.1:<dynamic-port>/auth/callback`. Listen before opening browser; use SSH loopback forwarding for remote Host.
- **Callback/exchange:** verify state, extract **issued** client_id from new-registration callback (never use `dynamic_agent_client` as the token-exchange client ID), POST authorization-code exchange to `https://auth.openai.com/api/accounts/oauth/token` with issued client ID, exactly matching redirect URI, PKCE verifier and resource. Verify signed ID token against OpenAI JWKS: issuer `https://auth.openai.com`, audience issued client ID, nonce, expiry and verified account identity. Confirm required granted scopes.
- **Storage:** per-registration atomic credential record includes issued client_id, validated issuer/subject and identity label, grant scopes, retained ID token, access token, rotating refresh token, token type, expiry, optional `earliest_refresh_at` and persistent Host ID. Parent directory 0700, file 0600, no symlinks/logs; never overwrite another account/workspace. Authorization URL with `id_token_hint` is sensitive and must not be logged.
- **Reauth:** reuse issued client ID + stable Host ID, omit agent_name_hint, optionally send retained `id_token_hint` to OpenAI authorize endpoint only, use new state/nonce/PKCE and validate identity before activation.
- **Refresh:** serialize per account and across Broker workers; `POST https://auth.openai.com/api/accounts/oauth/token` with `grant_type=refresh_token`, latest refresh token, issued client ID, `resource`, and **no scope override**; atomically replace the **entire token set** including rotating refresh token and expiry, before concurrent uses. On invalid grant or transient refresh failure, fail closed; reauthorize if required, never use BYOK. Prior Host PoC is not proof of refresh.
- Independent confirmation of subscription billing is still NOT_VERIFIED.

### 5.4 Claude Pro

Claude Agent Provider has previously traversed Cloudflare AI Gateway from a host CLI, but it has a different authentication/protocol path from SIWC. **Claude is not implemented by the first ChatGPT-only Broker milestone.** Its Host-side adapter will require a separate explicit feasibility decision, without allowing Claude tools to execute on host. Do not reuse an unverified Anthropic OAuth bearer in a generic API proxy.

## 6. Security and policy contract

1. Guest must not receive real OpenAI OAuth access/refresh/ID tokens, Cloudflare token, Host credential DB, Host OpenCode socket, SSH agent or Docker socket. **Guest capability is intentionally readable**, but bounded and revocable.
2. Authenticate capability by digest-matched bearer, model, actual requestBytes, expiry, revocation, maxCalls, maxCallsPerWindow/windowMs, maxConcurrent, maxRequestBytes, maxResponseBytes, maxTotalBytes, maxRequestDurationMs. `sandboxID` is **only a management label** until independently authenticated by transport; never use it as authorization proof. Limited reuse is allowed; blanket replay-prevention is **not** claimed.
3. **Effective deny-by-default policy is mandatory:** read back the disposable Sandbox's effective policy including inherited global rules, presets, sandbox rules and precedence; test that **no destination other than the Broker** can carry inference traffic. Include arbitrary hostname, direct IP, alternate port, proxy/CONNECT and DNS-derived bypass. Verify observed denial, not merely rule installation. If a global allow/preset overrides this and sandbox-only restrictions cannot fix it, **STOP**; never reset/change global Host policy.
4. Allow exactly `host.docker.internal:<broker-port>` if actually supported under Docker Sandboxes v0.51.0. Deny `api.openai.com`, `chatgpt.com`, `gateway.ai.cloudflare.com`, `api.anthropic.com` **and any unapproved egress**. Any unsupported CLI flag or uncertain enforcement is UNVERIFIED and a STOP before M1/M2.
5. Broker never provides arbitrary HTTP tunneling, Host tools/shell, account management, mounted files or unconstrained model requests. It authenticates and forwards inference only.
6. Missing plugin, unsafe network policy, missing/expired/revoked capability, quota/time/SSE failure, unavailable Broker, unauthorized model, invalid SIWC grant, upstream 4xx/5xx, `response.failed` or `response.incomplete` => explicit error, upstream abort and permit release, **never direct/BYOK fallback**.
7. Cleanup is limited to an explicitly approved disposable Sandbox and ephemeral Host Broker; never modify existing OC2 environments or global network policy.

## 7. Exact Broker HTTP and SIWC Responses wire contract

- Guest base `http://host.docker.internal:<port>/v1`. `GET /health` returns nonsecret readiness; authenticated `GET /v1/models` advertises only `gpt-6-luna`; authenticated `POST /v1/responses` accepts JSON. No other routes/verbs/query. Guest `Authorization: Bearer <limited-capability>` is consumed at Broker and **replaced**, not forwarded upstream.
- **Canonical M1:** `{"model":"gpt-6-luna","input":[{"role":"user","content":"Reply with exactly: gateway-ok"}],"store":false,"stream":true}`. Incoming `stream` **must be literal true**; `store` may be absent or false, never true. Broker **always** emits literal `store:false` + `stream:true` in rebuilt upstream body.
- **History and messages:** `input` is a nonempty array, never a string. M1 accepts text message `{role:"user"|"assistant"|"developer",content:string|[{type:"input_text",text:string}]}` only. Optional top-level `instructions:string` may be allowed; `{type:"message",role:"system"}` is forbidden. Each HTTP request includes all necessary history in `input`; no server-stored conversation dependency.
- **Unsupported fields:** `previous_response_id` is a hard 400 (Guest must resend full history); Broker never forwards it. Reject `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`, `tool_search`, `programmatic_tool_calling`, arbitrary/unknown keys and unsupported media. Guest must suppress such SDK-generated parameters during preparation; Broker then projects from an allowlist or rejects, **never silently drops required history**.
- **M2 tool schemas:** only guest-executed `function` or `custom` declarations, with bounded names/schemas. Convert validated flat Guest SDK function/custom definitions into SIWC `tools:[{type:"namespace",name:"guest",description:"Sandbox-local tools",tools:[{type:"function",name:"read_file",description:"Read disposable guest file",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}}]}]` for the **first M2 acceptance**. A `custom` tool, if accepted, uses `{type:"custom",name,description,format}` inside the same namespace, but custom-tool **execution is outside initial M2** and never silently emulated. Reject hosted MCP/shell/computer/file_search/image_generation/`tool_search`/programmatic tools.
- **M2 loop:** allowed SSE `function_call` item `{type:"function_call",namespace:"guest",name:"read_file",call_id,arguments}`; or accepted custom item `{type:"custom_tool_call",namespace:"guest",name,call_id,input}`. Guest maps call into its registered local tool and executes **in Guest only**; on next HTTP request send full relevant history plus `{type:"function_call_output",call_id,output:string}` (or custom analogue), preserving call_id, without `previous_response_id`. Reject mismatched/unknown call_id; do not execute tools in Broker.
- **Same SDK M1/M2:** OpenCode native `@opencode/ai@2.2.5` Responses driver. The Guest response-event adapter must be shown to deliver namespaced function calls safely; if unsupported in pinned runtime, **STOP M2**, no SDK or architecture substitution.
- **SSE success and quotas:** `response.completed` **and clean end** required; `response.failed`, `response.incomplete`, cancellation, invalid event or premature EOF fail even after output_text.delta / HTTP 200. Measure raw input/SSE response bytes and enforce capability cumulative bytes, concurrency, rate, absolute TTL and stream duration; abort/release on failure. Reject 400 invalid request, 401/403 auth, 404 unknown path, 413 oversized, 429 quotas, 502/503 upstream/auth failure; none retries via another provider.

## 8. Implementation sequence and gates (not approved for execution)

1. **Bounded host-path feasibility check:** use throwaway Sandbox and a dummy Host loopback responder (no OAuth or Cloudflare token); verify `host.docker.internal` and sandbox-scoped allow/deny on the pinned `sbx v0.51.0`. If unavailable, STOP for Owner decision. Do not broaden network or install new daemon by default.
2. **Broker with fake upstream:** contract tests for capabilities, allowlist, injection of synthetic non-secret headers, rejection, rate limits, SSE and abort. Do not touch real credentials yet.
3. **Host SIWC integration:** isolated host credential store; controlled token refresh, `/responses` via Cloudflare Custom Provider only.
4. **Guest OpenCode plugin:** separate guest mode, no OAuth secrets, no BYOK fallback; verify model selection, text streaming, function-tool round trip (guest executes tools), and policy denial.
5. **One live disposable run:** `gateway-ok` from guest + correlated Gateway HTTP 200 + guest secret absence + no direct-egress bypass. Stop and report; no automated follow-on review tasks.

## 9. Acceptance and stop conditions

**Acceptance (M1, narrow technical demonstration):**
- Sandbox-initiated `openai/gpt-6-luna` or dedicated provider alias yields exactly `gateway-ok`.
- Cloudflare Gateway's `custom-openai-public-probe/v1/responses` records HTTP 200 for a matching request.
- Guest has no OAuth or Cloudflare credentials in environment, files, command arguments, or writable mounts; Host-only credential store remains inaccessible from guest.
- Denied direct model host requests, unauthorized provider/model/path/capability, exceeded budget, and Broker stop yield errors rather than fallback.
- Host Broker processes **model inference only**; it cannot invoke host shell or workspace tools.

**Acceptance (M2, actual agent usability):**
- OpenCode agent receives function tool calls through the Broker and performs authorized filesystem/shell work **only in guest**; correct response and cancellation behavior confirmed.
- Host / guest logs are redacted, authentication renewal/expiry and recovery are exercised without credential leak.

**STOP for Owner judgment:** host connectivity cannot be safely established on sbx v0.51.0; token-sharing access/refresh cannot be obtained in a supported host-only way; any guest sees actual OAuth/Cloudflare tokens; a direct/BYOK fallback or host-side tool execution is observed; strict broker capability limits cannot be enforced; Cloudflare billing is unexpectedly charged; or test outcomes are insufficient to determine safe operation. Limit evidence and report instead of inventing substitute architecture.

**Document checkpoint:** Owner adopted Design R0.1; R0.1.1 is the bounded F-001–F-006 correction. Acceptance of revised documents and Implementation GO require separate Owner decisions. No automatic new review, PR, merge or implementation.

## 10. Sources and assumptions

- OpenCode v2.2.5 plugin `ctx.session.hook("model.request")`, `http.request`, and `ctx.provider.transform`:
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/provider.ts
- Current Host-only plugin: `src/gateway.mjs`, baseline HEAD above.
- Docker sandbox host services: https://docs.docker.com/ai/sandboxes/workflows/development/
- Docker sandbox isolation and network policy: https://docs.docker.com/ai/sandboxes/security/isolation/ and https://docs.docker.com/ai/governance/local/network-rules/
- Docker Sandbox credential proxy alternatives: https://docs.docker.com/ai/sandboxes/configuration/credentials/
- Cloudflare Logpush: https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/

- SIWC wire and Preview: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference ; https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- SIWC registration, refresh and storage: https://developers.openai.com/siwc/token-sharing-open-source/sign-in ; https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- OpenCode v2.2.5 registration schemas and SDK: https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/provider.ts ; https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/model.ts ; https://github.com/anomalyco/opencode/blob/v2.2.5/packages/ai/src/providers/openai/responses.ts

Docker documentation currently describes capabilities that may postdate pinned v0.51.0. Treat any version-specific CLI behavior and the Broker transport as **NOT VERIFIED** until read-only inspection and bounded disposable-host-path test.

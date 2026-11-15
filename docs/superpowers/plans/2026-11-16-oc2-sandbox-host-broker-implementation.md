# OC2 Sandbox Subscription Host Broker Implementation Plan R0.1.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run OpenCode v2.2.5's agent and tools inside a disposable Docker Sandbox while ChatGPT Plus SIWC model requests traverse a separately authenticated Host Broker and Cloudflare AI Gateway, without real OAuth/Gateway credentials in the guest.

**Architecture:** A guest-only custom OpenCode provider sends OpenAI Responses requests through a sandbox-scoped host-service network route. A loopback-only Node.js Broker authorizes a bounded guest capability, acquires/refreshes SIWC only on the host, validates the request and streams it through the existing Cloudflare Custom Provider. The existing Host-only plugin remains unchanged.

**Tech Stack:** Node.js 22+ ESM, Node built-in HTTP/crypto/fetch/test, OpenCode v2.2.5 `@opencode/plugin@2.2.5`, native SDK `@opencode/ai@2.2.5` (`@opencode/ai/providers/openai/responses`), OpenAI Responses/SSE, official SIWC OAuth token-sharing, Docker Sandboxes CLI v0.51.0 (`sbx`), Cloudflare AI Gateway Custom Provider `custom-openai-public-probe`.

**Spec:** `docs/superpowers/specs/2026-11-16-oc2-sandbox-subscription-host-broker-design.md` (R0.1 adopted 2026-11-16 JST; F-001–F-006 limited correction R0.1.1). **Plan status: DOCUMENT LIMITED CORRECTION / IMPLEMENTATION GO NOT AUTHORIZED**. Acceptance of corrected document and Implementation GO are separate decisions.

## Global Constraints

- **Authorization:** This is a DOCUMENT-ONLY implementation plan. Creating or running code, modifying Sandbox/network policy, storing credentials, opening a PR, or merging requires the Owner's separate implementation approval.
- **Versions:** Pin OpenCode to `v2.2.5`, Docker Sandboxes CLI to `v0.51.0`, and require Node.js `>=22`. Abort rather than silently upgrading or changing the host.
- **Isolation:** Use a new throwaway Sandbox and temporary workspace only. Do not alter existing OC2 Sandboxes, host OpenCode settings, daemon configuration, or global policies. No new Workers, Neon Functions, or OpenCode source patches.
- **Host secrets:** SIWC `chatgpt.tokens.use.direct` access/refresh tokens and `CF_AIG_TOKEN` stay on the host. Guest receives only a time-bounded, rate-bounded capability, which is **readable by untrusted guest code** and therefore must itself be limited/revocable.
- **No paid fallback:** No `OPENAI_API_KEY`, legacy Codex OAuth, direct OpenAI route, Cloudflare Unified Billing or alternate provider. Set upstream headers `cf-aig-no-wholesale: true`, `cf-aig-collect-log-payload: false`, `cf-aig-skip-cache: true`; remember that Logpush is independent.
- **Transport:** Host Broker binds only `127.0.0.1:<port>`; guest accesses `host.docker.internal:<port>` only if the Docker Sandbox v0.51.0 **effective policy** permits exactly this Broker path and denies all other model egress. Inherited global allow/presets, proxy and IP bypass must be checked. If per-Sandbox containment is impossible, STOP, never edit global policy.
- **Initial model:** Exact model ID `gpt-6-luna`. Broker `POST /v1/responses` is the only upstream inference route; `GET /health` and authenticated `GET /v1/models` are local.
- **Scope:** ChatGPT first. Claude Pro adapter, production daemon/systemd, arbitrary provider routing, image/media, and broad model selection are outside this plan. Never execute agent shell/tools on the host.
- **Stage boundaries:** M1 requires Guest `gateway-ok` + correlated Gateway HTTP 200 **and SIWC `response.completed` with orderly SSE termination** and secrets/egress checks. M2 requires local Guest function-tool round trip using the same pinned SDK. `response.failed`, `response.incomplete`, early EOF or quota interrupt is failure. Report NOT_RUN/NOT_VERIFIED separately; no automatic review loop.
- **Commit hygiene:** Each task commits only its relevant source/tests or documentation to a new implementation branch based on the adopted design branch. No secrets, live request payloads or tokens in Git. Do not merge or open PR automatically.

## Review Focus

1. **Untrusted guest authorization headers**: a guest that submits upstream `Authorization`, `cf-aig-*`, `x-api-key`, cookies, or target URL must not influence the host's upstream headers or destination. Tests in Task 2.
2. **Capability abuse**: expired/revoked, over-lifetime `maxCalls`, per-time-window `maxCallsPerWindow/windowMs`, concurrent or byte/time-limited bearer must reject and release; limited reuse up to budget is allowed. `sandboxID` is only a label absent trusted transport evidence. Tests in Task 2.
3. **SSE loss / timeout / cancellation**: success requires `response.completed` and orderly EOF; `response.failed`/`response.incomplete`, disconnect, request/response/aggregate byte quota or duration limit abort upstream and idempotently release permit, no retry/fallback. Tests Tasks 2/4.
4. **OAuth renewal failure / credential-path attack**: expired grant, bad state/nonce/issuer/audience, path symlink, unsafe mode and failed refresh must never trigger paid API fallback or leak secrets. Tests in Task 3.
5. **Host tool execution or direct egress**: OpenCode's function call must run only in the guest, and HTTP/IP bypass attempts must be blocked independently of plugin load. Tests in Tasks 1, 4, and 5.

---

## File / responsibility map

| Path | Responsibility |
| --- | --- |
| `scripts/probe-host-path.mjs` | Secret-free loopback probe for bounded Docker host reachability |
| `test/broker/host-path.test.mjs` | Local probe contract test |
| `src/broker/capabilities.mjs` | Mint/hash/revoke and enforce lifetime/window/concurrency/request+response byte/time quotas for per-test Guest bearers |
| `src/broker/policy.mjs` | Parse exact supported route and request schema; reject unwanted headers/types |
| `src/broker/upstream.mjs` | Build **host-only** Cloudflare Responses request; filter outgoing headers |
| `src/broker/server.mjs` | Node HTTP server, authentication, streaming, cancellation, errors |
| `test/broker/capabilities.test.mjs` | Capability expiry, budget, concurrency, revocation |
| `test/broker/server.test.mjs` | Broker routes, header stripping, fake upstream, SSE, disconnect |
| `src/broker/credential-store.mjs` | Host-only protected atomic credential persistence |
| `src/broker/siwc.mjs` | Official SIWC PKCE login, token validation, refresh, no BYOK |
| `test/broker/siwc.test.mjs` | Mocked OAuth endpoints, nonce/expiry, refresh, permissions |
| `bin/host-broker.mjs` | Foreground host-only Broker entrypoint and validated config |
| `src/guest/index.js` | Separate absolute-file OpenCode v2 Plugin.define Guest entrypoint; default Host entry unchanged |
| `src/guest/provider.mjs` | Register version-pinned native Responses provider/model, Guard requests, map tested namespaced response events |
| `test/guest/provider.test.mjs` | Provider.Info/Model.Info validation, SDK M1/M2 stream mapping and denial |
| `bin/guest-launch.mjs` | One-shot stdin/inherited-FD capability handoff into Guest process-local environment (version verified; no persistent files)
| `docs/sandbox-acceptance.md` | Disposable effective egress policy evidence, M1/M2 readback and observed/unknown matrix |
| `package.json` | Add Guest subpath export `"./guest":"./src/guest/index.js"`, preserve Host `".":"./src/index.js"`; pinned runtime `@opencode/ai@2.2.5` (no independently selected SDK) |
| `src/index.js`, `src/gateway.mjs` | Existing Host-only plugin: **leave unchanged** |

### Stable cross-task interfaces and fixed wire contracts

**Guest SDK/Provider (F-002):**
- Fixed OpenCode runtime SDK: `@opencode/ai@2.2.5`, native module `@opencode/ai/providers/openai/responses`, Plugin API `@opencode/plugin@2.2.5` / `Plugin.define`. `src/guest/index.js` is loaded by **absolute file path** from a disposable Guest `opencode.jsonc` plugin list. Keep Host `src/index.js` / `src/gateway.mjs` untouched. Plugin source subpath export `"./guest":"./src/guest/index.js"` does not override the root `".":"./src/index.js"`.
- `registerGuestProvider(ctx,{brokerURL,capability}):Promise<void>` uses `await ctx.provider.transform(editor=>editor.add({info,models:[model]}))`. `Provider.Info={id:"oc-cf-aig",name:"OC2 Host Broker",activation:"enabled",package:"@opencode/ai/providers/openai/responses",settings:{baseURL:brokerURL,apiKey:capability,transport:"http",encoding:"none"}}`. `apiKey` is only a **limited Guest→Broker bearer** in this provider config, never a real OpenAI API key.
- `Model.Info={id:"gpt-6-luna",modelID:"gpt-6-luna",providerID:"oc-cf-aig",name:"gpt-6-luna",capabilities:{tools:true,input:["text"],output:["text"]},variants:[],time:{released:0},cost:[],status:"active",enabled:true,limit:{context:200000,output:32000},settings:{compaction:{type:"summary"}}}`. Default metadata numbers come from **OpenCode v2.2.5 schema**, not verified actual model limits. The only offered model is `oc-cf-aig/gpt-6-luna`.
- `ctx.session.hook("model.request")` and `ctx.session.hook("http.request")` are scoped `{providerID:"oc-cf-aig"}` and validate URL, transport and bearer; `http.request.request` is **readonly**, not an in-place JSON body transformer. The Host Broker owns canonicalization. Guest `http.response` performs SSE namespace→Guest tool event adaptation **only if proven in tests**; otherwise STOP M2.

**Capability interface (F-003):**
- `createCapabilityStore({now,randomBytes}): { issue(config):{token,id}, authorize({token,model,requestBytes}):Permit, revoke(id):void }`.
- `config={sandboxID,model,ttlMs,maxCalls,maxCallsPerWindow,windowMs,maxConcurrent,maxRequestBytes,maxResponseBytes,maxTotalBytes,maxRequestDurationMs}`; every numeric limit mandatory positive and finite. `sandboxID` is a **management label only** unless an independently verified authenticated transport principal is available; it is **not** a permission check based on Guest-provided text/IP.
- `Permit={chargeResponse(bytes):void,release():void}`, `release` idempotent. Inbound body measured as real octets before parse; enforce `maxRequestBytes` per call. `chargeResponse` meters actual raw SSE octets incrementally and enforces `maxResponseBytes` per call; `maxTotalBytes` counts both inbound+outbound cumulatively across a capability. Exceeded quota/duration/TTL, client disconnect or invalid SSE => abort upstream, release once. `maxCalls` limits lifetime admissions; `maxCallsPerWindow/windowMs` separate rate limit; `maxConcurrent` active streams. Reuse within expiry/budget is expected, **not a replay vulnerability claimed solved**. Store only digest of bearer, no raw token after issue.
- One-shot handoff: Host mints a capability for a new disposable sandbox, sends it over **stdin/inherited FD** to Guest launcher `bin/guest-launch.mjs` via a version-verified non-logging `sbx exec` facility. Launcher passes `OC_CF_AIG_BROKER_CAPABILITY` and approved Broker URL only to the Guest OpenCode process environment. Guest can read this limited capability. Never pass in command args, logs, shell history, Git, image layers or persistent sandbox files; if no verified non-logging handoff channel on v0.51.0, STOP. Host revokes at end.

**Broker HTTP + SIWC wire (F-001):**
- `parseBrokerRequest({method,pathname,headers,body,limits}): ParsedRequest`, where `ParsedRequest={model:"gpt-6-luna",input:InputItem[],stream:true,store:false,instructions?:string,tools?:NamespacedTool[]}` or typed `PolicyError(status,message)` with no token in message. The Guest request must have `stream === true`, `store` absent/false, `input` nonempty **array**. `InputItem` M1 is text message `{role:"user"|"assistant"|"developer",content:string|[{type:"input_text",text:string}]}`; never `role:"system"` item. Each call resends full necessary history. M2 adds prior `function_call` and matching `function_call_output` items.
- Never forward `previous_response_id`, `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`, `tool_search`, `programmatic_tool_calling` or unknown fields. Guest suppresses unsupported auto-SDK options in preparation; Broker rejects unsupported input with 400, **rebuilds** supported body and sets `store:false,stream:true` on every upstream request, rather than forwarding/unilaterally discarding required context.
- M2 only `function/custom` **client-executed** declarations are admissible; serialize as SIWC `tools:[{type:"namespace",name:"guest",description:"Sandbox-local tools",tools:[{type:"function",name:"read_file",description:"Read disposable guest file",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}}]}]`. Support custom schema `{type:"custom",name,description,format}` only with validation; **custom execution is NOT part of initial M2**. No hosted tools, tool_search or built-in shell. SSE `function_call` item `{type:"function_call",namespace:"guest",name:"read_file",call_id,arguments}` becomes a Guest-local tool call. Next `input` contains prior assistant/tool-call history and `{type:"function_call_output",call_id,output:string}` with same ID, **no `previous_response_id`**. Custom item and output use `custom_tool_call`/`custom_tool_call_output` only if a later bounded test proves support.
- `createCloudflareUpstream({gatewayBase,gatewayToken,credentialSource,fetchImpl}):(parsed,signal)=>Promise<Response>` fixes Cloudflare Custom Provider `/custom-openai-public-probe/v1/responses`, uses Host SIWC bearer and Host Gateway token only, and rebuilds authenticated headers. `credentialSource.getAccessToken():Promise<string>` never falls back to BYOK.
- `createBrokerServer({capabilities,parseRequest,upstream,limits}): import("node:http").Server`. Only `GET /health`, authenticated `GET /v1/models`, authenticated `POST /v1/responses`. `response.completed` **plus orderly stream ending** is success; `response.failed`, `response.incomplete`, malformed SSE, early EOF and client cancellation are failure even if 200/text delta was observed. All retries/fallback disabled.

**Official SIWC credential interface (F-005):**
- `createSIWCSource({credentialPath,authBase,client,clock}):{beginLogin():Promise<{url,port,complete}>,getAccessToken():Promise<string>}`. Persist Host `ext_agent_host_id=urn:uuid:<UUIDv4>` once before first login; do not use Guest sandboxID. First OAuth `client_id=dynamic_agent_client`; `agent_name_hint=OC2 Subscription Broker`; scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; `resource=https://api.openai.com/v1`; fresh state, nonce, PKCE-S256; exact callback `http://127.0.0.1:<ephemeral>/auth/callback`.
- Authorize at `https://auth.openai.com/api/accounts/authorize`; after state validation exchange code at `https://auth.openai.com/api/accounts/oauth/token` using **issued client_id from callback**, original redirect URI, PKCE verifier and resource. Validate signed ID token via JWKS (issuer/audience/nonce/exp), identity and grant scopes before activation.
- Save per-registration validated subject/issuer, issued client_id, retained ID token, scopes, access token, **rotating** refresh token, token expiry, optional `earliest_refresh_at`, Host ID atomically in Host-only 0700 directory / 0600 file, reject symlinks. Reauth uses issued client_id + stable Host ID, omits `agent_name_hint`, optional `id_token_hint` only in authorize URL (never log). Refresh uses latest refresh token + issued client_id + resource with `grant_type=refresh_token` (no scope override); serialize per account across processes and atomically replace whole token set. All renewal failures fail closed, never API key.


## Task 1 — Disposable host-connection feasibility (STOP gate)

**Files:**
- Create: `scripts/probe-host-path.mjs`
- Test: `test/broker/host-path.test.mjs`
- No existing configuration changes.

**Interfaces:**
- Produces: `startProbeServer({host="127.0.0.1",port}):Promise<{close():Promise<void>}>`, a local `GET /health` responder returning `{"ok":true}`.
- Consumes: only built-in Node modules; **no credentials**.

- [ ] **Step 1: Write failing local probe test** `test/broker/host-path.test.mjs`: starts on `127.0.0.1` ephemeral port, checks `GET /health` -> 200 `{"ok":true}`, `GET /anything` -> 404, closes server.
- [ ] **Step 2: Confirm RED**: `node --test test/broker/host-path.test.mjs`; expected FAIL because `startProbeServer` does not exist.
- [ ] **Step 3: Implement minimal Node responder** with exact `startProbeServer` interface and no logging of request headers.
- [ ] **Step 4: Confirm GREEN**: `node --test test/broker/host-path.test.mjs` PASS.
- [ ] **Step 5: Verify target and effective policy without mutation**: inspect `sbx --version`, `sbx --help`, the available `sbx policy` subcommands and **read back the effective network policy** of the proposed disposable Sandbox including inherited global rules/presets/precedence. Confirm per-Sandbox-only policy is possible on actual v0.51.0; syntax shown in docs is a *candidate*, never VERIFIED without CLI evidence. STOP if global allow/preset defeats isolation or it would require global reset.
- [ ] **Step 6: Approved disposable probe only**: start nonsecret loopback responder on port `49187` and a new empty `oc2-aig-probe` Sandbox. Verify exact v0.51.0 CLI syntax before sandbox-specific **deny-by-default egress** with exception for `host.docker.internal:49187`. Verify actual health response, then read back **effective** policy, not only requested policy. Never edit pre-existing/global policy. If port allow or deny cannot be confined, STOP.
- [ ] **Step 7: Demonstrate independent effective denial**: verify no inference traffic can leave disposable Guest except through Host Broker, including known model hosts, unknown hostnames, direct public and private IPs, alternate ports, DNS-resolved addresses and HTTP proxy/CONNECT/other proxy routes. Denials must be observed from Guest and (where possible) policy logs; global allow/preset or any proxy/IP bypass => STOP. Avoid claiming exhaustive network assurance from 4 hostname checks.
- [ ] **Step 8: Record PASS / BLOCKED evidence without secrets** in `docs/sandbox-acceptance.md` and commit Task 1 source/test/doc only. Keep the disposable Sandbox or destroy it *only if explicitly authorized*; never affect existing Sandbox IDs.

**Task completion:** host loopback route and independent network-denial paths are observed on the pinned installation, or a truthful `BLOCKED` result and Owner STOP. Do not advance tasks 2–5 if this gate is BLOCKED.

## Task 2 — Secret-free Broker contract, policy, bounded capability and SSE

**Files:**
- Create: `src/broker/capabilities.mjs`, `src/broker/policy.mjs`, `src/broker/upstream.mjs`, `src/broker/server.mjs`
- Test: `test/broker/capabilities.test.mjs`, `test/broker/server.test.mjs`
- Modify: `package.json` (test/check scripts only, if needed)

**Interfaces:**
- Consumes and produces the stable Broker interfaces above.
- `gatewayBase` is validated to `https://gateway.ai.cloudflare.com/v1/<32-lower-hex-account>/<gateway-id>`; route is pinned to `/custom-openai-public-probe/v1/responses`.
- `fetchImpl` and `credentialSource` must be injectable for **synthetic tests**, with no real credentials or internet access.

- [ ] **Step 1: Write failing capability tests**: SHA-256 digest-only storage; valid reuse until `maxCalls`; expiry/revoke, `maxCallsPerWindow/windowMs`, `maxConcurrent`, measured `maxRequestBytes`/`maxResponseBytes`/cumulative `maxTotalBytes`, TTL during stream, `maxRequestDurationMs`, underflow/duplicate release, parallel contention. Assert arbitrary/forged sandboxID never authorizes on its own and no raw bearer logs.
- [ ] **Step 2: Confirm RED**: `node --test test/broker/capabilities.test.mjs` FAIL with missing exports.
- [ ] **Step 3: Implement `createCapabilityStore`** with `authorize({token,model,requestBytes}): Permit` and `Permit.chargeResponse(bytes)` / idempotent `Permit.release()`; enforce expiry/revocation/lifetime + time-window quotas, concurrent streams, request bytes before parse, response bytes incrementally, aggregate bytes, ongoing duration and TTL; abort and release on limit or disconnect.
- [ ] **Step 4: Confirm GREEN**: `node --test test/broker/capabilities.test.mjs` PASS.
- [ ] **Step 5: Write failing server/policy tests**: only allow `POST /v1/responses`, valid Guest bearer and model; `stream:true`, `store:false`, nonempty input array, complete M1 history, optional instructions, and expected 400 for `stream:false`, `store:true`, string input, system role, `previous_response_id`, every listed unsupported field and unknown model/tool. Test namespace function schema, custom declaration validation, no hosted tools, request/header injection and redacted response headers. Test measured body bytes rather than Content-Length.
- [ ] **Step 6: Confirm RED**: `node --test test/broker/server.test.mjs` FAIL with missing exports.
- [ ] **Step 7: Implement request parser, server and Cloudflare upstream builder**: `parseBrokerRequest` produces exact M1/M2 `ParsedRequest` contract above. Broker rebuilds from supported fields (including function namespace mapping), always sends `store:false,stream:true`, omits unsupported fields, forces exact Cloudflare Responses URL and Host-only `Authorization`/`cf-aig-authorization`; no guest upstream header forwarding, no fallback. Reject incompatible SDK defaults rather than silently drop required history. Enforce request/response/aggregate byte, duration, TTL, rate/concurrency limits and response backpressure.
- [ ] **Step 8: Write and run SSE/abort tests**: fake SSE `response.created`, output delta and `response.completed` + clean EOF is PASS; `response.failed`, `response.incomplete`, early EOF without completed, invalid framing, aborted client, 401/403/429/5xx and byte/time limits are FAIL, abort upstream and release permit once. Verify no retry or API-key fallback. `node --test test/broker/server.test.mjs` expected PASS.
- [ ] **Step 9: Run `npm test && npm run check`**, expect all tests PASS; commit Task 2 only.

**Task completion:** a fake upstream proves authenticated, rate-limited, streaming Broker behavior without host credentials. If headers can leak or enforcement is incomplete, STOP; no live token experiment.

## Task 3 — Host-only SIWC authentication, credential renewal and Cloudflare dispatch

**Files:**
- Create: `src/broker/credential-store.mjs`, `src/broker/siwc.mjs`, `bin/host-broker.mjs`
- Test: `test/broker/siwc.test.mjs`
- Modify: `package.json` only for executable script and minimal verifiable JWT/JWKS validation dependency (if required).

**Interfaces:**
- Produces `createSIWCSource({ credentialPath, authBase, client, clock })`, implementing the Task 2 `credentialSource.getAccessToken()` contract.
- Host login uses browser-opened OAuth URL plus SSH-forwarded **dynamic loopback callback**, PKCE, state, nonce, issuer, audience, required `chatgpt.tokens.use.direct` scope and dynamic client registration; refresh before expiry using the registered client ID.
- Host credential store: directory mode `0700`, file mode `0600`, symlink-resistant and atomic writes, restrictive readback, no secrets in errors/logs.

- [ ] **Step 1: Write failing credential-store tests**: persist one stable `ext_agent_host_id` (`urn:uuid:<UUIDv4>`) across restarts; separate issued client IDs/verified identity per account, ID/access/rotating refresh token, scopes, expiry and optional `earliest_refresh_at`; atomic 0600 token-set replacement in 0700 directory, symlink/unsafe path refusal, no secret in error/log.
- [ ] **Step 2: Write failing SIWC tests with mocked official authorize/token/JWKS endpoints**: initial `dynamic_agent_client`, fixed `agent_name_hint` and stable Host ID, required 6 scopes/resource, exact dynamic loopback `/auth/callback`, state/nonce/PKCE, issued client_id from callback (never dynamic placeholder in token exchange); signed ID-token issuer/audience/nonce/expiry/identity and grants checks; reauth uses issued client_id without agent_name_hint and optional redacted `id_token_hint`; rotating refresh atomic replacement, expired/401/timeout failure, concurrent refresh single-flight including process lock, no BYOK.
- [ ] **Step 3: Confirm RED**: `node --test test/broker/siwc.test.mjs` FAIL due to missing implementations.
- [ ] **Step 4: Implement credential store and SIWC source** using the fixed §5.3 official auth and token endpoints/parameters, persisted Host ID, per-account issued client ID, identity-bound reauth, PKCE/JWKS validation and serialized rotating refresh. Follow `chatgpt-token-sharing` only; no custom OAuth mode or credential DB scraping.
- [ ] **Step 5: Confirm GREEN**: `node --test test/broker/siwc.test.mjs` PASS.
- [ ] **Step 6: Add `bin/host-broker.mjs`**: validate Host-only runtime config, SIWC credential file path, Gateway origin and token, mandatory quotas and port; refuse if any are absent. Provide separate `login` and `serve` modes. Use foreground process only; do not register systemd.
- [ ] **Step 7: Run `npm test && npm run check`** with fake endpoints first (PASS). Only after explicit Owner authorization, perform one SSH-forwarded SIWC registration/reauth and controlled renewal, then one Cloudflare `/v1/responses` streaming call requiring `response.completed` + orderly end and matched Gateway HTTP 200. If auth/billing evidence is incomplete, distinguish NOT_VERIFIED and STOP rather than claiming $0.
- [ ] **Step 8: Commit Task 3 source/tests**, never token DB, client secrets, bearer literals, host paths or live payloads.

**Task completion:** SIWC lifecycle and exact Cloudflare dispatch are confirmed on host; absence of payment charges **remains NOT_VERIFIED** without independent billing evidence.

## Task 4 — Guest OpenCode provider and guest-only tool execution

**Files:**
- Create: `src/guest/index.js`, `src/guest/provider.mjs`
- Test: `test/guest/provider.test.mjs`
- Modify: `package.json` for a separate guest plugin export and required SDK dependency only; preserve `src/index.js` Host-only entrypoint.

**Interfaces:**
- Produces `registerGuestProvider(ctx,{brokerURL,capability}):Promise<void>`, only provider `oc-cf-aig` with model `gpt-6-luna`.
- Provider registry follows OpenCode v2.2.5 `ctx.provider.transform(editor.add({info,models}))` and an HTTP request hook scoped to `providerID:"oc-cf-aig"`. Use an OpenAI Responses-compatible SDK package, `transport:"http"`, `encoding:"none"`, and source model metadata only if reliably available. Capability bearer is an **in-guest limited credential**, not SIWC.
- Guest registration must not read `CF_AIG_TOKEN`, native OpenAI credential storage or Host plugin `registerGateway`; it must not expose OpenAI `openai` provider automatically as a fallback.

- [ ] **Step 1: Write failing guest tests**: Guest plugin absolute-path loading/exports, `Provider.Info`/`Model.Info` exact required fields, pinned `@opencode/ai/providers/openai/responses` package and model metadata, `apiKey` as limited Broker bearer only, baseURL/HTTP-only/encoding none, rejection of missing/wrong URL/capability/model, Host plugin import, direct API/WebSocket; no real OAuth/Gateway tokens.
- [ ] **Step 2: Confirm RED**: `node --test test/guest/provider.test.mjs` FAIL with missing guest exports.
- [ ] **Step 3: Implement `registerGuestProvider` and `src/guest/index.js`** exactly per Stable interfaces (native SDK pinned `@opencode/ai@2.2.5`, `ctx.provider.transform(editor.add({info,models:[model]}))`, scoped request hooks). Add `bin/guest-launch.mjs` with verified one-shot stdin/inherited FD delivery; set Guest process-local `OC_CF_AIG_BROKER_CAPABILITY`, no argv/file/history, keep Host default plugin export untouched. If pinned SDK/transport/metadata or version-verified stdin path fails, STOP; no SDK re-selection.
- [ ] **Step 4: Confirm GREEN**: `node --test test/guest/provider.test.mjs` PASS. Ensure the guest authentication bearer belongs only to Broker and cannot be reused against upstream.
- [ ] **Step 5: Offline guest-SDK wire test**: same native Responses driver M1/M2, stream requires `store:false,stream:true`, full input history; non-supported SDK fields are removed at approved Guest preparation or explicitly rejected by Broker. Test named `guest` function namespace, `function_call` + preserved `call_id`, Guest-local `read_file`, next request containing `function_call_output` and full history without previous_response_id, SSE `response.completed` + clean EOF, failure/incomplete/disconnect, cancellation and no Host tool use. Custom-tool schema validation only, no M2 custom execution. If SDK response adapter cannot preserve the stream, M2 BLOCKED.
- [ ] **Step 6: Run `npm test && npm run check`**, expected PASS; commit Guest plugin/tests only.

**Task completion:** host-independent fake Broker demonstrates OpenCode guest provider and tool loop; no native OAuth credential appears inside guest.

## Task 5 — One bounded live disposable acceptance, cleanup and Owner checkpoint

**Files:**
- Create/Update: `docs/sandbox-acceptance.md`
- No unrelated code changes. Any discovered failure requiring architectural change is a STOP and Owner decision, not an automatic new task.

**Interfaces:**
- Consumes Broker, guest provider and sandbox-scoped policy from Tasks 1–4.
- Produces a concise M1/M2 result record: `PASS`, `FAIL`, `NOT_RUN` or `NOT_VERIFIED` for each claim, with no secrets.

- [ ] **Step 1: Run local tests** `npm test && npm run check` (PASS required). Check branch diff for only approved files; no credential files/real tokens tracked.
- [ ] **Step 2: Inspect sandbox/host effective policy**: read back exact v0.51.0 effective rules including global/presets/precedence and proxy behavior, verify disposable Guest's only inference-capable egress is approved Broker, and check mounts/credential presence without printing token values. Global allow, unknown egress, private/public IP or proxy bypass => STOP, do not reset Host policy.
- [ ] **Step 3: Start foreground Host Broker**: capability bounded by expiry, maxCalls, maxCallsPerWindow, maxConcurrent, request/response/aggregate bytes and duration. Issue on Host; transfer once over version-verified nonlogging stdin/FD into Guest-launch process, never argv or persistent files. Select only `oc-cf-aig/gpt-6-luna`.
- [ ] **Step 4: Run exactly one approved M1 text prompt** `Reply with exactly: gateway-ok`; require Guest `gateway-ok`, upstream `store:false,stream:true`, terminal `response.completed` + orderly SSE end, correlated Cloudflare `custom-openai-public-probe/v1/responses` HTTP 200 and absence of Guest real tokens. A 200, a text delta or 499 without completed is NOT PASS.
- [ ] **Step 5: Run negative contract cases**: revoked/expired/over-lifetime or window-budget capability, over-input/output/aggregate bytes and duration, wrong model/path/stream:false/previous_response_id, Broker stop, SSE failure/incomplete/EOF, and direct hostname/IP/alternate-port/proxy egress. Verify upstream abort, permit release, no paid fallback or Host credential exposure.
- [ ] **Step 6: Run one bounded M2 function-tool case**: SDK namespaced function `guest.read_file` on a dummy Guest file, preserve call_id through Guest execution and `function_call_output` with complete history; verify no host filesystem/tool activity. Require `response.completed` + clean end and test cancellation. If unsupported by pinned SDK, M2 BLOCKED and report separately, do not change SDK.
- [ ] **Step 7: Revoke capability and stop foreground Broker**. Remove test Sandbox and its sandbox-scoped rules **only if explicitly authorized**; do not remove any pre-existing VM or workspace.
- [ ] **Step 8: Record results, evidence type and residuals** in `docs/sandbox-acceptance.md`, distinguishing `PASS`, observed `FAIL`, `NOT_RUN` and `NOT_VERIFIED`; commit only the redacted acceptance document.

**Task completion:** M1/M2 are reported independently. Stop after this bounded verification even if M2 is not achieved; ask the Owner whether to accept M1-limited operation, authorize a precisely scoped fix, or defer M2. No repeated independent review/repair chain.

## Acceptance and STOP crosswalk

| Condition | Evidence | Outcome |
| --- | --- | --- |
| Docker v0.51.0 guest→host loopback and independently enforced deny | Disposable probe and policy logs | Proceed / STOP |
| Broker fake upstream, caps, no credential bleed, SSE cancellation | Task 2 tests | Proceed / STOP |
| SIWC host-only token-sharing/refresh; no BYOK | Mock and limited host live evidence | Proceed / STOP |
| Guest plugin and function-tool invocation stays guest-only | Task 4 tests, Task 5 dummy workspace | M2 PASS / limited |
| Gateway HTTP 200 `custom-openai-public-probe` + guest `gateway-ok` | Matched Cloudflare log and guest CLI | M1 PASS / FAIL |
| OAuth/Gateway token absent from guest | Non-secret presence verification, mounts/env audits | Mandatory / STOP |
| Upstream billing attribution | Independent authoritative billing evidence, if available | VERIFIED or NOT_VERIFIED; do not infer $0 |

## Owner checkpoint and handoff

- **Current status:** PLAN WRITTEN / IMPLEMENTATION NOT AUTHORIZED.
- **Execution preference (recommended):** Native test-first bounded work with one Owner checkpoint, not mandatory independent reviewer per Task; no automatic findings/review loop. **Implementation remains on HOLD until explicitly approved.**
- **Owner must expressly authorize:** code implementation scope, creation of one disposable Sandbox, sandbox-specific policy changes, storage of Broker credentials, a bounded live model call, cleanup, and whether to create a PR. These are not implied by design or plan approval.
- **No cloud or persistent external writes** beyond the explicitly approved GitHub documentation for this plan have been performed. Do not start Task 1 merely because this plan has been committed.
- **Stop condition:** when Task 5 reports M1/M2 (including LIMITED/NOT_VERIFIED), return control to the Owner. No auto-merge, additional agent, new Finding correction chain, or systemd deployment.

## References

- Adopted design: `docs/superpowers/specs/2026-11-16-oc2-sandbox-subscription-host-broker-design.md`.
- Official SIWC wire/limits: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference and https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- Official SIWC registration/refresh: https://developers.openai.com/siwc/token-sharing-open-source/sign-in and https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- OpenCode v2.2.5 provider and session plugin contracts:
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/provider.ts
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/model.ts
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/provider.ts
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/ai/src/providers/openai/responses.ts
- Docker sandbox host access and policy:
  https://docs.docker.com/ai/sandboxes/workflows/development/
  https://docs.docker.com/ai/governance/local/network-rules/
  https://docs.docker.com/ai/sandboxes/release-notes/
- Cloudflare Logpush:
  https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/

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
| `src/guest/index.js` | Local Guest plugin **directory** entrypoint, `Plugin.define`; Host root entry unchanged |
| `src/guest/provider.mjs` | Pin native Responses provider/model; scoped context alias `read_file`; no SSE rewriting adapter |
| `test/guest/provider.test.mjs` | Directory Plugin loader, provider activation, real serialized SDK M1/M2 wire and native namespace dispatch |
| `bin/guest-launch.mjs` | One-shot stdin/inherited-FD capability handoff into Guest process-local environment (version verified; no persistent files)
| `docs/sandbox-acceptance.md` | Disposable effective egress policy evidence, M1/M2 readback and observed/unknown matrix |
| `package.json` | Optional import subpath `"./guest":"./src/guest/index.js"`, keep Host `".":"./src/index.js"`; Guest plugin loader targets **directory**, not the export |
| `src/index.js`, `src/gateway.mjs` | Existing Host-only plugin: **leave unchanged** |

### Stable cross-task interfaces and fixed wire contracts

**Guest SDK/Provider (PR2-F-002):**
- SDK fixed: `@opencode/ai@2.2.5`, module `@opencode/ai/providers/openai/responses`, plugin API `@opencode/plugin@2.2.5` / `Plugin.define`. Guest entrypoint is `src/guest/index.js`; loader target is **absolute directory** `/absolute/path/to/oc-cf-aig-subscription/src/guest` in disposable Guest `opencode.jsonc` `plugins`. Directory contains `index.js` + `provider.mjs`, **no nested package.json**; `Host.resolve` chooses conventional `index.js`. Optional root `package.json` subpath `"./guest":"./src/guest/index.js"` is for import only and **not** the loader path. Host `src/index.js`, Host `src/gateway.mjs` and root `".":"./src/index.js"` remain unchanged.
- `registerGuestProvider(ctx,{brokerURL,capability}):Promise<void>`: `ctx.provider.transform(editor => editor.add({info,models:[model]}))`. `Provider.Info={id:"oc-cf-aig",name:"OC2 Host Broker",activation:"enabled",package:"@opencode/ai/providers/openai/responses",settings:{baseURL:brokerURL,apiKey:capability,transport:"http",encoding:"none"}}`. `apiKey` is the **limited Guest→Broker bearer only**; never native OpenAI/BYOK credentials.
- `Model.Info={id:"gpt-6-luna",modelID:"gpt-6-luna",providerID:"oc-cf-aig",name:"gpt-6-luna",capabilities:{tools:true,input:["text"],output:["text"]},variants:[],time:{released:0},cost:[],status:"active",enabled:true,limit:{context:200000,output:32000},compatibility:{supportsPromptCacheKey:false},settings:{compaction:{type:"summary"}}}`. Limits here are OpenCode schema defaults, **not proven effective model limits**. Only `oc-cf-aig/gpt-6-luna` is selectable.
- **F-001/A fixed cache-key suppression:** `Model.Info.compatibility.supportsPromptCacheKey` is **literal `false`**, inherited into the resolved `LanguageModel.compatibility` with model-over-provider precedence (`packages/core/src/model.ts`, `model-resolver.ts`). `SessionModelRequest` still populates `LLMRequest.promptCacheKey`, but `packages/ai/src/protocols/shared.ts` `sendsPromptCacheKey` returns false and `OpenResponses.lowerGeneration` omits `prompt_cache_key` even when `request.cache` is enabled. Broker must **reject**, not erase, any present `prompt_cache_key`. Task 4 actual SDK serialization is mandatory: an emitted key triggers **M1 STOP**, without SDK replacement.
- Guest-only custom read-only **`read_file`** (not built-in `read`): keep `ctx.tool.transform` registration under `namespace:"guest"`, `codemode:false`, fixed fixture-root-confined schema and execute method. Its **registry identity is `guest_read_file`**. For primary `oc-cf-aig`, the context hook requires the original `event.tools["guest_read_file"]` and absence of a conflicting `event.tools["read_file"]`; set `event.tools["read_file"]=event.tools["guest_read_file"]` then delete only the original key, without cloning the ToolDefinition. `SessionModelRequest` matches the same object identity and preserves the original executor. **Public/native flat name = `read_file`**, never dotted `guest.read_file`. The Broker maps only that name to SIWC namespace `guest` leaf `read_file`; SSE Tool Event/Core execution uses flat name `read_file`. Missing/colliding alias => M2 BLOCKED (M1 remains independent).
- Scoped `ctx.session.hook("model.request")`/`http.request` validate Broker origin, path and no fallback. `http.request.request` is readonly, not an in-place JSON body transformer. The pinned native `openai-responses.ts` decoder already emits a namespaced `function_call` with separate `name:"read_file"` and `namespace:"guest"`; Core executes using the flat name `read_file` and the original Guest executor resolved by identity. **No custom SSE `http.response` adapter.** If name/namespace cannot be dispatched in Task 4, M2 BLOCKED, not Host tool execution or SDK replacement.
- Plugin not loaded: Guest startup admission must verify provider and `guest_read_file` registry availability and **effective** independent deny-by-default network policy. A missing plugin hook is not itself a security control.

**Capability interface (F-003):**
- `createCapabilityStore({now,randomBytes}): { issue(config):{token,id}, authorize({token,model,requestBytes}):Permit, revoke(id):void }`.
- `config={sandboxID,model,ttlMs,maxCalls,maxCallsPerWindow,windowMs,maxConcurrent,maxRequestBytes,maxResponseBytes,maxTotalBytes,maxRequestDurationMs}`; every numeric limit mandatory positive and finite. `sandboxID` is a **management label only** unless an independently verified authenticated transport principal is available; it is **not** a permission check based on Guest-provided text/IP.
- `Permit={chargeResponse(bytes):void,release():void}`, `release` idempotent. Inbound body measured as real octets before parse; enforce `maxRequestBytes` per call. `chargeResponse` meters actual raw SSE octets incrementally and enforces `maxResponseBytes` per call; `maxTotalBytes` counts both inbound+outbound cumulatively across a capability. Exceeded quota/duration/TTL, client disconnect or invalid SSE => abort upstream, release once. `maxCalls` limits lifetime admissions; `maxCallsPerWindow/windowMs` separate rate limit; `maxConcurrent` active streams. Reuse within expiry/budget is expected, **not a replay vulnerability claimed solved**. Store only digest of bearer, no raw token after issue.
- One-shot handoff: Host mints a capability for a new disposable sandbox, sends it over **stdin/inherited FD** to Guest launcher `bin/guest-launch.mjs` via a version-verified non-logging `sbx exec` facility. Launcher passes `OC_CF_AIG_BROKER_CAPABILITY` and approved Broker URL only to the Guest OpenCode process environment. Guest can read this limited capability. Never pass in command args, logs, shell history, Git, image layers or persistent sandbox files; if no verified non-logging handoff channel on v0.51.0, STOP. Host revokes at end.

**Broker HTTP + Native OpenCode v2.2.5 SIWC wire (PR2-F-001):**
- `parseBrokerRequest({method,pathname,headers,body,limits}): ParsedRequest` or `PolicyError(status,message)`. `ParsedRequest={model:"gpt-6-luna",input:InputItem[],stream:true,store:false,include?:["reasoning.encrypted_content"],instructions?:string,tools?:NamespacedTool[]}`. Reject any incoming `stream!==true`, `store===true`, empty/non-array input, missing full context and arbitrary/unknown field; Host always **reconstructs** upstream `store:false,stream:true`.
- **Exact M1 input union matching pinned `lowerMessages`:** `{type:"message",role:"developer",content:string}`; `{type:"message",role:"user",content:[{type:"input_text",text:string}],id?:string,status?:string}`; `{type:"message",role:"assistant",content:[{type:"output_text",text:string}],id?:string,phase?:"commentary"|"final_answer"|null,status?:string}`. Arrays nonempty and text only. Optional top-level `instructions:string`. Preserve stable order and validated optional IDs/metadata. Disallow explicit `{type:"message",role:"system"}` and bare shorthand `{role,content}` input.
- **Reasoning history** retains `{type:"reasoning",id?:string,summary:[{type:"summary_text",text:string}],encrypted_content?:string|null}` including opaque encrypted_content and original position. No truncation, decoding, discard or invented summary; malformed reasoning is 400. Pinned native driver `route.defaults` emits `include:["reasoning.encrypted_content"]`; Broker accepts **exactly that one-element array** or omission and passes it upstream, rejects all other `include` values. This is the only include form admitted in M1/M2 to preserve stateless replay.
- **SDK generation compatibility:** `lowerGeneration` can emit `max_output_tokens`, `temperature`, `top_p`, `prompt_cache_key`, `parallel_tool_calls`, `stream_options`, etc. Guest `ctx.session.hook("context")` may remove `options.maxTokens` for the narrowly selected Guest primary route to suppress SDK `max_output_tokens`; do **not** assert it suppresses cache/system options without observed serialized-body evidence. Broker rejects any present unsupported field with 400 and returns a safe error; **do not silently strip present-valued unsupported controls or required history**. If any auto-field is unavoidably generated, M1/M2 STOP until Owner decision. Always reject `previous_response_id`, `store:true`, `stream:false`, `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`, `tool_search`, `programmatic_tool_calling`, `context_management`, `prompt_cache_key`, `stream_options`, unsupported tools/media or unknown keys. Test the **serialized v2.2.5 SDK HTTP JSON**, not only synthetic hand-written bodies.
- **M2 fixed namespace/tool (PR2-F-002):** Only Guest custom registry `guest_read_file`, SDK public flat `read_file`, `namespace:"guest"`, fixed schema `{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}`. Broker accepts exactly `{type:"function",name:"read_file",description,parameters:<schema>,strict:false}` and projects upstream `tools:[{type:"namespace",name:"guest",description:"Sandbox-local tools",tools:[{type:"function",name:"read_file",description,parameters:<schema>,strict:false}]}]`. Native SSE Tool Event `{type:"function_call",name:"read_file",namespace:"guest",call_id,arguments,id?}` dispatches by **name only** through same-definition context alias to **Guest** executor. Native next-request history `function_call` has `name:"read_file"` and may omit `namespace`; the Broker accepts only missing/`guest` namespace, restores `namespace:"guest"` to the SIWC upstream history item and preserves exact `call_id`, `arguments`, optional `id`, order, assistant text and `reasoning.encrypted_content`. Pair `function_call_output.call_id` with the same valid preceding call and preserve its output byte-for-byte as JSON string content. Unknown/dotted tool names, foreign namespace, mismatched/duplicate call_id or altered schema/strict => 400 before Cloudflare. No custom/hosted tools, no SSE rewriting adapter and **no Host tool execution**.
- **PR2-F-002 native history conversion:** Native `function_call` with `name:"read_file",namespace` absent or literal `guest`, exact approved argument schema and unique `call_id` is converted only by adding/reasserting `namespace:"guest"` for upstream. Reject any other namespace, unknown/dotted tool name, mismatched/unpaired or repeated `call_id`; preserve the original `call_id`, `arguments`, `id` when present, `function_call_output.output`, message order, assistant `output_text` and `reasoning.encrypted_content`. No Host execution; no history truncation or generic namespace rewriting. M1 is unaffected.
- **F-001/B strict:false admission/normalization:** `OpenResponses.lowerTool` emits literal `strict:false` on a native flat `read_file` function. The Broker validates that exact literal and schema, remaps only the function **name** into SIWC namespace `guest` leaf `read_file`, and retains **`strict:false`** inside that leaf (never silently removes it). Reject `strict:true`, absent/null/nonboolean strict, other native/unknown keys and unsupported function names. Task 4 must verify actual serialized Native SDK flat function -> Broker accepted namespaced leaf with `strict:false` -> Guest tool call; no Host execution and no new SSE adapter.
- `createCloudflareUpstream({gatewayBase,gatewayToken,credentialSource,fetchImpl}):(parsed,signal)=>Promise<Response>` fixes Cloudflare Custom Provider `/custom-openai-public-probe/v1/responses`, Host SIWC bearer and Gateway token only; never forwards Guest auth headers. `credentialSource.getAccessToken():Promise<string>` never falls back to BYOK.
- `createBrokerServer({capabilities,parseRequest,upstream,limits}): import("node:http").Server`. Only `GET /health`, authenticated `GET /v1/models`, authenticated `POST /v1/responses`. Require `response.completed` **plus orderly stream ending** for success; `response.failed`, `response.incomplete`, malformed SSE, early EOF, cancellation are terminal failure even after HTTP 200/text delta; quota/timeout abort and Permit release. No retry/alternate provider.

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
- [ ] **Step 5: Write failing native wire Broker tests** (`test/broker/server.test.mjs`): (M1-A) accept exact Native `{type:"message",role:"user",content:[{type:"input_text",text:"gateway-ok"}]}`, `include:["reasoning.encrypted_content"]`, absent/present false store, stream:true; rebuilt upstream has required flags. (M1-B) preserve developer string, assistant `[{type:"output_text",text}]` with id/status/phase and `{type:"reasoning",summary,encrypted_content}` across full history in original order. (M2-A) accept `read_file` flat tool declaration and project exactly one SIWC namespace guest/read_file; reaccept next-request history with matching native `function_call(name:"read_file",namespace?:"guest",call_id,arguments)` projected to SIWC `namespace:"guest"` + `function_call_output(call_id,output)` and preserved reasoning item. (negative) reject bare shorthand, invalid user/assistant content, explicit system message, lost/mismatched call_id, missing reasoning content, arbitrary include, previous_response_id, store:true, stream:false, unsupported SDK options (`max_output_tokens`, `prompt_cache_key`, etc.), unknown model, hosted/custom tools, oversize/injected headers. Every negative returns expected 400/413 before upstream.
- [ ] **Step 5b: F-001/A-B narrow regression tests**: with synthetic Broker POST bodies, (A-positive) no `prompt_cache_key` is admitted; (A-negative) any present `prompt_cache_key` (including empty string) returns 400 without upstream invocation. (B-positive) native flat `read_file` `{type:"function",name:"read_file",description,parameters:<exact-schema>,strict:false}` maps to the **only** allowed SIWC namespace leaf `{type:"function",name:"read_file",description,parameters:<exact-schema>,strict:false}`. (B-negative) `strict:true`, missing/null/string strict, unknown function key, unknown function, different schema or unexpected hosted tool returns 400 and no Cloudflare request. No broad schema relaxation; verify M1/M2 histories and existing quotas stay intact.
- [ ] **Step 5c: PR2-F-002 Broker projection tests**: Native flat `{type:"function",name:"read_file",description,parameters:<exact-schema>,strict:false}` => SIWC namespace `guest` with leaf `read_file` and preserved false. Native history with `{type:"function_call",name:"read_file",call_id:"call_test",arguments:"{\\"path\\":\\"fixture.txt\\"}"}` (namespace absent) and the variant explicitly carrying `namespace:"guest"` => canonical upstream `namespace:"guest"`; matching `function_call_output(call_id:"call_test")` unchanged. Compare full ordered input with assistant text and opaque `reasoning.encrypted_content` before/after. Negatives: dotted `guest.read_file`, foreign namespace, unknown name, wrong schema, missing/true strict, missing/duplicate/unmatched `call_id` => 400 and no upstream request.
- [ ] **Step 6: Confirm RED**: `node --test test/broker/server.test.mjs` FAIL with missing exports.
- [ ] **Step 7: Implement native InputItem-aware parser and strict upstream projection**: validate exact M1 message variants, assistant output_text, opaque reasoning, M2 matching function_call/call_id/output; normalize only the pinned `read_file` tool to SIWC namespace `guest`/leaf `read_file`. Admit exact default include `["reasoning.encrypted_content"]` or absent, preserve encrypted reasoning, reject all unsupported **present** controls (and previous_response_id) rather than silently deleting. Always set upstream `store:false,stream:true`, pinned Gateway URL and Host-only credentials; no Guest headers or fallback. Retain byte/rate/time/stream controls.
- [ ] **Step 7a: Enforce the exact F-001 projection**: pre-dispatch reject any present `prompt_cache_key`; the Guest model suppresses it through `compatibility.supportsPromptCacheKey:false`, not Broker silent stripping. For one `read_file` function require literal `strict:false`, map its name to namespace `guest` / `read_file` and preserve `strict:false` in the outgoing leaf. All other tool/field shapes fail closed.
- [ ] **Step 7b: PR2-F-002 exact namespace contract**: Broker accepts only Native flat tool name `read_file`, validates `strict:false` and fixed schema, maps solely to SIWC namespace `guest` leaf `read_file`. For replayed native `function_call` items accept namespace omitted or `guest`, validate `call_id`/outputs, and reassert namespace `guest` while copying other history fields unchanged. Reject all unrecognized or ambiguous entries with typed 400; keep existing capability/Fail-Closed/SSE policies.
- [ ] **Step 8: Write and run SSE/abort tests**: synthetic `response.created`, text or `function_call` delta and `response.completed` + clean EOF is PASS; `response.failed`, `response.incomplete`, invalid framing, premature EOF, client abort, upstream 401/403/429/5xx or byte/time quota error is FAIL, abort upstream and release Permit once. `node --test test/broker/server.test.mjs` PASS, including cases M1-A/M1-B/M2-A.
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
- Create: `src/guest/index.js`, `src/guest/provider.mjs` (the **local Guest plugin directory**; do not add a nested `package.json`), plus `bin/guest-launch.mjs` from the existing Plan; Host entry unchanged.
- Test: `test/guest/provider.test.mjs`
- Modify: `package.json` for a separate guest plugin export and required SDK dependency only; preserve `src/index.js` Host-only entrypoint.

**Interfaces:**
- Produces `registerGuestProvider(ctx,{brokerURL,capability}):Promise<void>` with Guest-only `Provider.Info`/`Model.Info` pinned to `@opencode/ai@2.2.5`, and Guest-local `read_file` registered through `ctx.tool.transform` using `{namespace:"guest",codemode:false}`. Context hook aliases registered effective name `guest_read_file` to `read_file` while preserving definition object identity for v2.2.5 `SessionModelRequest`.
- Provider registration: `ctx.provider.transform(editor=>editor.add({info,models:[model]}))`. Loading: `plugins:["/absolute/path/to/oc-cf-aig-subscription/src/guest"]` (**directory**, not file or package subpath); built-in `Host.resolve` finds its `index.js`. Local tool registration: `ctx.tool.transform(editor => {editor.namespace({name:"guest",description:"Disposable Sandbox-only tools"});editor.add({name:"read_file",description:"Read an approved disposable Guest fixture",input:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false},options:{namespace:"guest",codemode:false},execute:async({path})=>({content:<bounded-text>})})})`. The execute implementation resolves only the disposable fixture root. SDK sees `read_file` alias via context hook; no SSE rewriting adapter.
- Guest registration must not read `CF_AIG_TOKEN`, native OpenAI credential storage or Host plugin `registerGateway`; it must not expose OpenAI `openai` provider automatically as a fallback.

- [ ] **Step 1: Write failing actual loader/provider/tool tests**: (M1-C) with disposable Guest `opencode.jsonc` `plugins:[<absolute src/guest directory>]`, verify Plugin setup active, `oc-cf-aig/gpt-6-luna` registered via required Provider.Info/Model.Info, and no Host plugin loaded; negative `plugins:[<absolute .js file>]` is not accepted contract, missing Guest plugin/provider prevents startup admission and independent egress policy denies direct traffic. (M2-B) verify `guest_read_file` is registered through `ctx.tool.transform` (`codemode:false`), context alias `read_file` preserves the same ToolDefinition identity, and fixture path confinement prevents Host paths. Verify capability bearer never equals real OpenAI/Gateway token.
- [ ] **Step 1b: Fixed model-compatibility assertion**: `Model.Info.compatibility` must contain `supportsPromptCacheKey:false`; inspect effective resolved `LanguageModel.compatibility` (model-over-provider precedence), and verify no Guest native provider or fallback overwrites it. Test that `SessionModelRequest` may still set a nonempty `promptCacheKey` without a body field.
- [ ] **Step 1c: PR2-F-002 registration/dispatch tests**: validate registry ID `guest_read_file`, context public key `read_file` pointing to exactly the same ToolDefinition object, original key removed, collisions/missing registry fail closed, and `SessionModelRequest` mapping dispatches Tool Event `name:"read_file"` to the original Guest executor. A dotted alias must never be emitted. M2 BLOCKED if name resolution fails; M1 assessed independently.
- [ ] **Step 2: Confirm RED**: `node --test test/guest/provider.test.mjs` FAIL with missing guest exports.
- [ ] **Step 3: Implement Guest plugin directory, provider and local read_file**: `src/guest/index.js` default `Plugin.define` and `src/guest/provider.mjs`, configured by absolute **directory**; register native Responses provider/model and local `read_file` through `ctx.tool.transform`, `options:{namespace:"guest",codemode:false}`; `ctx.session.hook("context")` creates alias `read_file` to `guest_read_file` preserving definition identity, and narrowly suppresses `options.maxTokens` where proven. Root `package.json` guest import subpath optional, root Host export unchanged. Guest launcher retains one-shot stdin/FD capability delivery. No replacement SDK, no Host tool execution.
- [ ] **Step 4: Confirm GREEN**: `node --test test/guest/provider.test.mjs` PASS. Ensure the guest authentication bearer belongs only to Broker and cannot be reused against upstream.
- [ ] **Step 5: Offline pinned SDK M1/M2 acceptance**: use a real OpenCode v2.2.5 Guest-plugin-loaded process with fake Broker (no live OAuth) and inspect **actual serialized HTTP JSON**, not only synthetic unit input. (M1-D) single user text yields native `type:"message"`, `input_text[]`, default `include:["reasoning.encrypted_content"]`, no unsupported fields, Broker 200 SSE `response.completed` + clean EOF, and `gateway-ok`. (M1-E) multi-turn assistant `output_text[]` plus encrypted reasoning history survives intact, with no previous_response_id. (M2-C) native SDK sends flat `read_file` tool; Broker translates to namespace `guest/read_file`; mocked namespaced function_call SSE with `call_id` executes only Guest-local fixture reader and next request has original history + `function_call_output` with matching ID; no custom SSE adapter. (negatives) deliberately emit `max_output_tokens`, prompt_cache_key, unsupported `include`, malformed message/namespace, failed/incomplete SSE and absent plugin; verify 400/Fail-Closed. If OpenCode v2.2.5 cannot suppress auto-injected controls, emit flat `read_file` tool names, or dispatch named namespace with the preserved identity, mark respective M1/M2 BLOCKED and STOP; never silently drop history or swap SDK.
- [ ] **Step 5b: Actual v2.2.5 SDK wire F-001 tests**: (M1) start a local fake-Broker session with nonempty affinity and default caching; capture the **serialized** POST and assert model `compatibility.supportsPromptCacheKey === false`, **no `prompt_cache_key`** even with `LLMRequest.promptCacheKey` populated, and existing SSE `response.completed` contract. Send a deliberately present key to assert Broker 400 and M1 STOP. (M2) capture the actual native flat `read_file` tool and verify exact boolean `strict:false`; Broker must accept and preserve false in the namespace leaf, then the Guest-local function tool completes with the same call_id. Test `strict:true`, omitted strict and unknown fields as 400. If native serialization or SIWC namespace acceptance differs, mark corresponding M1/M2 BLOCKED; no alternative SDK, field blanket-drop or Host tool execution.
- [ ] **Step 5c: PR2-F-002 pinned SDK round-trip**: actual OpenCode v2.2.5 Guest registers `guest_read_file` with `codemode:false`, publishes flat `read_file` by identity, emits Native flat function `name:"read_file",strict:false`, and Broker projects namespace `guest` leaf `read_file`. Feed native SSE `name:"read_file",namespace:"guest",call_id`; verify Guest-only execution and a subsequent native history item `name:"read_file"` with or without namespace is projected to SIWC `namespace:"guest"`. Confirm exact `call_id`, `arguments`, result, input order, full assistant + `reasoning.encrypted_content` replay. Negative unknown/dotted names, foreign namespace, mismatched IDs, wrong strict/schema => fail closed. No added SSE adapter, no Host tool calls. Failed M2 remains BLOCKED without changing M1 status.
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
- [ ] **Step 6: Run one bounded M2 function-tool case**: exercise SDK flat `read_file` (registry `guest_read_file`) and upstream SIWC `guest/read_file`; feed namespaced SSE `name:"read_file",namespace:"guest"` and verify the Guest-local fixture reader alone executes. Preserve `call_id` and `arguments`; Broker restores `namespace:"guest"` on replayed native `function_call(name:"read_file",namespace?:"guest")` while leaving full assistant/tool-result/reasoning history intact. Test missing/collision/foreign namespace or mismatch as Fail-Closed and M2 BLOCKED only; M1 independently judged.
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

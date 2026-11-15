# OC2 Sandbox Subscription Host Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Run OpenCode v2.2.5's agent and tools inside a disposable Docker Sandbox while ChatGPT Plus SIWC model requests traverse a separately authenticated Host Broker and Cloudflare AI Gateway, without real OAuth/Gateway credentials in the guest.

**Architecture:** A guest-only custom OpenCode provider sends OpenAI Responses requests through a sandbox-scoped host-service network route. A loopback-only Node.js Broker authorizes a bounded guest capability, acquires/refreshes SIWC only on the host, validates the request and streams it through the existing Cloudflare Custom Provider. The existing Host-only plugin remains unchanged.

**Tech Stack:** Node.js 22+ ESM, Node built-in HTTP/crypto/fetch/test, OpenCode v2.2.5 \`@opencode/plugin\`, OpenAI Responses/SSE, official SIWC OAuth token-sharing, Docker Sandboxes CLI v0.51.0 (\`sbx\`), Cloudflare AI Gateway Custom Provider \`custom-openai-public-probe\`.

**Spec:** \`docs/superpowers/specs/2026-11-16-oc2-sandbox-subscription-host-broker-design.md\` (R0.1; Owner adopted 2026-11-16 JST).

## Global Constraints

- **Authorization:** This is a DOCUMENT-ONLY implementation plan. Creating or running code, modifying Sandbox/network policy, storing credentials, opening a PR, or merging requires the Owner's separate implementation approval.
- **Versions:** Pin OpenCode to \`v2.2.5\`, Docker Sandboxes CLI to \`v0.51.0\`, and require Node.js \`>=22\`. Abort rather than silently upgrading or changing the host.
- **Isolation:** Use a new throwaway Sandbox and temporary workspace only. Do not alter existing OC2 Sandboxes, host OpenCode settings, daemon configuration, or global policies. No new Workers, Neon Functions, or OpenCode source patches.
- **Host secrets:** SIWC \`chatgpt.tokens.use.direct\` access/refresh tokens and \`CF_AIG_TOKEN\` stay on the host. Guest receives only a time-bounded, rate-bounded capability, which is **readable by untrusted guest code** and therefore must itself be limited/revocable.
- **No paid fallback:** No \`OPENAI_API_KEY\`, legacy Codex OAuth, direct OpenAI route, Cloudflare Unified Billing or alternate provider. Set upstream headers \`cf-aig-no-wholesale: true\`, \`cf-aig-collect-log-payload: false\`, \`cf-aig-skip-cache: true\`; remember that Logpush is independent.
- **Transport:** Host Broker binds only \`127.0.0.1:<port>\`; guest accesses \`host.docker.internal:<port>\` only via explicitly verified sandbox-scoped policy. The \`0.51.0\` capability is **NOT VERIFIED** before Task 1.
- **Initial model:** Exact model ID \`gpt-6-luna\`. Broker \`POST /v1/responses\` is the only upstream inference route; \`GET /health\` and authenticated \`GET /v1/models\` are local.
- **Scope:** ChatGPT first. Claude Pro adapter, production daemon/systemd, arbitrary provider routing, image/media, and broad model selection are outside this plan. Never execute agent shell/tools on the host.
- **Stage boundaries:** M1 establishes text Responses + SSE + Gateway HTTP 200 + denial controls. M2 establishes guest-only function-tool execution and cancellation. Stop on a spec-defined safety failure and ask the Owner; do not automatically launch review/fix cycles.
- **Commit hygiene:** Each task commits only its relevant source/tests or documentation to a new implementation branch based on the adopted design branch. No secrets, live request payloads or tokens in Git. Do not merge or open PR automatically.

## Review Focus

1. **Untrusted guest authorization headers**: a guest that submits upstream \`Authorization\`, \`cf-aig-*\`, \`x-api-key\`, cookies, or target URL must not influence the host's upstream headers or destination. Tests in Task 2.
2. **Capability abuse**: expired/revoked/replayed or over-budget capability, concurrent requests, and guessed sandbox identity must reject; no claimed cryptographic guest identity without transport evidence. Tests in Task 2.
3. **SSE loss / timeout / cancellation**: cancellation and broken streams must close upstream and release capability concurrency slots; no retry/fallback. Tests in Task 2 and Task 4.
4. **OAuth renewal failure / credential-path attack**: expired grant, bad state/nonce/issuer/audience, path symlink, unsafe mode and failed refresh must never trigger paid API fallback or leak secrets. Tests in Task 3.
5. **Host tool execution or direct egress**: OpenCode's function call must run only in the guest, and HTTP/IP bypass attempts must be blocked independently of plugin load. Tests in Tasks 1, 4, and 5.

---

## File / responsibility map

| Path | Responsibility |
| --- | --- |
| \`scripts/probe-host-path.mjs\` | Secret-free loopback probe for bounded Docker host reachability |
| \`test/broker/host-path.test.mjs\` | Local probe contract test |
| \`src/broker/capabilities.mjs\` | Mint/hash/revoke/budget per-test guest bearer capabilities |
| \`src/broker/policy.mjs\` | Parse exact supported route and request schema; reject unwanted headers/types |
| \`src/broker/upstream.mjs\` | Build **host-only** Cloudflare Responses request; filter outgoing headers |
| \`src/broker/server.mjs\` | Node HTTP server, authentication, streaming, cancellation, errors |
| \`test/broker/capabilities.test.mjs\` | Capability expiry, budget, concurrency, revocation |
| \`test/broker/server.test.mjs\` | Broker routes, header stripping, fake upstream, SSE, disconnect |
| \`src/broker/credential-store.mjs\` | Host-only protected atomic credential persistence |
| \`src/broker/siwc.mjs\` | Official SIWC PKCE login, token validation, refresh, no BYOK |
| \`test/broker/siwc.test.mjs\` | Mocked OAuth endpoints, nonce/expiry, refresh, permissions |
| \`bin/host-broker.mjs\` | Foreground host-only Broker entrypoint and validated config |
| \`src/guest/index.js\` | OpenCode v2 Plugin.define guest entrypoint |
| \`src/guest/provider.mjs\` | Register narrow Responses provider and request guard |
| \`test/guest/provider.test.mjs\` | Guest provider/transport and denial contract |
| \`docs/sandbox-acceptance.md\` | Minimal reproducible disposable acceptance and observed/unknown matrix |
| \`package.json\` | Additional scripts and explicit dependencies only where needed; preserve Host plugin exports |
| \`src/index.js\`, \`src/gateway.mjs\` | Existing Host-only plugin: **leave unchanged** |

### Stable cross-task interfaces

- \`createCapabilityStore({ now, randomBytes }): { issue(config): {token,id}, authorize(token,model): {release()}, revoke(id) }\`; config includes \`sandboxID\`, \`model\`, \`ttlMs\`, \`maxCalls\`, \`maxConcurrent\`, \`maxBytes\`. Store **only token hash**, expiry, usage counters and policy; issue raw token exactly once.
- \`parseBrokerRequest({ method, pathname, headers, body, limits }): ParsedRequest\`; \`ParsedRequest\` is \`{model:"gpt-6-luna", input, stream, tools?}\`, with strictly validated request fields. Throw a typed \`PolicyError(status,message)\` (never a stack trace).
- \`createCloudflareUpstream({ gatewayBase, gatewayToken, credentialSource, fetchImpl }): (parsed,signal)=>Promise<Response>\`; \`credentialSource.getAccessToken(): Promise<string>\`. Ignore guest-supplied upstream headers entirely.
- \`createBrokerServer({ capabilities, parseRequest, upstream, limits }): import("node:http").Server\`; only \`GET /health\`, authenticated \`GET /v1/models\`, and authenticated \`POST /v1/responses\` exist.
- \`createSIWCSource({ credentialPath, authBase, client, clock }): { beginLogin():Promise<{url,port,complete}>, getAccessToken():Promise<string> }\`; \`client\` is an injected HTTP/OAuth client, not an API-key provider.
- \`registerGuestProvider(ctx, { brokerURL, capability }):Promise<void>\`, provider ID \`oc-cf-aig\`, model ID \`gpt-6-luna\`, broker base \`http://host.docker.internal:<port>/v1\`. Guest \`Authorization\` is the **limited capability** and must never equal an OAuth/Gateway token.

## Task 1 — Disposable host-connection feasibility (STOP gate)

**Files:**
- Create: \`scripts/probe-host-path.mjs\`
- Test: \`test/broker/host-path.test.mjs\`
- No existing configuration changes.

**Interfaces:**
- Produces: \`startProbeServer({host="127.0.0.1",port}):Promise<{close():Promise<void>}>\`, a local \`GET /health\` responder returning \`{"ok":true}\`.
- Consumes: only built-in Node modules; **no credentials**.

- [ ] **Step 1: Write failing local probe test** \`test/broker/host-path.test.mjs\`: starts on \`127.0.0.1\` ephemeral port, checks \`GET /health\` -> 200 \`{"ok":true}\`, \`GET /anything\` -> 404, closes server.
- [ ] **Step 2: Confirm RED**: \`node --test test/broker/host-path.test.mjs\`; expected FAIL because \`startProbeServer\` does not exist.
- [ ] **Step 3: Implement minimal Node responder** with exact \`startProbeServer\` interface and no logging of request headers.
- [ ] **Step 4: Confirm GREEN**: \`node --test test/broker/host-path.test.mjs\` PASS.
- [ ] **Step 5: Verify target and isolated environment** using \`sbx --version\`, \`sbx policy ls\`, and \`sbx create --help\`; expect v0.51.0 and support for a **new** disposable sandbox and \`--sandbox\`-scoped rules. If version/kit/port-policy differs, STOP without changing global policy.
- [ ] **Step 6: Approved disposable probe only**: start responder on fixed disposable port \`49187\`; create sandbox named \`oc2-aig-probe\` in a fresh empty test workspace (verify the exact local \`sbx create\` syntax via \`--help\`, never mount a production repo). Apply \`sbx policy allow network --sandbox oc2-aig-probe localhost:49187\`, then \`sbx exec oc2-aig-probe curl -fsS http://host.docker.internal:49187/health\`; expected JSON \`{"ok":true}\`. Check \`sbx policy ls oc2-aig-probe\`.
- [ ] **Step 7: Demonstrate independent denial**: only inside this disposable Sandbox, apply sandbox-scoped denial to \`api.openai.com\`, \`chatgpt.com\`, \`gateway.ai.cloudflare.com\`, \`api.anthropic.com\`; attempt connections to those hosts and a representative direct-IP/alternative route; verify denied, with policy logs where available. If any bypass succeeds, STOP; do not proceed on the assertion that plugin hooks suffice.
- [ ] **Step 8: Record PASS / BLOCKED evidence without secrets** in \`docs/sandbox-acceptance.md\` and commit Task 1 source/test/doc only. Keep the disposable Sandbox or destroy it *only if explicitly authorized*; never affect existing Sandbox IDs.

**Task completion:** host loopback route and independent network-denial paths are observed on the pinned installation, or a truthful \`BLOCKED\` result and Owner STOP. Do not advance tasks 2–5 if this gate is BLOCKED.

## Task 2 — Secret-free Broker contract, policy, bounded capability and SSE

**Files:**
- Create: \`src/broker/capabilities.mjs\`, \`src/broker/policy.mjs\`, \`src/broker/upstream.mjs\`, \`src/broker/server.mjs\`
- Test: \`test/broker/capabilities.test.mjs\`, \`test/broker/server.test.mjs\`
- Modify: \`package.json\` (test/check scripts only, if needed)

**Interfaces:**
- Consumes and produces the stable Broker interfaces above.
- \`gatewayBase\` is validated to \`https://gateway.ai.cloudflare.com/v1/<32-lower-hex-account>/<gateway-id>\`; route is pinned to \`/custom-openai-public-probe/v1/responses\`.
- \`fetchImpl\` and \`credentialSource\` must be injectable for **synthetic tests**, with no real credentials or internet access.

- [ ] **Step 1: Write failing capability tests**: issue a random bearer, assert only a SHA-256 token digest is retained; exact model allowed; expiry, revocation, \`maxCalls\`, \`maxConcurrent\`, duplicate-release and parallel contention all deny/limit correctly. Never log the bearer.
- [ ] **Step 2: Confirm RED**: \`node --test test/broker/capabilities.test.mjs\` FAIL with missing exports.
- [ ] **Step 3: Implement \`createCapabilityStore\`** using cryptographic random bytes, timing-safe digest comparison, atomic usage/concurrency accounting and idempotent release, in \`capabilities.mjs\`.
- [ ] **Step 4: Confirm GREEN**: \`node --test test/broker/capabilities.test.mjs\` PASS.
- [ ] **Step 5: Write failing server/policy tests**: \`GET /health\` no sensitive fields; \`GET /v1/models\` only returns \`gpt-6-luna\` to valid bearer; \`POST /v1/responses\` accepts an allowlisted text/SSE envelope; disallows wrong verb/path/model, query, oversized body, unknown server-tool type, and guest \`Authorization\`/Cloudflare/API-key/cookie/upstream-target overrides; response contains no host authorization headers. \`POST\` consumes a capability permit.
- [ ] **Step 6: Confirm RED**: \`node --test test/broker/server.test.mjs\` FAIL with missing exports.
- [ ] **Step 7: Implement request parser, server and Cloudflare upstream builder** with explicit request-field allowlist for M1 (\`model\`, \`input\`, \`stream\`; deny unknown fields), fixed upstream host/path, \`cf-aig-no-wholesale: true\`, \`cf-aig-collect-log-payload: false\`, \`cf-aig-skip-cache: true\`, Host-only \`Authorization\` and \`cf-aig-authorization\`. **Build upstream headers from an empty allowlist**, not by forwarding guest headers. Bound body size, timeout, count and concurrency from mandatory config.
- [ ] **Step 8: Write and run SSE/abort tests**: fake upstream emits \`response.created\`, \`response.output_text.delta\`, \`response.completed\`; verify exact streaming bytes/order, client abort cancels upstream and releases permit, upstream 401/403/429/5xx never triggers retries or fallback. Expect \`node --test test/broker/server.test.mjs\` PASS.
- [ ] **Step 9: Run \`npm test && npm run check\`**, expect all tests PASS; commit Task 2 only.

**Task completion:** a fake upstream proves authenticated, rate-limited, streaming Broker behavior without host credentials. If headers can leak or enforcement is incomplete, STOP; no live token experiment.

## Task 3 — Host-only SIWC authentication, credential renewal and Cloudflare dispatch

**Files:**
- Create: \`src/broker/credential-store.mjs\`, \`src/broker/siwc.mjs\`, \`bin/host-broker.mjs\`
- Test: \`test/broker/siwc.test.mjs\`
- Modify: \`package.json\` only for executable script and minimal verifiable JWT/JWKS validation dependency (if required).

**Interfaces:**
- Produces \`createSIWCSource({ credentialPath, authBase, client, clock })\`, implementing the Task 2 \`credentialSource.getAccessToken()\` contract.
- Host login uses browser-opened OAuth URL plus SSH-forwarded **dynamic loopback callback**, PKCE, state, nonce, issuer, audience, required \`chatgpt.tokens.use.direct\` scope and dynamic client registration; refresh before expiry using the registered client ID.
- Host credential store: directory mode \`0700\`, file mode \`0600\`, symlink-resistant and atomic writes, restrictive readback, no secrets in errors/logs.

- [ ] **Step 1: Write failing credential-store tests**: securely create/read/update a dummy token record; reject symlink/unsafe permission path; never print record fields in errors; atomic replacement preserves mode \`0600\`.
- [ ] **Step 2: Write failing SIWC tests with mock authorization/token/JWKS endpoints**: invalid state/nonce/issuer/audience/scope fail; approved authorization succeeds; near-expiry token refresh returns new access token; refresh 401/timeout rejects without using an API key; concurrent calls share one refresh.
- [ ] **Step 3: Confirm RED**: \`node --test test/broker/siwc.test.mjs\` FAIL due to missing implementations.
- [ ] **Step 4: Implement credential store and SIWC source** in the named files. Follow OpenCode v2.2.5's **token-sharing** flow, not \`chatgpt-browser\` or \`chatgpt-headless\`. Verify ID-token signature and claims against issuer JWKS; never use JWT payload decoding without verification as proof of identity. Use test-injected HTTP client.
- [ ] **Step 5: Confirm GREEN**: \`node --test test/broker/siwc.test.mjs\` PASS.
- [ ] **Step 6: Add \`bin/host-broker.mjs\`**: validate Host-only runtime config, SIWC credential file path, Gateway origin and token, mandatory quotas and port; refuse if any are absent. Provide separate \`login\` and \`serve\` modes. Use foreground process only; do not register systemd.
- [ ] **Step 7: Run \`npm test && npm run check\`** with fake endpoints first, expected PASS. Then, only with Owner's authorized execution and protected Host environment, complete one SSH-forwarded SIWC sign-in, one controlled refresh/expiry exercise and one Cloudflare \`/v1/responses\` request; require Gateway HTTP 200 and no unexpected billing/Logpush exposure. Stop if authorization method or billing attribution is unsupported.
- [ ] **Step 8: Commit Task 3 source/tests**, never token DB, client secrets, bearer literals, host paths or live payloads.

**Task completion:** SIWC lifecycle and exact Cloudflare dispatch are confirmed on host; absence of payment charges **remains NOT_VERIFIED** without independent billing evidence.

## Task 4 — Guest OpenCode provider and guest-only tool execution

**Files:**
- Create: \`src/guest/index.js\`, \`src/guest/provider.mjs\`
- Test: \`test/guest/provider.test.mjs\`
- Modify: \`package.json\` for a separate guest plugin export and required SDK dependency only; preserve \`src/index.js\` Host-only entrypoint.

**Interfaces:**
- Produces \`registerGuestProvider(ctx,{brokerURL,capability}):Promise<void>\`, only provider \`oc-cf-aig\` with model \`gpt-6-luna\`.
- Provider registry follows OpenCode v2.2.5 \`ctx.provider.transform(editor.add({info,models}))\` and an HTTP request hook scoped to \`providerID:"oc-cf-aig"\`. Use an OpenAI Responses-compatible SDK package, \`transport:"http"\`, \`encoding:"none"\`, and source model metadata only if reliably available. Capability bearer is an **in-guest limited credential**, not SIWC.
- Guest registration must not read \`CF_AIG_TOKEN\`, native OpenAI credential storage or Host plugin \`registerGateway\`; it must not expose OpenAI \`openai\` provider automatically as a fallback.

- [ ] **Step 1: Write failing guest tests**: valid \`http://host.docker.internal:<port>/v1\` plus capability produces one \`oc-cf-aig/gpt-6-luna\` provider/model; invalid URL, unset capability, missing model definition and any native OpenAI/Cloudflare host should refuse registration or model dispatch; direct URL and WebSocket are rejected. Verify no Host secrets are read.
- [ ] **Step 2: Confirm RED**: \`node --test test/guest/provider.test.mjs\` FAIL with missing guest exports.
- [ ] **Step 3: Implement guest-only plugin registration** with the exact \`registerGuestProvider\` interface. Derive model capabilities/limits from the version-pinned OpenCode provider definition where possible; if not available, STOP rather than invent unsupported model metadata. Keep all Host credential logic outside the guest module import graph.
- [ ] **Step 4: Confirm GREEN**: \`node --test test/guest/provider.test.mjs\` PASS. Ensure the guest authentication bearer belongs only to Broker and cannot be reused against upstream.
- [ ] **Step 5: Offline guest-SDK wire test** against a local fake Broker: text SSE output works; \`function_call\` with function name + arguments is relayed to OpenCode, local \`read\` or equivalent tool is executed **only inside guest** and \`function_call_output\` returns through Broker; cancellation terminates the stream. If SDK uses unsupported request fields, extend the Task 2 field allowlist **only for exact observed function-tool schema** and add matching tests; otherwise STOP, not broad pass-through.
- [ ] **Step 6: Run \`npm test && npm run check\`**, expected PASS; commit Guest plugin/tests only.

**Task completion:** host-independent fake Broker demonstrates OpenCode guest provider and tool loop; no native OAuth credential appears inside guest.

## Task 5 — One bounded live disposable acceptance, cleanup and Owner checkpoint

**Files:**
- Create/Update: \`docs/sandbox-acceptance.md\`
- No unrelated code changes. Any discovered failure requiring architectural change is a STOP and Owner decision, not an automatic new task.

**Interfaces:**
- Consumes Broker, guest provider and sandbox-scoped policy from Tasks 1–4.
- Produces a concise M1/M2 result record: \`PASS\`, \`FAIL\`, \`NOT_RUN\` or \`NOT_VERIFIED\` for each claim, with no secrets.

- [ ] **Step 1: Run local tests** \`npm test && npm run check\` (PASS required). Check branch diff for only approved files; no credential files/real tokens tracked.
- [ ] **Step 2: Inspect sandbox/host policy** with \`sbx policy ls <disposable-name>\`, inspect kit/guest mounts, env, credentials configuration and daemon policy in read-only mode; verify no actual OAuth/Cloudflare tokens, host OpenCode database, SSH agent or Docker socket are shared. **Do not print token values** while checking presence.
- [ ] **Step 3: Start foreground Host Broker** bound only to loopback; issue one short-lived capability scoped to the test model, time and request quota. Launch guest plugin only inside the disposable Sandbox; require \`oc-cf-aig/gpt-6-luna\` to be the explicitly selected model.
- [ ] **Step 4: Run exactly one approved M1 text prompt** \`Reply with exactly: gateway-ok\` via Guest OpenCode; expect \`gateway-ok\`. Match timestamp/provider/model/path with a Cloudflare Gateway \`custom-openai-public-probe/v1/responses\` **HTTP 200**. \`gateway-ok\` without Gateway HTTP 200 is not a PASS.
- [ ] **Step 5: Run negative contract cases** with capability revoked/expired, Broker down, unapproved model/path, quota exhausted and direct API hostname/IP/alternative egress attempts; each must fail without paid fallback or host credentials disclosure.
- [ ] **Step 6: Run one bounded M2 function-tool case** that touches a known dummy file *in the disposable guest workspace*; verify file change/readback from guest, not host; verify correct tool output response and one cancellation case.
- [ ] **Step 7: Revoke capability and stop foreground Broker**. Remove test Sandbox and its sandbox-scoped rules **only if explicitly authorized**; do not remove any pre-existing VM or workspace.
- [ ] **Step 8: Record results, evidence type and residuals** in \`docs/sandbox-acceptance.md\`, distinguishing \`PASS\`, observed \`FAIL\`, \`NOT_RUN\` and \`NOT_VERIFIED\`; commit only the redacted acceptance document.

**Task completion:** M1/M2 are reported independently. Stop after this bounded verification even if M2 is not achieved; ask the Owner whether to accept M1-limited operation, authorize a precisely scoped fix, or defer M2. No repeated independent review/repair chain.

## Acceptance and STOP crosswalk

| Condition | Evidence | Outcome |
| --- | --- | --- |
| Docker v0.51.0 guest→host loopback and independently enforced deny | Disposable probe and policy logs | Proceed / STOP |
| Broker fake upstream, caps, no credential bleed, SSE cancellation | Task 2 tests | Proceed / STOP |
| SIWC host-only token-sharing/refresh; no BYOK | Mock and limited host live evidence | Proceed / STOP |
| Guest plugin and function-tool invocation stays guest-only | Task 4 tests, Task 5 dummy workspace | M2 PASS / limited |
| Gateway HTTP 200 \`custom-openai-public-probe\` + guest \`gateway-ok\` | Matched Cloudflare log and guest CLI | M1 PASS / FAIL |
| OAuth/Gateway token absent from guest | Non-secret presence verification, mounts/env audits | Mandatory / STOP |
| Upstream billing attribution | Independent authoritative billing evidence, if available | VERIFIED or NOT_VERIFIED; do not infer $0 |

## Owner checkpoint and handoff

- **Current status:** PLAN WRITTEN / IMPLEMENTATION NOT AUTHORIZED.
- **Execution preference (recommended):** Native / same-context task execution with test-first commits, one bounded validation at the end. Do not require independent reviewer after every task or an automatic whole-branch review loop.
- **Owner must expressly authorize:** code implementation scope, creation of one disposable Sandbox, sandbox-specific policy changes, storage of Broker credentials, a bounded live model call, cleanup, and whether to create a PR. These are not implied by design or plan approval.
- **No cloud or persistent external writes** beyond the explicitly approved GitHub documentation for this plan have been performed. Do not start Task 1 merely because this plan has been committed.
- **Stop condition:** when Task 5 reports M1/M2 (including LIMITED/NOT_VERIFIED), return control to the Owner. No auto-merge, additional agent, new Finding correction chain, or systemd deployment.

## References

- Adopted design: \`docs/superpowers/specs/2026-11-16-oc2-sandbox-subscription-host-broker-design.md\`.
- OpenCode v2.2.5 provider and session plugin contracts:
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/provider.ts
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/model.ts
- Docker sandbox host access and policy:
  https://docs.docker.com/ai/sandboxes/workflows/development/
  https://docs.docker.com/ai/governance/local/network-rules/
  https://docs.docker.com/ai/sandboxes/release-notes/
- Cloudflare Logpush:
  https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/

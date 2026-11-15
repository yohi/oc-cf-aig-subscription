# OC2 Sandbox Subscription Gateway — Host Broker Design R0.1

- **Status:** PROPOSED / OWNER DESIGN APPROVAL PENDING
- **Date:** 2026-11-16 (JST)
- **Repository:** `yohi/oc-cf-aig-subscription`
- **Baseline:** `feature/subscription-gateway-host-mvp-20261114` @ `05fdf258134e5e9af0d2c01d5fec0529a1b2681b`
- **Owner decision already made:** Approach A, a lightweight dedicated Host-side Broker with a separate guest integration. This document does **not** authorize implementation, systemd changes, network policy edits, Docker operations, PR creation, or merging.

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

- Separate runtime mode (e.g. `OC_CF_AIG_MODE=guest`); never reuse `OC_CF_AIG_HOST_ONLY=1` in the guest.
- Register an isolated custom provider/model definition exposing only models approved by the Broker. Initial allowlist: `gpt-6-luna`; no automatic provider discovery or BYOK fallback.
- OpenAI Responses-compatible HTTP transport with `POST /v1/responses`, SSE passthrough, abort propagation, and later function-tool traffic. Requests go only to a configured `http://host.docker.internal:<port>/v1` endpoint through the Docker policy proxy.
- Hold only a **short-lived, per-test, least-privilege guest capability** in sandbox memory. It is not an OAuth or Cloudflare token; however it remains theft/replay-capable until expiry and must never be represented as inherently secret from the guest.
- Fail before model dispatch if the Broker URL/capability is missing, or if the provider/transport cannot be pinned. If a plugin is absent, plugin hooks cannot enforce policy; require independently verified sandbox egress deny rules and a startup admission check.

### 5.2 Dedicated Host Broker

- Lightweight independent **Node.js 22+** process using existing repository conventions; separate service from Host OpenCode's agent/runtime. For the disposable PoC run in foreground; **systemd socket activation is deferred**, not assumed.
- Bind only to `127.0.0.1:<configured-port>`. Confirm on the pinned Docker version that the sandbox proxy translates `host.docker.internal` correctly to the loopback service. Do not bind to `0.0.0.0`, LAN, or public Cloudflare routes.
- Routes: `GET /health` (minimal status, no credentials), `GET /v1/models` (Broker allowlist only), `POST /v1/responses` (sole inference route). Reject every other path, HTTP method, provider or upstream URL.
- Validate guest capability, expiry, sandbox/test identity binding to the extent *actually supported* by the host transport, maximum body size, request rate/concurrency, model allowlist, and payload compatibility. Explicitly reject unknown server-side tool types, unauthorized models and arbitrary URLs. Do not trust origin or source IP alone, as the Docker network proxy may hide the guest address.
- First milestone: text-only Responses with SSE; end-to-end milestone: guest-owned function tool round trip. The Broker must never execute shell commands or OpenCode Agent tools.
- Construct upstream URL `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/custom-openai-public-probe/v1/responses` from validated host configuration, using **native SIWC access token** in `Authorization`, and host `CF_AIG_TOKEN` in `cf-aig-authorization`.
- Always set `cf-aig-no-wholesale: true`, `cf-aig-collect-log-payload: false`, `cf-aig-skip-cache: true`. For privacy, the Cloudflare Gateway's **Logpush must be disabled** where externally stored request/response payloads are prohibited; the header does not disable Logpush.
- Strip upstream authorization, cookies, and internal headers from outbound responses to the guest. No request/response body or credential logging. Emit only safe status, route, model, time, count, and a correlation ID.

### 5.3 Host SIWC credential source

- Use **official SIWC token-sharing** scope `chatgpt.tokens.use.direct`, separate from legacy Codex OAuth and OpenAI API-key billing; refresh only on host and fail closed if renewal is unsuccessful.
- **Proposed design call:** Independent host-only credential store owned by the Broker (mode `0600`, parent directory `0700`) and local browser login via SSH-port-forwarded OAuth callback. Avoid reading OpenCode's internal credential database or copying its token files; such an internal coupling is unstable.
- The previously successful standalone SIWC Python PoC is evidence that sign-in and Responses work, **not** evidence that a Node implementation has working credential renewal. Credential lifecycle behavior must be explicitly tested during implementation.
- No token may be written to Git, Docker image, Sandbox mounts, logs, shell history or the guest. Refresh failure is a service-unavailable condition, **never a signal to use a BYOK API key**.
- Do not claim subscription-billing attribution is proven by a Cloudflare `$ -` line; reconcile only if independent billing evidence is available.

### 5.4 Claude Pro

Claude Agent Provider has previously traversed Cloudflare AI Gateway from a host CLI, but it has a different authentication/protocol path from SIWC. **Claude is not implemented by the first ChatGPT-only Broker milestone.** Its Host-side adapter will require a separate explicit feasibility decision, without allowing Claude tools to execute on host. Do not reuse an unverified Anthropic OAuth bearer in a generic API proxy.

## 6. Security and policy contract

1. **Guest secrets:** real OpenAI access/refresh tokens, Cloudflare token, credentials DB, socket to the host OpenCode server, and SSH agent must not be mounted or forwarded to guest.
2. **Least-privilege capability:** scoped to one disposable Sandbox/test, exact allowlisted model and route, short expiry, request/concurrency budgets. Revocable on host without editing guest. The guest can read its capability: it is a *limited authorization*, not a confidentiality mechanism.
3. **Network:** per-sandbox permission only for `localhost:<broker-port>` (addressed by guest as `host.docker.internal:<broker-port>`); explicitly deny direct model hosts including `api.openai.com`, `chatgpt.com`, `gateway.ai.cloudflare.com`, and `api.anthropic.com` for this disposable test. Validate actual policy behavior, direct IP and alternative route attempts instead of assuming deny rules are sufficient.
4. **No privilege escalation:** Broker supports inference, not arbitrary HTTP tunneling, files, tools, commands, admin endpoints, arbitrary header proxying or a general OpenCode server.
5. **Failure behavior:** any missing plugin, invalid/expired guest capability, invalid Host credentials, unsupported transport, nonallowlisted model/path, denied network, unavailable Broker, upstream 401/403/429/5xx, or loss of SSE stream -> explicit failure; no alternate provider or paid API route.
6. **Cleanup:** terminate foreground Broker, revoke guest capability, remove only explicitly created disposable test Sandbox. Never reset/remove existing OC2 Sandbox, change global network policy, overwrite OAuth files, or modify daily OpenCode settings.

## 7. External HTTP interface (proposed)

- Base: `http://host.docker.internal:<configured-port>/v1`, accessible **only via the Docker policy-approved sandbox-to-host path**.
- `GET /health`: no leaked version strings, key presence or token state; readiness only.
- `GET /v1/models`: allowlisted public model names, ideally requiring guest capability.
- `POST /v1/responses`: compatible shape with the guest SDK; whitelist model `gpt-6-luna` for initial acceptance. Accept text prompt; support SSE response framing and cancellation. Add function-tool messages only when Guest SDK wire format is verified.
- Guest presents `Authorization: Bearer <guest-capability>`; Broker replaces it with the Host's SIWC bearer upstream. Guest cannot select upstream target, provider or Cloudflare headers.
- Error responses: 400 invalid request, 401/403 invalid capability/policy, 404 unknown path, 413 too large, 429 usage limit, 502/503 upstream/auth service unavailable. Never return credential-related stack traces.
- Timeouts, budgets and numeric request limits belong to config (not hardcoded secrets). Reject missing limits rather than silently accepting unlimited usage.

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

**Done for this brainstorming/design task:** owner reviews this R0.1, accepts or requests bounded changes. Do not begin implementation or independently open PR/merge. No automatic reviewer/fix loop.

## 10. Sources and assumptions

- OpenCode v2.2.5 plugin `ctx.session.hook("model.request")`, `http.request`, and `ctx.provider.transform`:
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts
  https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/provider.ts
- Current Host-only plugin: `src/gateway.mjs`, baseline HEAD above.
- Docker sandbox host services: https://docs.docker.com/ai/sandboxes/workflows/development/
- Docker sandbox isolation and network policy: https://docs.docker.com/ai/sandboxes/security/isolation/ and https://docs.docker.com/ai/governance/local/network-rules/
- Docker Sandbox credential proxy alternatives: https://docs.docker.com/ai/sandboxes/configuration/credentials/
- Cloudflare Logpush: https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/

Docker documentation currently describes capabilities that may postdate pinned v0.51.0. Treat any version-specific CLI behavior and the Broker transport as **NOT VERIFIED** until read-only inspection and bounded disposable-host-path test.

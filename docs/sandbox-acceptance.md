# Sandbox Acceptance Evidence

Pinned targets: Docker Sandboxes CLI `v0.51.0`, OpenCode `v2.2.5`, Node.js `>=22`.

## Task 1: Host connection feasibility

| Step | Result | Notes |
| --- | --- | --- |
| 1-4 Local loopback probe (`scripts/probe-host-path.mjs`, `test/broker/host-path.test.mjs`) | PASS | RED observed (module missing), then GREEN. `GET /health` returns 200 `{"ok":true}`; other paths return 404. Offline, no credentials. |
| 5 Effective policy read-back (no mutation) | BLOCKED on the existing daemon (inherits 197 global allows); resolved by an independent daemon | Read-only observation done; see "Task 1 Step 5 observations" below. |
| 6 Disposable Sandbox `oc2-aig-probe` and sandbox-scoped deny-by-default egress with exception for `host.docker.internal:49187` | **PASS** (independent daemon, see Steps 6-7 below) | Guest observed HTTP 200 `{"ok":true}`. |
| 7 Independent egress denial matrix | **PASS with NOT_VERIFIED items** | See matrix below. |

### Task 1 Step 5 observations (read-only; no mutation)

- `sbx --version` reports **v0.53.0**; the plan pins **v0.51.0** and says to abort rather than silently change the host. Result: version pin mismatch (BLOCKED pending Owner decision on accepting v0.53.0).
- `sbx policy` subcommands present: allow, approval, check, deny, init, inspect, log, ls, profile, refresh, reset, rm. Syntax of `allow/deny network` for sandbox scope was **not** exercised (not guessed).
- Effective policy (`sbx policy ls`): a global `local-policy` (applies to all sandboxes) holds 195 network allow rules, including model hosts (`**.openai.com:443`, `**.chatgpt.com:443`, `api.anthropic.com:443`, `generativelanguage.googleapis.com:443`) plus package registries; fallback is `default-deny-all`. Per-sandbox `kit` and `local` rules exist for existing sandboxes only.
- Documented precedence: deny beats allow across scopes, and a sandbox-scoped deny can coexist with a global allow. Isolation of a new Sandbox would therefore require sandbox-scoped deny rules enumerating every inherited global allow, which defeats a deny-by-default design and would also take precedence over a Broker exception for any overlapping host. Per-Sandbox containment without changing global policy is **not demonstrated** (NOT_VERIFIED); inherited global allows are a plan STOP condition.
- Existing Sandboxes (listed by `sbx ls`, all stopped) and `oc2-aig-probe` absence: `sbx ls` shows no `oc2-aig-probe` (grep count 0). No Sandbox was created, modified or removed; no policy rule was added, changed or removed; Host probe on port 49187 was not started.
- Not attempted: policy log correlation, Guest-side denial measurements, cleanup (nothing to clean up).


Gate status: Steps 6-7 were run on an **independent** sandboxd (see the run section below):
Host reachability and the egress denial matrix were observed (PASS with the listed NOT_VERIFIED
items). This does not apply to the existing daemon, which inherits 197 global allows. Live
inference, Task 3 live smoke and Task 5 M1/M2 remain NOT_RUN and need separate Owner approval.

### Task 1 Steps 6-7: independent sandboxd run (Owner-approved, v0.53.0)

Environment: a second `sbx` daemon (`--policy deny-all`) under a throwaway HOME on tmpfs (0700), with `HOME`, `DOCKER_CONFIG`, `XDG_*` isolated and D-Bus env unset; started via `sg kvm`. The Docker sign-in was done once by the Owner in that HOME (the CLI reported "no keychain detected": credentials were stored on disk inside the throwaway HOME only). The Sandbox `oc2-aig-probe` (agent `shell`, 2g) existed only in this daemon; the existing daemon never listed it. Existing daemon/policy/Sandbox list/Docker resources were identical before and after (hash comparison).

Independent policy (observed): `policy ls` = `default-deny-all` + filesystem-only `local-policy`; no inherited network allows; `sbx ls` empty before creation. Sandbox-scoped rule added with `sbx policy allow network --sandbox oc2-aig-probe localhost:49187` (`host.docker.internal` is evaluated as `localhost`); read back as one sandbox-scoped active allow, plus `default-deny-all` fallback.

Step 6 (Host probe `scripts/probe-host-path.mjs`, 127.0.0.1:49187):

| Check | Result | Evidence |
| --- | --- | --- |
| Guest `GET http://host.docker.internal:49187/health` before allow | 403 (denied) | Guest curl |
| Same after the sandbox-scoped allow | **200 `{"ok":true}`** | Guest curl, also `--noproxy` and CONNECT paths; policy log ALLOWED `localhost:49187` (forward, transparent, forward-bypass) |
| Host ports 49188, 22, 8080 via Guest | 403 | Guest curl; policy log BLOCKED |

Step 7 (all from inside the Guest; the policy log of the independent daemon was cross-checked):

| Target | Observed | Log |
| --- | --- | --- |
| `api.openai.com`, `api.anthropic.com`, `example.com` (HTTP/HTTPS via proxy env) | 403 | BLOCKED (forward) |
| IPv4 1.1.1.1, 8.8.8.8, DNS-resolved 172.66.0.243 (direct, no proxy, `--resolve`) | no data / TLS EOF | BLOCKED (transparent) |
| IPv6 `2606:4700:4700::1111` | 403 via proxy; TLS EOF direct | BLOCKED |
| Private 10.0.0.1, Host LAN IP 192.168.1.102 (ports 80, 22, 49187), gateway 172.17.0.0 (22, 49187) | no data | BLOCKED |
| Host name resolution of `api.openai.com`, `getent`/`dig` | fails | BLOCKED by `<dns proxy policy>` |
| UDP (1.1.1.1:53/443, 8.8.8.8:123) | no reply | `<udp proxy policy>` for DNS; others no reply |
| Explicit HTTP CONNECT through the gateway proxy to non-allowed targets | proxy answers `200` to the CONNECT line, then `403 Forbidden` for any payload (no tunnel) | BLOCKED (forward) |
| CONNECT to `localhost:49187` | tunnel established (allowed) | ALLOWED |
| Other proxy/SOCKS ports on the gateway (1080, 8080, 8888, 9050, 2375) | no data | n/a |

Interpretation notes:
- A raw TCP `connect()` from the Guest succeeds to any address because a transparent proxy accepts the handshake; this is **not** egress. Policy was judged by data actually returned and by the proxy log, not by `connect()` success. DNS failure or timeouts alone were not counted as denial; the log entries were.
- The proxy answers `HTTP/1.1 200 OK` to CONNECT for denied targets and only then returns 403 on the first payload. A client that stops at the CONNECT status could misread this.

Not verified: HTTPS to non-allowed hosts using other SNI tricks, non-TCP/UDP protocols (ICMP is documented as always blocked), Host-LAN services other than those tried, behaviour for other agent kits, and persistence across daemon restart. The Task 1 egress finding is for the independent-daemon configuration only; the existing daemon (197 global allows) is **not** isolated.

Cleanup: `sbx rm` was refused without `--force` and was not forced; the Sandbox was terminated when the dedicated daemon (PID verified against pid file and command line) was stopped, and its state was deleted with the throwaway HOME. The Host probe was stopped (PID/command verified). No `sbx logout`/`reset` was run. The Docker session issued in the throwaway HOME may still be valid server-side until the Owner revokes it.

Task 1 STOP gate (offline + this run): **PASS for the independent-daemon deny-by-default configuration with the single `localhost:49187` exception**, subject to the Not-verified list above and Owner acceptance.

## Task 3: Host-only SIWC (offline, mocked endpoints)

All OAuth/JWKS/token endpoints are mocked; no real credential or network was used.

| Item | Status |
| --- | --- |
| SIWC lifecycle, credential store, refresh, lock (mocked) | PASS (offline) |
| Live Host-only SIWC smoke (one Responses request) | NOT_RUN (no Owner gate) |
| JWKS URL (`https://auth.openai.com/.well-known/jwks.json`) in `src/broker/siwc.mjs` | NOT_VERIFIED (assumed) |
| Callback query parameter name `client_id` for the issued client ID | NOT_VERIFIED (assumed; wrong value fails closed at login) |
| `earliest_refresh_at` unit (treated as epoch seconds) | NOT_VERIFIED (a wrong unit could block refresh until re-login) |
| Reauth `--id-token-hint` URL printed to a TTY on stderr (explicit opt-in) | Residual exposure, accepted only by Owner decision |
| Upstream billing attribution ($0) | NOT_VERIFIED |

## Task 4: Guest OpenCode provider and guest-only tool execution

Offline only: no Sandbox, no real credentials, no live inference, no real Broker network.
Task 4 evidence is offline-only and does **not** satisfy the Task 1 STOP gate: Host-to-Guest
reachability and egress denial remain unverified. Tasks 2-4 were implemented offline under the
Owner-delegated scope, and no live or Sandbox step may advance until Task 1 Steps 5-7 are recorded.
Installed pinned packages: `@opencode/ai@2.2.5` and `@opencode/plugin@2.2.5` (exact). OpenCode
Core v2.2.5 (the `opencode` process) is **not** in scope, so Core behaviour is emulated by a test
double (`test/guest/harness.mjs`).

| Step | Result | Notes |
| --- | --- | --- |
| 1 / 1c Loader, provider, mode isolation, allowlist (`test/guest/provider.test.mjs`) | PASS | RED (module missing) then GREEN. Real `Host.resolve`/`Host.load` load the `src/guest` directory; `Provider.Info`/`Model.Info` decode with the real v2.2.5 schema. Plugin ctx is a test double. Missing/invalid mode, URL or capability makes plugin setup throw (Guest initialization STOP). |
| 1b Model-over-provider compatibility merge | NOT_VERIFIED (Core) | `Model.Info.compatibility.supportsPromptCacheKey` is literal `false` and decodes with the real schema. The merge test is a self-built spread, not Core's model-resolver, so the effective merge is unverified. The SDK-side effect of the merged value is covered in 5b. |
| 2-4 RED/GREEN | PASS | `node --test test/guest/provider.test.mjs`. |
| 5 M1-D / M1-E / M2-C (`test/guest/sdk-m1.test.mjs`, `test/guest/sdk-m2.test.mjs`) | PASS (SDK + Broker) / Core NOT_VERIFIED | Real `@opencode/ai/providers/openai/responses` serialization into the real Broker (capabilities, parser, server) with a scripted fake upstream. M1 and M2 run in separate node test processes. Core steps (context map to SDK tools, `model.request`/`http.request` dispatch, `SessionModelRequest` identity dispatch, compatibility merge, provider settings handling) are emulated. |
| 5b F-001 wire | PASS (SDK + Broker) / Core NOT_VERIFIED | `supportsPromptCacheKey:false` omits `prompt_cache_key` even with a nonempty `promptCacheKey`. Control without the flag emits it and the Broker returns 400 with no upstream call. Native flat `read_file` serializes with literal `strict:false`; the Broker keeps `strict:false` in `guest/read_file`. `strict:true`, omitted, null and unknown fields are rejected with 400. |
| 5c PR2-F-002 round trip | PASS (SDK + Broker) / Core NOT_VERIFIED | Native SSE `name:"read_file",namespace:"guest"` is decoded by the SDK, dispatched by definition identity to Guest `guest_read_file` only, and replayed with the exact `call_id`, arguments, output, reasoning `encrypted_content` and order. History without `namespace` is projected to `guest` upstream. Unknown, dotted and foreign-namespace calls do not execute; a mismatched `call_id` returns 400 before upstream. Dispatch is the `createFakeCore().dispatch` test double in `test/guest/harness.mjs`, not Core. |
| 5d Tool-isolation regression | PASS (SDK + Broker) / Core NOT_VERIFIED | Injected `bash`, `read`, `edit`, `write`, `execute` and an extra tool never reach the serialized body. M1 omits `tools`; M2 sends only `read_file`. Other providers' context maps stay unchanged, and their requests are refused (no fallback). The context map and hook dispatch come from the `test/guest/harness.mjs` test double. |
| Launcher `bin/guest-launch.mjs` (`test/guest/guest-launch.test.mjs`) | PASS (fake `opencode`) | Capability is accepted only over a stdin pipe or an inherited `--capability-fd`. Regular files and arguments are refused. The capability is set only in the child env and is never logged. The version check runs before the capability is read. The real `opencode --version` output format and the `sbx exec` v0.51.0 non-logging handoff are NOT_VERIFIED. |
| Live Guest inference | NOT_RUN | Requires separate Owner gates (Task 5). |

Load-bearing Core assumptions (NOT_VERIFIED):

- A throwing `model.request`/`http.request` hook aborts that request, and hooks registered
  without `providerID` run for every provider. The no-fallback guard and the defense-in-depth
  refusal hooks rely on this.
- Whether Core keeps refusal hooks after a plugin setup throws is unknown; the STOP itself relies
  on Core treating a throwing Guest plugin setup as a startup failure.
- Native OpenAI credential storage inside the Guest image (for example an OpenCode `auth.json`) is
  unchecked. The Guest plugin never reads it, but its absence must be verified in Task 5.

Interface change: `registerGuestProvider(ctx, {brokerURL, capability})` was extended to
`registerGuestProvider(ctx, {brokerURL, capability, mode, fixtureRoot})`. `mode` (`m1`/`m2`) is
required; `fixtureRoot` is used only in `m2`. `setupGuest(ctx, env)` reads them from
`OC_CF_AIG_ACCEPTANCE_MODE` and `OC_CF_AIG_GUEST_FIXTURE_ROOT`.

## Task 5: Bounded live acceptance (offline scope only)

| Step | Claim | Result |
| --- | --- | --- |
| 1 | `npm test && npm run check` on the implementation branch | PASS (offline, 269 tests) |
| 1 | Branch diff contains no credential files, tokens or host-specific paths | PASS (grep check) |
| 2 | Disposable Sandbox effective egress policy readback | NOT_RUN (needs Owner approval for Sandbox + sandbox-scoped policy; Task 1 Steps 5-7) |
| 3 | Foreground Host Broker with issued capability and Guest handoff in a Sandbox | NOT_RUN |
| 4 | M1 live: one Guest text inference (`gateway-ok`) | NOT_RUN (no per-gate Owner approval) |
| 5 | Negative contract tests (revoked/expired/quota/abort/SSE failure/header injection) | PASS against synthetic fixtures (Task 2 tests); Guest-side egress-bypass denial NOT_RUN |
| 6 | M2 live: Guest function-tool scenario | NOT_RUN (no per-gate Owner approval; separate-process launcher handoff on sbx v0.51.0 not verified) |
| 7 | Cleanup of Sandbox/rules | NOT_RUN (nothing created) |
| - | Task 3 Host-only SIWC live smoke | NOT_RUN |
| - | Upstream billing attribution ($0) | NOT_VERIFIED |
| - | M1 live PASS / M2 live PASS | NOT_RUN / NOT_RUN |

All of the above `NOT_RUN` items require the Owner's separate, explicit approval (including live-call ceilings) before they can be executed. No live inference, Sandbox creation or policy change was performed.

## Real OpenCode Core v2.2.5 offline integration (independent sandboxd, Owner-approved)

Setup: independent sandboxd (`deny-all`) on a throwaway tmpfs HOME as in the Steps 6-7 run; the Core was obtained **offline** from the existing local image `oc-cf-aig-subscription-poc:2.2.5` (`docker save` -> `sbx template load` -> `sbx create shell -t ... --pull never`), no external download. Guest: Alpine, `opencode v2.2.5` (musl build), Node. Sandbox-scoped allow `localhost:49187` only. Host side: a throwaway test Broker (real capability store, real `parseBrokerRequest`, real server) with a scripted FAKE upstream; no SIWC/Cloudflare credential, no external request. Capability handed over through a named pipe -> `sbx exec -i` stdin -> `guest-launch.mjs`; nothing in argv, files or logs (grep of captured output: 0 hits).

| Item | Result | Evidence |
| --- | --- | --- |
| OpenCode Core v2.2.5 starts in the Guest | **PASS** | `cli starting version=2.2.5` |
| Guest Plugin load (directory loader) | **PASS** | `loading plugin id=/opt/oc2/src/guest entrypoint=file:///opt/oc2/src/guest/index.js` |
| Provider/Model registration | **PASS** (events) | `provider.updated`, `model.updated` observed; request issued for `oc-cf-aig/gpt-6-luna` |
| Core hooks fire (context / model.request / http.request) | **NOT_VERIFIED** | The request was issued and reached the Broker, but hook dispatch was not directly observed; M1 stopped before tool/hook assertions. |
| M1 offline response (`gateway-ok`) | **FAIL** | Real Core sent `POST /v1/responses` with keys `model, input, instructions, stream, store, include, text`; the real Broker parser rejected it (`400 invalid_request`, Core error `request: unsupported field text`). `tools` absent, no `prompt_cache_key`, no `max_output_tokens`, `store:false`, `stream:true`, `include:["reasoning.encrypted_content"]` as designed. Upstream was never called. The value of `text` was not captured (SDK typing suggests a `verbosity` option; unconfirmed). |
| M2 Guest tool round trip | **NOT_RUN** | Same serialization path would hit the same rejection; stopped per the Owner's STOP rule. |
| Host tool execution | **NOT_VERIFIED** | Not reached (no tool call was made). |
| Guest credential non-possession | **PASS for SIWC/Cloudflare/OpenAI** | No `auth.json`, no CF/OpenAI/Anthropic env names. Guest env has a sandbox-injected `GH_TOKEN` (40 chars, GitHub-token-shaped, matches a sentinel pattern; the independent daemon stores no secrets). Whether it is a placeholder was judged by pattern only: NOT_VERIFIED. |
| Egress other than the Broker | **BLOCKED (not bypassed)** | Core tried `models.opencode.ai:443` (models list); denied by the sandbox policy (logged BLOCKED, Core logged a 403 and continued). Only `localhost:49187` appears under ALLOWED. |
| Cleanup | **PASS** | Sandbox removed (`rm --force` on the named sandbox in the independent daemon), test Broker stopped, independent daemon stopped (PID/command verified), throwaway HOME and tmpfs files deleted; existing daemon/policy (197 allows)/Sandbox list/Docker resources/auth metadata identical to the baseline. |

Defects/findings (no source change was made):
1. **`bin/guest-launch.mjs` version check fails against the real Core**: `opencode --version` prints `opencode v2.2.5` but the launcher expects exactly `v2.2.5`. For this run a Guest-side shim (`--version` -> `v2.2.5`, otherwise exec the real binary) was used. Needs a source fix.
2. **Real Core emits a `text` request field that the Broker policy rejects.** Either the Guest must suppress it (e.g. a context/option hook, if Core exposes one) or the Broker policy must admit an exact, validated `text` shape. This was previously invisible because the offline harness used the SDK without Core's defaults.
3. Core's `opencode run` needs `--standalone` here and tries `models.opencode.ai`; the deny policy blocks it and Core tolerates the failure.

Not tested: M2, hook-refusal behaviour (bad mode/provider) on the real Core, `session.context` tool restriction, history replay. Task 3/5 live inference remains NOT_RUN.

## Real OpenCode Core v2.2.5 offline re-verification after limited corrections

Same independent-sandboxd setup as above (throwaway tmpfs HOME, `deny-all`, sandbox-scoped `localhost:49187`, Core from the local image, real Broker validation logic + scripted fake upstream, no live inference, no external requests; capability via named pipe -> `sbx exec -i` stdin -> `guest-launch.mjs`, 0 hits in captured output).

Phase 1, shape of the Core-sent `text` (diagnostic, non-secret): `text = {"verbosity": "low"}` - an object with exactly one key `verbosity` whose value is a short lowercase string. No null, array, nested object or other keys. Request keys: `model, input, instructions, stream, store, include, text` (+ `tools` in M2).

Corrections (source, tests kept locally, not committed):
- `src/broker/policy.mjs` / `src/broker/upstream.mjs`: `text` is admitted only as `{verbosity: "low"|"medium"|"high"}` (Responses `text.verbosity` enum); `text.format`, extra keys, wrong types, null, arrays, empty objects are 400; upstream receives a freshly built `{verbosity}`. `prompt_cache_key`, `max_output_tokens` etc. remain rejected. Whether the SIWC upstream accepts `text.verbosity` is NOT_VERIFIED (fake upstream only).
- `bin/guest-launch.mjs`: version output accepted only as `2.2.5`, `v2.2.5` or `opencode v2.2.5` (surrounding whitespace trimmed); everything else (extra lines, other versions, `opencode 2.2.5`, other case/spacing) is rejected. No shim was used in the re-run.
- Regression tests added/updated (broker text accept/reject matrix, M1 native SDK body + Core text, launcher versions). `npm test`: 284 pass, 0 fail; `npm run check` passes.

| Item | Result | Evidence |
| --- | --- | --- |
| Core starts, Guest Plugin loads from the directory, no shim | PASS | `cli starting version=2.2.5`; launcher accepted real `opencode --version` |
| `text` shape confirmed | PASS | see above |
| GH_TOKEN safety | PASS (inferential) | Guest `GH_TOKEN` differs from the Host (the Host variable is unset in the agent shell), contains a sentinel-style marker, and the independent daemon stores no secrets (`secret ls`: none), so the proxy has nothing to substitute; no `auth.json`, no CF/OpenAI/Anthropic variables. Source of injection by sbx is inferred, not proven. |
| Real Core M1 (`gateway-ok`) | **PASS** | Broker accepted (no `tools`, no `prompt_cache_key`, no `max_output_tokens`, `store:false`, `stream:true`, `include` as designed); fake upstream called once; Core printed `gateway-ok`, exit 0, SSE completed. |
| Core hook effect | PASS (observed effect) | With the default `build` agent the request still had no tools (context hook emptied the map), and Core-resolved model produced no `prompt_cache_key` / `max_output_tokens`. The hook invocation itself was not traced. |
| Real Core M2 | **PASS** | Core published only `read_file` with `strict:false` (no bash/read/edit/write/execute); Broker projected it to `guest/read_file`; Core executed it in the Guest (output hash equals the Guest fixture; the fixture path does not exist on the Host); second request replayed `reasoning`, `function_call` (`call_id` call_core1, namespace restored to `guest`) and `function_call_output` with the same `call_id`; Core printed the final text and exited 0. |
| Unknown tool call from upstream (`bash`) | Not executed | Core: `Tool is not available for this request`; Broker 400 on replaying such history; no file written in the Guest. |
| Host tool execution | PASS (none observed) | Fixture exists only in the Guest; no Host process involvement. |
| Egress isolation | PASS (no bypass) | Policy log: ALLOWED only `localhost:49187`; BLOCKED `models.opencode.ai:443` (Core's model-list fetch, tolerated). |
| Cleanup | PASS | Sandbox (forced removal of the named sandbox in the independent daemon), test Broker, daemon (PID/command verified), throwaway HOME and tmpfs files removed; existing daemon, policy (197 allows), Sandbox list, Docker resources and `~/.docker` metadata identical to the baseline. |

Incident: during this run the Owner's first `sbx login` used a stale path file, so the env was not sourced and the command ran against the **existing** HOME ("You are signed in"). The existing auth store file under `~/.config/com.docker.sandboxes/com.docker.sandboxes-auth/` was rewritten at that moment (login re-save or routine refresh; not distinguishable). The existing session kept working and no existing policy/daemon/Sandbox changed.

Remaining: hook refusal behaviour (bad mode/provider) on real Core and compaction/title requests were not exercised; `text.verbosity` acceptance by the real SIWC endpoint, live inference and Task 3/5 live gates remain NOT_RUN.

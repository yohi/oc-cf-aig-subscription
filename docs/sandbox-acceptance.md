# Sandbox Acceptance Evidence

Pinned targets: Docker Sandboxes CLI `v0.51.0`, OpenCode `v2.2.5`, Node.js `>=22`.

## Task 1: Host connection feasibility

| Step | Result | Notes |
| --- | --- | --- |
| 1-4 Local loopback probe (`scripts/probe-host-path.mjs`, `test/broker/host-path.test.mjs`) | PASS | RED observed (module missing), then GREEN. `GET /health` returns 200 `{"ok":true}`; other paths return 404. Offline, no credentials. |
| 5 Effective policy read-back (no mutation) | NOT_RUN | Requires Owner approval. |
| 6 Disposable Sandbox `oc2-aig-probe` and sandbox-scoped deny-by-default egress with exception for `host.docker.internal:49187` | NOT_RUN | Requires Owner approval for a disposable Sandbox and sandbox-scoped policy. |
| 7 Independent egress denial matrix | NOT_RUN | Depends on step 6. |

Gate status: Task 1 STOP gate is **not yet satisfied**. Host-to-Guest reachability and network
denial are unverified; do not advance Tasks 2-5 until Steps 5-7 are run and recorded.

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

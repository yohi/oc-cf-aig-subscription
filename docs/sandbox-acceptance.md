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
Installed pinned packages: `@opencode/ai@2.2.5` and `@opencode/plugin@2.2.5` (exact). OpenCode
Core v2.2.5 (the `opencode` process) is **not** in scope, so Core behaviour is emulated by a test
double (`test/guest/harness.mjs`).

| Step | Result | Notes |
| --- | --- | --- |
| 1 / 1b / 1c Loader, provider, mode isolation, allowlist (`test/guest/provider.test.mjs`) | PASS | RED (module missing) then GREEN. Real `Host.resolve`/`Host.load` load the `src/guest` directory; `Provider.Info`/`Model.Info` decode with the real v2.2.5 schema. Plugin ctx is a test double. |
| 2-4 RED/GREEN | PASS | `node --test test/guest/provider.test.mjs`. |
| 5 M1-D / M1-E / M2-C (`test/guest/sdk-m1.test.mjs`, `test/guest/sdk-m2.test.mjs`) | PASS (SDK + Broker) / Core NOT_VERIFIED | Real `@opencode/ai/providers/openai/responses` serialization into the real Broker (capabilities, parser, server) with a scripted fake upstream. M1 and M2 run in separate node test processes. Core steps (context map to SDK tools, `model.request`/`http.request` dispatch, `SessionModelRequest` identity dispatch, compatibility merge, provider settings handling) are emulated. |
| 5b F-001 wire | PASS (SDK + Broker) / Core NOT_VERIFIED | `supportsPromptCacheKey:false` omits `prompt_cache_key` even with a nonempty `promptCacheKey`. Control without the flag emits it and the Broker returns 400 with no upstream call. Native flat `read_file` serializes with literal `strict:false`; the Broker keeps `strict:false` in `guest/read_file`. `strict:true`, omitted, null and unknown fields are rejected with 400. |
| 5c PR2-F-002 round trip | PASS (SDK + Broker) / Core NOT_VERIFIED | Native SSE `name:"read_file",namespace:"guest"` is decoded by the SDK, dispatched by definition identity to Guest `guest_read_file` only, and replayed with the exact `call_id`, arguments, output, reasoning `encrypted_content` and order. History without `namespace` is projected to `guest` upstream. Unknown, dotted and foreign-namespace calls do not execute; a mismatched `call_id` returns 400 before upstream. |
| 5d Tool-isolation regression | PASS (SDK + Broker) / Core NOT_VERIFIED | Injected `bash`, `read`, `edit`, `write`, `execute` and an extra tool never reach the serialized body. M1 omits `tools`; M2 sends only `read_file`. Other providers' context maps stay unchanged, and their requests are refused (no fallback). |
| Launcher `bin/guest-launch.mjs` (`test/guest/guest-launch.test.mjs`) | PASS (fake `opencode`) | Capability is accepted only over a stdin pipe or an inherited `--capability-fd`. Regular files and arguments are refused. The capability is set only in the child env and is never logged. The version check runs before the capability is read. The real `opencode --version` output format and the `sbx exec` v0.51.0 non-logging handoff are NOT_VERIFIED. |
| Live Guest inference | NOT_RUN | Requires separate Owner gates (Task 5). |

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

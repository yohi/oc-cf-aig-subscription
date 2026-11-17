# OC2-T6 — Post-Merge Component Acceptance Design R0.1

- **Status:** DESIGN PROPOSED / DOCUMENT-ONLY
- **Date:** 2026-11-17 (JST)
- **Repository:** `yohi/oc-cf-aig-subscription`
- **Baseline:** `master` @ `9cc106b5b4a3443eadd04e80644991cc77d095b5` (merged PR #3)
- **Task candidate:** `OC2-T6-POSTMERGE-001`
- **Authority:** Human Owner confirmed the component responsibility boundary and authorized creation/commit/push of this design document only. Execution of T6 is not implicitly authorized.

## 1. Intent and component completion goal

Determine whether the **merged Host Broker component**, not the complete OpenCode development environment, is suitable for an Owner's **limited component-completion decision**.

The component's role is to route OpenCode Core v2.2.5 requests from a disposable, secret-free Guest to Host-held ChatGPT Plus SIWC credentials via Cloudflare AI Gateway. It must preserve strict Guest / Host isolation, bounded Broker capabilities, no Direct API/BYOK fallback, and Guest-local tool execution.

Existing Task 3 / Task 5 live evidence is reused rather than repeated. T6 is a single **offline integration check + evidence synthesis**. It is not permission to launch a Sandbox or begin Opt-in operation.

## 2. Responsibility boundary (Owner-confirmed)

**In scope for this repository:**

- Host-only SIWC credential handling and Cloudflare AI Gateway request forwarding.
- Host Broker authentication, allowlists, quotas, timeouts, SSE validation and fail-closed behavior.
- Minimum Guest OpenCode provider/launcher integration needed for the inference boundary.
- Narrow M1 no-tool and M2 Guest-local `read_file` contract, including native `call_id` history replay.

**Out of scope:**

- Installing/configuring Skills, general-purpose MCP servers, development-oriented OpenCode Plugins and agent workflows.
- Broad source-editing/Shell/tool permissions for daily software development.
- General OC2 runtime orchestration, unrestricted Sandbox provisioning and development environment distribution.
- Unrelated repositories, OpenCode Core changes, new OAuth flows or additional inference providers.

These belong to a separate higher-level OC2 environment/configuration project. This design does **not** start that project.

## 3. Approaches considered

| Approach | Trade-off | Decision |
| --- | --- | --- |
| **A. Reuse evidence + one fixed-HEAD offline integration check** | Minimum time and credential risk; cannot replace live SSE evidence | **Selected as design proposal** |
| B. Re-run M1/M2 live acceptance | Might produce new direct SSE evidence, but consumes quota and reopens OAuth/Sandbox risk | Rejected for T6 |
| C. Extend this repository to Skills/MCP/Plugin orchestration | Makes broader development workflows possible but violates component ownership | Rejected for T6 |

No additional review/repair cycle is mandatory merely because an unverified item remains.

## 4. Evidence baseline and uncertainty

| Item | Baseline | Evidence status |
| --- | --- | --- |
| PR #3 | Merged into `master` at `9cc106b5...` | GitHub verified |
| Earlier offline Core M1/M2 | Fake Upstream / Guest tool / history replay recorded in `docs/sandbox-acceptance.md` | Fixed-HEAD acceptance record; subsequent `303 PASS / 0 FAIL` is executor-reported |
| Host-only SIWC and Guest M1 live | PASS | USER/EXECUTOR_REPORTED; not to be repeated |
| Guest M2 live | Actual Guest `read_file` + same `call_id` replay + final Core output reported, two HTTP 200 POSTs | FUNCTIONAL_PASS_REPORTED / ACCEPTANCE_EVIDENCE_INCOMPLETE |
| M2 direct SSE capture | Orchestrator automatic verdict FAIL; no captured `namespace:"guest"`, `response.completed`, clean end | NOT_VERIFIED, not interpreted as functional failure |
| Isolated daemon / Guest egress | Deny-all, 0 global allow, 0 service secrets, sandbox-local Broker exception | Executor-reported for live run; existing daemon with 197 allows remains prohibited |
| `GH_TOKEN` proxy sentinel origin | Conditional exception under fixed negative gates | PARTIAL / NOT_VERIFIED |
| Cloudflare billing/usage attribution | No independent dashboard proof | NOT_VERIFIED |
| Master SonarCloud check | Success at merge commit | GitHub check; does not substitute for local integration tests |

The merged PR head had changes beyond an earlier evidence-fixed commit. T6 checks the **merged** contents, not an old branch snapshot.

## 5. Proposed T6 execution, only after separate Owner approval

**Preconditions:**
- Verify repository, `master` and exact baseline SHA; worktree must be clean.
- Do not fetch/reset/checkout over local work or modify Git state to force the baseline.
- Check Node/runtime prerequisites and installed dependencies read-only; if missing, report `BLOCKED` rather than install automatically.

**Single offline check:**
1. Run `npm test` **once** at the fixed code snapshot and record exit status and count.
2. Run `npm run check` **once** and record exit status.
3. Using existing tests/results only, summarize the Broker / SIWC / Guest provider / M2 tool contract.
4. Compare the outcome to the existing evidence matrix and explicitly separate observed PASS, reported PASS, FAIL, NOT_RUN and NOT_VERIFIED.
5. Report a component-level completion recommendation and stop at `OWNER_DECISION`.

No additional independent review, source correction, rerun, or automatically started follow-on task.

## 6. Deliverables and decision criteria

**Deliverables** (report in the task result; no extra artifact required):
1. Fixed-HEAD test receipt (`npm test`, `npm run check`, runtime, one attempt each).
2. Compact evidence matrix (directly observed vs executor-reported vs NOT_VERIFIED).
3. Owner completion recommendation with known limits and actionable blockers only.

**Possible outcomes:**

- `COMPONENT_ACCEPTANCE_READY`: fixed-HEAD checks pass, no new safety-relevant blocker observed; Owner can separately accept limited component completion.
- `NOT_READY`: a directly observed test/contract failure is relevant to the component goal; report exact failure and impact, no automatic fix.
- `BLOCKED`: environment, baseline or prerequisite prevents a valid check; report what was not run, do not mislabel as failure.

These outcomes are **not** an approval for daily use, live inference, release or production deployment.

## 7. Security, stop and authority

T6 **must not**:
- Modify source files, dependencies, package lock, configuration or existing documents.
- Commit, push, merge, create PRs, trigger CodeRabbit, or initiate an independent review.
- Start/change Docker Sandbox/daemon, network policy, OAuth login, credential store, refresh or live SIWC/Cloudflare inference.
- Re-run M1/M2 live, fix SSE recording as a default step, or begin Skills/MCP/Plugin implementation.

Stop on HEAD mismatch, dirty worktree, unsafe prerequisite, missing installed dependencies, relevant test failure, or completion of the one permitted offline verification. Report residual risks and Owner's remaining choices without escalating into iterative findings.

**Final checkpoint:** `OWNER_DECISION / STOP`.

**Separate future decision:** if the Owner accepts limited component completion, the higher-level OC2 development environment (Skills/MCP/development Plugins and runtime orchestration) may be considered in its **own** scope and authorization. Do not automatically initiate it.

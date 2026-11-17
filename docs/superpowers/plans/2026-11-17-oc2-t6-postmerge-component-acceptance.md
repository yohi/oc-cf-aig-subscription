# OC2-T6 Post-Merge Component Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Task-specific override:** This plan is **verification-only**, not software implementation. Do not start subagents, reviews, repairs, commits or additional tasks. Execute only after separate Human Owner approval. The steps below are a single bounded task and do not require TDD or new tests.

**Goal:** Produce an evidence-based Human Owner decision on limited completion of the merged OC2 Host Broker component at the exact post-merge `master` commit, without expanding scope or repeating live inference.

**Architecture:** Reuse the existing Host Broker, Guest Provider, fixed M1/M2 tool contract and earlier acceptance record. Verify the exact merged source snapshot once with the repository's existing offline tests and syntax checks; record observed evidence separately from reported or unverified live evidence, then stop for Owner judgment.

**Tech Stack:** Node.js `>=22`, npm, native Node test runner (`node --test`), `@opencode/ai@2.2.5`, `@opencode/plugin@2.2.5`, JavaScript ESM; Git read-only commands. No Sandbox or Cloudflare/OAuth access.

**Spec:** `docs/superpowers/specs/2026-11-17-oc2-t6-postmerge-component-acceptance-design.md` (PR #4; Design was created in commit `5cfbe7ccffc9ac454a5720012c83da18567d6c95`, **not** the current feature-branch HEAD).

**Owner state:** PR #4 is Draft; its Design R0.1 is `DESIGN PROPOSED`. Writing this plan neither adopts the design nor approves T6 execution, code changes, feature branch creation, PR modifications or merge.

## Global Constraints

- **Repository:** `yohi/oc-cf-aig-subscription`; **execution target:** `master` at `9cc106b5b4a3443eadd04e80644991cc77d095b5` (merged PR #3), not PR #4's documentation-only branch.
- **Preconditions:** Correct repository, exact HEAD, `master` checked out, clean worktree, Node.js `>=22`, npm and already installed pinned dependencies. If any are absent or cannot be confirmed, return `BLOCKED` without modifying the environment.
- **Allowed work:** Read-only preflight and inspection, a single `npm test`, a single `npm run check`, and an in-response evidence/decision report.
- **Prohibited:** Source/config/dependency edits, `npm install`/`npm ci`, checkout/fetch/reset/clean, Git writes, commit/push/PR, Sandbox/daemon/network-policy operations, OAuth/login/refresh, credential-store changes, real model inference, live M1/M2 retry, new tests or reviews, and Skills/MCP/development-Plugin orchestration.
- **Credential boundary:** Actual SIWC and Cloudflare secrets remain Host-only; no Direct API/BYOK fallback, no Host-side Guest tool execution. Do not reveal credential values in output.
- **Evidence integrity:** Distinguish `OBSERVED_PASS`, `REPORTED_PASS`, `FAIL`, `NOT_RUN`, `NOT_VERIFIED` and `BLOCKED`. The historical `NOT_RUN` in `docs/sandbox-acceptance.md` and later **USER/EXECUTOR_REPORTED** live outcomes in PR #3 reflect different points in time; do not reclassify reports as new `OBSERVED_PASS`. A past PASS does not establish direct SSE evidence for the merged commit. If either source is unavailable at execution, mark its affected claims `NOT_VERIFIED` and do not assert PASS without evidence.
- **Execution owner:** Claude Code, only after authorization; final decision belongs to the Human Owner. No automatic follow-on task.

## Review Focus (existing coverage; no new tests)

These five safety-relevant conditions are inspected through **existing test coverage in Task 1**, rather than used to justify new tests:

1. **Forged bearer, unauthorized endpoint or quota exhaustion:** Broker must reject before upstream. Existing `test/broker/capabilities.test.mjs` and `test/broker/server.test.mjs` tests are included in `npm test`.
2. **Unsafe SIWC refresh/credential persistence:** Invalid or ambiguous refresh and unsafe file permissions must fail closed. Existing `test/broker/siwc.test.mjs` and `test/broker/credential-store.test.mjs` tests are included.
3. **Malformed SSE / stalled stream:** Missing completion, upstream errors, timeouts and client aborts must not be treated as success. Existing `test/broker/server.test.mjs` SSE tests are included. These offline tests **do not** resolve missing M2 live SSE capture.
4. **M1/M2 tool exposure:** M1 must publish no tool; M2 must publish only flat `read_file` with Guest-local execution and matching `call_id` replay. Existing `test/guest/provider.test.mjs`, `test/guest/sdk-m1.test.mjs` and `test/guest/sdk-m2.test.mjs` tests are included.
5. **Guest secret leakage / launcher misuse:** Credential-like environment variables and bad startup mode or Broker URL must be rejected or stripped. Existing `test/guest/guest-launch.test.mjs` and `test/guest/provider.test.mjs` tests are included. Sandbox-wide security remains a separately reported evidence limit.

If any named file/test is missing or excluded by the actual runner, state `NOT_VERIFIED` for that coverage rather than asserting it passed.

---

### Task 1: Fixed-HEAD Offline Acceptance and Owner Decision

**Files:**
- **Read:** `package.json` (scripts, Node floor, dependency pins)
- **Read:** `docs/superpowers/specs/2026-11-17-oc2-t6-postmerge-component-acceptance-design.md` (requirements, evidence labels, stop rules; read from PR #4 if absent from `master`)
- **Read:** `docs/sandbox-acceptance.md` (historical offline acceptance; its Task 3/5 live `NOT_RUN` entries describe the record's earlier point in time, not the later live execution outcomes)
- **Read:** [merged PR #3](https://github.com/yohi/oc-cf-aig-subscription/pull/3) (subsequent Task 3 and Task 5 Host-only/M1/M2 live outcomes; **USER/EXECUTOR_REPORTED**, not newly observed by T6)
- **Read/test only:** `test/broker/*.test.mjs`, `test/guest/*.test.mjs`, `test/gateway.test.mjs`
- **Modify/Create:** **None** in repository. The outcome is a report in the execution response, not a committed artifact.

**Interfaces:**
- **Consumes:** A local checkout whose `git rev-parse HEAD` is exactly `9cc106b5b4a3443eadd04e80644991cc77d095b5`, on `master`, with `git status --porcelain=v1 --untracked-files=all` empty; installed dependencies and Node.js `>=22`.
- **Produces:** `TestReceipt { repository, branch, sha, nodeVersion, npmVersion, testExit, passCount, failCount, checkExit }`, `EvidenceMatrix[] { claim, status, provenance, limitation }`, `OwnerRecommendation { verdict, blockers, residualRisks, unapprovedActions }`.
- **Verdicts:** `COMPONENT_ACCEPTANCE_READY`, `NOT_READY`, or `BLOCKED`, always followed by `OWNER_DECISION / STOP`.

- [ ] **Step 1: Verify exact source identity without changing Git state.**

  Run from the already existing local repository root (no automatic clone, checkout, fetch or reset):

  ```sh
  git remote get-url origin
  git branch --show-current
  git rev-parse HEAD
  git status --porcelain=v1 --untracked-files=all
  ```

  Expected: origin corresponds to `yohi/oc-cf-aig-subscription`; branch is `master`; HEAD is exactly `9cc106b5b4a3443eadd04e80644991cc77d095b5`; status output is empty. On any mismatch, **STOP as `BLOCKED`**; do not move branches or delete local changes.

- [ ] **Step 2: Verify offline prerequisites read-only.**

  ```sh
  node --version
  npm --version
  test -f node_modules/@opencode/ai/package.json && \
    test -f node_modules/@opencode/plugin/package.json && \
    test -f node_modules/effect/package.json
  ```

  Expected: Node.js major version `>=22`, npm available, all three installed package metadata files present, and `package.json` still defines `"test": "node --test"` plus `"check"` syntax validation. Read each installed package's `package.json` and confirm its actual `version` is exactly `@opencode/ai@2.2.5`, `@opencode/plugin@2.2.5`, and `effect@4.0.6`, respectively. If any metadata file is missing, a version mismatches or cannot be confirmed, or scripts unexpectedly invoke live endpoints, **STOP as `BLOCKED`**. Do not install packages or authenticate.

- [ ] **Step 3: Execute the existing offline test suite exactly once.**

  ```sh
  npm test
  ```

  Expected: process exit 0, test runner reports zero failures, and the existing Broker/SIWC/Guest/M2 suites execute (including the five Review Focus conditions). Record the actual pass, fail, skip and exit counts; **do not assume** the earlier executor-reported `303 PASS` count will match. On nonzero exit or a component-relevant failed assertion, **STOP as `NOT_READY`**; do not rerun, patch, or run a second diagnostic test command. On environment-related inability to start, **STOP as `BLOCKED`**.

- [ ] **Step 4: Execute the existing syntax check exactly once (only if Step 3 passes).**

  ```sh
  npm run check
  ```

  Expected: process exit 0. A nonzero exit is `NOT_READY` when caused by actual code/syntax failure, otherwise `BLOCKED` if the environment prevents execution. No retry or repair.

- [ ] **Step 5: Confirm that repository state was not altered.**

  ```sh
  git rev-parse HEAD
  git status --porcelain=v1 --untracked-files=all
  ```

  Expected: same HEAD, empty status. If not, record the unexpected change and stop; **do not** clean/reset it. Do not claim a clean verification if the runner modified files.

- [ ] **Step 6: Produce one concise report in the task result (no new file required).**

  Use the exact structure:

  ```text
  OC2-T6-POSTMERGE-001
  Target: yohi/oc-cf-aig-subscription / master / <observed SHA>
  Preflight: PASS | BLOCKED (reason)
  npm test: OBSERVED_PASS <pass/fail/skip, exit> | FAIL | NOT_RUN
  npm run check: OBSERVED_PASS <exit> | FAIL | NOT_RUN
  Key contracts: Broker capability / SIWC / SSE / Guest M1-M2 — observed coverage and limits
  Evidence provenance: offline/historical NOT_RUN = docs/sandbox-acceptance.md; later live = PR #3 (USER/EXECUTOR_REPORTED); any unavailable source = affected claims NOT_VERIFIED
  Earlier live evidence (PR #3; preserve source as USER/EXECUTOR_REPORTED for each item): Host-only PASS | NOT_VERIFIED (PR #3 unavailable); M1 PASS | NOT_VERIFIED (PR #3 unavailable); M2 FUNCTIONAL_PASS_REPORTED / ACCEPTANCE_EVIDENCE_INCOMPLETE | NOT_VERIFIED (PR #3 unavailable)
  Still NOT_VERIFIED: M2 direct upstream namespace/completed/clean EOF, GH_TOKEN provenance, independent Cloudflare billing attribution
  Verdict: COMPONENT_ACCEPTANCE_READY | NOT_READY | BLOCKED
  Blockers / residual risks / unapproved actions: ...
  Final: OWNER_DECISION / STOP
  ```

  For `COMPONENT_ACCEPTANCE_READY`, require exact HEAD and clean worktree, successful Step 3 and 4, and no newly observed safety-relevant blocker; it means **ready for an Owner decision**, **not** blanket production approval or automatic Opt-in. Record the distinct source and chronology of each prior claim, and label any inaccessible referenced source `NOT_VERIFIED` for the affected claims. For Earlier live evidence, choose `PASS` only when PR #3 is available and supports the claim; otherwise choose `NOT_VERIFIED` separately for Host-only, M1, and M2 while retaining `USER/EXECUTOR_REPORTED` as the reported source. Do not turn `NOT_VERIFIED` into `PASS`, turn a capture failure into a proven functional failure, or require additional live attempts simply to eliminate Findings.

- [ ] **Step 7: Stop.** No commit, push, PR, CodeRabbit, independent reviewer, second test attempt, Sandbox action or higher-level OC2 work starts from this plan. Any fix, live usage, release or separate Skills/MCP/Plugin task needs its own explicit Owner authorization.

## Completion and Stop Conditions

**Completed for T6:** One valid fixed-HEAD offline verification receipt and an Owner-facing evidence-based verdict, or a correctly classified `BLOCKED`/`NOT_READY` with no unauthorized changes. No additional artifact is required.

**Stop immediately:** HEAD/worktree mismatch, missing dependency/runtime, unexpected script behavior, relevant test failure, security boundary uncertainty that makes execution unsafe, or the final report. Do not create a new review or correction task automatically.

**Owner checkpoint:** If `COMPONENT_ACCEPTANCE_READY`, the Owner may explicitly accept limited **component** completion; start of Opt-in operation is a **separate authorization**. If `BLOCKED`/`NOT_READY`, report the smallest meaningful choice without acting on it. The higher-level OC2 Skills/MCP/development-Plugins integration remains separate.

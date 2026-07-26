# Review Recovery, Observability, and Maintainer Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved review-recovery architecture, simple maintainer-facing copy, and global local-data cleanup without leaking storage or runtime internals into the normal UI.

**Architecture:** Keep domain and persisted API contracts stable wherever a label is not behavior. Add a renderer-only copy map for action labels, a storage service operation that owns cleanup retention, and an explicit workbench recovery projection that separates ready/running/interrupted/failed states from `currentAttemptId`. Preserve Git/LLM concepts (`PR`, `HEAD`, `SHA`, checks, model, Reasoning) while hiding quarantine, worktree, session, attempt, runtime, agent, and lifecycle details.

**Tech Stack:** TypeScript, React, Hono loopback API, Valibot contracts, Vitest, Testing Library, Playwright, Electron packaging.

## Global Constraints

- Renderer stays sandboxed; no Node.js or filesystem access crosses preload.
- GitHub writes remain explicit UI actions and are unchanged by this work.
- `HEAD`, `Reviewed HEAD`, `Current HEAD`, `Reviewed SHA`, `Reasoning`, and `Low / Medium / High` remain user-visible concepts.
- Quarantine, worktree, checkout, session, attempt, runtime, agent, and lifecycle remain diagnostics/internal terms.
- Settings exposes only global `Clear cache` and `Clear local review data` actions.
- `Clear cache` preserves durable review records; local-data cleanup preserves running and recoverable reviews and removes discarded/quarantined data.
- Do not touch the existing unrelated `app-shell.tsx`, `.agents/tasks/codex-subscription-provider/`, `.agents/tasks/narrative-walkthrough/`, or `tests/renderer/app-shell.ui.test.tsx` changes.

---

## Workstream boundaries

The approved spec contains three independently testable workstreams. Land them in this order:

1. renderer copy projection, which is behavior-neutral;
2. Settings cleanup API and UI, which changes storage controls but not review execution;
3. explicit recovery projection and diagnostics, which changes lifecycle behavior and needs the widest verification.

## File map

### Copy projection

- Create: `src/renderer/src/review-copy.ts` — stable presentation labels and user-safe error copy.
- Modify: `src/renderer/src/components/maintainer-inbox.tsx`, `src/renderer/src/flows/inbox-flow.tsx`, `src/renderer/src/flows/prepared-review-flow.tsx`, `src/renderer/src/components/safe-run-panel.tsx`, `src/renderer/src/components/review-checks.tsx`, `src/renderer/src/components/completed-review-workbench.tsx`.
- Test: `tests/renderer/maintainer-inbox.ui.test.tsx`, `tests/renderer/prepared-review-flow.ui.test.tsx`, `tests/renderer/safe-run-panel.ui.test.tsx`, plus `tests/renderer/review-copy.test.ts`.

### Settings cleanup

- Modify: `src/adapters/storage/review-artifact-storage.ts`, `src/services/storage-management-service.ts`, `src/main/local-api.ts`, `src/main/desktop-bridge.ts`, `src/renderer/src/flows/settings-flow.tsx`.
- Test: `tests/services/storage-management-service.test.ts`, `tests/renderer/profile-settings.test.tsx`, `tests/desktop-bridge.test.ts`, `tests/local-api-auth.test.ts`.

### Recovery and diagnostics

- Modify: `src/services/review-workbench-projection.ts`, `src/renderer/src/renderer-models.ts`, `src/renderer/src/renderer-contracts.ts`, `src/renderer/src/flows/prepared-review-flow.tsx`, `src/renderer/src/components/safe-run-panel.tsx`, `src/main/local-api.ts`, `src/services/review-run-registry.ts`.
- Create: `src/domain/review-recovery.ts` — renderer-safe recovery state and capability types.
- Test: `tests/services/review-workbench-projection.test.ts`, `tests/renderer/prepared-review-flow.ui.test.tsx`, `tests/renderer/safe-run-panel.ui.test.tsx`, `tests/services/review-run-coordinator.test.ts`, `tests/browser/milestone-5.spec.ts`.

---

### Task 1: Add a renderer-only copy contract

**Files:**
- Create: `src/renderer/src/review-copy.ts`.
- Modify: `src/renderer/src/components/maintainer-inbox.tsx`, `src/renderer/src/flows/inbox-flow.tsx`, `src/renderer/src/flows/prepared-review-flow.tsx`, `src/renderer/src/components/review-checks.tsx`, `src/renderer/src/components/completed-review-workbench.tsx`.
- Test: `tests/renderer/review-copy.test.ts`, `tests/renderer/maintainer-inbox.ui.test.tsx`.

**Interfaces:**
- `reviewActionLabel(kind: InboxRecommendedAction["kind"]): string` returns `Run review`, `Review updates`, `View review`, `Open merge readiness`, `Review author response`, or `Inspect failing checks`.
- `reviewStatusLabel(status: SafeRunProjection["status"]): string` returns maintainer copy such as `Starting review`, `Reviewing`, `Review complete`, `Review failed`, or `Connection lost`.

- [ ] **Step 1: Write failing copy-map tests** for every action kind and run status, including the invariant that display labels are not sourced from persisted `recommendedAction.label`.
- [ ] **Step 2: Run the focused copy tests** with `pnpm test -- --run tests/renderer/review-copy.test.ts`; verify they fail because the map does not exist.
- [ ] **Step 3: Implement the copy map** with Git/LLM vocabulary preserved and implementation terms excluded.
- [ ] **Step 4: Replace renderer uses of `row.recommendedAction.label`** with `reviewActionLabel(row.recommendedAction.kind)`; leave domain labels and cached wire schemas unchanged for compatibility.
- [ ] **Step 5: Update visible copy**: `Selected PR`, `Inspect failing checks`, `PRs`, `This review won’t change GitHub`, and `Checks for this PR` where appropriate. Keep `HEAD`, `Reviewed HEAD`, `Current HEAD`, `Reviewed SHA`, `Reasoning`, and `Low / Medium / High`.
- [ ] **Step 6: Run renderer tests**: `pnpm test -- --run tests/renderer/review-copy.test.ts tests/renderer/maintainer-inbox.ui.test.tsx tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/safe-run-panel.ui.test.tsx`.
- [ ] **Step 7: Commit** with `git add src/renderer/src/review-copy.ts src/renderer/src/components/maintainer-inbox.tsx src/renderer/src/flows/inbox-flow.tsx src/renderer/src/flows/prepared-review-flow.tsx src/renderer/src/components/review-checks.tsx src/renderer/src/components/completed-review-workbench.tsx tests/renderer/review-copy.test.ts tests/renderer/maintainer-inbox.ui.test.tsx tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/safe-run-panel.ui.test.tsx && git commit -m "feat: simplify maintainer-facing review copy"`.

### Task 2: Add safe global local-data cleanup

**Files:**
- Modify: `src/adapters/storage/review-artifact-storage.ts`, `src/services/storage-management-service.ts`.
- Test: `tests/services/storage-management-service.test.ts` and the storage adapter tests under `tests/storage/`.

**Interfaces:**
- `ReviewArtifactStorage.removeSession(profileId, sessionId)` deletes only a validated app-owned session directory and is idempotent when missing.
- `ReviewArtifactStorage.removeQuarantined(profileId, entryName)` validates the quarantine name before deleting its paired session/worktree directories.
- `StorageManagementService.clearLocalData(profileId)` removes discarded sessions and quarantined entries while preserving `preparing`, `running`, `ready`, `completed`, `failed`, `interrupted`, and `stale` reviews.

- [ ] **Step 1: Write failing service tests** covering discarded-session removal, quarantined-entry removal, preservation of running/recoverable states, missing disposable entries, and partial failure retryability.
- [ ] **Step 2: Run `pnpm test -- --run tests/services/storage-management-service.test.ts`** and verify the new tests fail.
- [ ] **Step 3: Implement path-checked artifact removal** using `PatchdeskPaths` roots and idempotent filesystem operations; reject malformed quarantine names before any delete.
- [ ] **Step 4: Implement `clearLocalData`** with execution-time protected-state evaluation and no GitHub writes. Keep `clearCache` protection for running sessions and recorded-running entries.
- [ ] **Step 5: Run service and storage tests** and verify recoverable records and active worktrees remain.
- [ ] **Step 6: Commit** the storage service and adapter changes with `git add src/adapters/storage/review-artifact-storage.ts src/services/storage-management-service.ts tests/services/storage-management-service.test.ts tests/storage && git commit -m "feat: add safe global local-data cleanup"`.

### Task 3: Replace Settings storage controls with two global actions

**Files:**
- Modify: `src/main/local-api.ts`, `src/main/desktop-bridge.ts`, `src/renderer/src/flows/settings-flow.tsx`.
- Test: `tests/renderer/profile-settings.test.tsx`, `tests/desktop-bridge.test.ts`, `tests/local-api-auth.test.ts`.

**Interfaces:**
- Add `POST /v1/storage/clear-local-data` accepting `{ profileId: string }`.
- Keep `POST /v1/storage/cache/clear` for transient cache removal.
- Remove Settings-only `GET /v1/storage`, `POST /v1/storage/discard`, and `POST /v1/storage/quarantine/delete` after all renderer callers and tests are migrated.

- [ ] **Step 1: Rewrite profile-settings tests** to assert no Saved reviews, older-version, Discard, or quarantine-delete controls; assert `Clear cache` and `Clear local review data` each require confirmation.
- [ ] **Step 2: Run `pnpm test -- --run tests/renderer/profile-settings.test.tsx`** and verify the old UI assertions fail.
- [ ] **Step 3: Replace storage overview state and parser** in `settings-flow.tsx` with two action states: `clear-cache` and `clear-local-data`.
- [ ] **Step 4: Add action-specific confirmation copy**: cache removal preserves reviews; local-data cleanup removes discarded/quarantined data but preserves running/recoverable reviews.
- [ ] **Step 5: Add the API route and desktop allowlist entry** for `clear-local-data`; remove obsolete Settings-only routes only after route tests cover rejection and authorization.
- [ ] **Step 6: Run focused Settings/API tests** and verify failed cleanup keeps the dialog open for retry.
- [ ] **Step 7: Commit** with `git add src/main/local-api.ts src/main/desktop-bridge.ts src/renderer/src/flows/settings-flow.tsx tests/renderer/profile-settings.test.tsx tests/desktop-bridge.test.ts tests/local-api-auth.test.ts && git commit -m "feat: simplify Settings local review cleanup"`.

### Task 4: Add explicit renderer-safe recovery state

**Files:**
- Create: `src/domain/review-recovery.ts`.
- Modify: `src/services/review-workbench-projection.ts`, `src/services/review-run-registry.ts`, `src/main/local-api.ts`, `src/renderer/src/renderer-models.ts`, `src/renderer/src/renderer-contracts.ts`.
- Test: `tests/services/review-workbench-projection.test.ts`, `tests/services/review-run-coordinator.test.ts`.

**Interfaces:**
- `ReviewRecoveryState = "preparing" | "ready" | "running" | "completed" | "failed" | "interrupted" | "needs_preparation"`.
- `ReviewRecoveryCapabilities = { canRun: boolean; canReconnect: boolean; canRetry: boolean; canPrepare: boolean }`.
- Add `recovery: { state: ReviewRecoveryState; capabilities: ReviewRecoveryCapabilities }` to `WorkbenchSessionProjection`.
- Add a read-only `ReviewRunRegistry.find(owner)` dependency to workbench projection so reconnectability is based on an owned live run, not merely `currentAttemptId`.

- [ ] **Step 1: Write projection tests** for `Created → ready`, `Running + registry hit → running/canReconnect`, `Running + no registry hit → interrupted/canRun`, `ReviewFailed → failed/canRetry`, `Discarded → ready/canRun`, and `Merged → no run capability`.
- [ ] **Step 2: Run the focused projection tests** and verify they fail because recovery data is absent.
- [ ] **Step 3: Implement the pure state mapper** in `src/domain/review-recovery.ts`; keep persisted domain state unchanged.
- [ ] **Step 4: Inject the registry into `ReviewWorkbenchProjectionService`** from `local-api.ts` and project explicit capabilities.
- [ ] **Step 5: Update renderer contracts/models** to require the recovery projection and reject paths/internal handles as before.
- [ ] **Step 6: Run projection, coordinator, and contract tests**.
- [ ] **Step 7: Commit** with `git add src/domain/review-recovery.ts src/services/review-workbench-projection.ts src/services/review-run-registry.ts src/main/local-api.ts src/renderer/src/renderer-models.ts src/renderer/src/renderer-contracts.ts tests/services/review-workbench-projection.test.ts tests/services/review-run-coordinator.test.ts && git commit -m "feat: project explicit review recovery state"`.

### Task 5: Render truthful recovery actions and safe run status

**Files:**
- Modify: `src/renderer/src/flows/prepared-review-flow.tsx`, `src/renderer/src/components/safe-run-panel.tsx`, `src/renderer/src/components/renderer-recovery.tsx`.
- Test: `tests/renderer/prepared-review-flow.ui.test.tsx`, `tests/renderer/safe-run-panel.ui.test.tsx`.

**Interfaces:**
- `SafeRunPanel` consumes `recovery.state` and `recovery.capabilities`; it no longer infers the primary action from `runId === undefined`.
- User-facing statuses map to `Starting review`, `Reviewing`, `Review complete`, `Review failed`, `Connection lost`, and `Review interrupted`.

- [ ] **Step 1: Add failing UI tests** for Ready showing `Run review`, Discarded showing `Run review`, reconnectable Running showing `Reconnect`, interrupted Running showing `Start again`, and failed attempts showing `Try again`.
- [ ] **Step 2: Run the focused UI tests** and verify the current `This review is not running` behavior fails the new assertions.
- [ ] **Step 3: Update `PreparedReviewFlow`** to render actions from `recovery.capabilities`, not `currentAttemptId`.
- [ ] **Step 4: Update `SafeRunPanel`** to remove “may still be running in the background,” hide Agent/Mode/Access by default, and keep model/reasoning under an optional details section.
- [ ] **Step 5: Replace generic failure copy** with action-specific messages while preserving retry behavior and read-only guarantees.
- [ ] **Step 6: Run the focused renderer tests** and verify no recovery state claims a live run without registry ownership.
- [ ] **Step 7: Commit** with `git add src/renderer/src/flows/prepared-review-flow.tsx src/renderer/src/components/safe-run-panel.tsx src/renderer/src/components/renderer-recovery.tsx tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/safe-run-panel.ui.test.tsx && git commit -m "fix: make review recovery actions truthful"`.

### Task 6: Add diagnostics without exposing internals

**Files:**
- Modify: `src/adapters/storage/review-session-store.ts`, `src/services/review-session-preparation.ts`, `src/services/review-run-coordinator.ts`, `src/services/review-failure-service.ts`, `src/services/review-workbench-projection.ts`, `src/main/local-api.ts`.
- Create: `src/domain/review-diagnostic.ts`, `src/services/review-diagnostic-service.ts`.
- Test: `tests/services/review-diagnostic-service.test.ts`, `tests/services/review-session-preparation.test.ts`, `tests/services/review-failure-service.test.ts`.

**Interfaces:**
- `ReviewDiagnosticEvent` contains `incidentId`, `category`, `phase`, `retryable`, review/operation/attempt IDs, timestamp, and redacted detail.
- `ReviewDiagnosticService.record(event)` appends bounded JSONL under the app-owned review directory; it never writes secrets, credentials, full diffs, or absolute paths to renderer responses.
- Add optional `diagnosticId` and user-safe `recoveryMessage` to workbench projections.

- [ ] **Step 1: Write redaction and retention tests** for secrets, absolute paths, bounded event count/bytes, and stable incident IDs.
- [ ] **Step 2: Run `pnpm test -- --run tests/services/review-diagnostic-service.test.ts`** and verify it fails.
- [ ] **Step 3: Implement the diagnostic event schema and append-only store** using existing JSONL helpers and app-owned paths.
- [ ] **Step 4: Record preparation, run, and recovery boundary failures** with stable phases and retryability; keep raw errors in main-process logs only.
- [ ] **Step 5: Project only incident ID and recovery message** to the renderer; add `View details` only where an action or support handoff exists.
- [ ] **Step 6: Run focused diagnostic and lifecycle tests**.
- [ ] **Step 7: Commit** with `git add src/domain/review-diagnostic.ts src/services/review-diagnostic-service.ts src/adapters/storage/review-session-store.ts src/services/review-session-preparation.ts src/services/review-run-coordinator.ts src/services/review-failure-service.ts src/services/review-workbench-projection.ts src/main/local-api.ts tests/services/review-diagnostic-service.test.ts tests/services/review-session-preparation.test.ts tests/services/review-failure-service.test.ts && git commit -m "feat: add bounded review diagnostics"`.

### Task 7: Migrate cached and persisted data safely

**Files:**
- Modify: `src/adapters/storage/maintainer-inbox-cache-store.ts`, `src/adapters/storage/review-session-store.ts`, `src/services/review-recovery-service.ts`, `src/services/review-preparation-journal.ts`.
- Test: `tests/storage/maintainer-inbox-cache-store.test.ts`, `tests/storage/review-session-store-begin-attempt.test.ts`, `tests/services/review-recovery-service.test.ts`, `tests/services/review-preparation-journal.test.ts`.

**Interfaces:**
- Existing inbox cache action labels remain accepted and are normalized to action kinds before renderer presentation.
- Session migration is idempotent: a rerun never deletes a protected review and never creates duplicate attempts.

- [ ] **Step 1: Add fixtures** for old action labels, discarded sessions with a stale attempt pointer, invalid saved findings, and stranded preparation journals.
- [ ] **Step 2: Write migration tests** for tolerant cache parsing, discarded-session fresh attempts, quarantine-on-invalid-load, and journal recovery.
- [ ] **Step 3: Implement tolerant parsing and explicit migration markers** without changing `low`/`medium`/`high` reasoning values or Git HEAD/SHA data.
- [ ] **Step 4: Run storage and recovery tests** and verify repeated startup/load reconciliation is idempotent.
- [ ] **Step 5: Commit** with `git add src/adapters/storage/maintainer-inbox-cache-store.ts src/adapters/storage/review-session-store.ts src/services/review-recovery-service.ts src/services/review-preparation-journal.ts tests/storage/maintainer-inbox-cache-store.test.ts tests/storage/review-session-store-begin-attempt.test.ts tests/services/review-recovery-service.test.ts tests/services/review-preparation-journal.test.ts && git commit -m "fix: migrate and recover local review state safely"`.

### Task 8: Verify the real desktop and packaged flows

**Files:**
- Test: `tests/browser/milestone-5.spec.ts`, existing package smoke coverage, and the isolated packaged app.

- [ ] **Step 1: Run focused tests** for all changed services, renderer flows, storage, contracts, and API authorization.
- [ ] **Step 2: Run the required desktop gate:** `pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build`.
- [ ] **Step 3: Run browser tests** with `pnpm exec playwright test` and verify PR #717 can prepare again, #754 shows `Run review`, and #716 shows `Reconnect` or `Start again` truthfully.
- [ ] **Step 4: Package and smoke-test** with `pnpm package:mac && pnpm test:package-smoke`.
- [ ] **Step 5: Have the dedicated tester subagent perform packaged UI verification** with isolated user data and screenshots; the primary agent does not drive the packaged UI.
- [ ] **Step 6: Run `git diff --check` and `git status -sb`**, confirm unrelated existing changes remain untouched, and record any environment blockers.
- [ ] **Step 7: Commit the final test updates** with `git add tests/browser/milestone-5.spec.ts tests && git commit -m "test: cover review recovery and cleanup flows"`.

## Verification summary

The implementation is complete only when focused tests prove each workstream and the desktop/package gate passes. If private PR data remains inaccessible, use deterministic local fixtures for unit/browser coverage and report the live-surface limitation instead of claiming the three PR scenarios were verified.

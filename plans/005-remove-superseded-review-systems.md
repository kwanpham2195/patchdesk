# Plan 005: Remove superseded Review systems and keep one current runtime

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. This is
> a deletion-first architecture change: do not add aliases, adapters, migration
> shims, fallback parsers, deprecated exports, or placeholder routes. If anything
> in the "STOP conditions" section occurs, stop and report; do not improvise.
> When done, update the status row for this plan in `plans/README.md` unless a
> reviewer dispatched you and said that they maintain the index.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 7b4f6e6..HEAD -- \
>   src/domain src/services src/adapters/storage src/adapters/github \
>   src/main src/renderer/src src/workflows tests docs CONTEXT.md README.md CHANGELOG.md package.json
> ```
>
> Then run the same path list through `git diff --stat --` and
> `git diff --cached --stat --`, then run `git status -sb`. At planning time the
> checkout already had unrelated uncommitted changes in `AGENTS.md`,
> `CHANGELOG.md`, `package.json`, `pnpm-lock.yaml`,
> `src/renderer/src/components/summary-review-dialog.tsx`,
> `src/renderer/src/flows/review-workbench-flow.tsx`,
> `tests/renderer/review-workbench-flow.ui.test.tsx`, and
> `tests/renderer/summary-review-dialog.ui.test.tsx`, plus untracked
> `.agents/skills/react-doctor/` and `plans/`.
> Preserve those edits. Compare every in-scope dirty file with this plan before
> editing it. If you cannot separate the existing edit from this plan, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 001-004
- **Category**: tech-debt / migration / architecture
- **Status**: DONE — 2026-08-13
- **Planned at**: commit `7b4f6e6`, 2026-08-13

## Why this matters

Patchdesk currently carries several replaced architectures beside the current
Review lifecycle. The obsolete code includes a local `ReviewBatch` draft and
publication state machine, a second Review Attempt/run system, incremental
"Review updates", startup migrations, and read-time schema upgrades. These
paths enlarge the write and recovery surface, contradict the current domain
language, and force every change to support states that the product no longer
uses.

After this plan, the runtime has one authority for each concern:

- `Review` owns durable lifecycle, represented revision, freshness, and terminal
  state.
- `ReviewSession` owns immutable artifacts for one pinned revision and only the
  current pending-review and direct-summary receipts needed by active flows.
- `MergeOperation` owns uncertain merge evidence until the exact owning
  `Review` is durably terminal.
- `InsightRunCoordinator` owns Analysis and Walkthrough execution.
- GitHub owns the one editable pending review.
- Explicit Refresh is the only changed-revision adoption path.
- Observation and recovery never replay an uncertain GitHub write.

The product owner explicitly does not require backward compatibility. Old local
records may become unreadable, but the app must reject or quarantine them; it
must not silently reinterpret or delete them.

**Approved scope note:** current-runtime-only cleanup includes retirement of
the unreachable ADR-0010 Analysis completion/publication authorization.
`local-api.ts` strictly rejects `completion`, the renderer never supplies it,
and production never configures its completion handler. The exception still
named in `AGENTS.md` is stale and must be corrected in this plan. This approval
does not cover current Finding **Add to review** commands: preserve each
explicit write, pending-review operation, immutable Finding receipt,
duplicate-prevention rule, and Analysis-summary Finish-review prefill.

## Current state

### Current product contracts to preserve

`CONTEXT.md` defines these terms and constraints:

- A **Review** is the end-to-end evaluation of an open pull request.
- A **Review session** is local work pinned to one pull request revision.
- An **Analysis run** is the optional model execution. The glossary explicitly
  says to avoid the term "Review run".
- A **GitHub pending review** is the only authoritative editable Review draft.
  Patchdesk has no local mirror or local batch.
- A **Finding review command** is an explicit one-write command with no local
  queue and no automatic execution after Analysis.
- An **Analysis review summary** may only prefill the Finish review modal after
  a Finding-backed pending review exists. It is not persisted as a local draft.
- Explicit Refresh is the only changed-code adoption path.

Preserve the active decisions in:

- `docs/adr/0012-run-insight-types-independently.md`
- `docs/adr/0013-keep-model-runs-bounded-and-non-authoritative.md`
- `docs/adr/0014-use-github-pending-reviews-for-review-drafting.md`
- `docs/adr/0015-authorize-finding-review-commands-from-analysis.md`
- `docs/adr/0016-use-the-local-codex-cli-account.md`
- `docs/adr/0017-separate-pr-reconciliation-from-revision-refresh-and-merge-confirmation.md`

### Superseded local draft and publication authority

`src/domain/review-session.ts` still stores all of this obsolete authority:

```ts
readonly batch?: Pick<ReviewBatch, "state">;
readonly batchContent?: ReviewBatch;
readonly submittedReview?: SubmittedReviewRef;
readonly archivedReceipts?: ReadonlyArray<RemoteWriteReceipt>;
readonly visibleResult?: ReviewResult;
```

`src/services/review-session-preparation.ts` creates an empty local batch for
new sessions and carries a predecessor batch to a new revision. The renderer
still constructs `DraftSlot`, and `src/renderer/src/components/review-workbench.tsx`
mounts the slot in a hidden container. The API still exposes:

```text
POST /v1/reviews/batch
POST /v1/reviews/apply-batch
POST /v1/reviews/submit-batch
POST /v1/reviews/publication/preview
POST /v1/reviews/publication/confirm
POST /v1/reviews/publication/recover
POST /v1/reviews/complete
```

`InsightRunCoordinator` also accepts dead completion actions and publication
authorization even though `src/main/local-api.ts` drops `completion` at its
strict request schema and no caller invokes `configureCompletion()`.

Current types are incorrectly housed in `src/domain/review-batch.ts`:

- `GitHubReviewEvent`
- `GitHubWriteFailure`
- `ReviewAnchor` / `ReviewAnchorFingerprint` and fingerprint helpers used by
  direct diff authoring

`src/domain/pending-review.ts` already defines the current
`GitHubReviewEvent` and `PendingReviewAnchor`. Consolidate on those current
names rather than preserving batch aliases.

### Superseded Review Attempt and run authority

`ReviewSessionState` still includes `Running`, `ReviewCompleted`,
`ReviewFailed`, `Stale`, and `Discarded`, and the session still owns
`currentAttemptId`. The old stack includes:

- `src/domain/review-attempt.ts`
- `src/domain/review-recovery.ts`
- `src/domain/safe-run-projection.ts`
- `src/services/review-execution-service.ts`
- `src/services/review-completion-service.ts`
- `src/services/review-failure-service.ts`
- `src/services/review-workflow-starter.ts`
- `src/services/review-run-coordinator.ts`
- `src/services/review-run-registry.ts`
- `src/services/run-projection.ts`
- `src/services/review-attempt-artifacts.ts`
- the attempt persistence API in `ReviewSessionStore`
- `/v1/reviews/run`, `/v1/runs/review-pr`, `/v1/runs/reconnect`, and
  `/v1/runs/:runId`
- fixture-only `SafeRunPanel`

This is not the current Insight lifecycle. Current Analysis and Walkthrough runs
already use `InsightRunCoordinator`, `InsightStore`, session-level prepared
artifacts, and `/v1/reviews/insights/...` routes.

The Pi Analysis implementation still reuses `FlueCliReviewInvoker`,
`src/workflows/review-pr.ts`, `ModelReviewRunner`, `ReviewInspector`, and the
review rubric. Retain those execution pieces, but remove attempt IDs, run
registry types, and incremental scope from their inputs. Rename symbols or
files only where the old "Review run" name would remain user-facing or
architecturally misleading.

### Superseded incremental Review updates

`ReviewSessionPreparation` accepts:

```ts
type ReviewOpenMode =
  | { kind: "full" }
  | { kind: "incremental"; baseSessionId: ReviewSessionId };
```

The inbox can recommend `review_updates`, opens a comparison confirmation
modal, and sends `mode: "incremental"`. This stack owns
`review-comparison.ts`, `review-comparison-service.ts`, comparison artifact
paths, prior-Finding lifecycle evidence, incremental workflow prompt branches,
and `GitHubReader.compareRevisions()`.

Explicit Refresh already prepares a complete new session with `mode: "full"`.
The current retained Analysis projection calculates reviewed scope from the
retained session's complete patch. Keep that behavior.

### Startup migration and multi-version parsing

Startup currently constructs and runs both `UnifiedReviewMigration` and
`LegacyBatchDiscardMigration`, and `/v1/reviews` plus the workbench controller
run migration again on demand. Marker paths are still present in
`PatchdeskPaths`.

`ReviewSessionStore` accepts session schema versions 2, 3, 4, and 5, upgrades
legacy draft content, strips attempt ownership from batches, and retains old
session-owned Insight fields. `InsightStore` accepts schemas 1 and 2 and
constructs historical provenance. `domain/contracts.ts` accepts a legacy config
shape with `recentPrs`.

The current store must accept one schema only. Do not renumber current schema
constants only to signal cleanup; keep `Review.schemaVersion === 2`,
`InsightRecord.schemaVersion === 2`, and use the existing current
`ReviewSession.schemaVersion === 5` unless the reduced shape truly requires a
new persisted schema. Regardless of number, accept only the one chosen current
shape.

### Current recovery that must remain

Do not delete these systems:

- `ReviewPreparationJournal` and its crash-safe worktree/artifact cleanup
- `ReviewObservationJournalStore` and `ReviewObservationService`
- pending-review `WriteInFlight` / `OutcomeUnknown` recovery
- direct-summary recovery and durable receipt
- merge operation journal/store and merge outcome recovery
- exact Finding review receipts
- `ReviewOperationCoordinator`
- current GitHub Conversation, published-feedback writes, and inline comments
- `ReviewDiffSourceService`
- the evidence-gated Git diff fallback in `GitHubAdapter`

`ReviewRecoveryService` mixes current merge recovery with obsolete batch
publication and attempt recovery. Refactor it; do not delete it wholesale.

### Code conventions

- Use strict TypeScript. Do not add `any`, `// @ts-` suppression, or string
  casts for domain IDs.
- Parse unknown input at transport/storage boundaries and use `Result` in
  domain/services. Match `src/domain/review.ts` and
  `src/services/review-write-gate.ts`.
- Use double quotes and trailing commas.
- Keep the renderer sandboxed. GitHub writes stay behind the capability-gated
  local API and explicit current UI actions.
- Delete old paths. Do not retain compatibility without an explicit contract.
- Ask before removing intentional current functionality. This plan is explicit
  approval to remove only the superseded systems named here.

## Commands you will need

Run with pnpm 8.8.0.

- Focused tests: `pnpm test -- --run <test files>` → exit 0, all selected tests pass.
- Full unit/integration gate: `pnpm test -- --run` → exit 0, all tests pass.
- Typecheck: `pnpm typecheck` → exit 0, no errors.
- Lint: `pnpm lint` → exit 0, no warnings.
- Build: `pnpm build` → exit 0.
- Browser tests: `pnpm exec playwright test` → exit 0, all tests pass.
- Diff hygiene: `git diff --check` → no output, exit 0.
- Deletion inventory: use the `rg` commands in the Done criteria; expected exit
  is 1 with no output for deleted concepts.

Do not run packaging or live GitHub writes unless the operator separately asks.

## Scope

**In scope**

- Current-type extraction and removal of obsolete IDs/parsers in:
  - `src/domain/ids.ts`
  - `src/domain/pending-review.ts`
  - `src/domain/review-session.ts`
  - `src/domain/review-result.ts`
  - `src/domain/insight-record.ts`
  - `src/domain/insight-provider.ts`
  - `src/domain/contracts.ts`
  - `src/domain/github-context.ts`
  - `src/domain/merge-operation.ts`
- Deletion of obsolete domain files:
  - `src/domain/review-batch.ts`
  - `src/domain/review-attempt.ts`
  - `src/domain/review-comparison.ts`
  - `src/domain/finding-lifecycle.ts`
  - `src/domain/review-recovery.ts`
  - `src/domain/safe-run-projection.ts`
  - `src/domain/publication-authorization.ts`
  - `src/domain/review-anchor.ts` after any current anchor helper is moved
- Storage cleanup:
  - `src/adapters/storage/review-session-store.ts`
  - `src/adapters/storage/insight-store.ts`
  - `src/adapters/storage/patchdesk-paths.ts`
  - `src/adapters/storage/merge-operation-store.ts`
  - delete `src/adapters/storage/publication-authorization-store.ts`
- Adapter boundary cleanup:
  - `src/adapters/github/github-adapter.ts`
- Service cleanup and deletion:
  - delete `src/services/review-batch-controller.ts`
  - delete `src/services/review-submission-service.ts`
  - delete `src/services/review-write-controller.ts`
  - delete `src/services/publication-preview-service.ts`
  - delete `src/services/legacy-batch-discard-migration.ts`
  - delete `src/services/unified-review-migration.ts`
  - delete `src/services/review-execution-service.ts`
  - delete `src/services/review-completion-service.ts`
  - delete `src/services/review-failure-service.ts`
  - delete `src/services/review-workflow-starter.ts`
  - delete `src/services/review-run-coordinator.ts`
  - delete `src/services/review-run-registry.ts`
  - delete `src/services/run-projection.ts`
  - delete `src/services/review-attempt-artifacts.ts`
  - delete `src/services/review-comparison-service.ts`
  - modify `src/services/review-recovery-service.ts`
  - modify `src/services/review-session-preparation.ts`
  - modify `src/services/review-workbench-controller.ts`
  - modify `src/services/review-workbench-projection.ts`
  - modify `src/services/review-write-gate.ts`
  - modify `src/services/maintainer-inbox-service.ts`
  - modify `src/services/model-review-runner.ts`
  - modify `src/services/review-rubric.ts`
  - modify `src/services/flue-cli-review-invoker.ts`
  - modify `src/services/insight-run-coordinator.ts`
  - modify `src/services/merge-service.ts`
  - modify `src/services/merge-write-controller.ts`
  - modify `src/services/review-refresh-service.ts` where publication
    authorization or predecessor draft logic is removed
- Main-process and transport cleanup:
  - `src/main/local-api.ts`
  - `src/main/desktop-bridge.ts`
  - `src/main/electron-main.ts`
- Renderer cleanup:
  - `src/renderer/src/renderer-contracts.ts`
  - `src/renderer/src/flows/inbox-flow.tsx`
  - `src/renderer/src/flows/review-workbench-flow.tsx`
  - `src/renderer/src/flows/app-fixtures.tsx`
  - `src/renderer/src/flows/fixture-routes.ts`
  - `src/renderer/src/components/maintainer-inbox.tsx`
  - `src/renderer/src/components/review-workbench.tsx`
  - `src/renderer/src/components/review-diff-view.tsx`
  - `src/renderer/src/components/pr-overview-sheet.tsx`
  - `src/renderer/src/hooks/use-insight-run.ts`
  - delete `src/renderer/src/components/review-batch-panel.tsx`
  - delete `src/renderer/src/components/review-draft-dock.tsx`
  - delete `src/renderer/src/components/publication-preview-dialog.tsx`
  - delete `src/renderer/src/components/safe-run-panel.tsx`
- Workflow cleanup:
  - `src/workflows/review-pr.ts`
- Current provider verification:
  - `src/services/codex-insight-invoker.ts`
  - create `tests/services/codex-insight-invoker.test.ts` if no equivalent
    current provider-boundary test exists
- Tests and fixtures directly coupled to the removed concepts, including all
  files named in the Test plan below.
- Current source-of-truth documentation:
  - `CONTEXT.md`
  - `README.md`
  - `AGENTS.md` to remove the proven-stale automatic Analysis publication
    exception while preserving current explicit-write rules
  - active ADRs 0011–0017 where wording still names removed authority
  - `CHANGELOG.md`

**Out of scope**

- The uncommitted direct-summary receipt/observation fix except where a precise
  import or projection edit is required by deletion. Preserve its behavior and
  tests.
- The stale-observation generation guard and workbench accessibility repair
  completed by Plans 001-002. Preserve their behavior and regressions.
- Flue dependency packaging reproducibility, renderer bundle splitting, Pierre
  styling, compact merge keyboard polish, and Walkthrough Support UX.
- Provider selection, model catalogs, prompt quality, Analysis result shape
  apart from deleting incremental-only fields, and Walkthrough generation.
- The current remote pending-review, direct-summary, Conversation, published
  feedback, Refresh, observation, merge, worktree, and journal protocols.
- `.agents/archive/**` and completed historical task artifacts. They are
  historical evidence, not runtime or current documentation.
- Deleting user data from disk. Strict parsers may reject old records, but this
  plan does not authorize a filesystem purge.

## Git workflow

- Stay on the current branch unless the operator asks for a branch change.
- Commit logical slices only if the operator asks for commits. Use conventional
  commit style, for example: `refactor: remove superseded review systems`.
- Stage explicit paths only. Never use `git add .`, `git add -A`, or force add.
- Do not overwrite or revert the pre-existing uncommitted renderer/test edits.
- Do not push or open a PR unless asked.

## Steps

### Step 1: Add removal contract tests and capture the current preservation baseline

Before deleting source, add narrow characterization tests for the current
systems that must survive. These tests must not mention old fallback behavior.
Use existing test fixtures and `FakeGitHubAdapter`; do not make network calls.

Add or update tests that prove:

1. A current schema-5 full Review session round-trips with pending-review state,
   Finding receipts, direct-summary state, and timestamps.
2. Schema versions 2–4, `draft` / `draftContent`, `batch` / `batchContent`,
   attempt fields, session-owned Insight fields, and incremental `scope` are
   rejected as `invalid_stored_value` after the new parser is installed.
3. A current schema-2 Insight record round-trips `activeRun`, retained result,
   `replacementFailure`, dismissals, and Walkthrough progress. Schema 1 and
   `incidentId` are rejected after the new parser is installed.
4. Pending-review Start/AddThread/Submit/Discard recovery remains fail-closed.
5. Direct-summary confirmed and recovery-required states remain durable.
6. Same-revision observation, explicit Refresh, and merge outcome recovery keep
   their current behavior.
7. The represented diff can still load from the prepared session patch, and the
   evidence-gated Git diff fallback remains covered by
   `tests/services/review-diff-source-service.test.ts` and
   `tests/adapters/github-adapter.test.ts`.
8. Insight Analysis/Walkthrough replacement, cancellation, `superseded`
   completion, dismissal, and Walkthrough progress remain covered by
   `tests/services/insight-run-coordinator.test.ts` and
   `tests/storage/insight-store.test.ts`.

Do not make the rejection assertions pass by deleting test setup only. They
must call the real boundary parser.

**Verify**:

```bash
pnpm test -- --run \
  tests/storage/patchdesk-storage.test.ts \
  tests/storage/insight-store.test.ts \
  tests/domain/pending-review.test.ts \
  tests/services/pending-review-service.test.ts \
  tests/services/direct-summary-review-service.test.ts \
  tests/services/review-observation-service.test.ts \
  tests/services/review-refresh-service.test.ts \
  tests/services/merge-write-controller.test.ts \
  tests/services/review-recovery-service.test.ts \
  tests/services/review-diff-source-service.test.ts \
  tests/services/insight-run-coordinator.test.ts \
  tests/adapters/github-adapter.test.ts
```

Expected before deletion: current preservation tests pass; new legacy-rejection
tests may be marked with a temporary `it.todo` only until Step 7. Remove all
such `todo` markers before Step 7 finishes.

### Step 2: Move current GitHub and diff-anchor contracts out of ReviewBatch

Make current dependencies independent before deleting the obsolete module.

1. Use `GitHubReviewEvent` from `src/domain/pending-review.ts` everywhere.
2. Move `GitHubWriteFailure` to the current GitHub adapter boundary or a small
   current domain module such as `src/domain/github-write.ts`. Do not keep a
   `review-batch` re-export.
3. Consolidate `ReviewAnchor` onto `PendingReviewAnchor`. If the renderer still
   needs a fingerprint to validate a direct selection before sending a current
   command, move only `ReviewAnchorFingerprint` and
   `fingerprintPatchAnchor()` to a current neutral module such as
   `src/domain/diff-anchor.ts`. Delete carry-forward matching and all types that
   exist only for local draft repair.
4. Update `GitHubAdapter`, pending-review/direct-summary/inline services,
   merge code, renderer diff authoring, and tests to import the current types.
5. Remove `LocalReviewItemId`, `PublicationAuthorizationId`,
   `ReviewAttemptId`, their parsers, and attempt-sequence allocator from
   `src/domain/ids.ts` once their callers are removed. Keep all current GitHub,
   Finding, Review, ReviewSession, and Insight IDs.

**Verify**:

```bash
rg -n 'from ".*review-batch"|LocalReviewItemId|PublicationAuthorizationId' src tests
pnpm typecheck
```

Expected after this step: no non-obsolete current module imports
`review-batch`; typecheck exits 0. Temporary imports within files scheduled for
deletion may remain only until Step 3.

### Step 3: Delete local ReviewBatch, publication, and Analysis-completion authority

Delete the full obsolete local-draft stack, not only its hidden UI.

1. Remove batch creation and carry-forward from
   `ReviewSessionPreparation`. Remove `previousSessionId` from preparation and
   Refresh. A changed-revision Refresh prepares one complete new session and
   never copies local draft state.
2. Remove `batch`, `batchContent`, `submittedReview`, and `archivedReceipts`
   from `ReviewSession` and its parser.
3. Delete the batch domain/controller/submission/write/preview files and the
   publication authorization domain/store/path.
4. Remove batch publication reconciliation from `ReviewRecoveryService`.
   Keep merge recovery, observation recovery, invalid-entry quarantine, and
   preparation-journal recovery. Rename `reconcileReview()` or its result copy
   if it still says "publication" after publication code is gone.
5. Remove `draftRevision` from `ReviewWriteExpectation` and
   `ReviewWriteGate.requireFresh()`. The current gate remains bound to Review,
   session, head SHA, patch hash, freshness, terminal status, remote snapshot,
   and observation-journal absence.
6. Remove batch routes from `local-api.ts` and `desktop-bridge.ts`. Remove
   `reviewWriter` only if no current test seam needs it; current writer
   capability comes from the GitHub adapter and must still enable pending,
   inline, direct-summary, and published-feedback services.
7. Remove the hidden `DraftSlot`, draft dock slot, draft parsers and schemas,
   old PR overview batch props, and local publication fixtures. Delete the four
   obsolete renderer components listed in Scope.
8. Remove the unreachable Analysis completion/publication stack:
   `AnalysisCompletionAction`, `PublicationAuthorization*`, its store and ID,
   `InsightRunCoordinator` completion inputs and response fields,
   `pendingCompletions`, `configureCompletion()`, completion invocation, and
   authorization revocation. Remove the dead optional completion parameter
   from `useInsightRun` and unused completion props from `InsightRunDialog`.
   A successful Analysis only persists its retained Insight. Do not remove or
   merge this with Finding Add-to-review commands, pending-review operations,
   Finding receipts, or Analysis-summary Finish-review prefill.
9. Keep the current Finding review commands and Analysis-summary Finish action.
   They use pending-review state and Finding receipts, not local batch state.
10. Project Finding `disposition` from Insight dismissals only. Pending and
    published Finding status continues through `analysisReviewActions.findings`
    and receipts; do not label it as a local `added` disposition.
11. Delete batch/publication tests. Rewrite mixed tests so they assert current
    pending-review/direct-summary behavior instead of preserving batch setup.

Delete at minimum:

```text
src/domain/review-batch.ts
src/domain/publication-authorization.ts
src/adapters/storage/publication-authorization-store.ts
src/services/review-batch-controller.ts
src/services/review-submission-service.ts
src/services/review-write-controller.ts
src/services/publication-preview-service.ts
src/services/legacy-batch-discard-migration.ts
src/renderer/src/components/review-batch-panel.tsx
src/renderer/src/components/review-draft-dock.tsx
src/renderer/src/components/publication-preview-dialog.tsx
tests/domain/publication-authorization.test.ts
tests/services/review-batch-controller.test.ts
tests/services/review-submission-service.test.ts
tests/services/review-write-controller.test.ts
tests/services/publication-preview-service.test.ts
tests/services/legacy-batch-discard-migration.test.ts
tests/storage/publication-authorization-store.test.ts
tests/renderer/review-draft-dock.ui.test.tsx
tests/renderer/publication-preview-dialog.ui.test.tsx
```

**Verify**:

```bash
rg -n 'ReviewBatch|batchContent|archivedReceipts|submittedReview|publication/(preview|confirm|recover)|apply-batch|submit-batch|/v1/reviews/batch|PublishWhenComplete|SaveAsReviewDraft|OpenPreviewWhenComplete|PublicationAuthorization|DraftSlot|draftDock' src tests
pnpm test -- --run \
  tests/domain/pending-review.test.ts \
  tests/services/pending-review-service.test.ts \
  tests/services/direct-summary-review-service.test.ts \
  tests/services/inline-conversation-service.test.ts \
  tests/services/review-write-gate.test.ts \
  tests/services/review-recovery-service.test.ts \
  tests/services/insight-run-coordinator.test.ts \
  tests/renderer/review-workbench-flow.ui.test.tsx \
  tests/browser/local-api-workbench.spec.ts \
  tests/desktop-bridge.test.ts
```

Expected: the `rg` command returns no runtime matches for the removed concepts;
all selected tests pass. Historical documentation is handled in Step 8.

### Step 4: Remove incremental Review updates and prior-Finding lifecycle

Make every new session and every Refresh a complete full-revision session.

1. Replace `ReviewOpenMode` with no mode field, or delete it entirely.
   `ReviewSessionPreparation.prepare()` accepts identity plus profile only.
2. Remove `ReviewSession.scope`; Analysis always receives the complete prepared
   patch. Remove the incremental branch from `ModelReviewRunner`, review rubric,
   Flue workflow input, and invoker input.
3. Delete `review-comparison.ts`, `review-comparison-service.ts`,
   `finding-lifecycle.ts`, and their direct tests, including
   `tests/domain/finding-lifecycle.test.ts`. Remove comparison/prior/lifecycle
   paths from `PatchdeskPaths`.
4. Remove `GitHubReader.compareRevisions()` and its production/fake adapter
   implementations. Do not remove `getPullRequestDiff()` or the evidence-gated
   fetched-ref Git diff fallback.
5. Remove `priorFindingAssessments` from `ModelReviewResult`, its schema and
   parser. Keep current Finding fields and mapping.
6. Remove `review_updates`, `ReviewStartMode`, the comparison confirmation
   dialog, base-session arguments, and incremental cache schema from inbox
   domain, service, cache, renderer contracts, and UI.
7. For an updated PR, recommend the normal open/run action. Opening an existing
   Review still shows **Updates available** and requires explicit Refresh; do
   not make inbox opening silently adopt a new revision.
8. Remove incremental-only tests and cases. Rewrite model-runner/workflow tests
   to prove the complete patch path.

Delete at minimum:

```text
src/domain/review-comparison.ts
src/domain/finding-lifecycle.ts
src/services/review-comparison-service.ts
tests/domain/review-comparison.test.ts
tests/services/review-comparison-service.test.ts
```

**Verify**:

```bash
rg -n 'incremental|Review updates|review_updates|ReviewComparison|compareRevisions|baseSessionId|comparisonPatch|previousFindings|findingLifecycle|priorFindingAssessments' src tests
pnpm test -- --run \
  tests/services/review-session-preparation.test.ts \
  tests/services/model-review-runner.test.ts \
  tests/services/review-rubric.test.ts \
  tests/services/maintainer-inbox-service.test.ts \
  tests/domain/maintainer-inbox.test.ts \
  tests/storage/maintainer-inbox-cache-store.test.ts \
  tests/renderer/maintainer-inbox.ui.test.tsx \
  tests/renderer/review-workbench-flow.ui.test.tsx \
  tests/services/review-diff-source-service.test.ts \
  tests/adapters/github-adapter.test.ts
```

Expected: no matches for removed incremental concepts; all selected tests pass.

### Step 5: Remove the Review Attempt/run state machine while retaining Pi Analysis

Delete the second run lifecycle and make Insight execution the only model-run
owner.

1. Reduce `ReviewSession` to immutable session identity/artifacts plus current
   remote-write receipts. Remove `currentAttemptId`, attempt-based states,
   `visibleResult`, and attempt transition functions.
2. Session terminal state is not a second authority. `Review.status` is the
   sole open/merged/closed authority. Remove `Merged` session state and
   `mergeDecision`. Before doing so, add `reviewId: ReviewId` to
   `MergeOperation`, its strict parser, `requestMergeOperation()`, and
   `MergeOperationStore` tests. Keep `sessionId` because revision identity and
   operation storage are still session-bound. Both direct completion and
   startup recovery must load the exact owning Review, persist
   `Review.status = Terminal/merged`, and only then remove the operation file.
   A failure to save the terminal Review leaves the operation Confirmed or
   OutcomeUnknown and returns `merge_outcome_unknown`; it must never report
   success or delete the only recovery evidence.
3. Remove `ReviewAttemptId`, attempt directory/path methods, attempt
   persistence, begin/list/load/save attempt methods, debug JSONL attempt
   events, and `isRecordedRunning()`. Current `InsightRecord.activeRun` is the
   only model-run lock.
4. Delete the attempt/run services, domain, safe-run fixture/component, and API
   routes listed in Scope.
5. Remove `workflowInvoker`, `supportedReviewModels`, `runProjection`, and
   old `/v1/reviews/models` configuration from the local API if no current
   caller remains. Current Insight providers and model catalogs remain.
6. Remove `createWorkflowInvoker()` from `electron-main.ts`. Keep
   `createInsightCoordinator()`, `FlueCliReviewInvoker`, and its Analysis
   workflow invocation.
7. Refactor `FlueCliReviewInvoker` to own a current Analysis invocation input;
   remove `attemptId`, `ReviewWorkflowInput`, and `ReviewActivityStep`.
8. Refactor `src/workflows/review-pr.ts` and `ModelReviewRunner` to use full
   prepared artifacts only. Rename `workflow:review-pr` only if the Flue
   manifest/alias can be changed atomically with tests and packaging. Do not
   delete it; it is the current Pi Analysis implementation.
9. Keep `ReviewPreparationJournal`. Remove only its dependency on attempt state
   or attempt recovery. Its `preparing` / `committing` crash protocol and
   worktree cleanup stay.
10. Simplify `ReviewRecoveryService` to current recovery: preparation journal,
    invalid storage quarantine, merge operation reconciliation, and current
    write protocols. Inject `ReviewStore`; for a merged outcome, confirm or
    retain the merge operation, mark the operation's exact `reviewId` terminal,
    and remove the operation only after the Review save succeeds. Remove orphan
    attempt recovery.
11. Simplify `ReviewWorkbenchProjectionService`: do not list attempts or project
    `recoveryView`; use `InsightStore` exclusively for Analysis/Walkthrough
    status. The fallback that projects `session.visibleResult` must be deleted.
12. Simplify the inbox. Remove `starting`, `running`, `completed`, `failed`,
    `draft`, and `submitted` session-derived states. Derive only current Review
    status and current Insight activity. If the inbox cannot read `ReviewStore`
    and `InsightStore` without a broad redesign, show a neutral **Open Review**
    action for known sessions and keep the existing **Run review** action for
    unknown ones; do not retain attempt state as a shortcut.
13. Keep session-level `prepared/context.json`, `prepared/review-input.md`,
    `prepared/debug.json`, the patch, and represented-review worktree. Verify
    both Pi and Codex Insight invokers read these paths. Add
    `tests/services/codex-insight-invoker.test.ts` (or an exact equivalent) for
    the Codex boundary and a coordinator/wiring assertion that Pi and Codex
    invocation inputs contain no attempt, scope, completion, or batch fields.
14. Remove dead attempt/session workflow contracts from `domain/contracts.ts`.
    Remove `attemptId` from logs and diagnostics if it has no current producer.
    Keep generic `run` diagnostic category only if current Insight diagnostics
    use it; rename it to `insight` if practical in the same change.

Delete at minimum:

```text
src/domain/review-attempt.ts
src/domain/review-recovery.ts
src/domain/safe-run-projection.ts
src/services/review-execution-service.ts
src/services/review-completion-service.ts
src/services/review-failure-service.ts
src/services/review-workflow-starter.ts
src/services/review-run-coordinator.ts
src/services/review-run-registry.ts
src/services/run-projection.ts
src/services/review-attempt-artifacts.ts
src/services/review-head-verifier.ts
src/services/review-workbench.ts
src/renderer/src/components/safe-run-panel.tsx
tests/services/review-execution-service.test.ts
tests/services/review-completion-service.test.ts
tests/services/review-failure-service.test.ts
tests/services/review-workflow-starter.test.ts
tests/services/review-run-coordinator.test.ts
tests/services/review-run-registry.test.ts
tests/services/run-projection.test.ts
tests/services/review-attempt-artifacts.test.ts
tests/services/review-workbench.test.ts
tests/domain/review-recovery.test.ts
tests/renderer/safe-run-panel.ui.test.tsx
tests/storage/review-session-store-begin-attempt.test.ts
```

Before deleting `src/services/review-workbench.ts`, confirm no current symbol
remains there after batch/attempt deletion. Move only a genuinely current helper
to the service that owns it; do not keep the file as a shell.

**Verify**:

```bash
rg -n 'ReviewAttempt|ReviewAttemptId|currentAttemptId|attemptId|ReviewCompleted|ReviewFailed|orphaned_run|ReviewRun|SafeRun|review_in_progress|review_interrupted|/v1/reviews/run|/v1/runs/review-pr|/v1/runs/reconnect|/v1/runs/:runId|visibleResult|mergeDecision' src tests
pnpm test -- --run \
  tests/services/flue-cli-review-invoker.test.ts \
  tests/services/model-review-runner.test.ts \
  tests/services/insight-run-coordinator.test.ts \
  tests/services/review-session-preparation.test.ts \
  tests/services/review-preparation-journal.test.ts \
  tests/services/review-workbench-projection.test.ts \
  tests/services/maintainer-inbox-service.test.ts \
  tests/services/merge-service.test.ts \
  tests/services/merge-write-controller.test.ts \
  tests/storage/merge-operation-store.test.ts \
  tests/domain/merge-operation.test.ts \
  tests/services/review-recovery-service.test.ts \
  tests/services/codex-insight-invoker.test.ts \
  tests/local-api-auth.test.ts \
  tests/desktop-bridge.test.ts
```

Expected: no runtime matches for the removed attempt/run concepts; current
Insight, preparation, workbench, inbox, and merge tests pass.

### Step 6: Remove startup migrations and every request-time compatibility facade

1. Delete `UnifiedReviewMigration` and its tests.
2. Remove migration construction and both startup loops from `local-api.ts`.
   Startup now recovers current preparation journals, current observation
   journals, Insight active records, current merge operations, and invalid
   storage entries only.
3. Remove migration from `ReviewWorkbenchController`, including `migrate()`,
   the call in `open()`, and the call in `load()`.
4. Remove migration from `/v1/reviews`; preferably remove this unused list route
   if no renderer caller exists. If retained for diagnostics, list current
   `ReviewStore` records rather than session migration state.
5. Remove review and batch migration marker paths. Do not add cleanup code that
   deletes existing marker files.
6. Make the workbench controller require its current lifecycle dependencies.
   Delete optional legacy/session-only branches in `open`, `load`, `refresh`,
   and projection construction. `/v1/reviews/load` accepts `reviewId`, not a
   legacy `sessionId` alternative.
7. Make `ReviewWorkbenchProjectionService` require current `ReviewStore` and
   `InsightStore` dependencies. Delete its session-owned Insight and
   session-only projection fallbacks.
8. Make `ReviewObservationService` the required detection owner. Remove the
   controller fallback to `ReviewRefreshService.detect()`, the head-only
   "legacy detector" and compatibility DTO, and any test-only composition that
   omits observation. Keep `ReviewRefreshService.refresh()` as the explicit
   changed-revision adoption owner.

Delete at minimum:

```text
src/services/unified-review-migration.ts
tests/services/unified-review-migration.test.ts
```

**Verify**:

```bash
rg -n 'UnifiedReviewMigration|LegacyBatchDiscardMigration|reviewMigrationMarkerFile|batchDiscardMarkerFile|migration-failed|migrateProfile|legacy/session-only|legacy detector|compatibility DTO|sessionId.*reviews/load' src tests
pnpm test -- --run \
  tests/services/review-workbench-controller.test.ts \
  tests/services/review-workbench-projection.test.ts \
  tests/services/review-observation-service.test.ts \
  tests/services/review-refresh-service.test.ts \
  tests/browser/local-api-workbench.spec.ts \
  tests/local-api-auth.test.ts
```

Expected: no migration/fallback matches; all selected tests pass.

### Step 7: Enforce one current storage schema

Do this after all current producers use the reduced shape.

1. Replace `ReviewSessionStore`'s versions 2–5 schema with one strict current
   schema. Remove legacy draft parsing, batch parsing, attempt parsing, old
   Insight fields, old state conversion, archived receipt conversion, and
   read-time normalization. `save()` and `load()` parse the same shape.
2. Keep strict ownership invariants: deterministic session ID, matching profile,
   PR identity, head SHA, patch/worktree head, typed pending-review state,
   Finding receipts, direct-summary state, and valid timestamps.
3. Replace Insight schema union with strict schema 2 parsing. Require current
   provider/model/reasoning provenance for retained results and failures.
   Remove `incidentId`, historical provenance, `parseV1Record()`, and
   `parseLegacyRetained()`.
4. Remove `HistoricalInsightProvenance` and make retained provenance equal to
   current `InsightProvenance`.
5. Remove `legacyPatchdeskConfigSchema` and `recentPrs` acceptance from
   `domain/contracts.ts`.
6. Delete stale parser tests and add exact rejection tests for removed shapes.
7. Remove every temporary `it.todo` added in Step 1.
8. Verify old records are rejected/quarantined, never silently deleted or
   rewritten. Current records must round-trip byte-semantically through the
   parser.

**Verify**:

```bash
rg -n 'schemaVersion: v.picklist|recordSchemaV1|activeRunSchemaV1|parseV1Record|parseLegacy|LegacyReviewDraft|historicalProvenance|HistoricalInsightProvenance|configuration: "unavailable"|recentPrs' src tests
pnpm test -- --run \
  tests/storage/patchdesk-storage.test.ts \
  tests/storage/insight-store.test.ts \
  tests/storage/review-store.test.ts \
  tests/services/review-session-preparation.test.ts \
  tests/services/insight-run-coordinator.test.ts \
  tests/services/review-recovery-service.test.ts
```

Expected: no compatibility-parser matches; current round trips and explicit old
shape rejection tests pass.

### Step 8: Align current docs, fixtures, and language

1. Update `CONTEXT.md` only if any deleted terms remain outside its explicit
   `_Avoid_` lists. Keep Review, Review session, Analysis run, GitHub pending
   review, Finding review receipt, and Analysis review summary definitions.
2. Update active ADRs 0011–0017 so they describe current authority only:
   - ADR-0011: Finding status is actionable/pending/published/dismissed, not
     local-draft `added`.
   - ADR-0012: Files and GitHub pending-review authoring remain usable while an
     Insight runs; remove Review-draft and authorization revocation wording.
   - ADR-0013: remove "enter the Review draft" and publication authorization.
   - ADR-0014: keep its supersession history, but move completed one-time
     migration detail into an explicit historical note rather than current
     runtime instructions.
   - ADR-0017: recovery wording names merge, pending-review, direct-summary,
     observation, and preparation evidence only.
3. Retain superseded ADRs 0002, 0004, 0006, 0007, 0008, and 0010 as historical
   decision records, but add a clear superseded status/link where one is not
   already present. Historical records must not claim to be current authority.
   Retain ADRs whose decisions are current, including explicit Refresh history,
   retained Insight behavior, PR lifecycle, Analysis body structure, merge
   policy, independent Insights, bounded runs, pending review, Finding
   commands, Codex, and reconciliation.
4. Update `AGENTS.md` to remove the stale immutable Analysis publication
   exception while retaining the rule that every current GitHub write requires
   one explicit UI action. Update README architecture/write-safety text so it
   names the immutable
   Analysis result and explicit Finding commands, not publication
   authorization or a local draft.
5. Update fixtures and browser/design routes to remove submission, safe-run,
   and hidden-draft-only states. Keep fixtures for current pending-review,
   direct-summary, Insight, Refresh, Conversation, diff, and merge states.
6. Update `CHANGELOG.md` in its existing style with one user-facing bullet that
   says old local Review draft/run/update state was removed and current local
   records are the only supported schema. Preserve the existing uncommitted
   changelog edit.
7. Run a final source scan for `legacy`, `compatibility`, `deprecated`,
   `migration`, `old schema`, and `fallback`. Remove stale comments and
   compatibility branches. Do not delete current product vocabulary (for
   example the Analysis callout category `compatibility`) or the current
   evidence-gated Git diff fallback. If a match is current, rewrite any comment
   that incorrectly calls it legacy.

Do not rewrite `.agents/archive/**`. Historical artifacts may mention deleted
concepts.

**Verify**:

```bash
rg -n 'ReviewBatch|Review batch|local batch|local Review draft|Review updates|incremental review|completion action|publication authorization|Review Attempt|Review run|legacy batch|one-time migration' \
  CONTEXT.md README.md AGENTS.md docs/adr src/renderer/src/flows/app-fixtures.tsx
```

Expected: no stale current-authority statements. Matches are allowed only in an
explicit `_Avoid_` vocabulary list or an ADR sentence that identifies a deleted
historical decision without treating it as supported.

### Step 9: Run the complete gate and inspect the deletion

Run the tests in repository order. For renderer/desktop changes, use the full
ordered gate from `AGENTS.md`.

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
git diff --check
```

Expected: every command exits 0. If the full Vitest suite exposes the known
Walkthrough focus timing flake, rerun the exact failing test once. If it passes
alone, report both results; do not weaken the assertion.

Then inspect:

```bash
git status -sb
git --no-pager diff --color=never --stat
git --no-pager diff --color=never
```

Confirm that all source changes trace to this plan and the pre-existing dirty
renderer fix remains intact.

## Test plan

### Delete tests whose only subject is removed

Delete these files when their production subject is deleted:

```text
tests/domain/publication-authorization.test.ts
tests/domain/review-anchor.test.ts           # retain/move only direct fingerprint cases
tests/domain/review-comparison.test.ts
tests/domain/finding-lifecycle.test.ts
tests/domain/review-recovery.test.ts
tests/services/legacy-batch-discard-migration.test.ts
tests/services/unified-review-migration.test.ts
tests/services/review-batch-controller.test.ts
tests/services/review-submission-service.test.ts
tests/services/review-write-controller.test.ts
tests/services/publication-preview-service.test.ts
tests/storage/publication-authorization-store.test.ts
tests/services/review-execution-service.test.ts
tests/services/review-completion-service.test.ts
tests/services/review-failure-service.test.ts
tests/services/review-workflow-starter.test.ts
tests/services/review-run-coordinator.test.ts
tests/services/review-run-registry.test.ts
tests/services/run-projection.test.ts
tests/services/review-attempt-artifacts.test.ts
tests/services/review-comparison-service.test.ts
tests/services/review-workbench.test.ts
tests/storage/review-session-store-begin-attempt.test.ts
tests/renderer/review-draft-dock.ui.test.tsx
tests/renderer/publication-preview-dialog.ui.test.tsx
tests/renderer/safe-run-panel.ui.test.tsx
```

### Rewrite mixed tests

- `tests/domain/review-domain.test.ts`: remove batch, attempt, workflow input,
  legacy config, incremental, and prior-Finding cases. Keep current config,
  GitHub DTO, result, and ID parsing.
- `tests/storage/patchdesk-storage.test.ts`: test only the reduced current
  session/config schema and explicit rejection of old shapes.
- `tests/storage/insight-store.test.ts`: test schema 2 only and current
  provenance/concurrency fields.
- `tests/services/review-session-preparation.test.ts`: keep full preparation,
  deterministic resume, worktree, complete patch/context, journal, quarantine,
  and head-race tests; remove batch carry-forward and incremental cases.
- `tests/services/review-preparation-journal.test.ts`: keep crash cleanup;
  remove attempt state assumptions.
- `tests/services/model-review-runner.test.ts` and
  `tests/services/flue-cli-review-invoker.test.ts`: keep bounded full Analysis,
  immutable Git inspection, validation, cancellation, and error mapping; remove
  attempt/incremental fields.
- `tests/services/codex-insight-invoker.test.ts`: create a current provider
  boundary test that proves verified read-only worktree use and session-level
  prepared inputs without attempt, incremental scope, completion, or batch data.
- `tests/services/review-workbench-projection.test.ts`: keep represented
  Review, freshness, Conversation, checks, commits, Analysis/Walkthrough,
  pending review, direct summary, and merge readiness. Remove draft,
  attempt-recovery, and session-owned Insight fallbacks.
- `tests/services/review-recovery-service.test.ts`: keep invalid-entry,
  preparation-journal, and merge recovery. Remove batch publication and orphan
  attempt cases.
- `tests/services/maintainer-inbox-service.test.ts`,
  `tests/domain/maintainer-inbox.test.ts`,
  `tests/storage/maintainer-inbox-cache-store.test.ts`, and
  `tests/renderer/maintainer-inbox.ui.test.tsx`: assert current Review and
  Insight actions without Review updates or attempt states.
- `tests/local-api-auth.test.ts`, `tests/desktop-bridge.test.ts`, and
  `tests/browser/local-api-workbench.spec.ts`: assert removed routes are not
  registered/allowed and current routes remain protected.
- `tests/renderer/review-workbench-flow.ui.test.tsx`: preserve the existing
  uncommitted direct-summary regressions; remove DraftSlot/publication mocks;
  retain pending-review, direct-summary, Refresh, post-write observation,
  Finding command, and Insight tests.
- `tests/browser/review-workbench.spec.ts` and accessibility/performance tests:
  remove obsolete fixture selectors and keep current workbench coverage.

### Required new regressions

- Old session versions and old Insight version are rejected.
- Removed route names return 404 at the local API and are denied by the desktop
  bridge.
- A current Analysis can run through Pi and Codex providers without any attempt
  ID, Review run registry, completion action, or local batch.
- Insight run transport rejects a `completion` field, renderer Analysis sends
  no completion field, and no production composition configures a completion
  handler.
- An Analysis Finding can still Start/AddThread through the current pending
  review, and its receipt still locks duplicate Finding commands correctly.
- The Analysis summary still prefills only the Finish review modal for a
  Finding-backed pending review.
- Merge confirmation and merge recovery use the durable operation's `reviewId`,
  mark `Review.status` terminal without a session merge state, and retain the
  operation when terminal Review persistence fails.
- A current session/Insight record round-trips all current durable write and
  retained-result state.
- Explicit Refresh prepares a complete new session and does not carry local
  draft or incremental artifacts.

## Done criteria

All must hold:

- [x] `pnpm lint` exits 0 with no warnings.
- [x] `pnpm typecheck` exits 0.
- [x] `pnpm test -- --run` exits 0.
- [x] `pnpm build` exits 0.
- [x] `pnpm exec playwright test` exits 0, or one known timing flake is reported
      with an immediate isolated pass and no assertion weakening.
- [x] `git diff --check` has no output.
- [x] `ReviewSession` has one strict current persisted shape and no attempt,
      batch, incremental, session-owned Insight, or merge-terminal authority.
- [x] `InsightStore` accepts schema 2 only and has no `incidentId` or historical
      provenance fallback.
- [x] No startup or request-time migration runs.
- [x] No local batch/publication, Review Attempt/run, or Review updates route is
      registered or allowed by the desktop bridge.
- [x] Current pending-review, direct-summary, inline feedback, published
      feedback, Refresh/observation, merge recovery, and Insight tests pass.
- [x] Every durable merge operation contains its exact `reviewId`; direct and
      recovered merge paths delete it only after the terminal Review save.
- [x] Pi and Codex Analysis invocation tests prove no attempt, incremental
      scope, completion, or batch fields reach the provider boundary.
- [x] The Pi Analysis workflow still packages and builds.
- [x] The evidence-gated Git diff fallback tests pass.
- [x] The pre-existing uncommitted direct-summary changes remain present.
- [x] `AGENTS.md` no longer permits the unreachable automatic Analysis
      publication exception; current explicit Finding commands remain covered.
- [x] `plans/README.md` marks Plan 005 DONE with exact verification results.

Final inventory commands; each must return exit 1 with no output outside
historical `.agents/archive/**`:

```bash
rg -n 'ReviewBatch|batchContent|PublicationAuthorization|PublishWhenComplete|SaveAsReviewDraft|OpenPreviewWhenComplete' src tests
rg -n 'ReviewAttempt|ReviewAttemptId|currentAttemptId|ReviewCompleted|ReviewFailed|ReviewRun|SafeRun|/v1/reviews/run|/v1/runs/' src tests
rg -n 'incremental|Review updates|review_updates|ReviewComparison|compareRevisions|priorFindingAssessments' src tests
rg -n 'UnifiedReviewMigration|LegacyBatchDiscardMigration|reviewMigrationMarkerFile|batchDiscardMarkerFile|recordSchemaV1|parseLegacy' src tests
```

## Completion evidence

- Full current gate: `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run`
  (609 passed), `pnpm build`, `pnpm exec playwright test` (35 passed), and
  `git diff --check` passed.
- The four required removal inventories each exited 1 with no output.
- Focused final blocker proof passed 20 tests across Finding receipt locking,
  shared Insight coordination, and strict Insight storage.
- The isolated performance browser test passed after the full browser run.
- Read-only Electron QA after a main-process restart confirmed a represented
  Review, exclusive Conversation/Diff/Insights pressed state, separate cache
  and local-data cleanup controls, and empty fresh console and page-error
  buffers on CDP 9233.
- Independent follow-up review found no blocking issues and confirmed that all
  three earlier findings were resolved.

## STOP conditions

Stop and report; do not improvise if:

- Any in-scope dirty hunk cannot be separated from the pre-existing
  direct-summary work.
- A current renderer path still calls a route scheduled for deletion after the
  matching current replacement in this plan is applied.
- Removing Review Attempt would require deleting Pi Analysis,
  `FlueCliReviewInvoker`, `ModelReviewRunner`, Review Inspector tools, or
  `src/workflows/review-pr.ts` rather than only changing their input ownership.
- Removing batch code would require removing GitHub pending-review,
  direct-summary, direct inline comment, reply, thread state, published-feedback,
  or Finding receipt behavior.
- The inherited product-owner approval for removing the unreachable
  Analysis-completion publication path cannot be verified. In that case, STOP
  before changing the `AGENTS.md` hard rule.
- Removing incremental scope would require removing the full represented patch,
  `ReviewDiffSourceService`, or the fetched-ref proof that guards Git diff
  fallback.
- Refactoring `ReviewRecoveryService` cannot preserve merge outcome recovery,
  preparation-journal recovery, invalid-entry quarantine, and current write
  reconciliation.
- A current schema record produced by HEAD is rejected by the new strict parser.
- Old records would be silently deleted or rewritten instead of rejected or
  quarantined.
- Merge can be reported confirmed before `Review.status` is durably terminal,
  or merge recovery cannot resolve the exact Review from durable `reviewId`
  evidence.
- A verification step fails twice after one reasonable focused correction.
- The change requires touching an out-of-scope product area.

## Maintenance notes

- Review this as removal of competing authority, not a file-count exercise. A
  smaller source tree is not sufficient if a compatibility branch, hidden
  route, old DTO, fixture, or parser still accepts the removed concepts.
- Scrutinize `local-api.ts`, `ReviewSessionStore`,
  `ReviewWorkbenchProjectionService`, and `ReviewRecoveryService`. They are the
  highest-risk composition points and currently combine old and current paths.
- Keep session-level prepared artifacts. They are current immutable inputs for
  both Pi and Codex Insights, even though their original names came from the
  attempt architecture.
- `superseded` is a current Insight concurrency result, not legacy state. Do not
  remove it.
- Historical Finding review receipts are current safety evidence. Do not remove
  them.
- The fetched-ref Git diff fallback is current and evidence-gated. Do not remove
  it because its comments use the word "fallback".
- `.agents/archive/**` can retain historical terms. Current source, tests,
  current ADRs, runtime fixtures, and transport surfaces cannot.

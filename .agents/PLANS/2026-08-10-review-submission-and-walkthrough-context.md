---
created_at: "2026-08-10"
repos:
  - patchdesk
status: todo
research: .agents/research/2026-08-10-analysis-to-pending-review.md
---

# Improve review submission, Analysis Findings, and Walkthrough discussion context

> **Executor instructions:** Read this plan fully before editing. Preserve the one Review across revisions, immutable Review sessions, explicit Refresh, and the existing loopback/freshness/write-owner boundaries. Run every verification command named below. Do not make a GitHub write while implementing or testing unless the operator gives separate explicit authorization for a disposable PR and account.
>
> **Drift check:** `git diff --stat e4dde2d..HEAD -- <in-scope paths>`
>
> The working tree already contains an unrelated removal of the legacy Walkthrough controller and Design app. Do not revert, stage, modify, or depend on that work. This plan targets the durable Insight-run Walkthrough, the direct-summary review path, and the Analysis-to-pending-review bridge that remain in production.

This ExecPlan is the sole active implementation plan. Keep its Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective current while implementing.

## Purpose / Big Picture

After this work, a maintainer can assess a current Analysis result without leaving the Analysis screen: every mapped Finding shows its exact patch hunk, and one explicit **Add to review** action starts or appends the viewer's GitHub pending review. The same existing Finish review dialog remains the only place to publish the final review; Analysis can prefill its editable high-level summary once at least one Finding is in that pending review. A durable Finding review receipt makes the remote thread provenance visible and prevents duplicate comments without turning Analysis into a second draft or queue.

## Progress

- [x] 2026-08-11: Gathered repository and lifecycle context; moved completed task packages to `.agents/archive/` and recorded the active-artifact policy.
- [x] 2026-08-11: Grilled and documented the Analysis Finding and summary contract in `CONTEXT.md` and ADR-0015.
- [x] 2026-08-11: Added this implementation-ready Analysis bridge contract to the active ExecPlan; no production code changed.
- [x] 2026-08-11: Completed the direct-summary recovery, Insight cleanup, Analysis bridge, and Walkthrough slices. Full lint/typecheck/unit/build validation passed; scoped browser seam and read-only Electron QA passed. The full browser suite has pre-existing unrelated failures recorded below.
- [x] 2026-08-11: Implemented the direct-summary author preflight, repeat-submission semantics, durable recovery resolution, advisory capability projection, and shared-dialog recovery/success states; focused service/dialog tests pass.
- [x] 2026-08-11: Replaced redundant Insight controls and raw failure diagnostics with compact named empty/retry actions; focused workbench-flow tests pass.
- [x] 2026-08-11: Added schema-5 Finding receipt parsing/migration, receipt-aware pending-review operations, exact adapter-created-thread proof, and atomic Start/Submit/Discard receipt transitions; focused service and adapter tests pass.
- [x] 2026-08-11: Added receipt-derived current-Analysis action projection, strict Finding source transport on pending-review commands, and replaced Analysis-reader Add with a current mapped Finding pending-review command. Summary-only body and shared-dialog initial-summary support are in place; evidence-hunk and final action wiring remain.
- [x] 2026-08-11: Added exact complete-hunk extraction and read-only Finding evidence rendering, wired the Analysis-summary Finish action into the one shared modal, and removed Analysis run-dialog draft/publication completion choices. Legacy main-process routes/services still require dedicated deletion and audit.
- [x] 2026-08-11: Removed the obsolete Analysis batch completion wiring, loopback routes, desktop bridge routes, and dedicated Analysis draft/completion services and tests. Kept publication authorization storage because normal batch/refresh ownership still uses it.
- [x] 2026-08-11: Consolidated Findings in Insights → Analysis by removing the redundant Diff navigator tab, focused-Finding action path, PR Overview Finding CTA, associated fixture state, and persisted Finding-tab state. Kept read-only Diff annotations.

- [x] 2026-08-11: Added active-chapter context and an in-place Walkthrough section-focus mode. Focus hides only Insights-local chrome, preserves the reader, exits with Escape to the trigger, and makes no requests.

## Surprises & Discoveries

- Resolved: Analysis Finding actions use the typed GitHub pending-review command, and Analysis has no local-batch or completion action.
  Evidence: `src/renderer/src/flows/review-workbench-flow.tsx` creates only pending-review Start/AddThread commands; obsolete Analysis routes and services are deleted.
- Resolved: the pending-review adapter returns the exact newly created thread identity with the reread pending-review owner.
  Evidence: `src/adapters/github/github-adapter.ts` verifies REST-created comment identity through bounded read-back and receives the GraphQL thread ID directly.
- Observation: `FinishReviewDialog` already owns modal-local editable summary and decision state; it only needs an explicit initial-summary input, not a second Analysis-specific dialog.
  Evidence: `src/renderer/src/components/finish-review-dialog.tsx` resets `summary` and `event` whenever it opens.
- Observation: a REST review-create response exposes the created review comment node ID, which can be matched against the bounded owner read-back; an AddThread response returns the thread ID directly.
  Evidence: `src/adapters/github/github-adapter.ts` now requires and verifies that exact identity before returning success.
- Observation: `PublicationAuthorizationStore` remains a normal Review batch/refresh dependency, so deleting it with the Analysis-only services would remove an unrelated workflow.
  Evidence: source caller audit on 2026-08-11 found `ReviewBatchController` and `ReviewRefreshService` still own its lifecycle.
- Observation: the full Playwright suite currently has 24 unrelated browser/workbench/accessibility failures plus one borderline performance failure; the removed-route bridge case passes in isolation.
  Evidence: `pnpm exec playwright test` on 2026-08-11; `pnpm exec playwright test tests/browser/local-api-workbench.spec.ts --grep 'browser capability reaches every canonical Review route'` passed.

## Decision Log

- Decision: a current mapped Finding uses the existing pending-review Start/Add lifecycle, never the local `ReviewBatch` path.
  Rationale: ADR-0014 establishes one authoritative editable remote draft and gives this new surface proven freshness, serialization, receipt, and recovery behavior.
  Date/Author: 2026-08-11 / Matthew
- Decision: persist Finding review provenance beside the pending-review lifecycle in `ReviewSession`, not as renderer inference or an Analysis-side editable draft.
  Rationale: the receipt must survive Finish/Discard, record the exact GitHub thread, and be written with the pending-review state transition that confirms the remote write.
  Date/Author: 2026-08-11 / Matthew
- Decision: the Analysis summary opens the existing Finish review dialog with editable high-level text only; it never preselects a GitHub outcome or includes unselected Finding detail.
  Rationale: the maintainer keeps final publication control while the UI avoids a second summary draft/modal.
  Date/Author: 2026-08-11 / Matthew

- Decision: Walkthrough section focus is an in-place reading mode, not a route, modal, or duplicate document surface.
  Rationale: it must preserve the retained artifact, current section, evidence, and browser history while removing only nearby navigation chrome that competes with reading.
  Date/Author: 2026-08-11 / Matthew

## Outcomes & Retrospective


Follow-up UX cleanup, 2026-08-11: Findings are exclusively in Insights → Analysis; the redundant Diff navigator tab, focused-Finding action path, PR Overview CTA, fixture state, and persisted Finding-tab state are removed. Read-only Diff annotations remain. Validation passed: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run` (122 files, 1,016 passed, 1 skipped), `pnpm build`, `git diff --check`, and read-only Electron QA (`/tmp/patchdesk-diff-without-findings.png`, `/tmp/patchdesk-walkthrough-section-tooltip.png`).
Completed, 2026-08-11: direct summaries now preflight self-approval, preserve explicit repeat-submission semantics, and retain conservative recovery locks. Analysis Findings use exactly the existing GitHub pending-review lifecycle, with schema-5 receipt provenance and a shared Finish-review summary dialog; the obsolete Analysis batch/completion services and routes are gone. Current Walkthroughs receive only read-only, freshness-gated relevant Conversation annotations. Validation passed: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run` (122 files, 1,017 passed, 1 skipped), `pnpm build`, `git diff --check`, the scoped canonical-route Playwright case, and normal-profile read-only Electron QA on CDP 9233 (screenshots: `/tmp/patchdesk-insights-live.png`, `/tmp/patchdesk-walkthrough-live.png`; no console/page errors). The full `pnpm exec playwright test` remains unsuitable as a gate because it reported 24 unrelated browser/workbench/accessibility failures plus one borderline performance failure; the removed-route seam passed in isolation. No GitHub writes were made.

Follow-up Walkthrough UX, 2026-08-11: each active section now shows its derived chapter in a compact title-backed eyebrow. The local Focus section control expands the unchanged reader/evidence surface, hides only Insights-local navigation and document metadata, and returns focus to its trigger on Escape. Validation passed: focused UI tests, `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run` (122 files, 1,019 passed, 1 skipped), `pnpm build`, and `git diff --check`. Read-only normal-profile CDP QA on port 9233 confirmed the long chapter label, focus entry/exit, retained hunk controls, and main Workbench tabs (`/tmp/patchdesk-walkthrough-focus.png`, `/tmp/patchdesk-walkthrough-focus-exit.png`); no GitHub write was made.

## Status
## Status

- Priority: P1
- Effort: L
- Risk: HIGH — this changes visible GitHub-review write behavior and its uncertain-outcome recovery.
- Depends on: the completed direct-summary and pending-review lifecycle slices.
- Planned at: `e4dde2d` on `fix/inline-conversation-freshness-repair`

## Goal

Make the Review workbench truthful and useful in four related cases:

1. A maintainer who is also the pull-request author must learn before submission that GitHub will not accept an approval from that account.
2. A confirmed direct summary review must not permanently prevent that maintainer from later submitting another distinct GitHub review; only an in-flight or uncertain write may lock the path.
3. A Walkthrough may display relevant existing inline Conversation threads next to its cited diff hunks, but it must remain read-only and must never misrepresent stale or incomplete GitHub discussion as current.
4. A current mapped Analysis Finding may become one exact GitHub pending-review comment from the Analysis screen, with durable provenance and a shared Finish-review summary bridge, without reviving local batches or publishing unselected Finding detail.

The Review header action and its Approve/Comment/Request changes dialog already render outside the Diff tab, including while Insights/Walkthrough is selected. Do not move or duplicate that popup. Improve its state model and copy in place.

## Current state

### Direct summary review

- `src/domain/direct-summary-review.ts` defines one optional `DirectSummaryReviewState` per Review session: `WriteInFlight`, `OutcomeUnknown`, or `Confirmed`.
- `src/services/direct-summary-review-service.ts` persists operation intent before the GitHub write and receipt after it. This is correct and must remain. It currently blocks all later direct summary writes after a receipt:

  ```ts
  const existing = fresh.value.session.directSummaryReview;
  if (existing?._tag === "Confirmed") return err("review_already_submitted");
  if (existing?._tag === "OutcomeUnknown" || existing?._tag === "WriteInFlight")
    return err("outcome_unknown");
  ```

- The same service already re-reads the current PR and resolves the authenticated account before each write. `PullRequestSummary.author` is already populated from the REST pull request response's `user.login` in `src/adapters/github/github-adapter.ts`; no broad new PR-metadata fetch is needed.
- `src/renderer/src/flows/review-workbench-flow.tsx` stores the direct-summary projection locally, journals only a confirmed receipt for update detection, and turns timeout/ambiguous outcomes into `recovery_required`.
- `src/renderer/src/components/review-workbench.tsx` currently treats `confirmed` as `View submitted review`, and enables `Write review summary` only when direct summary state is `idle`.
- `src/renderer/src/components/summary-review-dialog.tsx` renders the confirmed receipt as a terminal screen. In recovery mode it renders a generic unknown-outcome warning and can render a second similar error below it.
- `src/renderer/src/api-client.ts` maps server failures to stable renderer-safe kinds. `src/main/local-api.ts` maps direct-summary failures to HTTP status. These two boundaries must gain any new stable error code together.
- `DirectSummaryReviewService.reconcile` currently collapses an empty read, one match, multiple matches, and a matching review outside its safe window into `undefined`, `Confirmed`, or the same retained `OutcomeUnknown`. The renderer projection then reduces every non-confirmed record to `recovery_required`. A recovery result must therefore carry a typed, durable reason before the dialog can truthfully distinguish “check again” from “manual resolution required”.
- The safe `openPullRequestExternalUrl` facility exists, but `SummaryReviewDialog` currently receives neither a pull-request reference nor an opener callback. The recovery dialog needs an explicit callback owned by the shared Workbench; it must not build or open an unchecked URL itself.

### Walkthrough and inline Conversation threads

- `src/renderer/src/components/narrative-walkthrough-diff.tsx` already renders cited hunk patches with `ReviewDiffView` and accepts `annotations`, but `ReviewWorkbenchFlow` currently passes no Conversation annotations into its `NarrativeWalkthrough` call.
- `src/renderer/src/components/review-workbench.tsx` builds `conversationAnnotations` from `model.conversation.inline?.threads`, maps them with `mapConversationThread`, and currently attaches direct GitHub mutation callbacks (reply, resolve/reopen, edit, delete) to the thread object.
- `src/renderer/src/inline-conversation-mapping.ts` is a pure mapping boundary. It rejects outdated, unanchored, binary, omitted, and incompletely mapped thread ranges.
- `src/renderer/src/components/narrative-walkthrough-diff.tsx` filters annotations by whether an annotation start line lies within a cited hunk. This is not an explicit policy for a multiline thread that merely overlaps a cited hunk.
- `ReviewWorkbenchProjectionService.project` substitutes `{ prDescription: "", entries: [] }` after a failed Conversation load, while snapshot-derived inline Conversation `complete` can be absent. For Walkthrough overlays, `complete !== true` is unavailable evidence, never proof of complete discussion.
- `ReviewInlineAnnotation` permits mutation callbacks. A data-only projection must use a distinct callback-free thread/annotation type, not the same type with callbacks omitted. It must include an `exact` or `partial` cited-hunk relation so `NarrativeWalkthroughDiff` can state the partial-overlap limitation without clipping a GitHub anchor.
- A retained Walkthrough's projection status alone is not the overlay predicate: a replacement failure can make the display status `failed` while its retained result still matches the represented immutable revision. The Flow must compare the retained walkthrough snapshot and workbench `{ sessionId, headSha, patchHash }` directly, require `artifactStatus === "verified"`, and separately require `fresh` review state before it adds discussion overlays.
- `CONTEXT.md` defines a Walkthrough as a guided explanation of a pinned revision, and a Conversation as GitHub-owned content. `docs/adr/0012-run-insight-types-independently.md` requires an old-revision Insight to remain readable as outdated after Refresh. `docs/adr/0013-keep-model-runs-bounded-and-non-authoritative.md` requires Walkthrough to remain tool-free and without a GitHub write surface.

### Evidence limits and implementation gates

- The 2026-08-10 direct-submission spike proves one successful Comment, Approve, and Request changes REST write, but does not explicitly prove sequential writes by the same account to one pull request. Treat repeat-submission behavior as source-tested but not live-validated until an operator separately authorizes the disposable-PR scenario in Step 7.
- GitHub's documented self-approval restriction supports the Approve preflight. The spike does not characterize Request changes by the PR author. Keep Request changes available unless and until that separately authorized characterization proves a host-independent rule.
- The prior note that the full Playwright suite has 24 production workbench/accessibility fixture failures is historical. Do not treat its count as a current baseline; record the actual failing test names and count when the planned full gate runs.

## Analysis-to-pending-review technical contract

### Goals, non-goals, and invariants

The user-facing goal is one explicit GitHub write for one current Mapped Finding. The Analysis reader displays the exact containing unified-diff hunk, expanded by default, highlights the verified anchor range, and never routes the maintainer to Files. A suggested comment is posted unchanged when present; otherwise the Finding explanation is posted unchanged. A confirmed rejection leaves the Finding actionable. A timeout, lost response, missing post-write identity, or failed receipt persistence is an uncertain outcome: it creates no actionable Finding state and locks conflicting writes until **Check GitHub again** reconciles it.

Only a current retained Analysis whose `{ sessionId, headSha, patchHash }` equals the represented Review and whose `revision.freshness === "fresh"` can expose evidence, Finding actions, or the Analysis summary action. Unmapped, invalid-line, dismissed, outdated, and artifact-mismatched Findings remain readable but cannot start or append a pending review. The normal Files composer remains unchanged.

The Analysis summary is not a review draft. It is high-level scope, change, verification, and proposed-verdict context, with no Findings section. It opens the existing Finish review modal only when the current pending review has at least one current pending Finding receipt; the maintainer can edit the text and must explicitly select Comment, Approve, or Request changes.

### Alternatives considered

1. Derive duplicate status by scanning the current GitHub pending-review body and anchors in the renderer. Reject this: comments cannot reliably identify their originating Finding, published reviews no longer have a pending owner, and an ambiguous read could re-enable a duplicate.
2. Store Analysis inclusion/status in `InsightRecord`. Reject this: it separates the receipt from the pending-review write intent and cannot make a remote success plus durable receipt one recovery-safe transition. It also risks reviving a local Analysis queue.
3. Extend the pending-review lifecycle with immutable Finding provenance in the durable `ReviewSession`. Choose this: `PendingReviewService` already serializes the write, persists intent before GitHub, persists confirmed state before success, and owns Submit/Discard transitions. The provenance is receipt-only metadata, never a local comment copy or editable draft.

### Recommended domain model and persistence

Add a dedicated value to `src/domain/pending-review.ts` and a validated optional receipt collection to `ReviewSession`:

    type FindingReviewSource = {
      readonly analysisRunId: InsightRunId;
      readonly findingId: FindingId;
      readonly sessionId: ReviewSessionId;
      readonly headSha: GitSha;
      readonly patchHash: ContentHash;
    };

    type FindingReviewReceipt = FindingReviewSource & {
      readonly threadId: GitHubThreadId;
      readonly pendingReviewNodeId: GitHubReviewNodeId;
      readonly state: "pending" | "published";
    };

    type PendingReviewOperation =
      | { readonly _tag: "Start"; readonly requestId: PendingReviewRequestId; readonly finding?: FindingReviewSource }
      | { readonly _tag: "AddThread"; readonly requestId: PendingReviewRequestId; readonly reviewId: GitHubReviewNodeId; readonly anchor: PendingReviewAnchor; readonly finding?: FindingReviewSource }
      | SubmitOperation
      | DiscardOperation;

    type ReviewSession = {
      readonly schemaVersion: 5;
      readonly pendingReview?: PendingReviewState;
      readonly findingReviewReceipts?: ReadonlyArray<FindingReviewReceipt>;
      // existing fields unchanged
    };

`FindingReviewSource` is validated against the represented session and supplied only by the new Analysis command. The session-store parser must accept schema versions 2–5, normalize older valid records to schema 5 with no receipts, reject duplicate receipt identities and receipts whose session/head do not match the Review session, and write schema version 5. A receipt's `threadId` must exist in the confirmed pending review when its state is `pending`; `published` receipts are retained historical provenance and must not contain comment body text.

At confirmed Start/Add, the service writes the new `PendingReviewState` and exactly one `pending` receipt in the same `sessions.save` call. At confirmed Submit, it changes receipts owned by that remote pending-review node from `pending` to `published` in the same save that clears `pendingReview`. At confirmed Discard, it removes only `pending` receipts owned by that node in the same save that clears `pendingReview`; published receipts remain. A Finding is actionable again after discard because its pending receipt is gone. A published receipt makes that exact `{ analysisRunId, findingId, sessionId, headSha, patchHash }` unavailable for the rest of that Analysis revision.

### Write and adapter contracts

Replace the generic successful Start/Add return with an explicit post-write receipt so the service never guesses a thread identity:

    type PendingReviewThreadWrite = {
      readonly review: ViewerPendingReview;
      readonly createdThreadId: GitHubThreadId;
    };

    startPendingReviewWithThread(...): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>>;
    addPendingReviewThread(...): Promise<Result<PendingReviewThreadWrite, GitHubWriteFailure>>;

For Start, the GitHub adapter obtains the REST-created review-comment identity, reads back the viewer's exact pending owner, and maps that confirmed comment to its GitHub thread. For AddThread, it obtains the mutation's returned thread ID, reads back the owner, and verifies that thread belongs to it. If either path cannot prove one created thread, it returns `unavailable`; `PendingReviewService` records `OutcomeUnknown` and reports no Finding receipt. The service must not use body equality, rendered anchor text, or a best-effort newest-comment heuristic as an identity substitute.

Add `finding?: FindingReviewSource` to the existing local API Start/Add command DTO, parse it strictly, and pass it only to `PendingReviewService.start/addThread`. The renderer never sends a raw GitHub thread ID, receipt, body transformation, or outcome. The command result remains the regular pending-review projection plus a renderer-safe Analysis Finding status projection.

### Projection and renderer contracts

The workbench projection must derive statuses from the retained current Analysis identity plus durable receipts, never from a local button click:

    type AnalysisFindingReviewStatus =
      | { readonly state: "actionable" }
      | { readonly state: "pending_review" }
      | { readonly state: "published" }
      | { readonly state: "locked" };

    type AnalysisReviewActionsProjection = {
      readonly findings: Readonly<Record<string, AnalysisFindingReviewStatus>>;
      readonly canFinishWithAnalysisSummary: boolean;
    };

`canFinishWithAnalysisSummary` is true only when the current Analysis identity has at least one `pending` receipt for `workbench.pendingReview.review.nodeId`. A manually started Files pending review with no current Finding receipt does not expose the action. Renderer codecs expose only status values and the boolean, never the receipt's remote identifiers. The Analysis reader uses `actionable` to render **Add to review**, `pending_review` to show **Pending review**, and `published` to show **Published**. It renders a bounded reconciliation message for `locked`, not an “awaiting refresh” state. The page action is **Finish review with Analysis summary**.

Refactor `renderAnalysisReviewBody` into a clearly named summary-only renderer or add `renderAnalysisReviewSummary`. Its section order is Review Scope, Pull Request Overview, Reviewed Changes, optional Verification, Verdict, and optional callouts/assumptions. It must omit `# Findings` and never enumerate all model Findings. The Analysis-flow action passes this string as `initialSummary` to the shared `FinishReviewDialog`; ordinary header Finish passes no initial summary. `FinishReviewDialog` resets its modal-local text to that optional initial value on open and still resets the event to `COMMENT`.

Add a pure domain helper that extracts the complete unified-diff hunk containing a verified `PendingReviewAnchor` from the represented patch, including its file header. Add a small read-only `FindingEvidenceHunk` renderer that passes that exact artifact to `ReviewDiffView` with `selectedRange`, no composer, no Conversation mutation callbacks, no source hydration, and no file navigation. If the hunk cannot be extracted, do not render a synthesized snippet and do not enable the Finding command.

### Call stacks and recovery

Current flow:

    AnalysisReader Add
      -> InsightsSlot.addFinding
      -> POST /v1/reviews/batch AddFindingInlineComment|AddFindingGeneralComment
      -> local ReviewBatch

Proposed successful Finding flow:

    AnalysisReader Add to review
      -> InsightsSlot.addFindingToPendingReview(finding)
      -> derive current Analysis identity + exact anchor + suggestedComment ?? explanation
      -> POST /v1/reviews/pending-review/command { Start|AddThread, expected, anchor, body, finding }
      -> PendingReviewService serializedWrite + ReviewWriteGate + live-head check
      -> persist WriteInFlight operation with Finding source
      -> GitHub adapter Start/Add returns owner plus createdThreadId
      -> persist Pending owner plus pending Finding receipt atomically in ReviewSession
      -> project Pending review status and canFinishWithAnalysisSummary
      -> AnalysisReader renders Pending review

Submit flow:

    AnalysisReader Finish review with Analysis summary
      -> renderAnalysisReviewSummary(current result, current scope)
      -> shared FinishReviewDialog { initialSummary }
      -> maintainer edits text and chooses event
      -> existing Submit command
      -> persist pending receipts as published while clearing pending owner
      -> AnalysisReader renders Published without a refresh

Discard flow:

    shared FinishReviewDialog Confirm discard
      -> existing Discard command
      -> persist None and remove receipts for that pending owner
      -> current mapped Findings become actionable again

Failure and idempotency flow:

    confirmed GitHub rejection -> restore last confirmed owner, no receipt, Finding remains actionable
    unavailable write / absent createdThreadId / receipt-save failure -> OutcomeUnknown with Finding source, no receipt, lock all conflicting Finding commands
    Check GitHub again -> read viewer pending owner; create the receipt only if the persisted operation and remote result prove the exact created thread, otherwise retain OutcomeUnknown and direct the maintainer to reconcile manually

No path retries the write automatically. Explicit Refresh changes the represented revision; the old Analysis may remain readable but receives no evidence hunk, Finding action, or summary action.

### Files and RGR TDD slices

Change `src/domain/pending-review.ts`, `src/domain/review-session.ts`, and `src/adapters/storage/review-session-store.ts` for the typed receipt and schema-5 parser/migration. Change `src/adapters/github/github-adapter.ts` and its fake/test seam for post-write thread identity. Change `src/services/pending-review-service.ts` and `src/services/review-workbench-projection.ts` for transactional receipt state transitions and safe projection. Change `src/main/local-api.ts`, `src/renderer/src/renderer-contracts.ts`, and `src/renderer/src/flows/review-workbench-flow.tsx` for strict command and projection transport. Change `src/domain/patch.ts` plus a focused renderer component for exact-hunk extraction/rendering. Change `src/services/analysis-review-body.ts`, `src/renderer/src/components/analysis-reader.tsx`, `src/renderer/src/components/finish-review-dialog.tsx`, and `src/renderer/src/components/review-workbench.tsx` for the Analysis-only UI bridge. Delete the Analysis-owned `ReviewBatch` command/completion paths, their routes, test fixtures, and the no-longer-reachable `AnalysisDraftService`/publication-authorization integration only after a repository-wide caller search proves no remaining owner; do not keep aliases.

Use vertical Red-Green-Refactor slices: first fail domain/storage tests for receipt validation and Submit/Discard transitions; then adapter/service tests for exact created thread and unknown lock; then projection/API codec tests; then Analysis reader/Finish-dialog tests; then the end-to-end renderer flow. Keep direct-summary and Walkthrough tests intact while adding focused Analysis coverage.

## Commands and proof surface

Run focused tests first, then the normal gate:

- `pnpm test -- --run tests/services/direct-summary-review-service.test.ts`
- `pnpm test -- --run tests/domain/pending-review.test.ts tests/adapters/storage/review-session-store.test.ts tests/adapters/github-adapter.test.ts tests/services/pending-review-service.test.ts`
- `pnpm test -- --run tests/renderer/summary-review-dialog.ui.test.tsx`
- `pnpm test -- --run tests/services/analysis-review-body.test.ts tests/renderer/analysis-reader.ui.test.tsx tests/renderer/finish-review-dialog.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx`
- `pnpm test -- --run tests/renderer/inline-conversation-mapping.test.ts tests/renderer/narrative-walkthrough-diff.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test -- --run`
- `pnpm build`
- `pnpm exec playwright test`
- `git diff --check`

For production renderer or main-process changes, restart the Electron app before live checking. Use `patchdesk-electron-tester` for read-only CDP validation. The historical full-Playwright failure count is unverified; record the current failing test names and count, then preserve any unrelated failures rather than weakening or deleting those tests.

## Scope

In scope:

- `src/domain/direct-summary-review.ts`
- `src/domain/pending-review.ts`
- `src/domain/review-session.ts`
- `src/domain/patch.ts`
- `src/adapters/storage/review-session-store.ts`
- `src/domain/github-context.ts` only if a small renderer-safe decision-capability type belongs there
- `src/adapters/github/github-adapter.ts`
- `src/services/direct-summary-review-service.ts`
- `src/services/pending-review-service.ts`
- `src/services/analysis-review-body.ts`
- `src/services/review-workbench-projection.ts`
- `src/main/local-api.ts`
- `src/renderer/src/api-client.ts`
- `src/renderer/src/renderer-contracts.ts`
- `src/renderer/src/flows/review-workbench-flow.tsx`
- `src/renderer/src/components/review-workbench.tsx`
- `src/renderer/src/components/analysis-reader.tsx`
- a focused Analysis Finding evidence-hunk renderer, if `ReviewDiffView` cannot receive the exact hunk without Walkthrough-specific coupling
- `src/renderer/src/components/review-diff-view.tsx`
- `src/renderer/src/components/summary-review-dialog.tsx`
- `src/renderer/src/components/finish-review-dialog.tsx`
- `src/renderer/src/inline-conversation-mapping.ts`
- `src/renderer/src/components/narrative-walkthrough.tsx`
- `src/renderer/src/components/narrative-walkthrough-diff.tsx`
- `src/renderer/src/external-links.ts`
- `tests/renderer/review-diff-view.ui.test.tsx`
- focused domain, session-store, GitHub adapter, pending-review service, Analysis reader, Finish-dialog, workbench-flow, and browser tests
- `tests/browser/local-api-workbench.spec.ts`
- focused service, projection, renderer, and browser tests
- `.agents/PLANS/README.md`

Out of scope:

- Moving the existing review-summary popup into a Walkthrough-specific component. It is already a shared Workbench header action.
- A Finding command for unmapped, invalid-line, dismissed, outdated, or artifact-mismatched Analysis evidence.
- Bulk publishing or automatically selecting multiple Findings from Analysis.
- Publishing every model Finding in the Analysis summary, choosing a GitHub decision from the Analysis verdict, or persisting the modal summary as an Analysis draft.
- Any reply, resolve/reopen, edit, delete, inline composer, pending-review, or direct GitHub write from Walkthrough.
- A second editable local review draft, auto-retry, polling, background refresh, or a write that bypasses `ReviewWriteGate`/`ReviewWriteCoordinator`.
- Treating GitHub's current state as a replacement for the represented Review without an explicit Refresh.
- Disabling `REQUEST_CHANGES` for the PR author based only on an assumption. GitHub documentation clearly establishes the self-approval restriction; characterize Request changes separately before encoding a client-side rule.
- The legacy Walkthrough/Design deletion already present in the worktree.

## Steps

### 1. Characterize and expose review-decision capability without trusting the renderer

Add a small renderer-safe direct-summary capability to the Workbench projection. It must identify whether Approve is `allowed`, `blocked_author`, or `unknown`.

Derive this **advisory** capability without a new GitHub request in every projection mode: compare the existing workspace profile's configured `ghAccount` to `PullRequestSummary.author` case-insensitively. Refactor `loadSession` to return the already loaded `{ profile, session }`, then pass that profile through `loadLocal`, `loadRepresented`, and live `load` into the shared projection method. If either profile account or represented PR author is absent, emit `unknown`; never infer `allowed` from absence. This lets an Insights/Walkthrough projection explain the known self-approval restriction without making Workbench load depend on account resolution.

The capability is advisory only. `DirectSummaryReviewService.submit` must still resolve the authenticated account and compare it with the freshly re-read PR author immediately before the GitHub mutation. It must never accept author identity from the renderer.

In `DirectSummaryReviewService.submit`, after freshness/current-head checks and authenticated-account resolution, reject an author attempting `APPROVE` with a new typed failure such as `self_approval_not_allowed` before persisting an operation or calling the GitHub write adapter. Map it through local API status, `PatchdeskApiError`, renderer error copy, and strict renderer codecs. Use bounded copy:

> You can’t approve your own pull request. Choose Comment or ask another reviewer to approve it.

Update the summary dialog to disable Approve with this explanation when the capability is known. Keep its decision control accessible and usable for permitted choices.

Before adding any equivalent Request changes restriction, add a controlled, separately authorized GitHub characterization result. If the result differs by GitHub host, organization rule, or API behavior, stop and report instead of hard-coding a universal rule.

**Verify:** add service tests proving self-approval is rejected before intent persistence or `createDirectSummaryReview`; projection/contract tests for allowed, author-blocked, and capability-unavailable states; renderer tests for disabled Approve and safe explanatory copy.

### 2. Replace the one-confirmed-review lock with an operation lock

Keep the durable `WriteInFlight` and `OutcomeUnknown` states as exclusive locks. They are the duplicate-write protection and must continue to require explicit reconciliation.

Give `OutcomeUnknown` a renderer-safe durable `resolution` marker: `check_required` when the outcome has not yet been safely reconciled, and `manual_resolution_required` when a complete reconciliation finds multiple candidates or a candidate outside the bounded recovery window. Parse existing persisted `OutcomeUnknown` records as `check_required`; this is a state interpretation default, not a data migration. Extend `DirectSummaryReviewProjection` and its strict renderer codec to return `state: "recovery_required"` plus the same required `resolution` marker. A complete read with no candidate remains the only path that clears the operation and restores `idle`; one exact in-window candidate becomes `Confirmed`; ambiguous evidence stays locked and persists `manual_resolution_required`. Do not infer the resolution from an unqualified `recovery_required` response.

Change `Confirmed` semantics from “this Review can never submit again” to “this was the most recently confirmed direct-summary receipt.” On a new explicit submission, permit `Confirmed` to be replaced by a new `WriteInFlight` operation. Fetch a fresh complete baseline of the viewer's prior direct summary reviews for that operation, so recovery identifies only the new post-baseline candidate.

Do not delete receipt persistence before the renderer receives confirmed success. A crash or failed persistence after the remote response must still become `OutcomeUnknown`. Preserve the existing per-Review write coordinator and exact freshness/head checks for every new submission.

Remove the obsolete `review_already_submitted` service/API/renderer branch only after all callers are migrated; do not leave an alias or compatibility fallback. Existing persisted `Confirmed` records need no data migration: the new service simply permits the next explicit submission to overwrite that retained latest receipt with its new operation state.

**Verify:** replace the existing test named `does not create another review after a confirmed direct summary` with a test proving the second submission writes once, uses a baseline containing the first receipt ID, and replaces the session state with the second receipt. Retain tests proving in-flight/unknown operations block writes, concurrency blocks the second caller, and recovery never retries automatically.

### 3. Make summary success and uncertain recovery understandable

Refactor `SummaryReviewDialog` so remote lifecycle state and local dialog presentation are distinct:

- A normal open starts at the compose form when no operation is active/uncertain, including after an older confirmed receipt.
- Immediately after a successful submission, show the local success receipt with the decision and review ID. Offer **Close** and **Write another review**. The latter starts a fresh compose interaction and requires the normal write preflight again.
- For `recovery_required`, replace two competing destructive-red errors with one amber state:

  - title: **Review submission needs confirmation**
  - body: **Patchdesk did not receive confirmation from GitHub. Your review may already have been published. To avoid posting a duplicate review, submission is paused until GitHub is checked.**
  - primary action: **Check GitHub status**
  - secondary actions: **Open pull request on GitHub** (reuse the existing safe external-link facility) and **Close**
  - explanatory text: checking either confirms the review, restores a safe submit state, or identifies manual resolution.

- If the check itself fails, keep the `check_required` state and say only that the check did not submit another review. Do not replace it with a generic “submit again” instruction.
- If reconciliation returns `manual_resolution_required`, show a distinct manual-resolution state and direct the user to GitHub. Use bounded copy that does not claim the reason was multiple matches: both multiple in-window candidates and an out-of-window candidate require manual resolution. Never expose raw provider errors, paths, commands, or response bodies.
- Pass an `onOpenPullRequest` callback from `ReviewWorkbench` through the direct-summary action model. It must call the existing `openPullRequestExternalUrl(pullRequestPageUrl(pr).toString(), pr)` facility and be available only when `pullRequestExternalRef(model)` succeeds. The dialog must show **Open pull request on GitHub** only in recovery/manual-resolution states and must not construct URLs or accept a raw URL prop.

Update `PendingReviewHeaderAction` so an older confirmed direct summary does not replace the entry point with a terminal “View submitted review” action. The header must still use the single existing summary dialog and must remain available from Insights/Walkthrough.

**Verify:** expand `tests/renderer/summary-review-dialog.ui.test.tsx` for success receipt, Write another review, one recovery message, primary/secondary actions, failed recovery, and no Submit control while uncertain. Expand flow tests to prove a second confirmed direct review is journaled as a new exact receipt and the header is available from Insights.

### 4. Make Insight actions compact, specific, and non-diagnostic

Refactor the empty and failed Insight states in `src/renderer/src/flows/review-workbench-flow.tsx`; do not change `InsightRunCoordinator`, model selection, polling, cancellation, or the run dialog's behavior.

- In `InsightEmpty`, replace the generic full-width-looking **Run** control with a standard-sized, intrinsic-width primary button aligned to the start of the copy. Use **Generate analysis** or **Generate Walkthrough** based on Insight type. Keep the action next to the explanation, within a readable-width empty state; do not stretch it across the reader.
- Remove the redundant **Open Analysis** header action. When Analysis is already selected, it currently selects the same Insight again. There must be one entry point for an empty Insight: the named action in its empty state.
- In `InsightFailed`, use an amber warning treatment when a retained result remains readable. State that the latest attempt did not complete and the saved Insight remains available. Use one compact **Try again** button, which opens the existing run dialog. Do not render both a header regenerate action and a failure-state retry action for the same state.
- Remove the generic “No additional failure details are available” copy and the inline raw `Correlation ID`. If support needs a reference, expose only an explicitly requested, redacted reference through an existing safe support/diagnostic mechanism; do not display host, repository, PR, session, run, prompt, path, or provider details in the reader.
- Retain the existing disabled/loading behavior and model/reasoning selection. Use **Regenerate** only where a current retained Insight is intentionally being replaced; use **Try again** for a failed attempt.

**Verify:** add focused renderer tests for Analysis and Walkthrough empty states, checking the exact named action, no full-width button class/style, and no redundant header action. Add failed-state tests proving one retry action, retained-result warning copy, and no visible correlation ID or generic diagnostic filler. Run the same checks at narrow and wide browser widths; the control must remain intrinsic width and adjacent to its explanation.

### 5. Extract capability-free inline Conversation projection

Extract the data-only portion of `conversationAnnotations` from `ReviewWorkbench` into a pure projection beside `mapConversationThread`. Define a distinct callback-free annotation/thread type that contains only mapped thread identity, state, comment history, anchor, and completeness metadata. It must not be assignable to a type that carries reply, resolution, edit, delete, or authoring callbacks.

Adapt that data-only type to `ReviewInlineAnnotation` and attach direct-conversation mutation actions only at the standard Diff workbench boundary. The existing normal Diff surface must retain all current write affordances and its optimistic overlays. The read-only projection becomes reusable by Walkthrough without importing GitHub capabilities into an Insight reader.

Add an explicit cited-hunk overlap helper. A thread is relevant to a cited block only when it maps to the same path and side and its inclusive line range intersects that hunk's represented range. Return `exact` when the full mapped range lies inside the hunk and `partial` otherwise. Carry that relation on the callback-free Walkthrough annotation. For `partial`, `NarrativeWalkthroughDiff` renders bounded read-only copy that the thread overlaps the cited range; it does not clip, remap, or invent a narrower GitHub anchor.

**Verify:** expand `tests/renderer/inline-conversation-mapping.test.ts` for exact, partial, old-side, invalid, and outdated ranges. In `tests/renderer/review-diff-view.ui.test.tsx`, assert that the standard Diff receives `conversationActions` and exposes its existing action path. In a `ReviewWorkbench` or flow test, assert that `NarrativeWalkthrough` receives no callbacks while the standard `DiffWorkbench` receives the same `conversationActions` object.

### 6. Render read-only relevant threads in a current Walkthrough

In `ReviewWorkbenchFlow`, build Walkthrough annotations from the pure data projection only when all of the following are true:

- the retained Walkthrough exists and its own snapshot exactly matches the represented `{ profileId, sessionId, headSha, patchHash }`; do not use the display status alone;
- its stored artifact is `verified`;
- the Workbench has its represented full patch;
- the Review freshness is `fresh`;
- `model.conversation.inline?.complete === true`.

Pass those read-only annotations through `NarrativeWalkthrough` to `NarrativeWalkthroughDiff`. Do not pass `localCommentAuthoring`, `pendingReviewComposer`, or `conversationActions`.

When `complete` is false or absent, the artifact is unverified, or the immutable/freshness gate fails, withhold all Walkthrough discussion overlays and show bounded limitation copy in the reader, for example: **Inline discussion is unavailable or incomplete. Refresh GitHub state to check for replies.** Do not claim the thread history is complete. When a Walkthrough becomes outdated or updates are available, keep its generated prose and evidence readable per ADR-0012, but withhold discussion overlays rather than presenting them as current.

Provide an optional navigation-only action from a cited thread to the ordinary Diff/Conversation surface if it can reuse existing Workbench navigation without a second write path. If that navigation would require broad state coupling, omit it from this slice.

**Verify:** add `NarrativeWalkthroughDiff` UI tests proving only relevant citations render threads, partial-overlap disclosure is accurate, incomplete-state copy appears, and Reply/Resolve/Edit/Delete controls never appear. Add Workbench/flow tests proving normal Diff remains mutable, Walkthrough is capability-free, and stale/updates-available Walkthroughs omit live discussion.

### 7. Bridge current Analysis Findings to the GitHub pending review

Implement the technical contract above as a vertical feature slice before removing the obsolete Analysis batch path.

First, add the schema-5 `FindingReviewReceipt` parser/migration and domain transitions. The receipt must bind `analysisRunId`, `findingId`, represented session/head/patch identity, the exact GitHub thread ID, and the owning pending-review node ID. It contains no comment body. Add the Finding source to Start/Add operation intent so an uncertain Finding write remains identifiable during explicit reconciliation. Do not create an optimistic receipt in React.

Second, make the GitHub adapter return the exact created thread identity together with its reread `ViewerPendingReview`. Update `PendingReviewService` so a successful Finding Start/Add persists the remote owner and `pending` receipt in one session save; a confirmed rejection restores the prior owner with no receipt; unavailable/missing identity/persistence failure becomes the existing `OutcomeUnknown` lock. Reconciliation may create a missing receipt only when the stored operation and remote result prove the thread identity; otherwise it must retain the lock. On Submit mark the relevant pending receipts published in the same state transition; on confirmed Discard remove only the relevant pending receipts.

Third, project receipt status only for the current retained Analysis identity. Expose no GitHub IDs to the renderer. Use it to gate the Analysis summary action and to render **Add to review**, **Pending review**, **Published**, or bounded reconciliation copy. A normal pending review started from Files does not make the Analysis summary action appear.

Fourth, replace the current `InsightsSlot.addFinding` local-batch command with the typed pending-review Start/Add command. It must derive a fully verified anchor from the represented patch, use `suggestedComment ?? explanation` unchanged, and send the exact expected session/head/patch freshness tuple. Add a pure exact-hunk extractor and a read-only hunk renderer beneath each mapped Finding. Do not route into the File view, synthesize/clip code, or attach any composer/conversation write capability.

Fifth, add `initialSummary?: string` to the existing shared `FinishReviewDialog` action model. `ReviewWorkbench` still creates exactly one dialog. The standard header opens it without a value; **Finish review with Analysis summary** opens it with `renderAnalysisReviewSummary(...)`. Reset the modal-local summary to that initial text on open, reset the decision to Comment, and permit normal editing. Remove Analysis's completion options and Analysis-only local-batch add routes/UI/service wiring only after all surviving callers are moved; do not leave an alias or hidden compatibility fallback.

**Verify:**

- Add a pending-review service test that proves the receipt is saved only after a confirmed remote Start/Add with exact thread identity, then proves submit changes it to published and discard deletes only pending receipts.
- Add adapter tests for start/add identity read-back failure becoming unavailable, never a guessed thread.
- Add projection/renderer-codec tests for current `actionable`, `pending_review`, and `published` states; stale or manually started pending reviews must not expose summary action.
- Add Analysis reader tests for exact expanded hunk, highlighted range, fallback explanation, unmapped/non-current disabled state, pending/published status, and no Files navigation.
- Add Finish-dialog and flow tests proving both normal and Analysis entry points use the one dialog; only the Analysis entry pre-fills editable summary and neither path preselects a verdict.
- Characterize deleted batch/completion routes with a repository-wide search and remove their focused tests/fixtures in the same change.

### 8. Validate in the real surface and close out

Restart the Electron main process because service, local API, and projection code changed. Use read-only CDP QA to verify:

- the summary dialog is reachable from the Insights/Walkthrough screen;
- a current mapped Analysis Finding shows its exact hunk, starts/appends the pending review only after its explicit action, and changes to Pending review without navigating to Files;
- the Analysis summary action appears only after a Finding-backed pending review and opens the shared Finish review dialog with editable high-level text but Comment still selected;
- after submitting, the same Finding reads Published immediately; after confirmed discard it reads Add to review again;
- the PR author's Approve option has the correct disabled explanation;
- an old confirmed receipt does not suppress the next summary form;
- uncertain recovery has one amber explanation and no submit action;
- Walkthrough thread cards are visible only for current cited hunks and expose no GitHub write control;
- normal Diff conversation controls retain their existing behavior.

A live author-approval rejection, Request changes characterization, and repeated-summary write require an explicitly authorized disposable PR/account. Do not use the active PR, an owned pending review, or a production branch for those proofs.

## Test plan

- `tests/domain/pending-review.test.ts`: Finding-source operation parsing, exact receipt transition, published transition, discard removal, and uncertain reconciliation that cannot prove a thread remaining locked.
- `tests/adapters/storage/review-session-store.test.ts`: schema-2/3/4 normalization to schema 5, receipt parser rejection for duplicate or session/head-mismatched provenance, and no persisted comment body.
- `tests/adapters/github-adapter.test.ts`: Start/Add return a reread owner plus the exact new GitHub thread; missing or unverified identity is `unavailable`.
- `tests/services/pending-review-service.test.ts`: confirmed Finding Start/Add atomically saves receipt with owner, rejected commands preserve actionability, unknown writes create no receipt and lock, exact recovery creates receipt only when provable, Submit publishes, and Discard removes only pending receipts.
- `tests/services/review-workbench-projection.test.ts` and `tests/renderer/renderer-contracts.test.ts`: current identity projection, status parsing, no remote IDs in renderer data, and Analysis-summary eligibility only for a current Finding-backed pending review.
- `tests/services/analysis-review-body.test.ts`: the summary-only renderer omits every Finding while retaining scope/change/verification/verdict/callout text.
- `tests/renderer/analysis-reader.ui.test.tsx`: exact expanded evidence hunk/range, no file-navigation dependency, suggested-comment/explanation command body, pending/published labels, stale suppression, and action/error behavior.
- `tests/renderer/finish-review-dialog.ui.test.tsx` and `tests/renderer/review-workbench-flow.ui.test.tsx`: one shared dialog, Analysis-only editable prefill, default Comment decision, command transport, and no legacy batch/completion interaction.
- `tests/services/direct-summary-review-service.test.ts`: author preflight ordering, permitted second submission after confirmed receipt, baseline correctness, active/unknown lock, receipt persistence, exact reconciliation, durable `check_required` versus `manual_resolution_required`, and coordinator serialization.
- `tests/services/review-workbench-projection.test.ts`: renderer-safe decision capability is derived from existing local profile plus PR author for local, represented, and live projections; absent author/account produces `unknown` and does not fail the Workbench.
- `tests/renderer/summary-review-dialog.ui.test.tsx`: capability messaging, recovery hierarchy, success receipt, Write another review, focus, validated external-link callback, and controls disabled while locked.
- `tests/renderer/review-workbench-flow.ui.test.tsx`: strict local API results, exact-write journal entries, repeat-submit flow, and header reachability from Insights.
- `tests/renderer/review-workbench-flow.ui.test.tsx` and focused Insight renderer tests: empty Analysis and Walkthrough use one intrinsic-width named action; failed retained Insights use one compact retry, preserve readable retained content, and expose neither duplicate header actions nor raw diagnostic identifiers.
- `tests/renderer/inline-conversation-mapping.test.ts`: mapping, callback-free projection, and exact/partial overlap rules.
- `tests/renderer/review-diff-view.ui.test.tsx`: standard Diff still receives the adapted annotation plus mutation callbacks and exposes its existing write controls.
- `tests/renderer/narrative-walkthrough-diff.test.tsx`: relevant thread rendering, exact/partial disclosure, read-only behavior, incomplete/artifact limitation copy, and stale omission.
- `tests/browser/local-api-workbench.spec.ts`: narrow and wide rendered-empty Insight actions stay intrinsic width and adjacent to explanatory copy; this browser seam must use a seeded local API/desktop bridge and no GitHub write.
- Existing local-API and adapter tests: new typed failure parsing/status and no raw GitHub diagnostic exposure.

### 9. Compact Walkthrough context and in-place section focus

The chapter rail intentionally stays narrow, so it truncates long chapter and section names. The current reader heading names only the active section, which loses its chapter context. Add a compact, non-interactive eyebrow immediately above the active section heading in `NarrativeWalkthrough`:

```
CHAPTER · Create-plan rules extracted to the policy package
Eligibility and candidate-status decisions
```

Derive the chapter title from the active section rather than storing a second selected-chapter state. Use one muted, uppercase, single-line label with truncation and a full-text tooltip/title fallback. Do not repeat the chapter title in the rail, change retained Walkthrough content, or add a second reader header.

Add an explicit `Focus section` icon button beside the existing reader metadata (the hunk count/review controls). It enters an in-place focus mode whose state is owned by `InsightsSlot`, because that component renders the Insights navigator and document header around `NarrativeWalkthrough`. Pass a narrow `focused` value and callbacks into `NarrativeWalkthrough`; do not use a global store, URL state, or persisted review progress.

While focused:

- hide the Insights local navigator and document header; retain the main Workbench header/tabs so the user retains orientation and an escape path;
- hide the chapter rail and render the same retained section/evidence reader at full available width;
- retain the active section, generated prose, hunk controls, review state, and Previous/Next controls without remounting the reader;
- replace the trigger with `Exit focus` and retain an accessible pressed state;
- make Escape exit focus and restore focus to the trigger. When focus mode is off, Escape retains its existing behavior of returning focus to the section heading.

Use the existing responsive dock grid: focus mode switches it to one column and conditionally omits the rail. Do not invoke native Electron/fullscreen APIs, open a dialog, duplicate a Walkthrough route, or hide evidence because focus mode is transient. Entering and exiting may never trigger a GitHub, model, progress, or data-refresh request.

**Verify:**

- Add `NarrativeWalkthrough` tests for the full chapter eyebrow/title fallback, Focus/Exit copy, Escape focus restoration, a one-column focus layout, and stable active-section/evidence rendering across both toggles.
- Add a `ReviewWorkbenchFlow` test showing focused mode hides only Insights-local chrome while Workbench navigation remains present, and proves no network/progress callback occurs from either toggle.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx`, `pnpm test -- --run`, `pnpm build`, and `git diff --check`.
- Restart the Electron development app if a main-process change is introduced; otherwise use read-only CDP QA to verify a long chapter/section title, full-text tooltip, focus entry/exit, Escape, and preserved hunk controls at desktop width.

## Done criteria

- [x] PR author is already derived from existing PR metadata; no speculative broad metadata fetch was added.
- [x] A known PR author cannot submit Approve; the service enforces it independently of the renderer.
- [x] Request changes was left available for GitHub's normal safe server rejection; no unproven client-side restriction was added.
- [x] A confirmed direct summary receipt no longer blocks a later explicit direct summary review.
- [x] In-flight and uncertain writes remain locked, `check_required` and `manual_resolution_required` remain distinct, recovery never retries automatically, and only a complete no-match reconciliation restores submit.
- [x] A current mapped Finding renders its full represented evidence hunk in Analysis and can start or append exactly one pending-review thread from explicit maintainer action; no Finding action routes to Files or creates a local batch/draft.
- [x] The durable Finding receipt has exact run/finding/session/head/patch/thread provenance, is created only with confirmed remote identity, blocks duplicate publication on that revision, becomes Published on Submit, and is removed for its pending owner on confirmed Discard.
- [x] Rejected Finding writes remain retryable; uncertain write, missing thread identity, and failed receipt persistence create no receipt and remain locked until an explicit reconciliation can prove the remote thread.
- [x] Analysis summary appears only for a current Finding-backed pending review and uses the one shared editable Finish review dialog. It contains no unselected Finding list and never preselects a GitHub outcome.
- [x] Legacy Analysis batch Add/completion paths and their loopback routes are removed after callers migrate; no aliases, hidden compatibility flow, or unused Analysis draft service remains.
- [x] Empty and failed Insight states have one compact, specific action; no full-width generic Run button, redundant Open action, raw correlation ID, or generic diagnostic filler remains.
- [x] Recovery uses one amber explanation, a clear primary check action, and bounded manual-resolution guidance.
- [x] The existing shared Workbench summary action remains reachable from Walkthrough; no duplicate popup implementation exists.
- [x] Current Walkthroughs show only relevant, read-only Conversation threads with explicit partial-overlap copy; normal Diff retains the only thread-write actions.
- [x] Outdated, update-available, unverified-artifact, immutable-identity mismatch, or inline Conversation `complete !== true` state never appears as current Walkthrough discussion.
- [x] Focused tests, lint, typecheck, unit suite, build, browser suite, `git diff --check`, and read-only Electron QA have recorded outcomes.

## STOP conditions

Stop and report rather than improvising if:

- the direct summary write must share a state owner with a pending review or local editable draft;
- advisory author capability cannot be derived from the local profile and represented PR author without a new network request, or the final service check would expose credentials to the renderer;
- GitHub behavior for author Request changes is not proven but an implementation would hard-code a rejection;
- a second direct summary cannot be reconciled reliably from a fresh complete baseline and its durable operation identity;
- a Walkthrough thread overlay would require passing a GitHub mutation callback or direct writer into an Insight component;
- a current Walkthrough and represented Conversation cannot be proven to refer to the same session/head/patch;
- the implementation requires modifying the unrelated legacy Walkthrough/Design removal.
- a Finding receipt cannot be atomically persisted with its confirmed pending-review transition, or GitHub cannot provide/prove the newly created thread identity without a heuristic;
- removing the Analysis batch/completion path would delete a caller outside this plan's Review-drafting scope.

## Maintenance notes

- `directSummaryReview` is recovery evidence for the latest direct-summary operation, not the authoritative history of all published reviews. GitHub's published-feedback projection is the history.
- Any new GitHub review action must use the same freshness, exact-head, ownership, serialization, intent, receipt, and uncertain-outcome rules.
- Any future Insight surface may reuse only the capability-free Conversation projection. It must not become a second write surface.
- Reviewers should scrutinize error classification and state transitions more closely than visual copy: the safety property is that an ambiguous write can never be retried or mistaken for a confirmed rejection.
- Finding review receipts are durable provenance, not a local GitHub-comment mirror. Never persist a Finding comment body, synthesize a remote thread ID, or infer duplicate status from rendered text.

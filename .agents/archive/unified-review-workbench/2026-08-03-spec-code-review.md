# Unified Review Workbench Spec Code Review

Date: 2026-08-03
Target: current working tree at `3cfccf6`
Specification: `.agents/tasks/unified-review-workbench/spec.md`

## Verdict

The implementation is not ready for spec acceptance. The unified shell and several domain foundations are present, but core Electron routes, Analysis completion, GitHub-write ownership, merge, migration, publication recovery, and draft recovery still diverge from the approved contract.

This review found 10 P1 issues and 8 P2 issues. No P0 issue was found.

Severity meanings:

- P1: blocks a required end-to-end workflow, violates a safety boundary, or risks incorrect remote/durable state.
- P2: material missing or incorrect behavior that does not by itself corrupt remote state.

## P1 findings

### P1-1: The packaged Electron bridge rejects core workbench routes

- Spec: lines 242-267 require draft, publication, and Published feedback operations; lines 286-294 require those controls to work on the desktop surface.
- Evidence: `src/main/desktop-bridge.ts:34-75` omits publication preview/confirm, Published feedback edit/delete/dismiss, Finding add/dismiss, Walkthrough progress, and every `/v1/reviews/draft/*` route. `src/main/desktop-bridge.ts:145-147` rejects omitted routes as `invalid_input`. The local API defines them at `src/main/local-api.ts:604-702`, and the renderer already calls several at `src/renderer/src/flows/review-workbench-flow.tsx:213-225,415-425,485-495`.
- Impact: browser fixtures can pass while the packaged app cannot complete publication, mutate Published feedback, dismiss a Finding, or persist Walkthrough progress.
- Required correction: make the bridge allowlist match the exact protected workbench route surface and add bridge tests for every renderer call.

### P1-2: Analysis can supply its own final Finding mapping

- Spec: lines 210-218 and 223-228 say Patchdesk computes Finding mapping and postability after validating model output; the model cannot declare a Finding postable.
- Evidence: `src/services/insight-run-coordinator.ts:290-321` first accepts `parseReviewResult(value)` and returns it unchanged. That schema accepts `mappingStatus` at `src/domain/review-result.ts:143-160`. Patchdesk calls `mapFindingLocation` only when the first parse fails and the value falls back to `parseModelReviewResult`.
- Impact: a provider response shaped like the final schema can mark an invalid coordinate as `mapped`, bypassing the app-owned authority boundary used for draft generation and evidence navigation.
- Required correction: accept only the model-result schema from the invoker, always recompute every mapping from the immutable patch, and add an adversarial final-schema regression test.

### P1-3: Publication and merge bypass the stable Review freshness gate

- Spec: lines 177-184 and 259-277 require every GitHub write to use the represented Review, pause on `Updates available` or unavailable freshness, reject terminal Reviews, and recheck the exact head.
- Evidence: `ReviewWriteController` loads only profile, session, and draft revision (`src/services/review-write-controller.ts:24-29,94-109`). `MergeWriteController` is also session-owned (`src/services/merge-write-controller.ts:24-53`). `src/main/local-api.ts:269-284,337-357,403-416` wires `ReviewWriteGate` only into Published feedback, not publication or merge. The unused gate already checks terminal state, represented remote state, detected updates, current session, snapshot identity, and head consistency at `src/services/review-write-gate.ts:30-70`.
- Impact: a discussion/check update with an unchanged SHA, unavailable freshness, a foreign/non-current session, or a terminal Review can still reach publication or merge.
- Required correction: make publication and merge Review-owned operations under the shared gate and per-Review serialization, then perform the final live head check immediately before the write.

### P1-4: Reopening an existing Review can apply a new head without Refresh

- Spec: lines 43-52 and 177-193 require remote content to change only after explicit Refresh, with draft carry-forward from the current session.
- Evidence: `ReviewWorkbenchController.open()` always calls preparation (`src/services/review-workbench-controller.ts:64-102`). Unless the caller explicitly passes `previousSessionId`, a changed-head open prepares without the Review's current session as predecessor. It then advances the Review at `src/services/review-workbench-controller.ts:103-117` while reusing the old `representedRemote`. The test at `tests/services/review-workbench-controller.test.ts:59-65` explicitly expects changed-head open to advance.
- Impact: ordinary navigation can replace the visible revision, create inconsistent Review/remote identity, and orphan unpublished draft content outside the explicit refresh path.
- Required correction: existing Review opens must load the represented session. Only `ReviewRefreshService.refresh()` may prepare and advance a new session, always with the current session as predecessor.

### P1-5: Analysis completion actions run before the Analysis is retained

- Spec: lines 240-255 require a validated current Analysis to seed, preview, or publish a draft for that run.
- Evidence: `src/services/insight-run-coordinator.ts:271-274` invokes the completion handler before `completeInsightRun()` persists the retained result at lines 275-282. The handler calls `AnalysisDraftService.seedCurrent()` in `src/main/local-api.ts:295-305`, but `seedCurrent()` requires the retained Analysis at `src/services/analysis-draft-service.ts:123-143`.
- Impact: Save as Review draft, Open preview, and Publish when complete can fail because the result they need is not yet durable.
- Required correction: retain the validated candidate first, then execute the completion transition with identity and draft-CAS rechecks. Cover the real coordinator-to-draft integration for all five completion actions.

### P1-6: Publication authorization and unknown outcomes are not safely recoverable

- Spec: lines 251-267 require authorization bound to run/revision/draft identity, ordered durable receipts, idempotency, and frozen retries after partial or unknown outcomes.
- Evidence: `AnalysisCompletionService.consumeForPublication()` checks only authorization ID, session, head, and event (`src/services/analysis-completion-service.ts:31-40`), omitting patch hash, Analysis run, and expected draft revision. `ReviewWriteController` consumes authorization before apply/submit at `src/services/review-write-controller.ts:59-79`. In `applyReviewBatch`, a remote operation can succeed before its receipt is durably saved (`src/services/review-submission-service.ts:160-223`). On the final persist failure, the controller does not persist/freeze the unknown outcome (`src/services/review-write-controller.ts:83-90`), so a retry can plan the same remote operation again.
- Impact: authorization can drift to changed content, and an unknown outcome can replay a GitHub write.
- Required correction: validate the complete immutable authorization under the Review lock, persist intent before each write, persist each receipt immediately after success, and freeze/reconcile unknown outcomes before any retry.

### P1-7: Needs-attention drafts can bypass the publication block and have no recovery UI

- Spec: lines 186-193 and 242-247 require every unsafe anchor to remain under Needs attention until reattached, converted, or removed; publication must remain unavailable until all affected items are handled.
- Evidence: the backend already supports `RepairInlineAnchor` and `ConvertInlineToGeneral` (`src/services/review-batch-controller.ts:66-124,614-637`), but the renderer exposes neither operation. `src/renderer/src/components/review-batch-panel.tsx:203-206` shows only the item and Remove. Publication checks only _included_ Needs-attention items (`src/services/publication-preview-service.ts:35-42`; `src/services/review-submission-service.ts:236-239`), and the UI permits changing inclusion.
- Impact: the user cannot perform two required recovery actions and can exclude an unresolved item to bypass the all-items publication safety rule.
- Required correction: show original context and reason, wire exact reattach/convert/remove actions, and block preview/apply/submit while any Needs-attention item exists regardless of inclusion.

### P1-8: Merge is absent from the unified workbench and uses legacy readiness state

- Spec: lines 130-140, 170-171, and 269-277 require a PR Overview merge action with explicit SHA-bound confirmation and profile-scoped Analysis policy.
- Evidence: the unified flow passes `mergeAction: null` at `src/renderer/src/flows/review-workbench-flow.tsx:137-142`; the canonical overview is read-only. Backend projection computes readiness from `session.visibleResult`, not the retained current Insight, and never applies the profile policy (`src/services/review-workbench-projection.ts:308-310,436-459`). `MergeWriteController` also passes only `session.visibleResult` at `src/services/merge-write-controller.ts:42`.
- Impact: merge is unreachable from the required surface. If the legacy endpoint is called, current/dismissed/outdated Finding state and Advisory/Require acknowledgement/Block policy can be evaluated incorrectly.
- Required correction: project readiness from the current retained Analysis plus dispositions and profile policy, keep non-configurable GitHub/write blockers, and wire the confirmation dialog into PR Overview through the Review-owned merge service.

### P1-9: Migration does not preserve the required durable state

- Spec: lines 279-284 require one-time migration of drafts, receipts, retained Analysis, retained Walkthrough, immutable revision identity, terminal evidence, and bounded recovery state.
- Evidence: `UnifiedReviewMigration` only groups sessions and creates a new open `Review` pointer (`src/services/unified-review-migration.ts:22-46`). Migration runs only from `GET /v1/reviews` at `src/main/local-api.ts:626-647`, not direct open. With an `InsightStore` configured, projection prefers empty stored Insight records and can hide legacy `visibleResult` (`src/services/review-workbench-projection.ts:312-317,359-380`).
- Impact: direct opening can skip migration, legacy retained results can disappear, merged sessions can become open Reviews, and required recovery/receipt state is not converted.
- Required correction: implement a staged idempotent migration with artifact conversion, terminal evidence, marker-last commit, interruption recovery, and invocation before list/open/load projection.

### P1-10: Confirmed publication does not create the next empty draft

- Spec: lines 123-128 and 257-267 require confirmed content to move into GitHub-owned Published feedback and a new empty Review draft to become active.
- Evidence: `submitReviewBatch()` marks the same batch `Submitted` and stores it as `session.batchContent` (`src/services/review-submission-service.ts:82-98`). The renderer confirmation only patches that returned batch (`src/renderer/src/flows/review-workbench-flow.tsx:490-495`); it does not reload remote Published feedback or obtain a successor draft.
- Impact: submitted content remains the active dock, later feedback cannot start from a clean draft, and local submission state is confused with GitHub-owned feedback.
- Required correction: retain submitted intent/receipts as immutable evidence, refresh/reconcile GitHub-owned Published feedback, and create a distinct empty active draft only after confirmed complete publication.

## P2 findings

### P2-1: Analysis completion choices and default do not match the contract

- Spec: lines 249-255 require Save draft, Open preview, and Publish as Comment/Approve/Request changes for every run; Open preview is the default.
- Evidence: `src/renderer/src/flows/review-workbench-flow.tsx:170,286-306` defaults to `none` / Keep result only and exposes no Publish-when-complete choices. `src/renderer/src/hooks/use-insight-run.ts:94-110` invokes `onCompleted` for completed, failed, and cancelled statuses, so Open preview can trigger after a failed/cancelled run.
- Impact: three required actions are unreachable, the safe default is wrong, and failure can open a preview for a retained older result.

### P2-2: The persistent draft dock is absent or disabled in valid local-work states

- Spec: lines 107-118 and 172-193 require one persistent draft across Files and Insights, including while remote updates wait.
- Evidence: `DraftSlot` returns `null` when `workbench.draft` is absent (`src/renderer/src/flows/review-workbench-flow.tsx:430-443`), so a new Review without a stored batch has no draft entry point. The same flow maps all non-fresh states to `writeBlocked` at lines 497-501; `src/renderer/src/components/review-batch-panel.tsx:100,183-200` then disables local body, decision, inclusion, item, and inline editing.
- Impact: users cannot start manual feedback on an empty Review and cannot continue drafting after `Updates available`, even though only GitHub writes should pause.

### P2-3: Outdated Insights lack their required boundaries and recovery action

- Spec: lines 77-85 and 195-206 require readable Outdated content with its original revision, disabled evidence/draft actions, a warning, and `Run for latest revision` as the primary action.
- Evidence: retained Analysis and Walkthrough can be opened regardless of status at `src/renderer/src/flows/review-workbench-flow.tsx:299-331`. `AnalysisReader` has no Outdated warning or source revision (`src/renderer/src/components/analysis-reader.tsx:28-95`). Generic cards show `Regenerate`, and Walkthrough receives the current patch. Backend rejects some stale mutations, but the UI still offers them and reports a generic error.
- Impact: old evidence looks current and recovery is unclear.

### P2-4: Detection can permanently report false updates after Published feedback is stored

- Spec: lines 43-48 and 175-184 require `Updates available` only after positive evidence of newer GitHub state.
- Evidence: refresh stores snapshots with optional `publishedFeedback` (`src/services/review-refresh-service.ts:118-130`). Detection reconstructs a comparison snapshot without that field and compares the full hash at lines 78-90. `hashSnapshot()` includes every present field (`src/adapters/storage/review-remote-store.ts:130-132`).
- Impact: unchanged GitHub state can be marked updated after feedback exists, blocking all remote writes until a refresh that reproduces the same false signal.

### P2-5: Published feedback capabilities are hard-coded unavailable

- Spec: lines 124-128 and 257-267 require edit/delete/dismiss actions when GitHub permits them.
- Evidence: `GitHubAdapter.getPullRequestPublishedFeedback()` sets every `canDismiss`, `canEdit`, and `canDelete` to `false` at `src/adapters/github/github-adapter.ts:771-798`. The renderer correctly hides actions from those flags at `src/renderer/src/components/published-feedback.tsx:45-64`.
- Impact: required permitted mutations are never reachable through the production adapter.

### P2-6: The workbench omits required freshness and terminal presentation

- Spec: lines 37-50, 170-184, and 286-294 require visible last-refreshed state and unavailable terminal actions to be removed.
- Evidence: the header renders only a freshness label and snapshot SHA, not `revision.refreshedAt` (`src/renderer/src/components/review-workbench.tsx:164-185`). Refresh is always rendered and merely disabled for terminal Reviews at lines 174-183. Draft and Published feedback slots remain mounted at lines 245-249. User-facing copy still says `Starting a review is read-only` at `src/renderer/src/components/maintainer-inbox.tsx:367`, contrary to the canonical language decision at spec lines 156-161.
- Impact: users cannot judge when state was refreshed, and terminal Reviews still present a mode-like disabled-action surface.

### P2-7: Several required navigation and preview details are missing

- Spec: lines 56-68, 85-86, 123, 259-260, and 286-294 require Finding disposition, Walkthrough navigation to Files, exact preview actions, and focus restoration.
- Evidence: Findings always show a `Mapped` badge instead of open/added/dismissed disposition (`src/renderer/src/components/review-navigator.tsx:74-80`). Walkthrough `Back to files` only closes the reader and leaves the Insights tab selected (`src/renderer/src/flows/review-workbench-flow.tsx:331`). Insight detail uses booleans without opener focus restoration (`src/renderer/src/flows/review-workbench-flow.tsx:172-173,330-331`). Publication preview shows only a thread-action count, not the exact actions (`src/renderer/src/components/publication-preview-dialog.tsx:47-48`).
- Impact: triage state, navigation, keyboard continuity, and exact-write review are incomplete.

### P2-8: The required acceptance journey and safety matrices do not exist

- Spec: lines 296-313 require one protected loopback/browser journey through Files, Findings, Commits, Insights, Analysis, draft editing, detection, refresh/new revision, anchor recovery, publication, and terminal state, plus focused lifecycle matrices.
- Evidence: `tests/browser/local-api-workbench.spec.ts:20-57` only opens seeded workbenches and a publication preview. `tests/renderer/review-workbench-flow.ui.test.tsx` covers isolated projection/render slices. Existing service tests do not integrate the Review gate with publication/merge, coordinator completion with draft seeding, all merge-policy/disposition states, or publication unknown-outcome recovery.
- Impact: the focused suite is green while core workflows remain unreachable or unsafe.

## Confirmed strengths

- The renderer has one canonical `state: "review"` workbench with Files and Insights.
- Stable Review identity and represented remote snapshot types exist.
- Lightweight detection and explicit Refresh are separate service operations.
- Draft carry-forward code preserves unsafe anchors rather than deleting them.
- Insight records retain the latest successful result across running/failed replacements.
- Analysis inspection is bounded and Walkthrough generation is tool-free.
- The Analysis Review body renderer uses deterministic sections and Patchdesk-owned formatting.
- Published feedback mutations already use `ReviewWriteGate`; publication and merge should converge on the same ownership boundary.

## Verification

Passed:

```text
pnpm test -- --run \
  tests/services/review-write-gate.test.ts \
  tests/services/review-refresh-service.test.ts \
  tests/services/insight-run-coordinator.test.ts \
  tests/services/review-workbench-projection.test.ts \
  tests/services/unified-review-migration.test.ts \
  tests/services/review-submission-service.test.ts \
  tests/services/merge-write-controller.test.ts \
  tests/desktop-bridge.test.ts
```

Result: 8 files, 62 tests passed.

Also passed: a 10-file focused renderer/service set, 55 tests.

These results prove the current focused assertions pass. They do not satisfy the spec's integrated acceptance journey or invalidate the findings above; several tests currently assert the divergent behavior directly.

No implementation files were modified.

---
created_at: 2026-08-02
repos:
  - patchdesk
status: review
---

# Unified Review Workbench: Three-Agent Code/Spec Review

## Verdict

**Not ready for final acceptance.** Three independent read-only reviewers found the same set of high-confidence gaps around the Review-owned write boundary, merge lifecycle, Analysis completion, migration, terminal state, publication recovery, and Published feedback permissions. Passing unit and focused UI tests do not cover these cross-service paths.

## Review scope

Reviewers inspected:

- `.agents/tasks/unified-review-workbench/spec.md`
- All unified-workbench plans under `.agents/tasks/unified-review-workbench/plans/`
- Relevant ADRs under `docs/adr/`
- Current committed and uncommitted implementation and tests

The reviewers did not find repository-root `plan.md` or `progress.md`; those paths were not part of the supplied task artifact set.

## Findings

### Critical

#### C1. Publication, thread, Published feedback, preview, and merge bypass the Review freshness/write gate

- **Confidence:** High
- **Evidence:** `src/services/review-write-controller.ts:21-109`, `src/services/publication-preview-service.ts:31-42`, `src/services/merge-write-controller.ts:24-53`, `src/services/published-feedback-service.ts:45-65`, `src/main/local-api.ts:599-618,707-710`.
- **Requirement:** Spec “Refresh and freshness” and stories 16, 20, 74, 78, 82–84, 92; Foundation write-safety task; Feedback Tasks 3–6. Remote writes must stop when Updates available is set, freshness is unavailable, the Review is terminal, or the submitted session is not the Review’s current session.
- **Problem:** The renderer disables some controls, but the protected API and services accept session/profile identifiers and do not require `ReviewWriteGate.requireFresh()` against the stable Review. Preview accepts `reviewId` without validating it. Merge reads a session directly. Dismissal and other feedback writes do not recheck the exact represented head and capability.
- **Impact:** A capability-bearing caller can publish, mutate feedback, or merge after a detected update, against a non-current session, or for a terminal Review if the remote head happens to remain unchanged.
- **Fix direction:** Make all write operations Review-owned. Require `reviewId`, resolve the gate’s current session, require the session/head/patch/draft revision to match, hold the per-Review write lock, perform the final GitHub head check, and fail closed on terminal or unavailable state. Remove session-only public write paths. Add authenticated route tests for stale markers, terminal Reviews, cross-Review sessions, and head races.

#### C2. Merge is still a legacy session-only path and is unavailable from the unified workbench

- **Confidence:** High
- **Evidence:** `src/renderer/src/flows/review-workbench-flow.tsx:137-141`; `src/services/merge-write-controller.ts:24-53`; `src/services/merge-service.ts:47-63`; `src/main/local-api.ts:707-710`.
- **Requirement:** Spec stories 85–93; ADRs 0005 and 0011; Feedback Tasks 6–7. Merge must be an explicitly confirmed SHA-bound action using the current retained Analysis policy and then terminalize the stable Review.
- **Problem:** The workbench receives `mergeAction: null`. The backend reads `session.visibleResult`, not retained current Insight records, does not evaluate dismissed/open P0/P1 Findings under the configured policy, does not call the Review gate, and only saves the session after merge. The stable Review is not marked terminal.
- **Impact:** The required merge journey cannot be performed from the unified workbench, and the legacy endpoint can merge despite stale state, outdated Analysis, or blocked policy.
- **Fix direction:** Replace the session controller with a Review-owned merge service. Gate freshness, load current retained Analysis and dismissal state, bind acknowledgement to Review/session/head/run, recheck head, perform explicit confirmation, record terminal merge evidence, and expose the action in PR Overview.

#### C3. Reopening a Review can advance its session and orphan the active draft

- **Confidence:** High
- **Evidence:** `src/services/review-workbench-controller.ts:79-117`; `src/services/review-session-preparation.ts:441-460`.
- **Requirement:** Spec stories 14, 18, 71–74 and the Refresh/Draft carry-forward decisions. Opening an existing Review must preserve its represented snapshot and active draft; only explicit refresh may advance the session, with the current session as predecessor.
- **Problem:** `ReviewWorkbenchController.open()` always calls preparation. It only supplies `previousSessionId` when the request explicitly contains one, so reopening an existing Review on a changed head can create a new session without carrying the current draft.
- **Impact:** A normal open can replace `currentSessionId`, expose new remote content, and orphan unpublished feedback without an explicit refresh.
- **Fix direction:** Existing Review opens should load the represented snapshot/session without preparation. Move session advancement and carry-forward exclusively into `ReviewRefreshService.refresh()`, always using the Review’s current session as predecessor. Add reopen/new-head/draft-preservation tests.

### High

#### H1. Analysis completion invokes seeding/publication before retaining the Analysis

- **Confidence:** High
- **Evidence:** `src/services/insight-run-coordinator.ts:271-282`; `src/services/analysis-draft-service.ts:127-143`; `src/main/local-api.ts:295-305`.
- **Requirement:** Spec stories 66–78; Feedback Task 3. A successful current Analysis must be durably retained before Save, Open Preview, or authorized publication acts on it.
- **Problem:** The coordinator calls the completion handler before `completeInsightRun()` persists the retained result. `seedCurrent()` requires a retained Analysis, so newly completed Save/Open/Publish actions can fail or revoke authorization.
- **Fix direction:** Retain the validated candidate first, then execute the completion transition with identity/revision/CAS rechecks, or use one transaction-aware completion service. Add real integration coverage for all completion actions.

#### H2. Completion choices violate the required UI contract

- **Confidence:** High
- **Evidence:** `src/renderer/src/flows/review-workbench-flow.tsx:164-170,286-306`.
- **Requirement:** Spec stories 75–78 and ADR 0010. Each run must choose Save draft, Open preview, or Publish as Comment/Approve/Request changes; Open preview is the default.
- **Problem:** The UI defaults to `none` / “Keep result only” and does not expose any Publish-when-complete choices.
- **Impact:** Users cannot initiate the required per-run authorization flow and the safe default is wrong.
- **Fix direction:** Default to Open preview, expose the three publication event choices with one-run authorization copy, return and bind the authorization ID, and cover revocation/recovery states.

#### H3. Publication authorization is not revoked on draft edits and is only partially bound at confirmation

- **Confidence:** High
- **Evidence:** `src/services/review-batch-controller.ts:251-375`; `src/services/analysis-completion-service.ts:31-39`; `src/adapters/storage/publication-authorization-store.ts:43-57`.
- **Requirement:** Spec stories 77–79 and ADR 0010. Authorization must be immutable to the run/session/head/patch/draft revision and be invalidated by draft changes.
- **Problem:** Draft mutation has no authorization-store dependency or revocation step. Consumption checks authorization ID, session, head, and event but omits patch hash, Analysis run, and expected draft revision.
- **Impact:** An older auto-publication authorization can remain usable after the draft changes, or a successful run can lose its authorization under concurrent starts.
- **Fix direction:** Revoke armed authorization on every successful draft mutation. Use full `authorizationMatches()` binding under the Review write lock. Serialize authorization creation with same-type run arbitration and add concurrency tests.

#### H4. Confirmed publication leaves the submitted batch active instead of creating a new empty draft

- **Confidence:** High
- **Evidence:** `src/services/review-submission-service.ts:68-103`; `src/services/review-write-controller.ts:73-79`; `src/services/review-workbench-projection.ts:350`; `src/renderer/src/flows/review-workbench-flow.tsx:490-495`.
- **Requirement:** Spec stories 80–84; ADR 0006; Feedback Task 4. Submitted content must remain immutable evidence while a new empty local draft becomes active.
- **Problem:** Submission marks the same batch `Submitted`; no successor empty batch is created and no publication-evidence separation exists.
- **Impact:** Sent feedback remains the active editable surface, later feedback cannot start cleanly, and receipt reconciliation is incomplete.
- **Fix direction:** Preserve submitted batch and receipts as immutable evidence, create a distinct empty current-session batch only after confirmed completion, and add receipt-backed recovery for partial/unknown outcomes.

#### H5. Migration creates only a Review pointer and loses required durable state

- **Confidence:** High
- **Evidence:** `src/services/unified-review-migration.ts:22-46`; `tests/services/unified-review-migration.test.ts:12-27`; `src/services/review-workbench-projection.ts:312-317,359-390,473-509`.
- **Requirement:** Spec “Persistence and transition”; Feedback Task 8. Migration must preserve drafts, receipts, retained Analysis, retained Walkthrough, immutable identity, terminal merge evidence, profile policy, recovery state, and restart/idempotence behavior.
- **Problem:** Migration groups sessions and saves Review records only. It does not create Insight records, migrate Walkthroughs, migrate profile policy, preserve recovery state, create draft records, terminalize merged Reviews, or leave a marker-last recovery trail. Projection can therefore show `not_generated` where legacy `visibleResult` existed.
- **Fix direction:** Implement an idempotent staged migration with artifact conversion, profile-policy migration, terminal evidence, bounded recovery records, marker-last ordering, interruption handling, and multi-session/partial-write fixtures.

#### H6. Terminal Reviews still expose local draft and remote feedback actions

- **Confidence:** High
- **Evidence:** `src/renderer/src/components/review-workbench.tsx:176-183`; `src/renderer/src/flows/review-workbench-flow.tsx:430-505`; `src/renderer/src/components/review-draft-dock.tsx:28-42`; `src/renderer/src/components/published-feedback.tsx:36,53-63`; `src/services/review-batch-controller.ts:276-347`.
- **Requirement:** Spec stories 8–10; terminal-state invariant; UI Task 4 and Feedback Task 7. Terminal actions must be removed, not merely disabled.
- **Problem:** Refresh is rendered disabled rather than omitted. Draft and Published-feedback controls are still projected/rendered based mainly on freshness, and services do not reject terminal draft mutations.
- **Impact:** A merged/terminal Review can still appear editable or publishable.
- **Fix direction:** Omit refresh, draft editing, Insight runs, publication, feedback mutation, and merge controls for terminal Reviews. Enforce terminal rejection in every service/API boundary.

#### H7. Outdated Analysis remains actionable and lacks the required recovery UI

- **Confidence:** High
- **Evidence:** `src/renderer/src/flows/review-workbench-flow.tsx:215-231,299-331,391-399`; `src/renderer/src/components/analysis-reader.tsx:76-116`.
- **Requirement:** Spec stories 35, 41–47; Insights Task 6. Outdated evidence must be visibly bounded, non-mutating, and offer “Run for latest revision” as the primary recovery.
- **Problem:** Retained outdated Analysis is opened with Add/Dismiss callbacks. The reader does not show revision/outdated warning, and cards use generic Run/Regenerate actions. Active runs also lack the required bounded update warning.
- **Impact:** Stale evidence can mutate the current draft or dismiss Findings, contrary to the stale-analysis contract.
- **Fix direction:** Derive a current/outdated capability once, pass no mutating/navigation callbacks to outdated readers, show source revision and warning, and make Run for latest revision primary. Add active-run update warning coverage.

#### H8. Needs-attention anchors cannot be repaired or converted in the renderer

- **Confidence:** High
- **Evidence:** `src/renderer/src/components/review-draft-dock.tsx:28-42`; `src/renderer/src/components/review-batch-panel.tsx:203-206`; `src/services/review-submission-service.ts:55,106-110,150-153`.
- **Requirement:** Spec stories 71–74; Foundation Task 2; Feedback Tasks 1 and 7. Unsafe anchors require reattach, convert-to-body, or remove resolution before publication.
- **Problem:** The dock counts attention items, but the item renderer does not present their context/reason or repair actions. Existing commands are not reachable from the UI.
- **Impact:** Refresh can preserve an unsafe draft correctly, but users cannot resolve the publication block. Verify separately that exclusion cannot bypass the block.
- **Fix direction:** Show original context and reason, add exact-anchor reattach, convert-to-general-feedback, and remove actions, and ensure all `needs_attention` items—not only included ones—block publication.

#### H9. Published-feedback capabilities are not enforced at the write boundary

- **Confidence:** High
- **Evidence:** `src/adapters/github/github-adapter.ts:771-798`; `src/services/published-feedback-service.ts:17-65`; `src/renderer/src/components/published-feedback.tsx:45-52`.
- **Requirement:** Spec stories 82–84; Feedback Task 5. Mutations require the projected capability, authenticated permission, represented record, and fresh exact head.
- **Problem:** The adapter projects `canEdit`, `canDelete`, and `canDismiss` as false, so permitted actions are unavailable. Service edit/delete checks comment author text rather than projected capability. Dismissal writes without checking `canDismiss` or doing a final head check.
- **Impact:** The UI cannot offer required permitted operations, while a direct capable request can attempt operations the projection forbids; dismissal is missing freshness protection.
- **Fix direction:** Derive capabilities from authenticated permission evidence, reload the represented feedback record for each mutation, fail closed unless the exact action is allowed, and recheck head before edit/delete/dismiss.

#### H10. Every open Review does not receive a persistent empty draft

- **Confidence:** High
- **Evidence:** `src/services/review-workbench-projection.ts:350`; `src/renderer/src/flows/review-workbench-flow.tsx:441-443`.
- **Requirement:** Workbench composition and Feedback Task 1. Every open Review needs an empty current draft, including Reviews without Analysis or a legacy `batchContent`.
- **Problem:** The dock is rendered only when a parsable draft exists.
- **Impact:** A maintainer opening a new PR without Analysis or legacy draft cannot add general feedback or manual inline feedback.
- **Fix direction:** Persist `createEmptyReviewBatch()` during open/migration/refresh and always render the draft dock for open Reviews.

#### H11. Findings navigator does not show disposition

- **Confidence:** High
- **Evidence:** `src/renderer/src/components/review-navigator.tsx:76-94`.
- **Requirement:** Spec story 24. Each Finding row must show severity, title, file, line, and disposition.
- **Problem:** The row shows a hard-coded “Mapped” badge rather than open/added/dismissed disposition.
- **Fix direction:** Render projected disposition and cover all supported states in renderer tests.

#### H12. Walkthrough “Back to files” does not navigate to Files

- **Confidence:** High
- **Evidence:** `src/renderer/src/flows/review-workbench-flow.tsx:331`.
- **Requirement:** Spec story 47. The action must return to current Files evidence.
- **Problem:** The callback only closes the reader, leaving the primary Insights tab selected.
- **Fix direction:** Control the primary tab from the workbench and switch to Files, optionally focusing mapped evidence.

### Medium

#### M1. Repeated refresh detection can falsely report updates after Published feedback is stored

- **Confidence:** High
- **Evidence:** `src/services/review-refresh-service.ts:78-90,118-130`; `src/adapters/storage/review-remote-store.ts:103-105,130-132`.
- **Requirement:** Spec stories 12–16 and ADR 0001. Unchanged remote metadata must not create an Updates available marker.
- **Problem:** Stored snapshots include `publishedFeedback`, but the comparison snapshot omits it while hashing includes optional stored fields. The hashes diverge even with unchanged checks.
- **Impact:** Reviews can be permanently marked updated and writes unnecessarily blocked after feedback is loaded.
- **Fix direction:** Compare one canonical checks-only fingerprint, or construct both stored and comparison snapshots with identical fields. Add unchanged-after-feedback regression coverage.

#### M2. Remote updates disable local drafting instead of only blocking remote writes

- **Confidence:** High from the independent review; verify against current branch.
- **Evidence:** `src/renderer/src/flows/review-workbench-flow.tsx:113-116`; `src/renderer/src/components/review-batch-panel.tsx:100,187-200`.
- **Requirement:** Spec story 17. Local draft work remains available while remote updates wait; only GitHub writes are blocked.
- **Problem:** `writeBlocked` is used to disable local body edits, inclusion changes, and inline drafting.
- **Fix direction:** Separate local editability from remote-write freshness. Preserve local CAS draft commands while blocking publication/thread/feedback/merge operations.

#### M3. The Review draft/terminal projection does not fully separate submitted evidence from active state

- **Confidence:** High
- **Evidence:** `src/services/review-workbench-projection.ts:318-355`; `src/services/review-submission-service.ts:82-103`.
- **Requirement:** Spec persistence and transition rules, ADR 0006.
- **Problem:** The same session/batch is used for both submitted evidence and the active workbench draft, compounding H4 and making terminal/current-state projection ambiguous.
- **Fix direction:** Model immutable submitted evidence and a new active draft as separate durable records with explicit projection precedence.

#### M4. Focused tests create false confidence for the unified protected-loopback journey

- **Confidence:** High
- **Evidence:** `tests/browser/review-workbench.spec.ts` primarily uses static `#workbench-fixture` scenarios; `tests/browser/protected-loopback-workflow.spec.ts:30-144` covers profile/watchlist controls rather than Review open/refresh/Insight/publication/merge; `tests/renderer/review-draft-dock.ui.test.tsx:17-25`; `tests/services/publication-preview-service.test.ts:16-23`.
- **Requirement:** Spec testing decisions and Feedback Task 9.
- **Problem:** Passing tests do not prove seeded protected-loopback Review journeys, stale-write refusal, terminal behavior, publication recovery, permissions, outdated Insights, or keyboard/focus behavior on the real API path.
- **Fix direction:** Add the specified seeded browser journey plus service/API matrices for each write and lifecycle invariant, including 1280px/1440px accessibility checks.

### Low

#### L1. Terminal actions are disabled rather than removed

- **Confidence:** High
- **Evidence:** `src/renderer/src/components/review-workbench.tsx:174-190`.
- **Requirement:** Spec story 10. Unavailable terminal actions should be removed.
- **Problem:** Refresh remains visible in a disabled state.
- **Fix direction:** Omit terminal-inapplicable controls and ensure terminal drafts/publication cannot appear.

## Confirmed strengths

The reviewers independently confirmed these areas:

- Stable Review projection uses canonical `state: "review"` and stable Review identity.
- Renderer routing is Review-ID based and refresh does not change the destination.
- Remote snapshot persistence is content-addressed/atomic, and refresh structurally separates represented content from update detection.
- Draft anchor carry-forward preserves unsafe anchors as `needs_attention` rather than silently dropping them.
- Current Findings are filtered to mapped/current Analysis before Files navigation.
- Insight retention keeps prior successful output during running/failed replacement and detects outdated revisions.
- Insight inspection is bounded and tool-limited.
- Walkthrough generation is tool-free and schema-bounded.
- Deterministic Analysis body section ordering is implemented.
- Loopback origin/capability protection has focused coverage.
- The publication preview is main-process derived and confirmation-backed.

## Verification reported by reviewers

- `pnpm test -- --run`: 105 files / 658 tests passed in one review pass.
- Focused service/renderer/API review set: 6 files / 56 tests passed.
- Separate focused UI/API set: 8 files / 48 tests passed.
- `pnpm typecheck` passed in one review pass.
- `git diff --check` passed in one review pass.
- No files were modified by the reviewers.

## Recommended execution order

1. Replace session-only publication/feedback/merge boundaries with Review-owned freshness-gated services.
2. Fix Analysis retention ordering and completion-choice/authorization binding.
3. Implement terminal-state enforcement and merge terminalization.
4. Implement publication successor-draft and receipt recovery behavior.
5. Complete migration of durable artifacts and recovery state.
6. Implement stale Insight and Needs-attention repair UI.
7. Fix capability projection/enforcement and update-detection hashing.
8. Add protected-loopback/browser/API regression matrices, then rerun the complete acceptance gate.

---
created_at: "2026-08-09"
repos:
  - patchdesk
status: needs-validation
spec: .agents/tasks/inline-diff-conversations/spec.md
tech-spec: .agents/tasks/inline-diff-conversations/tech-spec.md
research: .agents/tasks/inline-diff-conversations/01-research-github-start-review-and-local-draft.md
---

# Plan 004: Make GitHub pending reviews the Review workbench draft

> **Executor instructions:** This plan replaces the local Review draft and its hidden bottom dock with a GitHub-native pending-review workflow. Do not implement the renderer first and fake remote state. First implement and test the approved legacy-data discard in Step 0, then run the disposable-PR API spike in Step 1; update the contract in Step 2 and stop if either gate invalidates it. All GitHub writes remain capability-protected, freshness-gated, exact-head checked where the spike proves it applies, and explicitly user-confirmed. Do not make live GitHub writes during ordinary automated or Electron QA.

## Status

- **Priority:** P0
- **Effort:** XL
- **Risk:** high — replaces the persisted Review draft lifecycle and adds remote pending-review recovery.
- **Step 0:** complete — `88c55e4` discards approved legacy `batchContent`; `ba2d5ad` records the decision in ADR-0014. Reported verification: migration tests, full unit suite, typecheck, lint, build, and performance spec passed.
- **Step 1:** partially complete — redacted evidence at `fbb91b4` proves the bounded reader, Start-with-first-thread, append, Submit, Comment-now rejection while pending, and create/add/submit lost-response reconciliation. Follow-up evidence at `dbacd62` proves normal-response Discard DELETE and bounded absence read-back. The product owner explicitly accepts the unvalidated timeout/lost-response Discard path only as persisted `OutcomeUnknown`, no automatic retry, locked conflicting controls, and explicit Check GitHub again reconciliation. Isolation with repository access, empty review, Reply/Resolve/Unresolve, and head-change behavior remain unproven.
- **Proven implementation:** complete in `0ba8679`, `7404c7e`, `5edd561`, `0358a84`, `0b52bdd`, `ff8b52a`, and `2b9d944`: pending-review domain/state, protected command/recovery routes, renderer header/composer/modal, capability tests, and confirmed-DELETE Discard with conservative `OutcomeUnknown` recovery.
- **Environment deviation:** the owner selected a real open-repository PR and their own account, not the planned sandbox/disposable PR and dedicated test account. The evidence records this deviation; no further GitHub writes or cleanup writes are authorized.
- **Depends on:** separate approval and an appropriate target for any additional live GitHub write. Isolation with repository access, empty review, Reply/Resolve/Unresolve, and head-change behavior remain out of the shipped scope.
- **Planned at:** `2ff270b` on `fix/inline-conversation-freshness-repair`.
- **Design direction:** GitHub’s review flow, as confirmed in the product grilling on 2026-08-09.

## Delivery checkpoint

- Proven scope verification: typecheck, lint, build, and performance spec passed; the full suite has 1014 passing unit/integration tests.
- Browser/a11y failures were confirmed against baseline `8cf049e`: 18 review-workbench, 2 protected-loopback, and 4–5 accessibility failures. They are fixture/workbench drift outside this implementation.
- Live Electron verification on 2026-08-09 used CDP 9233 after a required main-process restart. It confirmed the no-pending header, Diff navigation, and no-pending inline composer; no console/API errors occurred. Finish, Discard confirmation, pending composer, and recovery views require a pending owner and were intentionally not opened because creating one would be an unauthorized GitHub write.
- The approved lifecycle is complete. The plan remains `needs-validation` only for deliberately excluded work: isolation with repository access, empty review, Reply/Resolve/Unresolve, and head-change behavior.

## Product decisions

These decisions supersede the original inline-conversation specification’s immediate-only authoring rule and the original UI-only scope.

1. A GitHub **pending review** is the authoritative draft after the maintainer starts a review. It is not mirrored from a second editable local draft.
2. The workbench has one header action in Files and Insights: **Start a review** when none exists; **Finish review · N** when the signed-in reviewer has pending items. The hidden bottom dock is removed.
3. With no pending review, an inline composer offers **Comment now** and **Start a review**. The latter creates the pending GitHub review with the first inline comment. Once a pending review exists, the composer offers **Add review comment**.
4. Patchdesk discovers a viewer-owned GitHub pending review started elsewhere and presents it in the same Review flow. Its remote identity is tracked for recovery, but it is not shown as a separate ownership mode.
5. **Finish review** opens a GitHub-style modal: optional final summary, pending-comment list, Comment/Approve/Request changes choice, explicit submit, and explicit destructive discard. The summary is sent only with submission.
6. Analysis completion and Finding **Add to review** actions join the same pending review. They do not create or modify a competing local batch.
7. Patchdesk retains explicit Refresh. A new head shows Updates available; Refresh imports the current pending-review state and marks outdated anchors. New coordinate writes require the refreshed revision. Whether the existing pending review can then be submitted or discarded is an explicit validation-spike gate; until proven, Patchdesk preserves it for recovery and does not claim GitHub permits either action.
8. Reply, Resolve, and Unresolve join the pending-review flow only if the validation spike proves GitHub’s behavior and target identity are reliable. Otherwise this release preserves their current immediate path and records the limitation in the specification.

## Why this matters

The production workbench currently creates `DraftSlot` for every Review but mounts it in a permanently hidden `data-review-workbench-draft-dock` container. The resulting local Review draft can receive Analysis/Finding content, require recovery, and publish, yet has no normal reachable editor.

A visible dock alone is not the target. The selected design follows GitHub’s review mental model: review comments become remote pending items as they are created, and one header action leads to one finishing modal. This removes the confusing split between immediate inline conversation writes and a hidden local batch.

## Document and ADR impact

This direction conflicts with, and must formally supersede, parts of the current documentation:

- ADR-0002 requires local draft carry-forward and Needs attention after refresh.
- ADR-0004 requires a persistent shared bottom dock.
- ADR-0006 defines every editable Review draft as local until publication.
- ADR-0008 seeds a local draft from Analysis.
- ADR-0010 authorizes local-draft/preview completion actions and defaults to preview.
- Earlier versions of `.agents/tasks/inline-diff-conversations/spec.md` and `tech-spec.md` excluded pending reviews and required immediate direct comments; this package now replaces those requirements.

Add `docs/adr/0014-use-github-pending-reviews-for-review-drafting.md` rather than rewriting those historical decisions. It must name ADR-0002, ADR-0004, ADR-0006, ADR-0008, and ADR-0010 as superseded only for the Review-drafting surface. Update `CONTEXT.md`, the task spec, and tech spec to use **GitHub pending review** for the remote editable draft; retain **Review** for the end-to-end maintained evaluation. Update Analysis completion copy and its ADR references to name the new explicit start-review write.

## Step 0: Apply the approved local-batch data treatment

**Decision recorded 2026-08-09; implemented in `88c55e4`:** the product owner chose **discard** for every persisted legacy `batchContent` state: `Local`, `PendingReview`, `Applying`, and `PartialFailure`/outcome-unknown. Do not retain or export legacy local batch data, and do not silently publish or translate it into the remote pending review.

1. Implement one explicit migration path that removes the approved legacy local data without issuing a remote write or retrying an old operation.
2. Add migration tests for every legacy record class. They must prove deletion happens only through this approved migration, leaves no local draft projection or legacy recovery route, and never replays an uncertain GitHub write.
3. A known remote side effect is still GitHub-owned: the new bounded pending-review reader must reconcile it once the spike-proven reader exists. Local deletion is not proof that the remote outcome was absent.

**Stop condition:** do not replace the `ReviewBatch` owner, remove its storage, or delete batch UI/routes until the approved discard migration and its tests pass.

## Step 1: Run a bounded GitHub API validation spike

**Precondition:** use a disposable pull request and dedicated test account. Obtain separate explicit approval before performing these writes. Save only redacted request/response shape and outcomes under `.agents/research/`; never record tokens, PR URLs, comment bodies, command output, or account details.

Create adapter-level fixtures first, then run the following exactly once per stated operation:

1. Create a `PENDING` review with one inline comment through the current REST create-review path. Record REST id, GraphQL node id, viewer identity, commit SHA, and returned thread/comment relationships.
2. Load the review and its pending comments as the reviewer through the smallest candidate REST and GraphQL reads. Confirm that the query can identify `PENDING`, current author, full thread location, owning review, and complete versus incomplete results within an explicit bounded page policy. If the result is incomplete, it is unavailable—not proof that no pending review exists.
3. Attempt to create an empty `PENDING` review. If GitHub accepts it, confirm it has no final summary body and can receive a later inline thread. Then add an inline comment with GraphQL `addPullRequestReviewThread` bound to that review id. Confirm its reply/thread mapping and whether the current `reviewThreads` query exposes it.
4. Try the immediate REST inline-comment path while the pending review exists. Record the exact accepted/rejected outcome and GitHub error class.
5. Try a reply and Resolve/Unresolve while the review is pending. Confirm whether each becomes part of the pending review, a separately submitted review, or a rejected write.
6. Push a new head. Explicitly Refresh the read model, inspect anchor/outdated state, attempt an additional pending inline comment, and separately attempt review submission and discard. Record the actual result; do not enable stale-review submit/discard behavior unless it is proved.
7. Delete/abandon the pending review without submitting. Confirm that comments disappear and a new pending review can be started.
8. Repeat the read as a second account to establish visibility and ensure Patchdesk never imports another reviewer’s pending content.
9. Simulate one timeout/lost response for create, add-thread, submit, and discard. Confirm the smallest read-side reconciliation that distinguishes completed, absent, and unknown outcomes.

**Evidence update — `fbb91b4` and `dbacd62`:** the bounded authenticated reader, Start with first thread, append, Submit, Comment-now rejection while pending, and create/add/submit lost-response reconciliation are proven for the tested account/PR. `dbacd62` additionally proves normal-response DELETE of a pending review and bounded absence read-back. Lost-response Discard recovery was not authorized or tested; the product owner accepts its conservative, unvalidated `OutcomeUnknown` path with no automatic retry, locked conflicting controls, and explicit Check GitHub again reconciliation. Isolation with repository access, empty review, Reply/Resolve/Unresolve, and head-change behavior remain gated or out of scope.

**Stop condition:** do not ship any other unproven operation. A follow-up write run needs separate approval, a named appropriate target, and redacted evidence before its contract is added. Do not emulate a missing operation through local draft mirroring.

### Step-1 validation protocol

#### Authorization and environment gate

- Obtain written approval that names the disposable PR, dedicated test account, and the exact operations authorized for this run. A new operation or repeat requires new approval.
- Confirm the PR is disposable, open, and has a known baseline head. Do not use a production PR, maintainer account, or a PR with unrelated pending feedback.
- Run the candidate operations through the main-process adapter/test harness only. The renderer is not a GitHub client, and ordinary browser/Electron QA remains non-writing.
- Create fixtures and the redacted evidence template before the first write. A forced timeout must cut off only the client response after the request boundary; it must not issue a second mutation.

#### Evidence record

Store one redacted row per authorized operation under `.agents/research/`. Do not record bodies, PR URLs, account names, tokens, raw JSON, command output, or full IDs. Each row records only:

- operation label and one-time sequence number;
- baseline/current-head relationship;
- authenticated-viewer match: yes/no/unavailable;
- result: confirmed, rejected, unavailable, or outcome-unknown;
- whether the bounded reader returned complete, incomplete, none, or pending;
- which identities were available to the typed adapter (REST review, node review, thread, comment), expressed as present/absent rather than values;
- whether the result permits the proposed product action; and
- the required design disposition: implement, gate, or out of scope.

#### Execution matrix

1. **Reader baseline:** resolve the authenticated account and perform the candidate bounded pending-review read before any write. Prove `None` only with a complete result; incomplete, malformed, or foreign data must be `Unavailable`.
2. **Start with first thread:** create exactly one pending review with one valid selected inline range. Read it back as the same account and verify the minimum review/thread/comment identities and anchors needed by the typed contract.
3. **Import isolation:** repeat the bounded read as a second account. It must not expose or make actionable the first account’s pending content.
4. **Append thread:** use only the candidate append operation identified by the spike. Read it back and verify its parent review, thread/comment identity, and anchor. If any relationship cannot be proven, do not add this operation to the product contract.
5. **Empty review (conditional):** run only if unmapped/general Analysis feedback needs a destination. Verify creation without a final summary, later thread addition, and read-back. Otherwise record this row as not required and keep that feedback blocked.
6. **Existing immediate path:** while the pending review exists, run the current REST inline-comment candidate once. Record whether GitHub accepts, rejects, or separates it; do not infer the future UI from expectation.
7. **Reply and state changes:** run Reply, Resolve, and Unresolve separately. Classify each as pending-review-owned, separately published, rejected, or unavailable. Each classification independently controls scope.
8. **Head change:** move the disposable PR head, explicitly Refresh, then separately test add-thread, Submit, and Discard. Record whether each action is accepted and how pending anchors read back. No stale-review action ships without this evidence.
9. **Unknown outcomes:** for Start, AddThread, Submit, and Discard, persist intent, force one lost-response case, then use only the bounded reader to reconcile. Verify no automatic retry and classify confirmed completion, confirmed absence, or still unknown.
10. **Discard and cleanup:** discard only with the authorized account, verify the spike-proven read-back result, then confirm no pending test content remains. If cleanup cannot be proven, stop and use the approved GitHub recovery path rather than issuing further writes.

#### Acceptance and disposition

- **Proven for the initial implementation:** complete same-account reader; safe first-thread start; append identity/read-back; Submit; Comment-now rejection while pending; and create/add/submit reconciliation without retry.
- **Still gated:** Discard/read-back and isolation with repository access. Empty review controls only unmapped/general Analysis feedback. Reply, Resolve, and Unresolve control only their own pending-review integration; an unproven operation stays on the current immediate path or is unavailable.
- **Fail closed:** pagination/incomplete reads, missing identities, unknown outcomes, or head-change ambiguity never become `None`, an enabled write, or a local-draft workaround.
- At the end, update the tech spec with only the proven request/response contract and classify every matrix row as implemented, gated, or out of scope. Do not change source code in the spike itself.

## Step 2: Establish the revised vocabulary, contract, and fixture matrix

1. Add ADR-0014 and update `CONTEXT.md`, task spec, and tech spec as described above. Remove obsolete statements that claim new inline comments always publish immediately or that the hidden dock remains the Review editor.
2. Replace task design references with a GitHub-style review modal direction: header action, count badge, large modal, optional final summary, pending comment ledger, decision choice, submit/discard controls, and focus behavior.
3. Add deterministic fixture states for:
   - no pending review;
   - Patchdesk-started pending review with one/many comments;
   - externally started viewer pending review;
   - pending-review read unavailable, including retention of a prior confirmed projection;
   - stale head with outdated pending anchors;
   - submission/discard in progress;
   - outcome unknown/recovery required;
   - terminal pull request with readable, inactive state.
4. Define explicit product copy. Never call a local-only item `Pending`, and never call a GitHub-persisted pending comment a `Review draft` without stating that it is pending on GitHub.

**Verify:** focused renderer fixture/test compile; documentation links resolve; no UI text promises a local draft after the contract changes.

## Step 3: Replace the local-batch model with a remote pending-review state machine

Create a domain module such as `src/domain/pending-review.ts`; do not extend `ReviewBatch` with optional remote fields. The old batch state conflates local editing, publication planning, and remote receipts and cannot safely import a review created outside Patchdesk.

Model a parsed `ViewerPendingReview` with:

- REST review id and GraphQL node id;
- active pull-request identity, authenticated author resolved through `GitHubReader.resolveAuthenticatedAccount`, bound head SHA, and timestamps;
- remote state (`None`, `Pending`, `Submitting`, `Discarding`, `OutcomeUnknown`);
- remote inline comment/thread ids and validated anchors, plus an optional local display status only while a write receipt is reconciling;
- durable operation intent/receipts required to recover create, add-thread, submit, and discard ambiguity.

The parser must reject wrong-account, wrong-PR, non-pending, missing-id, and contradictory stored state. Persist operation intent before each remote write; a timed-out creation or deletion stays locked until a read-side reconcile confirms the remote result. Use one keyed pending-review owner per active Review/session so concurrent commands cannot race identity or receipts.

Only after Step 0's approved data treatment, replace the persisted `batchContent` owner and the `ReviewBatch` projection with this state. Remove local include/exclude, local body editing, anchor repair, and successor-local-draft rotation rather than keeping a compatibility path. No migration or silent re-publication of existing local drafts is part of this change; their treatment must be explicitly approved and tested before code that deletes, clears, replaces, ignores, or transforms persisted batch content runs.

**Primary files:**

- add `src/domain/pending-review.ts` and focused domain tests;
- replace `src/domain/review-batch.ts` and its parser call sites only after all consumers move;
- update `src/domain/review-session.ts`, `src/adapters/storage/review-session-store.ts`, and `src/adapters/storage/review-remote-store.ts` schemas/projections;
- delete `src/services/review-batch-controller.ts` and batch-only helpers after dependent controllers move.

**Verify:** parser and lifecycle tests prove only legal remote states/operation transitions; reload/restart retains enough evidence to reconcile but never treats stale local text as GitHub truth.

## Step 4: Add one bounded GitHub pending-review reader/writer seam

Extend `GitHubReader` and `GitHubReviewWriter` in `src/adapters/github/github-adapter.ts` from the spike’s proven operations. Keep raw GraphQL/REST shape in the adapter and expose typed domain results only.

Required operations:

- `getViewerPendingReview({ profile, pr, account })` matches `account` against the remote review author inside the adapter and returns `None` or the one viewer-owned pending review with complete bounded comments/threads, anchors, review ids, and head SHA. An incomplete page is `unavailable`, never `None`;
- `startPendingReviewWithThread(...)` creates the initial pending review and its selected inline comment. An empty review is allowed only if Step 1 proves it works without sending the final summary body;
- `addPendingReviewThread(...)` appends a new remote inline thread to the known review id;
- `submitPendingReview(...)` keeps the existing exact review-id/event/body path;
- `discardPendingReview(...)` deletes/abandons the remote pending review; and
- only operations proven in Step 1 for reply/thread-state behavior.

Every target-specific write must first prove current PR membership and viewer ownership where GitHub requires it. New coordinate writes run after `ReviewWriteGate.requireFresh()` and a final current-head read, using exact represented coordinates and the current head. Submission or discard after a refreshed head change remains disabled until Step 1 proves its exact requirements and result. Mutations return semantic receipts and typed failure variants; they never leak body text, IDs, raw GitHub output, or credentials to the renderer/logs.

Extend `FakeGitHubAdapter` and `tests/adapters/github-adapter.test.ts` with same-PR, other-PR, other-viewer, pending/submitted, pagination/incomplete, rejected, unavailable, and unknown-outcome fixtures. Do not add a broad all-thread scan or a renderer-to-GitHub path.

**Verify:** adapter tests assert strict parse rejection, the exact REST/GraphQL request structure from the spike, PR/account isolation, and no duplicate mutation after an unknown outcome.

## Step 5: Replace local publication services with pending-review orchestration and recovery

Replace `ReviewSubmissionService`, `ReviewWriteController`, and batch recovery with a dedicated pending-review service/controller. It owns this sequence:

1. load/reconcile the viewer’s pending review at initial Review open, explicit Refresh, and the maintainer’s explicit recovery action (**Check GitHub again**);
2. create or import the pending review;
3. append an inline thread or accepted Analysis/Finding item;
4. persist receipt/state after each confirmed write;
5. submit with explicit selected event and optional final summary; or
6. discard after explicit destructive confirmation.

Incoming external pending content is imported into the same renderer projection only after the authenticated-account and active-PR checks. It may be displayed and completed normally. The app must never import, submit, discard, or expose another person’s pending review.

Retain the existing exact-head and freshness gate for all new write commands. Keep initial open and explicit Refresh as the only represented-snapshot replacement; **Check GitHub again** reconciles only an uncertain pending-review operation. On a head change, preserve the remote pending review, render outdated anchors truthfully, and block new coordinates until Refresh. Do not attempt local anchor migration or mutation replay. Submission or discard after that Refresh remains disabled unless Step 1 proves the exact GitHub result. For `Submitting`, `Discarding`, or any uncertain outcome, lock conflicting actions; show **Check GitHub again** and **Open on GitHub**, then reconcile before another write.

Update local API route schemas, `src/main/local-api.ts` composition/guards, renderer contract codecs, and the desktop bridge only for the new protected pending-review commands. Reject unknown command fields at the route boundary. Remove `/v1/reviews/batch` and the old publication preview/confirm/recover routes once all callers are moved; do not maintain aliases.

**Verify:** service/local-API tests prove import, create, add, submit, discard, same-review serialization, stale/head behavior, unknown-outcome lock, refresh reconciliation, no duplicate writes, and redacted errors through actual fake gateway seams.

## Step 6: Implement the GitHub-style UI and remove the dock

Work in the canonical `ReviewWorkbench` and `ReviewWorkbenchFlow`, not the legacy overview path.

1. Replace `ReviewWorkbenchSlots.draftDock` with a narrow typed pending-review slot/action. Remove the permanently hidden dock wrapper in `src/renderer/src/components/review-workbench.tsx` after all callers migrate.
2. Add the header button beside PR overview/Open on GitHub. Use **Start a review** when `None`; it directs the maintainer to select a valid inline range and open the composer, and must not create an empty remote review unless Step 1 proves that path. Use **Finish review · N** when `Pending`. Keep it visible in Files and Insights, absent/disabled for terminal Reviews, unavailable reads, or an outcome-unknown lock. It must communicate blocked freshness with text, not color alone.
3. Extract/rebuild `ReviewDraftDock` as a controlled `FinishReviewDialog` using installed Base UI/shadcn `Dialog`, `AlertDialog`, `Button`, `Badge`, `Textarea`, and `Select`. Do not create a second modal inside a modal.
4. The dialog shows final summary input, expandable pending comments with exact path/range context, Comment/Approve/Request changes, a clear submit action, and a two-step destructive Discard confirmation. Submission disables close/duplicate actions; unknown recovery supplies Check GitHub again and Open on GitHub.
5. Change the inline composer state/action labels without altering renderer sandboxing:
   - no active review: secondary **Comment now**, primary **Start a review**;
   - active pending review: **Add review comment**;
   - show a concise remote-pending status/optimistic row only until the returned receipt is reconciled;
   - preserve existing immediate thread-card controls only where Step 1 supports their semantics.
6. Rewire mapped Analysis/Finding Add to review through the same pending-review command owner. A model result remains non-authoritative; the maintainer’s explicit action is the GitHub-write authorization. Do not invent a local persisted queue for unmapped/general Analysis feedback: Step 1 must prove an empty pending-review path, or the product must decide where that final-summary-only content lives before implementation.
7. Remove `ReviewDraftDock`, `ReviewBatchPanel`, `PublicationPreviewDialog`, old draft-inline annotations, and their hidden/legacy fixture paths once replacement tests pass. Retain the existing published-feedback view for submitted GitHub feedback.

**Verify:** renderer tests prove action labels, count changes, modal focus trap/return, keyboard operation, visible submission state, discard confirmation, stale/outdated copy, no duplicate hidden controls, and no direct renderer GitHub call. Browser tests prove 960px/1280px/1440px geometry, dialog scrolling, Diff remains stable when closed, and no horizontal viewport overflow.

## Step 7: Update all test seams and execute proof in risk order

Add or replace tests through these caller-facing seams:

- `tests/domain/`: pending-review parser and legal transitions.
- `tests/adapters/github-adapter.test.ts`: query/mutation shape, bounded parsing, account/PR isolation, error classification.
- new `tests/services/pending-review-service.test.ts`: operation sequencing, persistence-before-write, exact-head/freshness, import/reconcile, unknown recovery, and discard.
- `tests/local-api-auth.test.ts` and `tests/browser/local-api-workbench.spec.ts`: strict protected command bodies and capability enforcement.
- `tests/renderer/review-workbench-flow.ui.test.tsx`: Start/Finish/unavailable-read lock and retry/refresh/recovery/Analysis/Finding end-to-end projection.
- `tests/renderer/review-diff-view.ui.test.tsx`: split inline actions, pending state, composer focus, and no duplicate action after receipt.
- migration tests: the approved Step-0 discard path removes ordinary, pending, in-flight, and unknown `batchContent` without remote replay; the new bounded reader remains responsible for any GitHub-owned remote result.
- replace `tests/renderer/review-draft-dock.ui.test.tsx` with dialog behavior; retain accessible publication/recovery coverage in a renamed dialog test.
- `tests/browser/review-workbench.spec.ts`, `tests/browser/design.spec.ts`, and `tests/browser/accessibility.spec.ts`: header action, modal accessibility, responsive geometry, and absence of the dock.

Run, in order:

```bash
pnpm exec vitest run tests/adapters/github-adapter.test.ts tests/services/pending-review-service.test.ts tests/local-api-auth.test.ts
pnpm exec vitest run tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-diff-view.ui.test.tsx
pnpm build
pnpm exec playwright test tests/browser/review-workbench.spec.ts tests/browser/accessibility.spec.ts
pnpm typecheck
pnpm lint
pnpm test -- --run
pnpm build
pnpm run test:a11y
pnpm run test:performance
pnpm exec playwright test
git diff --check
```

Finally, restart the Electron main process in the Herdr dev pane, then delegate read-only live UI verification to `patchdesk-electron-tester`. Verify both header states, the modal, keyboard/focus, refresh/outdated presentation, and a clean console. Do not write GitHub during live QA unless separately authorized for the disposable-PR spike.

## Done criteria

- [ ] The task spec, tech spec, glossary, and ADR-0014 accurately describe GitHub-pending review drafting and identify superseded local-draft decisions.
- [ ] A signed-in maintainer can start, import, view, add to, finish, submit, and explicitly discard their GitHub pending review from Patchdesk.
- [ ] The header action and finish dialog replace the Review draft dock in both Files and Insights; no hidden duplicate dock remains.
- [ ] A reviewer can intentionally choose Comment now before starting a review; later new inline comments join the pending review.
- [ ] Analysis/Finding actions use the same pending-review owner and preserve explicit human authorization.
- [ ] Freshness, exact-head checks, target ownership, destructive confirmation, serialization, and outcome-unknown recovery remain intact.
- [ ] Every legacy `batchContent` state was discarded only through the explicitly approved and tested Step-0 migration; no old operation was replayed and no local draft path remains.
- [ ] Another reviewer’s pending content is never imported or actionable.
- [ ] Step-1 evidence governs reply/state behavior; unsupported behavior is not guessed or emulated locally.
- [ ] Focused, full, browser, accessibility, type, lint, build, and live Electron checks have recorded outcomes; any blocked live write proof is named as unproven.

## Stop conditions

Stop and revise the plan rather than improvising if:

- GitHub cannot provide a bounded authenticated reader that identifies the reviewer’s pending review and complete actionable comment identity.
- A pending review cannot be safely discarded/reconciled after an unknown outcome.
- Existing GitHub behavior prevents adding pending threads, or makes Reply/Resolve semantics ambiguous; limit scope to proven operations.
- The approved discard migration cannot remove every legacy `batchContent` class without proving it makes no remote write or automatic replay.
- The UI requires bypassing the loopback capability, `ReviewWriteGate`, exact-head validation, explicit confirmation, or sandboxing.
- A header/modal implementation cannot preserve focus, accessibility, responsive geometry, or the existing terminal-Review restrictions.

## Out of scope

- Remote mirroring of arbitrary local edits after a pending review starts.
- Automatic adoption, submission, discard, or mutation of another viewer’s pending review.
- Polling/webhooks or automatic refresh.
- Editing/dismissing submitted GitHub review summaries beyond existing published-feedback capability.
- Backward-compatibility aliases, batch/draft migrations, or silent local-draft republishing without a separate approved data plan.
- Production GitHub writes in tests or routine QA.

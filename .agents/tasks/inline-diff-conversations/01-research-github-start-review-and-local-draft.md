---
created_at: 2026-08-09
repos:
  - patchdesk
status: needs-validation
spec: .agents/tasks/inline-diff-conversations/spec.md
tech-spec: .agents/tasks/inline-diff-conversations/tech-spec.md
plan: .agents/tasks/inline-diff-conversations/plans/2026-08-09-github-pending-review-workbench.md
---

# GitHub pending-review evidence and Patchdesk's hidden local draft

## Research question

What does the current Patchdesk implementation prove about inline conversation and local-batch behavior, and which GitHub pending-review claims still require a disposable-PR validation spike before they become product or adapter contracts?

This research initially inspected `fix/inline-conversation-freshness-repair` on 2026-08-09 without a live GitHub write. Subsequent redacted evidence is committed at `fbb91b4` in `.agents/research/2026-08-09-github-pending-review-spike.md` and `dbacd62` in `.agents/research/2026-08-09-github-pending-review-discard-validation.md`; those artifacts, rather than this pre-spike observation, govern proven API claims.

## Conclusion

The current implementation has two separate feedback owners. The subsequent spike proves a bounded remote-pending path for reader/Start/append/Submit only; it does not retroactively prove Discard, isolation with repository access, empty review, Reply/Resolve/Unresolve, or head-change behavior:

1. `InlineConversationService` writes an inline comment, reply, or thread-state change directly to GitHub.
2. `ReviewBatch` stores editable local items and `ReviewSubmissionService` later creates then submits a pending review.

The current code proves a safe create-pending → persist receipt → submit sequence for the local-batch publication path. It does **not** prove that Patchdesk can read a viewer-owned pending review, append an inline thread to it, discard it, or correlate its pending comments/threads. Those are validation-spike gates.

The selected product direction changes the future ownership model: after **Start a review**, the viewer's remote GitHub pending review becomes the authoritative editable review. It does not retroactively make today’s direct-write or local-batch behavior evidence of those unimplemented remote operations.

## Current Patchdesk evidence

### Local ReviewBatch is real but unreachable in production

- `src/domain/review-batch.ts` persists a local `ReviewBatch` with inline comments, general comments, thread replies, thread-state changes, a local `summaryBody`, inclusion state, anchor-repair state, and remote receipts.
- `src/domain/review-session.ts` stores it in `batchContent`, with a summary state in `batch`; lifecycle/recovery code treats in-flight and unknown outcomes as evidence that must not be discarded.
- `src/services/review-submission-service.ts` plans and applies local batch operations, persists a pending-review receipt before later submission, and blocks stale or Needs-attention local anchors.
- `src/services/review-write-controller.ts` owns the existing batch write lock and installs an empty successor local batch after a confirmed publication.
- `src/services/review-recovery-service.ts` reconciles legacy local-batch publication evidence. In particular, a create timeout lacks enough existing durable remote identity to be guessed safely.
- `src/renderer/src/flows/review-workbench-flow.tsx` constructs a `DraftSlot`, allows Analysis and Findings to write to `/v1/reviews/batch`, and maintains a fallback empty local batch.
- `src/renderer/src/components/review-workbench.tsx` wraps `slots.draftDock` in a permanent `hidden` container. The local batch can therefore gain content, need recovery, or be published without a normal visible editor.

This is the user-data migration risk. The product owner selected **discard** for every legacy `batchContent` class on 2026-08-09. The selected migration must be tested to remove only local evidence, issue no remote write or automatic retry, and never translate local content into a remote pending review. Local deletion is not proof that an old remote operation did or did not complete; the spike-proven bounded reader owns that later determination.

### Current direct conversation writes are immediate, not pending-review writes

The current renderer flow sends commands to `/v1/reviews/inline-conversations/command`; `src/main/local-api.ts` parses the command, then `InlineConversationService` applies `ReviewWriteGate` freshness and current-head checks before adapter writes.

`src/adapters/github/github-adapter.ts` currently implements:

- a REST inline-comment create that returns a comment node ID and may return a review ID, but not a thread ID;
- GraphQL reply and resolve/unresolve mutations;
- edit/delete operations for owned published comments; and
- a recent-write journal path that suppresses false update markers without replacing the represented snapshot.

The adapter comments describe current direct comment and reply writes as separately submitted `COMMENTED` reviews. This is not evidence of their behavior while a viewer pending review exists. In the selected design, **Comment now** retains this direct path only before a viewer pending review is confirmed. Afterward, the composer must offer **Add review comment** instead. Reply/Resolve/Unresolve pending-review participation remains unproven.

### Current read paths do not import pending reviews

- `getPullRequestPublishedFeedback()` deliberately skips reviews without `submitted_at`; `PENDING` reviews therefore are not published feedback.
- The `reviewThreads` GraphQL query reads thread locations and comments, but it does not request an owning review ID or review state.
- `resolveAuthenticatedAccount()` is a bounded main-process identity check, but no current reader combines that identity with a pending-review query.
- `GitHubReviewWriter` currently provides `createPendingReview()` and `submitPendingReview()` only. It has no pending-review read, append-thread, or discard operation.

Consequently, the design must not say the existing adapter “reuses” those missing operations. A new pending-review reader/writer seam may be designed only around the exact read and mutation shape the spike proves.

### Current create/submit behavior is useful but limited evidence

`createPendingReview()` uses REST `POST /pulls/{number}/reviews` with `commit_id`, a summary body, and zero or more inline comments. It rejects a completely empty body-and-comments request, parses only a REST review ID, and requires the returned state to be `PENDING`.

`submitPendingReview()` uses REST `POST /pulls/{number}/reviews/{review_id}/events` with the selected event and body. The current local-batch code persists the pending review ID before submission, which is a useful recovery boundary for that path.

This demonstrates a candidate first-comment Start path, not a complete remote-authoritative lifecycle. In particular, it does not establish:

- the GraphQL node ID required by a possible append-thread mutation;
- whether a complete viewer-owned pending review and its actionable comments/threads can be read in a bounded result;
- empty-pending-review behavior;
- discard semantics;
- how to reconcile a create, add, submit, or discard timeout; or
- whether a pending review can be submitted or discarded after its pull request head changes.

## Product-to-code implications

- The hidden dock is not a surface to restore. The replacement is a workbench header action in Files and Insights plus a Finish review modal.
- The final summary must be modal-local and sent only by Submit. Current `ReviewBatch.summaryBody`, Analysis body seeding, and publication preview are legacy local-batch behavior, not a remote pending-review contract.
- A mapped Analysis/Finding action can become a pending-review write only after explicit maintainer authorization, a valid mapped anchor, freshness/current-head checks, and a spike-proven append operation. It must not create a local fallback queue.
- General or unmapped Analysis feedback has no safe remote destination yet. It remains blocked until the spike proves an empty pending review can be created and later populated without placing a final summary outside the Finish modal, or until product selects another destination.
- Explicit Refresh stays authoritative for the represented GitHub snapshot. A typed response to a user-initiated pending-review mutation may update that narrow pending-review owner, but it must not silently replace the broader workbench snapshot.
- A pending-review recovery read is an explicit **Check GitHub again** action. It locks conflicting writes after an uncertain outcome and never retries the original mutation automatically.

## Disposable-PR validation spike

Use a disposable pull request and dedicated test account. Obtain separate explicit authorization before every write. Store only redacted request/response shapes and outcomes; never store credentials, PR URLs, account names, raw bodies, or raw command output.

1. Create a pending review with one selected inline comment using the candidate first-comment path. Record the minimum returned identity and the smallest read that can locate the same review and its comment/thread relationship.
2. Resolve the authenticated account, then prove a bounded read can distinguish exactly that account’s pending review for the active PR from no pending review, foreign data, pagination, and incomplete comment results.
3. Attempt the candidate append-thread operation using the proven pending-review identity. Read it back and record the exact thread/comment identities and anchor fields needed by the renderer.
4. Attempt an empty pending review only if unmapped/general Analysis feedback is required. Verify whether it can later receive a thread without creating or persisting a final summary outside the Finish modal.
5. Submit with a modal-supplied summary and decision. Separately inspect a pending review created on GitHub with any existing body so the product can decide whether Patchdesk must block, preserve, or replace that body; do not assume overwrite behavior.
6. Discard the pending review. Verify read-back absence, comment disappearance if applicable, and whether another pending review can be started.
7. Move the PR head, explicitly refresh, and separately test add-thread, submit, and discard. Record results rather than claiming stale pending-review behavior in advance.
8. Test Reply, Resolve, and Unresolve while a pending review exists. Record whether each joins, publishes separately, or fails. Do not implement pending-review integration for any unproven result.
9. For create, append, submit, and discard, simulate a timeout or lost response after a persisted intent. Prove the smallest read-side reconciliation that distinguishes confirmed completion, confirmed absence, and still-unknown outcome. Never retry automatically.
10. Repeat pending-review reads from a second account to ensure Patchdesk never imports or exposes another reviewer’s pending content.

## Open decisions and gates

- **Approved product decision:** discard every persisted legacy `batchContent` class. Test that the migration removes no remote state, retries no operation, and leaves later remote reconciliation to the bounded pending-review reader.
- **Accepted validation exception:** `fbb91b4` proves the bounded reader and append-thread identity; `dbacd62` proves normal-response Discard semantics. The product owner accepts implementing the untested timeout/lost-response Discard path only as persisted `OutcomeUnknown`, with no automatic retry, locked conflicting controls, and explicit Check GitHub again reconciliation.
- **Required spike result:** reply/thread-state semantics and stale-head submit/discard behavior.
- **Required product decision if empty creation fails:** where unmapped/general Analysis feedback belongs without reintroducing a competing local draft.
- **Required product decision after body observation:** how the Finish modal handles an imported GitHub pending review that already has a remote review body.

## Sources

Local evidence:

- `src/domain/review-batch.ts`
- `src/domain/review-session.ts`
- `src/services/review-submission-service.ts`
- `src/services/review-write-controller.ts`
- `src/services/review-recovery-service.ts`
- `.agents/research/2026-08-09-github-pending-review-spike.md` (committed as `fbb91b4`; evidence includes the real-PR/owner-account environment deviation)
- `src/adapters/github/github-adapter.ts`
- `src/main/local-api.ts`
- `src/renderer/src/flows/review-workbench-flow.tsx`
- `src/renderer/src/components/review-workbench.tsx`
- `docs/adr/0001-manual-github-refresh.md`
- `docs/adr/0002-preserve-review-drafts-across-revisions.md`
- `docs/adr/0004-use-one-progressive-review-workbench.md`
- `docs/adr/0006-separate-draft-and-published-feedback.md`
- `docs/adr/0008-seed-review-drafts-from-analysis.md`
- `docs/adr/0010-choose-an-analysis-completion-action-per-run.md`

Candidate GitHub documentation to validate against the disposable PR rather than treat as implementation proof:

- [Reviewing proposed changes in a pull request](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request)
- [REST API endpoints for pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [GraphQL pull request schema](https://docs.github.com/en/graphql/reference/pulls)

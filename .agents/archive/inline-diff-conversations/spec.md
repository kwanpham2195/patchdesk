---
created_at: 2026-08-08
repos:
  - patchdesk
status: needs-validation
tech-spec: .agents/tasks/inline-diff-conversations/tech-spec.md
research: .agents/tasks/inline-diff-conversations/01-research-github-start-review-and-local-draft.md
plan: .agents/tasks/inline-diff-conversations/plans/2026-08-09-github-pending-review-workbench.md
---

# Inline diff conversations and GitHub pending reviews

Status: needs-validation — the disposable-PR validation spike must prove the remote operations before implementation.

## Problem statement

Patchdesk can represent GitHub inline Conversation threads in the Diff, but its current authoring model splits feedback between immediate GitHub writes and a persisted local `ReviewBatch`. The local batch can contain manual, Analysis, and Finding content even though its Review draft dock is permanently hidden in the production workbench.

The workbench needs one visible, GitHub-native owner for editable review feedback. Once a maintainer starts a review, that owner is the authenticated maintainer's GitHub `PENDING` review—not a second editable local draft. The design must still preserve the explicit **Comment now** path before a pending review exists. The product owner has explicitly approved discarding every legacy local `batchContent` record through the tested migration; the migration must not issue or replay a GitHub write.

## Selected behavior

- The workbench imports only an authenticated viewer's pending review for the represented pull request. A pending review created on GitHub is therefore available in the same workbench flow.
- Before that pending review exists, a valid inline composer offers **Comment now** and **Start a review**. **Comment now** is the existing explicit immediate GitHub write. **Start a review** creates the viewer's pending review with the selected inline comment.
- Once a viewer pending review exists, new inline authoring offers **Add review comment**. It appends to that remote pending-review owner; it does not offer or create a local Review draft.
- The header replaces the hidden Review draft dock in Files and Insights: **Start a review** when no actionable viewer pending review is confirmed, and **Finish review · N** when one is confirmed. Until the empty-review spike gate is accepted, the header Start action directs the maintainer to select a valid inline range and open the composer; it does not create an empty remote review. `N` is the confirmed pending-comment count, not a local queue count.
- **Finish review** opens a GitHub-style modal with the pending-comment ledger, Comment/Approve/Request changes decision, an optional final summary, Submit, and an explicitly confirmed two-step destructive Discard action. The final summary is modal-local and is sent only with Submit; it is not stored in a local batch or displayed elsewhere in the workbench.
- Analysis completion and a mapped Finding's explicit **Add to review** action use this same pending-review owner. They remain separate model evidence until the maintainer explicitly authorizes the GitHub write. Unmapped or general Analysis content has no invented local queue; it is blocked until the validation spike proves an empty-pending-review path or product chooses another source of truth.
- Explicit Refresh remains the only normal replacement of the represented GitHub snapshot. Initial open obtains its initial snapshot; **Check GitHub again** is an explicit recovery action for an uncertain pending-review write. Neither polling nor a background write result silently replaces the broader snapshot.
- Reply, Resolve, and Unresolve join the pending-review flow only if the disposable-PR spike proves their ownership and outcome semantics. Until then, they remain on their existing immediate path or are unavailable; the UI must not imply they are pending-review items.

## User stories

1. As a maintainer, I want open and resolved mapped Conversation threads beside the relevant old- or new-side Diff lines, so that current GitHub discussion stays with the code.
2. As a maintainer, I want complete, unambiguous thread anchors only, separate cards in opening-comment order, range-end placement, and necessary collapsed context revealed, so that Patchdesk does not attach discussion ambiguously.
3. As a maintainer, I want safe Markdown, partial-history disclosure, keyboard operation, and screen-reader status text for thread cards, so that inline conversations remain usable and truthful.
4. As a maintainer with no pending review, I want to choose **Comment now** or **Start a review** from a valid inline composer, so that immediate feedback and a GitHub pending review are deliberate, distinct GitHub actions.
5. As a maintainer with a pending review, I want **Add review comment** to append to it, so that my editable review has one authoritative owner.
6. As a maintainer who started a review on GitHub, I want Patchdesk to import my pending review after initial open or explicit Refresh, so that I can finish it without recreating it.
7. As a maintainer, I want the only final summary field in **Finish review**, so that an unsent summary is not mistaken for saved draft content.
8. As a maintainer, I want Submit and Discard to be explicit, with Discard separately confirmed, so that GitHub writes and destructive removal are intentional.
9. As a maintainer, I want a timeout or lost response to lock conflicting actions and offer **Check GitHub again** and **Open on GitHub**, so that Patchdesk never duplicates or guesses a remote result.
10. As a maintainer, I want a new head to block new coordinate writes until explicit Refresh, while retaining the known pending review for truthful recovery or the spike-proven actions, so that shifted anchors are never reused silently.
11. As a maintainer, I want the approved migration to discard legacy local `batchContent` without replaying an old GitHub operation, so that removed local data cannot create a duplicate remote write.

## Implementation decisions

- The existing Diff mapping and Conversation read projection remain the renderer source for mapped published Conversation threads. Outdated, unanchored, cross-side, or partially mapped ranges remain excluded. A pending-review comment is a separate remote projection and must not be mislabeled as a local draft annotation.
- A remote pending review is authoritative after Start. Local durable state is limited to parsed remote identity, operation intent, confirmed receipts, and an `OutcomeUnknown` recovery lock. It is never a second editable copy of remote comment or summary text.
- The pending-review reader must fail closed. It may report `None` only when it proves there is no viewer-owned pending review for this PR. Pagination limits, incomplete comments, missing identity, wrong PR, wrong author, or malformed data are unavailable—not proof of absence and not permission to start another review. In that state, both new-comment branches stay disabled and the workbench offers an explicit retry.
- Before every start, add-comment, submit, or discard remote write, Patchdesk applies the loopback capability, open-Review/lifecycle checks, serialization for one Review/session owner, freshness gate, and the applicable final current-head check. An operation intent is persisted before the remote boundary. A successful remote response is persisted before success is shown.
- Coordinate writes require a fresh represented patch, full same-side anchor, and current head. After Refresh to a different head, the app does not migrate or replay anchors. Whether an existing remote review may still be submitted or discarded in that state is a validation-spike result, not an assumed GitHub behavior.
- A confirmed pending-review mutation can update its narrow pending-review projection from its typed receipt. It does not perform an implicit full GitHub refresh.
- Direct **Comment now** continues through the current protected direct-conversation path only while no viewer pending review is confirmed. It is never converted into a local draft or silently attached to a pending review.
- Existing persisted `batchContent` has an approved **discard** treatment for Local, PendingReview, Applying, and PartialFailure/outcome-unknown records. The tested migration may remove that local evidence only without a remote write, retry, or local fallback. It is not proof that any GitHub-owned outcome was absent; the new bounded pending-review reader remains responsible for remote reconciliation.
- A new ADR must supersede ADR-0002, ADR-0004, ADR-0006, ADR-0008, and ADR-0010 only for the Review-drafting surface. Until then, those historical ADRs describe current behavior rather than a reason to retain dual authorities.

## Validation-spike status, gates, and open questions

Redacted evidence at `fbb91b4` proves the bounded reader, Start with first inline thread, Add review comment, Submit, Comment-now rejection while pending, and create/add/submit lost-response reconciliation for the tested account/PR. It records a deliberate environment deviation: a real open-repository PR and the owner's own account were used instead of the planned sandbox/disposable PR and dedicated test account. This evidence does not authorize further writes.

The following remain gates before their UI or adapter contracts ship:

1. A bounded authenticated read that distinguishes the viewer's pending review, its PR and author, review identity, complete actionable pending comments/threads, and incomplete results.
2. Start-with-first-inline-comment behavior and the exact remote IDs/receipts needed to show an editable pending review.
3. Add-thread behavior for a known pending review, including thread/comment identity and read-back visibility.
4. Empty-pending-review behavior, if it is needed for unmapped/general Analysis content; otherwise that content remains out of scope.
5. **Accepted validation exception:** `dbacd62` proves normal-response DELETE and bounded absence read-back, but not a timeout/lost response. The product owner explicitly accepts implementing Discard without that live spike. A timeout/lost response must persist `OutcomeUnknown`, prohibit automatic retry, lock conflicting controls, and require explicit **Check GitHub again**; it must not claim a confirmed discard.
6. Whether a head change permits submission or discard of the existing pending review, and how its pending anchors are represented after Refresh.
7. Whether Reply, Resolve, and Unresolve join the pending review, publish separately, or fail. Their result determines their scope.
8. How an externally created pending review with any pre-existing review body behaves at submission. Patchdesk must not invent a second persisted summary field or overwrite semantics.

## Testing decisions

- Domain and storage tests cover strict parsing, account/PR isolation, `None` versus unavailable, legal state transitions, persistence-before-write, receipt persistence, serialization, and every `OutcomeUnknown` reconciliation path.
- Adapter tests use only the exact REST/GraphQL requests and response shapes proven by the spike. They cover bounded pagination, malformed/incomplete data, foreign account/PR results, ownership, rejection, unavailable responses, and no automatic retry.
- Service and protected-local-API tests cover Start, import, Add review comment, Submit, Discard confirmation, stale/current-head policy, recovery lock, explicit Check GitHub again, and redacted errors. They also prove no pending-review action reaches the renderer without the loopback capability.
- Renderer and browser tests cover both header states in Files and Insights; unavailable-read lock and retry; header Start leading to valid inline authoring without an unproven empty review; composer labels and exclusivity; pending count; Finish modal summary lifetime, focus, decision, submit and discard behavior; terminal and stale presentation; no hidden draft dock; and no duplicate action after a receipt.
- Analysis/Finding tests prove only explicit mapped actions use the pending-review owner. Tests keep unmapped/general behavior blocked unless the empty-review spike gate is accepted.
- Migration tests cover the approved discard path for every legacy `batchContent` class, including in-flight/unknown evidence. They prove no remote write/retry occurs and no test normalizes old local content into a remote pending review.
- Existing mapped-thread, Markdown, accessibility, and immediate-direct-comment tests remain for their unchanged surfaces. Reply/Resolve/Unresolve pending-review assertions are added only after the spike proves the semantics.

## Out of scope

- A local mirror, offline queue, compatibility shim, or automatic re-publication of a GitHub pending review.
- Another reviewer's pending content, automatic adoption, polling, webhooks, or implicit refresh.
- A final summary outside the Finish review modal.
- Automatic retry or a claimed confirmed outcome after a timed-out/lost-response Discard. Normal-response DELETE/read-back is proven in `dbacd62`; the product accepts the conservative unvalidated recovery path.
- Local anchor migration, local include/exclude editing, or successor local-draft rotation after the new lifecycle ships.
- Unmapped/general Analysis feedback without the empty-review validation result or a separate product decision.
- Pending-review Reply/Resolve/Unresolve behavior before the validation spike proves it.
- Any deletion or replacement of persisted `batchContent` outside the approved, tested discard migration.

## Further notes

- The existing local-comment UI and Review draft dock are implementation history, not a target behavior. They must not remain hidden compatibility paths once the approved migration completes.
- The workbench-level **Open on GitHub** action remains the escape hatch for unsupported GitHub behavior, history, permissions, and recovery investigation.
- This package changes no GitHub state. The validation spike and any live GitHub-write QA require separate explicit authorization.

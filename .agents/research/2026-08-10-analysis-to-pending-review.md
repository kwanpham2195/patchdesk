---
created_at: 2026-08-10
repos:
  - patchdesk
status: research
spec: .agents/archive/inline-diff-conversations/spec.md
adr: docs/adr/0014-use-github-pending-reviews-for-review-drafting.md
---

# Analysis to pending-review research

## Recommendation

Apply the Start/Finish review foundation to current, mapped Analysis Findings and
to the Analysis summary, but do it through the existing GitHub pending-review
lifecycle. Do not reconnect either surface to the legacy local `ReviewBatch`.

- A mapped Finding gets a deliberate **Review this Finding** action. With no
  pending review, the action starts the authenticated viewer's GitHub pending
  review with the Finding's verified anchor and proposed text. With a confirmed
  pending review, it appends one review comment to that same owner.
- The Analysis summary gets **Insert Analysis summary** only in the Finish
  review dialog. It pre-fills the modal-local summary field and never persists a
  second draft body.
- The existing direct **Write review summary** can later offer a clearly labelled
  **Use Analysis summary** shortcut. It must pre-fill an editable immediate
  review and its suggested decision, and state that it creates no inline
  comments or pending review.

This preserves the selected contract: Analysis is model evidence until a human
explicitly authorizes a GitHub write, and GitHub's pending review is the sole
editable review owner.

## Current state

The production workbench already has the correct remote foundation:

- `PendingReviewService.start`, `addThread`, and `submit` serialize writes,
  apply freshness/current-head gates, persist operation intent before GitHub,
  persist receipts before success, and lock uncertain outcomes for explicit
  reconciliation.
- `FinishReviewDialog` already takes an optional summary at submit time.
- `SummaryReviewDialog` is a separate immediate GitHub-review path; it creates
  no pending review and currently resets to an empty Comment form whenever it
  opens.

Analysis already supplies the needed read-side evidence: a structured summary,
a proposed verdict, mapped Finding coordinates, and suggested comment text.
The Analysis Reader and focused Finding header instead still send **Add** to
`/v1/reviews/batch`. That old local-batch path is hidden in the workbench but
still changes Finding disposition to `added`; it conflicts with ADR-0014's
single-authority rule.

## Required boundaries

Only offer these actions when the retained Analysis is current for the represented
Review session, head, and patch, and the normal pending-review write gate passes.
The action itself must remain a visible, user-triggered GitHub write. No Analysis
completion setting may auto-start, append to, or submit a review.

An unmapped or general Finding remains read-only. It must not create an empty
pending review, a general pending comment, or a local queue until the
empty-pending-review validation gate is accepted or the product chooses another
authoritative source.

For a mapped Finding, the service needs the proven anchor and body. The renderer
should show a sending/failed overlay only while the command is unresolved, then
replace it with the confirmed pending-review projection. Do not mark the Finding
`added` merely because the action was clicked or a network response is uncertain.

## UI shape

1. In Analysis Reader, replace **Add** with **Review this Finding** for a current
   mapped, open Finding. Retain explicit Dismiss.
2. If no viewer pending review is confirmed, show copy explaining that the action
   starts a review with this one inline comment. If one exists, say it adds the
   comment to that pending review.
3. In Finish review, place **Insert Analysis summary** beside the editable summary
   field. The action copies a deterministic Analysis-formatted body into that
   modal only; the maintainer can edit it and choose a different decision.
4. Keep a separate summary-only option only if it is useful enough to justify a
   small `SummaryReviewDialog` prefill API. Its copy must distinguish an
   immediate GitHub review from Finish review.

The Analysis Reader lives in the Insights slot while the inline composer lives
in the Diff. The first implementation should therefore call the pending-review
service directly from the Finding action rather than introduce an implicit
cross-surface composer. A later refinement can navigate to the anchored Diff
and prefill the composer, but only with a typed, one-shot intent that requires
the maintainer's second explicit Start/Add click.

## Do not carry forward

- Do not restore the hidden Review draft dock or local `ReviewBatch` as an
  Analysis staging area.
- Do not preserve a local include/exclude queue, a local review-summary draft,
  or automatic retry/replay for Analysis-generated GitHub writes.
- Do not bulk-start/add many Findings in the first slice. That becomes a
  multi-write operation with partial-outcome recovery and needs a separate
  product contract.
- Do not infer that a Finding is included by matching comment text. GitHub lets
  users edit comment text, and matching is not durable provenance.

## Delivery order

1. Finish the approved legacy-batch discard/migration boundary and remove the
   old Analysis completion choices that save, preview, or publish a local batch.
2. Replace the mapped Finding action with the existing Start/Add pending-review
   commands and their established recovery behavior.
3. Add modal-local Analysis-summary insertion to Finish review, reusing
   `renderAnalysisReviewBody` and an editable suggested verdict.
4. Decide whether the direct-summary prefill merits a separate small enhancement.
5. Consider bulk selection only after an explicit composite-operation and
   recovery design.

## Evidence

- `docs/adr/0014-use-github-pending-reviews-for-review-drafting.md`
- `.agents/archive/inline-diff-conversations/spec.md`
- `src/services/pending-review-service.ts`
- `src/services/analysis-review-body.ts`
- `src/renderer/src/components/review-workbench.tsx`
- `src/renderer/src/components/analysis-reader.tsx`
- `src/renderer/src/flows/review-workbench-flow.tsx`
- `src/renderer/src/components/summary-review-dialog.tsx`

---
created_at: 2026-07-29
status: complete
scope: walkthrough entry from a prepared immutable pull-request diff
canonical_packet: narrative-walkthrough
sources:
  - ./02-research-codiff.md
  - ./01-research-patchdesk.md
  - ./spec.md
  - ../../PLANS/2026-07-27-recovery-settings-walkthrough.md
  - src/services/narrative-walkthrough-service.ts
  - src/renderer/src/flows/prepared-review-flow.tsx
  - src/renderer/src/flows/completed-review-flow.tsx
---

# Prepared-diff walkthrough entry — research

## Decision

Generate a walkthrough from a prepared, immutable pull-request snapshot. Do not require a completed AI review. The walkthrough and AI review are separate, manually started readers of the same stored patch.

This is an evidence-based correction, not a new feature. The approved packet already specifies a prepared snapshot; the implementation and recovery plan drifted to a completed-review-only entry.

## Evidence

Codiff organizes the current diff into chapters and hunk-focused stops. Its generation and normalization boundary is keyed to the diff structure and model output, rather than to a code-review verdict ([Codiff research](./02-research-codiff.md)). This is not a requirement to copy Codiff's UI, but it confirms the appropriate lifecycle boundary: a stored diff.

Patchdesk's approved specification says the reviewer explicitly starts a walkthrough from a prepared, read-only snapshot and does not need to rerun analysis ([spec](./spec.md)). The Patchdesk research also keeps walkthrough generation manual and separate from ordinary review completion ([Patchdesk research](./01-research-patchdesk.md)).

The current service contradicts that design twice: it rejects every state except `ReviewCompleted` when loading the snapshot, then treats a review-state change during generation as stale even when the patch and head are unchanged (`src/services/narrative-walkthrough-service.ts:148-155,271-279`). The renderer reinforces the mistake by placing the dialog and generation controller only in `CompletedReviewFlow`.

## Required changes

1. Change walkthrough eligibility to immutable snapshot availability.

   Allow generation when the stored patch exists and its `{ profileId, sessionId, headSha, patchHash }` identity is current. `Created`, `Running`, `ReviewCompleted`, and `ReviewFailed` can all satisfy that condition. Keep `Stale`, `Discarded`, `Merged`, a missing patch, and a changed patch/head unavailable with a clear reason.

2. Make freshness compare the snapshot, not the review result.

   After the model returns, compare the original and current snapshot identity and patch hash. Do not reject an otherwise valid walkthrough merely because a concurrently running AI review moved from `Created` to `Running` or `ReviewCompleted`.

3. Extract the walkthrough controller from the completed-review flow.

   Reuse one model-selection dialog, generation/load/retry lifecycle, per-profile model preference, and takeover surface from both prepared and completed workbenches. Do not duplicate the controller in `PreparedReviewFlow`, and do not mutate normal Files selection state while the takeover is active.

4. Put the action where the saved diff is being read.

   In the prepared diff header, show **Generate walkthrough** as a secondary action and retain **Run review** as the primary analysis action. The walkthrough action must not start a review, and review completion must not start a walkthrough.

5. Remove the redundant active action.

   `PreparedReviewFlow` currently renders **View diff** even when `showingDiff` is true; it only changes its visual variant. Hide it while the diff is already on screen. Keep **View diff** only from the overview/checks context, where it navigates somewhere useful.

6. Preserve the existing hunk/Pierre path.

   Continue filtering immutable raw patch text by normalized hunk IDs and reparsing the bounded patch for Pierre. Do not splice parsed hunk metadata or touch the virtualized all-files stream.

## Inline-draft boundary to settle before implementation

The existing focused walkthrough UI assumes a completed review batch. A prepared-only walkthrough has no completed review result, so it cannot silently borrow that batch contract. The desired rule should be explicit:

- Recommended: create or reuse the existing local draft batch for the prepared snapshot so walkthrough comments and Files comments remain one draft store, with the existing explicit GitHub confirmation unchanged.
- Narrow fallback: make prepared walkthroughs read-only until a review result exists. This is simpler, but conflicts with the approved packet's promise that walkthrough drafts are the same drafts as Files mode.

The first option preserves the approved user experience without adding a new remote-write path; it needs a small shared draft-batch seam rather than a second store.

## Tests and verification

- Service: accept prepared/created, running, completed, and failed snapshots when identity and patch hash match; reject stale, discarded, merged, missing-patch, and changed-patch cases.
- Service concurrency: a review state transition during walkthrough generation does not invalidate the result when the snapshot is unchanged.
- Renderer: diff view shows **Generate walkthrough** and no **View diff**; checks/overview show **View diff**; Generate does not start a review.
- Renderer/browser: generate, ready, return to Files, and draft visibility work from a prepared PR without running review first.
- Keep normalization, support coverage, Pierre filtering, local-API capability checks, and the 1,000-file performance ceiling unchanged.
- Packaged-app QA: use a prepared PR with failing checks and generate a walkthrough directly from its diff, clearing isolated review data afterwards.

## Documentation to synchronize

Update the recovery implementation plan and older recovery/Pierre design docs that say “completed snapshot” or make the completed workbench the only entry. The approved feature packet should remain the source of truth, with its inline-draft behavior clarified by the selected boundary above.

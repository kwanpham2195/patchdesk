---
created_at: 2026-08-12
repos:
  - patchdesk
status: todo
adr: docs/adr/0017-separate-pr-reconciliation-from-revision-refresh-and-merge-confirmation.md
spec: .agents/specs/2026-08-12-pr-metadata-reconciliation-and-workbench-polish/2026-08-12-tech-spec.md
---

# Reconcile same-revision GitHub state and polish the workbench

> Read this plan, spec, `CONTEXT.md`, ADR-0001, ADR-0012, ADR-0013, and ADR-0017 before editing. Preserve immutable represented-review worktrees, explicit write confirmation, and uncertain-write recovery. Use deterministic fakes and read-only Electron verification only.

## Status

- Priority: P1
- Effort: L
- Risk: HIGH — changes reconciliation, draft ownership, durable freshness, and merge-write contracts.

## Purpose

Quietly show current GitHub state only for the represented revision; use explicit **Refresh** to adopt changed code. Also fix Pierre light theme and replace merge confirmation dialog with a compact method selector and **Merge** command.

## Fixed product decisions

- Revision identity is `(headSha, baseSha, canonicalPatchHash)`. The observation adapter fetches GitHub's complete unified diff for those SHAs and hashes exactly the normalized bytes used by `ReviewSessionPreparation` for the represented session patch. Missing/incomplete comparison evidence is `unavailable`, never head-only proof.
- `revision_changed` applies no remote metadata/draft state and exposes Refresh. `unavailable` preserves the last known read-only projection, blocks writes, and hides Refresh. A successful same-revision observation clears unavailable automatically.
- A terminal merged/closed result is the narrow exception: mark terminal and stop writes, without adopting changed revision state.
- Same-revision reconciliation quietly saves bounded metadata, Conversation, and the authoritative pending draft; never session/worktree/Insight/patch artifacts. Pending draft adoption is forbidden while `WriteInFlight` or `OutcomeUnknown`.
- Old Finding receipt evidence becomes Historical on draft replacement/removal. It re-enables a Finding only when complete GitHub pending and published-feedback evidence proves no remaining remote receipt.
- Finish review preserves typed summary in a stable controller. Submit carries an opaque pending-review revision token and makes no write after drift. Discard targets current adopted draft. A direct reply retains text but Comment now cannot write after an adopted draft appears.
- Every confirmed state-changing write queues one coalesced, read-only follow-up observation. Failed/uncertain writes queue no **immediate** follow-up; ordinary visible-workbench observation may still update read-only state but must leave locked draft/recovery state intact.
- `RecentReviewWrite` journal entries are consumed only after a successful same-revision snapshot/projection that contains their receipts; until then they normalize detector propagation only. They are never retained past reconciliation or explicit Refresh.
- All Refresh, observation, write, and recovery work uses one `ReviewOperationCoordinator` lock keyed by profile/review. Do not retain independent refresh/write locks.
- Snapshot candidate, session draft transition, and Review freshness transition use an operation journal. Persist candidate first; journal intended old/new hashes and session version; atomically save each optimistic-concurrency transition in order; complete/remove journal last. Recovery either completes the exact transition or marks Review unavailable. Never project a new session draft with old Review snapshot.
- Merge is selector + **Merge**, no dialog. Warnings require acknowledgement bound to exact revision/warning codes. It returns typed outcomes. `OutcomeUnknown` uses the existing workbench recovery action and `POST /v1/reviews/publication/recover`; extend that route and `ReviewRecoveryService` to reconcile the durable merge operation as well as publication evidence before reloading the workbench. Add no button.
- Pierre inherits active app light/dark theme; no separate preference.

## Implementation slices

### 1. Verify durable contracts before behavior

Verify/update ADR-0017 and glossary wording. Add `ReviewFreshness` durable union to `Review`:

```ts
type ReviewFreshness =
  | { readonly _tag: "Fresh" }
  | { readonly _tag: "RevisionChanged"; readonly detectedAt: IsoTimestamp; readonly identity: ObservedRevisionIdentity }
  | { readonly _tag: "Unavailable"; readonly detectedAt: IsoTimestamp; readonly reason: "base_missing" | "diff_incomplete" | "github_read" | "comparison_ambiguous" | "reconciliation_incomplete" };
```

Migrate/parse existing Review records as `Fresh` when they have a represented snapshot and no `detectedUpdate`; map legacy `detectedUpdate` to `RevisionChanged`. Update `ReviewWriteGate.requireFresh()` to allow only `Fresh`; update workbench freshness projection and error mapping. Use compare-and-save expected `Review.updatedAt` on every change.

**Verify:** migration/parser, gate, old detected-update compatibility, unavailable→fresh recovery, and terminal precedence tests.

### 2. Prove canonical remote revision identity

Add `GitHubRevisionIdentityReader` around existing `GitHubReader.getPullRequest()` and `getPullRequestDiff({ snapshot: { baseSha, headSha } })`. Require parsed base SHA and full diff. Normalize GitHub diff by the exact `ReviewSessionPreparation` patch normalization function, then use `contentHash`/the same SHA-256 implementation used for session patches. Compare it to the persisted session patch hash. Return a closed `Same | Changed | Unavailable` result; no head-only fallback.

**Verify:** equal normalized diff, base/head/patch change, missing base, incomplete/failed diff, normalization regression, fake adapter contract.

### 3. Share coordination and make observation recoverable

Replace `ReviewRefreshService` private lock and `ReviewWriteCoordinator` set with injected `ReviewOperationCoordinator.withReviewLock(profileId, reviewId, operation)`. Use it in explicit refresh, `ReviewObservationService`, pending-review writes/adoption, merge controller, and `ReviewRecoveryService.reconcilePublication` (inside existing profile lifecycle lock).

Add `ReviewObservationJournal` storage. Under the shared lock:

```txt
read Review/session/snapshot @ versions
-> prove revision identity twice
-> read bounded metadata/Conversation/pending/publication evidence
-> save content-addressed candidate snapshot
-> write observation journal(old/new snapshot, expected Review/session versions)
-> save session adoption @ expected session version
-> save Review represented snapshot/freshness @ expected Review.updatedAt
-> remove journal
-> project
```

If a save fails after journal creation, return unavailable; recovery replays only exact expected versions or marks unavailable. Orphaned candidate snapshots are allowed.

**Verify:** lock contention among observation/refresh/write/recovery; save failures at each transition; journal replay/mark-unavailable; no mixed projection.

### 4. Persist every reconciled seam and draft evidence

Extend `ReviewRemoteStore` `snapshotSchema`/`parseReviewRemoteSnapshot` to include bounded `conversation`; update fixtures and old snapshot migration. `PendingReviewService.adoptObservedState()` changes only confirmed states; locked states return unchanged. Add Historical receipt schema/state and complete-evidence classifier. If pending/published readers are incomplete/unavailable, retain receipt non-actionable.

Consume `RecentReviewWrite` entries after the newly persisted snapshot contains their comment/review/thread evidence. Explicit Refresh clears the journal after its complete snapshot is durable. If GitHub propagation still hides a receipt, leave the entry for the next ordinary observation; do not falsely mark freshness stale.

**Verify:** Conversation persistence round trip; adoption/replacement/removal; locked preservation; receipt evidence ambiguity; journal consumption/propagation.

### 5. Protected projection and safe renderer behavior

Evolve detect-updates DTO to closed `reconciled | revision_changed | unavailable | terminal | unchanged`. The renderer keeps one coalesced observation for the visible workbench and identity-checks Review/session/revision before applying it. It retains Finish-review text in flow/controller state. Submit sends pending revision token; drift gives focused error and zero write. The ordinary detector may run during locked recovery but must never replace locked pending state.

**Verify:** route parsing/redaction, stale DTO rejection, write coalescing, no immediate observe after failed/unknown write, text persistence, direct-reply blocking.

### 6. Typed compact merge command

Replace/delete `MergeConfirmationDialog`. Add compact selector, current readiness/warnings, exact acknowledgement, and **Merge** button. `MergeWriteController` parses `MergeWarningAcknowledgement`, acquires shared lock, proves revision identity/readiness, validates same warning set, then sends one merge write. It maps `ReadinessChanged | RevisionChanged | Unavailable | OutcomeUnknown | Merged` to bounded UI states. Existing recovery endpoint is reused for `OutcomeUnknown`; renderer uses its existing recovery action/copy, not a new control.

**Verify:** acknowledgement invalidation, final revision/readiness check, all typed outcomes, recovery endpoint projection, keyboard/focus/narrow sidebar tests.

### 7. Theme and gates

Use Pierre supported container color-scheme/CSS variables. Preserve interaction and contrast. Run focused tests after each slice, then `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`, `pnpm exec playwright test`, and `git diff --check`. Restart Electron before read-only CDP QA; record baseline browser failures.

## Done criteria

- [ ] Canonical remote identity is proven or writes fail closed as unavailable.
- [ ] Freshness state is durable, migrated, parser-validated, and gate-enforced.
- [ ] Observation, refresh, writes, and recovery share one review lock and recover multi-store transitions without mixed view.
- [ ] Same-revision snapshot persists Conversation/draft evidence and safely consumes confirmed-write journal entries.
- [ ] Refresh remains the only changed-revision/worktree adoption path; terminal exception is narrow.
- [ ] Draft drift preserves typed Finish-review text and cannot duplicate Findings.
- [ ] Compact one-click Merge has exact warning/revision acknowledgement and a reachable existing uncertain-outcome recovery path.
- [ ] Tree follows light/dark theme; verification passes or exact baseline failures are documented.

## Stop conditions

Stop and ask if GitHub diff normalization cannot reproduce session-patch hashing, complete pending/published evidence is unavailable for receipt reactivation, shared coordinator cannot cover all current write/refresh/recovery paths, or the existing recovery action is not reachable from merge outcome UI.

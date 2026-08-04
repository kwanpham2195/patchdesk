# Task 4 implementation report

## Changed files

- `src/adapters/storage/review-remote-store.ts`
- `src/services/review-refresh-service.ts`
- `src/services/review-write-gate.ts`
- `src/services/review-workbench-controller.ts`
- `src/main/local-api.ts`
- `tests/storage/review-remote-store.test.ts`
- `tests/services/review-refresh-service.test.ts`
- `tests/services/review-write-gate.test.ts`
- `task-4-report.md`

Existing unrelated dirty files were preserved. No changes were made to `tests/local-api-auth.test.ts` because the existing capability/origin coverage remained passing.

## Tests added

- Content-addressed strict remote snapshot round trip and hash URL exclusion.
- Marker-only elapsed-time detection.
- Fresh write gate and detected-update rejection.

## Commands run

- `pnpm typecheck` — passed.
- `pnpm test -- --run tests/services/review-refresh-service.test.ts tests/services/review-write-gate.test.ts tests/storage/review-remote-store.test.ts tests/local-api-auth.test.ts` — passed, 4 files / 39 tests.
- `git diff --check -- <Task 4 files>` — passed.
- `git status --short --untracked-files=all` — confirmed no staged files; existing unrelated modifications remain.

## Validation

- Remote snapshots use strict parsing, content-addressed atomic JSON writes, and canonical SHA-256 hashing with check URLs excluded; storage stays under the existing Review workbench path seam.
- Detection reads remote PR/check metadata and only persists `Review.detectedUpdate`; elapsed time alone does not mark updates.
- Refresh is serialized per Review, persists candidate snapshots before Review pointer advancement, handles same-head and new-head sessions, performs an exact-head verification, and preserves the old Review pointer when later persistence fails.
- Local API retains capability/origin middleware and adds strict schemas for open/load/detect/refresh routes with status mapping.
- Review write gate rejects missing represented state, detected updates, identity/head mismatches, and terminal Reviews.

## Reviewer safety fix evidence

- Loads and explicit refresh responses now project the represented or newly committed snapshot without a live GitHub read; represented projection has regression coverage for stale live data.
- New-head preparation carries all non-terminal batch content, including Applying and PartialFailure state plus receipts; a prepared B→C race is rejected before Review advancement.
- ReviewWriteGate loads the content-addressed snapshot and verifies PR identity/head; ReviewStore rejects same-millisecond stale CAS updates after domain transitions advance timestamps monotonically.
- Detection serializes on the same per-Review lock as refresh and always returns `detectedAt`, including false outcomes. API status mapping returns 503 for `github_read` and storage availability.

Additional commands run:

- `pnpm test -- --run tests/domain/review-anchor.test.ts tests/storage/review-store.test.ts tests/services/review-refresh-service.test.ts tests/services/review-write-gate.test.ts tests/storage/review-remote-store.test.ts tests/services/review-workbench-projection.test.ts tests/local-api-auth.test.ts` — passed, 7 files / 66 tests.
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `git diff --check` — passed.

## Residual risks

- Full lifecycle coverage for publication, feedback/thread mutation, and merge callers belongs to later plans.
- No commit/stage/branch/reset/clean/stash operations were performed.

## Task 4 blocker-fix pass (2026-08-01)

### Changes

- Existing deterministic target Sessions now load and carry a predecessor's non-terminal draft before returning `resumed`; missing predecessor/patch/save evidence fails closed without advancing Review.
- Detection reads the current PR head before old-head checks or represented snapshot dependencies, so an unavailable old-head checks response cannot hide a changed head.
- Renderer saved load, explicit refresh, and periodic detection now use stable `reviewId`; session IDs remain only on session-scoped run, diff, walkthrough, and write contracts. The Electron allowlist includes `POST /v1/reviews/detect-updates`.
- Workbench terminal status uses the durable Review aggregate when available; session terminal state is not authoritative in the composed application path.
- Added a renderer stable-ID derivation seam for older in-memory projections that omit the Review field.

### Tests added or updated

- `tests/services/review-session-preparation.test.ts`: existing deterministic target draft carry-forward.
- `tests/services/review-refresh-service.test.ts`: changed-head detection despite unavailable old-head checks.
- `tests/services/review-workbench-projection.test.ts`: durable Review status overrides a merged Session state.
- `tests/desktop-bridge.test.ts`: detect-updates allowlist.

### Exact verification

- `pnpm test -- --run tests/services/review-session-preparation.test.ts tests/services/review-refresh-service.test.ts tests/services/review-write-gate.test.ts tests/storage/review-remote-store.test.ts tests/local-api-auth.test.ts tests/renderer/renderer-contracts.test.ts tests/renderer/review-workbench.ui.test.tsx` — passed, 7 files / 77 tests.
- `pnpm test -- --run tests/services/review-workbench-projection.test.ts tests/desktop-bridge.test.ts tests/services/review-session-preparation.test.ts tests/services/review-refresh-service.test.ts` — passed, 4 files / 39 tests.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `git diff --check` — passed.
- `pnpm test -- --run` — failed, 86 files / 602 passed / 7 failed, with one unhandled rejection. The failures are legacy dirty-branch renderer expectations for `sessionId`/old refresh payload and the pre-existing `review_started` controller expectation; they are not used as acceptance evidence for the stable Review contract.
- `git diff --cached --quiet` — passed (no staged files).

### Residuals

- The full-suite legacy UI tests still expect session-bound saved-load/refresh payloads and the pre-migration projection states; updating those tests requires the broader Task 3/4 projection migration already present in unrelated dirty work.
- Full lifecycle coverage for publication, feedback/thread mutation, and merge callers remains assigned to later plans.

## Task 4 repair-blocker pass (2026-08-01)

### Changes

- `ReviewRefreshService.refresh()` now loads and validates the current Review session before any remote candidate write, rejecting missing sessions, identity mismatches, and session-head mismatches without advancing or writing a candidate.
- Refresh no longer terminalizes a Review when `MergeOutcome.state` is `open`; only `merged` and `closed_unmerged` are terminal outcomes.
- `ReviewWorkbenchController.projectStable()` now falls back to local session projection when the represented snapshot head differs from the durable Review head, matching the load guard.
- Seven reviewer-listed renderer/service tests now use the canonical `state: "review"`, nested `revision`, stable `reviewId`, and atomic refresh projection contract. No `review_started`/`review_completed` aliases were added.

### Tests added or updated

- `tests/services/review-refresh-service.test.ts`: missing current session, mismatched session head, and open merge outcome regressions.
- `tests/services/review-workbench-controller.test.ts`: represented snapshot/session head mismatch guard.
- `tests/renderer/dashboard.ui.test.tsx`: three persisted workbench tests migrated to canonical projection and Review ID destination.
- `tests/renderer/prepared-review-flow.ui.test.tsx`: refresh and changed-head tests migrated to atomic canonical refresh responses.
- `tests/renderer/completed-review-flow.ui.test.tsx`: changed-head refresh migrated to atomic canonical response.
- `tests/services/review-workbench.test.ts`: canonical nested revision assertion.

### Exact verification

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm test -- --run tests/services/review-refresh-service.test.ts tests/services/review-workbench-controller.test.ts` — passed, 2 files / 14 tests.
- `pnpm test -- --run tests/services/review-refresh-service.test.ts tests/services/review-write-gate.test.ts tests/storage/review-remote-store.test.ts tests/local-api-auth.test.ts` — passed, 4 files / 47 tests (Task 4 focused gate).
- `pnpm test -- --run tests/renderer/dashboard.ui.test.tsx tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/completed-review-flow.ui.test.tsx` — passed, 3 files / 49 tests.
- `pnpm test -- --run tests/services/review-workbench.test.ts` — passed, 1 file / 5 tests.
- `pnpm test -- --run` — passed, 91 files / 622 tests; no unhandled rejection.
- `pnpm build` — passed.
- `git diff --check` — passed.
- `rg -n 'review_started|review_completed' src/renderer/src/flows/review-workbench-flow.tsx tests/renderer/dashboard.ui.test.tsx tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/completed-review-flow.ui.test.tsx tests/services/review-workbench.test.ts` — existing internal `review_started` adapter references only; no new aliases were added.
- `git diff --cached --quiet` — passed; no staged files.

### Remaining blocker

- None for Task 4 review blockers. Publication, feedback/thread mutation, and merge lifecycle coverage remains assigned to later plans.

## Task 4 canonical renderer repair pass (2026-08-01)

### Changes

- Replaced the prohibited prepared/completed response-shape adapter in `src/renderer/src/flows/review-workbench-flow.tsx` with direct `WorkbenchResponse` rendering.
- Added the minimum canonical `ReviewWorkbench` shell and typed slots for Insights, draft, published feedback, and merge surfaces; the full Review projection remains the sole renderer model.
- Kept detection marker-only: it patches only `revision.freshness`; explicit refresh parses and atomically replaces the complete canonical projection by stable `review.id`.
- Added focused renderer coverage for direct `state: "review"` rendering and stable Review refresh replacement.

### Exact verification

- `pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/dashboard.ui.test.tsx` — passed, 2 files / 26 tests.
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm test -- --run` — passed, 92 files / 624 tests.
- `pnpm build` — passed.
- `git diff --check` — passed.
- `rg -n 'review_started|review_completed|PreparedReviewFlow|CompletedReviewFlow|toPreparedFlow|toCompletedFlow|fromPreparedPatch|fromCompletedPatch' src/renderer/src/flows/review-workbench-flow.tsx` — no matches.
- No files were staged or committed; unrelated dirty work remains untouched.

### Residuals

- Analysis execution, draft mutation/publication, Published feedback mutation, merge, and commit-specific navigation remain typed slots for later unified-workbench tasks; this pass does not reintroduce legacy renderer contracts.

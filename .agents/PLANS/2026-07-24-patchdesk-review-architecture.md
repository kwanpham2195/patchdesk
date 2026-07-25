---
created_at: 2026-07-24
repos:
  - patchdesk
status: draft
design: .agents/designs/2026-07-24-patchdesk-review-architecture.md
depends_on:
  - .agents/PLANS/2026-07-23-patchdesk-ux-recovery-completion.md
---

# Patchdesk review architecture deepening

This ExecPlan is a living document. Keep **Progress**, **Surprises & Discoveries**, **Decision Log**, and **Outcomes & Retrospective** current as work proceeds.

## Purpose / Big Picture

Deepen the three review paths that have changed most often without changing Patchdesk’s safety model or adding product scope:

1. immutable Review Session preparation and Workbench projection;
2. the completed Review Workbench interaction boundary;
3. the renderer application flow.

The end state gives each path one clear owner. Preparing a Review Session remains a read-only, immutable workflow. Projecting a Workbench remains a safe renderer read model. The completed-review screen owns its local selection and write-safety behavior. The renderer root owns only cross-screen routing and navigation safety.

A maintainer must see no changed GitHub-write, review-attempt, diff, theme, or fixed-desktop-geometry behavior. The work is complete only when the existing customer-management PR #118 packaged-Electron path remains readable, rails restore correctly, the command palette works, the page has no horizontal overflow, and no console or page errors occur.

## Progress

- [x] Confirm the recovery-completion contracts on the target revision before implementation.
- [x] 2026-07-24: Milestone 1 will land independently before renderer work begins.
- [x] 2026-07-24: Milestone 0 behavior map completed against revision `21bb052`; see Behavior map below.
- [x] Establish behavior tests for the Session lifecycle and Workbench projection seam.
- [x] 2026-07-24: Deepened immutable Session preparation and Workbench projection (`d7436e5`).
- [x] 2026-07-24: Deepened the completed Review Workbench interaction boundary (`6cc338c`, `d05c785`).
- [x] 2026-07-24: Isolated hash-routed fixtures (`8a05f23`), Inbox screen content (`4db46c1`), and Settings screen content (`444ff6a`). The remaining Inbox/Settings API sequencing and state ownership moved to their flows; App now retains workspace snapshots/generation refresh, routing guards, shell, and appearance.
- [x] 2026-07-24: Final packaged-Electron acceptance passed on the latest artifact through the dedicated CDP tester; evidence is recorded below.

## Behavior map (Milestone 0, revision `21bb052`)

Observable behaviors that may not change, confirmed in code:

- `POST /v1/reviews/open` (`ReviewWorkbenchController.open`): parses `profileId/host/owner/repo/number` then optional `mode`/`baseSessionId`; failure reasons are exactly `invalid_input | not_found | github_read | head_changed | storage`. Profile load maps `not_found`→`not_found`, other→`storage`. A stored Session resumes (no artifact writes, no Attempt mutation) iff its patch file reads or its state is `ReviewCompleted`; a stored Session with a missing patch and no completed state is re-prepared. Incremental mode: unparseable `baseSessionId` or missing comparison capability→`invalid_input`; unusable base→`not_found`; comparison failure→`head_changed`/`storage`; incomplete/unavailable GitHub comparison→truthful full fallback; head rechecked after comparison → `github_read`/`head_changed`. Session-preparation failure→`storage`.
- `POST /v1/reviews/load`: any profile or session load error→`not_found`; attempts-list failure inside projection→`storage`.
- Prepared projection (`review_started`): session, optional fullPatch/pullRequest/currentHeadSha, reviewedHeadSha, freshness (`fresh|stale|unavailable`), refreshedAt, safe checks fallback `{overall:"unknown",checks:[]}`. Never lists attempts, never starts anything.
- Completed projection: safe fallbacks for comments/checks/current PR (prContext-derived summary when GitHub is down), comparisonAvailability (`available|not_requested|incomplete|missing`), history from stored attempts, mergeReadiness blocked with `stale_head` when GitHub is unavailable.
- Wire leak today: `open`/`load` serialize the domain `ReviewSession` (with `patchPath`, `worktree`) and incremental `ReviewScope` (with four artifact paths). The renderer never reads them; `parseWorkbenchResponse` currently fails on real responses (strict session schema) so every response takes the permissive `isWorkbenchPayload` fallback. Consequence: Milestone 1 makes the strict parser authoritative and deletes the fallback.
- Renderer consumption of the workbench payload: `session.id`, `session.key.{profileId,owner,repo,prNumber,headSha}`, `session.currentAttemptId`; `reviewScope.kind` (+ badge/tabs only); inline `fullPatch`/`comparisonPatch`/`comparison`/`lifecycle`; `result/draft/comments/checks/history/mergeReadiness/pullRequest/reviewedHeadSha/currentHeadSha/freshness/refreshedAt/comparisonAvailability`. `session.draftContent` is typed but never read.
- Completed-review interaction state (Milestone 2 target) lives in `review-workbench.tsx`: fixQueue (localStorage per profile+head), diffSurface, selectedPath/selectedFinding/findingFilter/selectedAttempt, copyState, draftSaveState, writePending, navigationOpen, preferences (localStorage), collapsedPaths; it reports `clear|dirty_draft|write_pending` to the root.
- `app.tsx` (Milestone 3 target): ~53 state slots, 23 API call sites, 8 hash-routed fixtures (`#diff-fixture`, `#run-fixture`, `#workbench-fixture`, `#long-workbench-fixture`, `#performance-fixture`, `#submission-fixture`, `#submission-rejection-fixture`, `#merge-fixture`), destination persisted at localStorage `patchdesk.destination`, single-flight profile-scoped `InboxRefreshScheduler`, navigation guard dialog where `write_pending` offers only cancel.

Grilling outcomes: the design's open questions resolve as follows. (1) The completed-review route needs nothing in `App` beyond the projection and action callbacks — `WorkbenchPayload` (app.tsx:142-173) plus `saveDraft`/`reviewWrite`/`mergeReview`/`setNavigationState` cover it; `runId` is renderer-local and attached by `startOwnedRun`, so it belongs to the prepared-review flow, not the completed model. (2) Fixture routes can move to dedicated fixture modules unchanged because they are hash-based (`window.location.hash`) and never touch the destination store. No new durable term needed a glossary entry; existing Session/Attempt/Workbench/immutable-artifact vocabulary is precise.

## Scope and non-goals

In scope:

- Concentrating existing review preparation policy, including full versus incremental preparation, immutable artifact ownership, current-head verification, and safe preparation fallback.
- Separating Session preparation from Workbench projection without changing their observable API behavior.
- Concentrating completed-review local interaction state, including finding/file selection, filters, layout preference application, draft-save state, and write-pending navigation protection.
- Separating renderer screen flows from the root application component while preserving route restoration, refresh behavior, and existing local preference keys.

Out of scope:

- New Review, Attempt, Session, GitHub-write, Flue, model, storage, or renderer privileges.
- A second implementation of the My PRs workspace in `.agents/PLANS/2026-07-24-patchdesk-my-prs-maintenance.md`.
- Moving Pierre hydration, progressive stream batching/cancellation, or QA scroll diagnostics back into `ReviewDiffView`.
- Generic route registrars, repository wrappers, service-per-noun abstractions, framework-wide state management, or compatibility layers without an explicit public contract.
- Changing the fixed desktop geometry, the Base Nova primitive defaults, Pierre’s scoped code metrics, or the explicit GitHub write-confirmation flow.

## Context and orientation

The completed recovery plan establishes the current product contract:

- opening a pull request creates or resumes a read-only Session and does not start a model;
- a user explicitly starts an Attempt after current-head and model validation;
- a renderer receives bounded local-API projections only;
- immutable diff artifacts belong to the real Session and Attempt lifecycle;
- live UI proof uses the dedicated read-only `code-analysis.patchdesk-electron-tester` through CDP.

The relevant modules are:

- `src/services/review-workbench-controller.ts`: currently parses review-opening input, chooses resume/full/incremental behavior, coordinates preparation, and projects prepared/completed workbenches.
- `src/services/review-session-service.ts`: creates immutable Sessions and writes their patch/context artifacts.
- `src/services/review-comparison-service.ts` and `src/services/review-attempt-artifacts.ts`: own comparison and artifact mechanics.
- `src/main/local-api.ts`: the authenticated loopback protocol boundary and composition root.
- `src/renderer/src/components/review-workbench.tsx`: completed-review selection, filtering, draft/write safety, layout, and child composition.
- `src/renderer/src/components/review-diff-view.tsx` and its hooks: Pierre integration. This plan preserves its hook boundaries.
- `src/renderer/src/app.tsx`: the renderer root, currently also owning screen-local state, API sequencing, and fixture surfaces.

No `CONTEXT.md` or ADR currently exists. The plan uses existing Review Session, Attempt, Workbench, and immutable artifact language. Create `CONTEXT.md` only when the grilling loop resolves a new durable term that does not already have a precise name in the code.

## Evidence and architectural diagnosis

Recent commits repeatedly touched `app.tsx`, `review-workbench.tsx`, `review-diff-view.tsx`, `local-api.ts`, `review-workbench-controller.ts`, and `review-session-service.ts`.

- `app.tsx` is 3,100 lines and combines route state, profile/inbox refresh behavior, model preference state, settings drafts, review actions, screen rendering, and test fixtures.
- `review-workbench.tsx` is 985 lines and accepts a broad collection of review, draft, submission, merge, diff, and callback data while owning local selection and write-safety state.
- `review-workbench-controller.ts` combines Session opening/preparation policy with the read-side projection of a prepared or completed Workbench.

The deletion test supports the three targets. Removing an extracted Session-preparation capability would push immutable artifact and head-safety rules across callers. Removing the completed-review interaction boundary would push selection and write-safety rules into the renderer root. Removing a screen flow would push API sequencing and local loading policy back into `App`.

By contrast, splitting `local-api.ts` into thin route registrars is not planned. It is a security-sensitive composition and protocol boundary. Reducing its line count alone would not create a deeper module.

## Plan of work

Work from the innermost safety boundary outward. Each milestone should be reviewable and releasable on its own. Do not begin the next milestone until the prior milestone’s real-seam tests pass.

### Milestone 0: confirm terms, behavior, and independent landing boundaries

Goal: agree on the implementation order and document the observable behavior that cannot change before moving code.

Work:

1. Inspect the current recovery-completion behavior and tests for Session open/resume, incremental preparation, stale heads, prepared workbenches, completed workbenches, dirty draft navigation, and explicit review start.
2. Make a focused behavior map that distinguishes Session preparation, Workbench projection, completed-review interaction state, and root application routing. This is a design note inside this plan, not a new abstraction.
3. Define the acceptance boundary for each milestone in terms of what callers can observe. Do not settle module signatures or move code solely to make helpers testable.
4. Run the grilling loop one decision at a time. Record accepted answers in the Decision Log. Create a glossary entry only for a newly resolved term.
5. Treat existing local saved sessions, browser local-storage preferences, and renderer-internal routes as development data, not compatibility contracts. A better architecture may intentionally invalidate them. Do not add migration, dual-read, fallback, alias, or dual-write paths.

Exit criterion: every milestone has a stable observable outcome, an owner, and focused test coverage to protect it. No implementation interface has been selected by convenience.

### Milestone 1: make immutable Session preparation and Workbench projection distinct capabilities

Goal: one capability prepares or resumes a read-only immutable Review Session; another safely projects an existing Session into the renderer Workbench shape.

Work:

1. Move the preparation policy currently spread through `ReviewWorkbenchController.open` and `ReviewSessionService` behind one cohesive Session lifecycle capability. It owns current PR reads, resume eligibility, full versus incremental scope choice, keyed serialization by derived Session ID, a durable preparation journal, staged comparison preparation, current-head recheck before commit, immutable artifact persistence, and cleanup/recovery when later steps fail.
2. Keep the existing storage and GitHub adapters as dependencies at the existing main-process seam. The lifecycle uses narrow behavior-shaped dependencies rather than a new generic repository layer.
3. Move prepared/completed Workbench assembly into a distinct read-side projection capability. It owns safe fallback projection when GitHub is unavailable, preserves the current no-rerun/no-synthetic-attempt behavior, and serializes explicit renderer-safe Session/scope projections that omit every artifact and worktree path.
4. Keep `local-api.ts` responsible for authentication, protocol failure mapping, and capability composition. Preserve its current request-parsing behavior; a strict review-opening command parser is a separate deferred improvement.
5. Preserve the product invariant that merely opening or refreshing a Workbench does not start, restart, complete, discard, or mutate an Attempt.
6. Delete the old mixed ownership path once all callers use the new capability. Do not leave aliases or duplicate paths unless the grilling outcome establishes a real external contract.

Tests:

- Existing Session resumes without a model run or a new Attempt.
- New full and incremental Session preparation persists the correct immutable artifacts, serializes concurrent opens for the same derived Session, and rejects a changed head before commit.
- A changed head after comparison preparation or any later final-artifact/Session-persistence failure removes every journalled staging and final artifact: comparison files, patch, context, review input, debug file, and managed worktree. A cleanup failure retains only a non-renderable recovery journal for startup cleanup.
- Incomplete incremental comparison falls back only to the truthful full-review behavior already accepted by the recovery plan.
- Prepared and completed projections preserve safe GitHub-unavailable behavior and never re-run preparation just to render a saved result.
- The local API preserves its existing review-opening protocol behavior, maps expected lifecycle failures without exposing internal paths or diagnostics, and serializes no patch, worktree, or incremental-artifact paths. Renderer-contract tests reject such fields.
- No read-only Session/workbench route mutates an Attempt or invokes a workflow.

Exit criterion: callers can request “open this review” or “load this Workbench” without learning the ordering of GitHub reads, comparison preparation, artifact persistence, or projection fallbacks.

### Milestone 2: deepen the completed Review Workbench interaction boundary

Goal: the completed-review surface owns the local rules that make a review inspectable and safe to navigate away from.

Work:

1. Concentrate selected finding, selected file, selected evidence range, filtering, collapsed-file state, local Fix queue status, view preferences, draft-save state, and write-pending navigation state in one completed-review interaction owner.
2. Keep presentational children focused on their content. The diff remains a dedicated Pierre boundary, and its hydration, progressive streaming, and QA diagnostic hooks remain where they are.
3. Keep review result interpretation, freshness, stale-head write blocking, and draft/merge affordances visible through the interaction boundary. The root application must not translate a large unrelated callback set into the completed review surface.
4. Preserve keyboard navigation, screen-reader labels, focus behavior, and the 1280px desktop rail contract.
5. Delete duplicate selection/navigation/write-state logic after the behavior is covered. Do not introduce a global renderer store for state that belongs to one open review.

Tests:

- Selecting a finding selects the mapped file/range and expands only the needed local state.
- Applying and clearing filters retains or truthfully hides the selected finding without corrupting navigation.
- A dirty draft or write in progress blocks route changes through the existing navigation contract.
- Stale/unavailable GitHub freshness prevents write actions but leaves saved review evidence readable.
- Diff selection, file mode, unified/split layout, and all-files progressive rendering retain the existing Pierre behavior.
- Renderer tests exercise the interaction boundary through the same user controls callers use, not private helpers or component spies.

Exit criterion: the completed-review caller supplies a safe Workbench projection and receives one coherent interaction surface, without knowing how selection, filtering, draft safety, or diff navigation are coordinated.

### Milestone 3: deepen renderer screen flows and shrink the application root

Goal: `App` becomes a small renderer composition root for destination selection and cross-screen navigation protection. Each screen flow owns its own API sequencing and local UI state.

Work:

1. Identify the existing Inbox, Review Workbench, Settings, and fixture-only screen flows in `app.tsx`; preserve their current route restoration and safe bridge calls.
2. Extract each cohesive screen flow with its API reads, loading/error/refresh states, and local controls. Keep API parsing at the renderer boundary through existing concrete contracts; do not pass raw API values through the component tree.
3. Move run-dialog visibility, model-catalog loading, selected model/reasoning preference, and dialog-local errors into the prepared-review flow. Keep only shared destination state, profile-level handoff, appearance application, and cross-screen dirty-draft/write-pending navigation safety in the root.
4. Move development/browser fixtures out of the production application flow where doing so does not change their current test URL or test contract.
5. Keep Inbox refresh scheduling single-flight, profile-scoped, and read-only. Entering or leaving an extracted screen may not refresh, mutate, or restart an in-progress review by accident.
6. Delete the old root-owned screen state after adoption. Do not retain duplicated screen routes or compatibility state bags.

Tests:

- Route restoration, profile selection, Inbox refresh, direct review open/load, Settings preferences, and review execution dialog behavior remain observable through the existing renderer surface.
- Navigation guards behave identically when a draft is dirty or a GitHub write is pending.
- An Inbox refresh does not mutate a Session or Attempt; an active review remains truthful across screen changes.
- Existing fixture routes remain isolated from production behavior and preserve browser-test expectations.
- No page-level horizontal overflow, console error, or page error at both 1920×1080 and 1280×800.

Exit criterion: a maintainer can still move across Inbox, history, review workbench, and Settings exactly as before, while a change to one screen no longer requires understanding unrelated screen state in `App`.

### Milestone 4: whole-product verification and plan reconciliation

Goal: prove the architecture change in the real packaged Electron product and remove obsolete paths.

Work:

1. Run focused tests at each milestone, then the complete repository gate.
2. Package the macOS application and run package smoke verification.
3. Dispatch `code-analysis.patchdesk-electron-tester` as the sole interactive QA owner. It must use `agent-browser` over CDP, take screenshots, inspect console/page errors after routes, and assert zero page-level horizontal overflow.
4. The tester validates saved customer-management PR #118, application and queue rail restoration, command palette operation, prepared-review Overview and Diff, and normal completed-review navigation. It must not start a review or enter a GitHub write-confirmation flow.
5. Review every moved/deleted path. Remove accidental aliases, stale exports, tests of implementation details, and dead compatibility branches.
6. Update this plan’s Progress, discoveries, decisions, and Outcomes with exact commands, screenshot paths, residual risks, and the final changed-path summary.

Exit criterion: all test gates pass, packaged CDP evidence is saved, the app has no page-level overflow or renderer errors, and no removed path remains reachable.

## Concrete verification

Run focused behavior tests while changing their owner, then run the full gate from `/Users/kwanpham/Work/cfw/patchdesk`:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm exec playwright test
pnpm package:mac
pnpm test:package-smoke
```

For live packaged verification, the dedicated tester follows the project CDP protocol:

```bash
./release/mac-arm64/Patchdesk.app/Contents/MacOS/Patchdesk \
  --user-data-dir=/tmp/patchdesk-qa-architecture \
  --remote-debugging-port=9233
agent-browser --session patchdesk-qa-architecture --cdp 9233 snapshot -i
agent-browser --session patchdesk-qa-architecture --cdp 9233 errors
agent-browser --session patchdesk-qa-architecture --cdp 9233 console
agent-browser --session patchdesk-qa-architecture --cdp 9233 screenshot /tmp/patchdesk-architecture-qa.png
```

Use a different CDP port when 9233 is in use. Before each live interaction, re-snapshot. The tester also asserts:

```js
document.documentElement.scrollWidth - document.documentElement.clientWidth === 0
```

## Risks and recovery

- Session preparation is a safety boundary. Preserve its observable behavior with real-seam tests before moving code, and stop if a refactor would need a synthetic Attempt or a hidden rerun to maintain behavior.
- Incremental comparisons may be unavailable or incomplete. Retain only the accepted truthful fallback already in the completed recovery plan; do not invent a new partial-review mode.
- Renderer extraction risks changing state lifetime. Keep state local to its screen or review interaction boundary and test route transitions, profile changes, and in-flight refresh cancellation.
- The diff is performance-sensitive. Do not move its hook responsibilities or add scrolling behavior. Keep the existing 1,000-file performance ceiling below 200ms.
- If a failure appears only in the packaged application, the dedicated Electron tester’s evidence is authoritative. Do not claim a browser/unit test proves the package behavior.

## Surprises & discoveries

- 2026-07-24: The recovery-completion ExecPlan is marked complete and records full packaged-Electron validation. Consequence: this plan deepens established behavior rather than reopening its UX scope.
- 2026-07-24: Recent changes cluster around renderer application flow, completed reviews, Pierre diff behavior, local API, and Review Session preparation. Consequence: the work is sequenced from immutable Session safety outward to the renderer root.
- 2026-07-24: `ReviewDiffView` already delegates immutable context hydration, progressive stream batching/cancellation, and QA scroll diagnostics to dedicated hooks. Consequence: it is protected as a bounded integration surface, not refactored for line-count reduction.
- 2026-07-24: No `CONTEXT.md` or ADR exists. Consequence: use the existing code’s Review Session, Attempt, Workbench, and immutable artifact vocabulary until a new term is explicitly resolved.
- 2026-07-24: Linear search found no related Patchdesk architecture issue. Consequence: this draft is not linked to a Linear issue.
- 2026-07-24: Before Milestone 1, the two `milestone-12` browser tests failed on this checkout; after the strict bounded projection landed, both passed. The first aggregate Playwright run then had a one-off `milestone-5` parallel failure; its isolated rerun and the next full suite were green (31/31). Consequence: treat the final full suite pass as the milestone evidence, while keeping an eye on parallel browser-test timing in final QA.
- 2026-07-24: Packaged #118 navigation is not slow: a visible PR-title condition appeared in 1.448s. The prior 120-second result waited for non-visible aria-label text and was invalid timing evidence.
  Rationale: package QA must wait for user-visible output, not accessibility attributes that do not render as text.
- 2026-07-24: The final fresh-package tester became detached after resolving an occupied CDP-port conflict; no existing Electron process was terminated.
  Rationale: preserve local process safety and report the missing final-CDP proof rather than synthesizing it from package smoke or browser tests.

## Decision log

- 2026-07-24: Draft the three strong architecture candidates as one ordered program: Session safety/projection, completed-review interaction, then renderer screen flow.
  Rationale: each outer milestone depends on the inner milestone’s stable caller-facing behavior.
- 2026-07-24: Milestone 1 will land independently before any renderer work starts.
  Rationale: stabilize immutable Session behavior before changing renderer ownership.
- 2026-07-24: Existing local saved sessions, browser preferences, and renderer-internal routes are development data, not compatibility contracts. Intentional breaking changes are welcome when they improve the architecture.
  Rationale: Patchdesk is still in development. Preserve review-safety behavior, but delete old paths instead of adding migrations or fallback compatibility.
- 2026-07-24: Milestones 2 and 3 will land as separate changes after Milestone 1 is stable.
  Rationale: completed-review interaction state and root-level routing/refresh have different failure modes and verification surfaces.
- 2026-07-24: Defer strict local-API review-opening command parsing.
  Rationale: it was a Worth exploring candidate, not one of the three selected strong candidates. Keep this plan focused.
- 2026-07-24: Workbench local-API projections must omit all Session/worktree/comparison artifact paths, and Session preparation must serialize concurrent opens with a durable journal, staged artifact commit, exhaustive cleanup, and startup recovery for interrupted cleanup.
  Rationale: domain `ReviewSession` and incremental `ReviewScope` carry absolute paths, while concurrent/open-failure preparation must not leak or orphan immutable artifacts.
- 2026-07-24: Preparation failure union splits `ProfileNotFound`/`ProfileUnavailable` and `InvalidIncrementalBase`/`IncrementalBaseNotFound` beyond the design's seven tags.
  Rationale: the existing route vocabulary maps profile storage errors to `storage` and unusable incremental bases to `not_found`; preserving observable behavior requires the distinction.
- 2026-07-24: The preparation journal records `profileId`, `sessionId`, lifecycle state, staging root, target paths, and for a managed worktree also the repository root path.
  Rationale: crash recovery can only run safety-checked `git worktree remove` with the repository path; the journal stays main-process-only and is never rendered or logged, so recording it does not weaken the projection boundary.
- 2026-07-24: Journal states are `preparing` then `committing` (marked before the atomic Session save); recovery deletes all recorded targets for `preparing` journals and only removes the journal for `committing` ones.
  Rationale: a crash between Session save and journal removal must not delete artifacts a persisted Session references.
- 2026-07-24: `isWorkbenchPayload`'s permissive pre-Phase-2 fallback is deleted in Milestone 1; `parseWorkbenchResponse` becomes the only renderer boundary.
  Rationale: the main process will always emit the strict safe projection, and the plan forbids retaining dual-read compatibility paths for development data.
- 2026-07-24: Session preparation records each target before its write/promotion and marks the journal `committing` before Session persistence; startup recovery cleans `committing` journals without a Session file and removes only journals backed by an atomic Session save.
  Rationale: this closes the crash window between artifact creation, journal updates, and Session persistence without exposing an incomplete Session.

## Outcomes & retrospective

Milestone 0 complete on `21bb052`. Milestone 1 completed in `d7436e5`: `ReviewSessionPreparation` now owns serialized, journalled immutable preparation and recovery; `ReviewWorkbenchProjectionService` owns renderer-safe projection; the old mixed Session service is deleted; strict renderer contracts reject all artifact paths.

Milestone 2 completed in `6cc338c` and `d05c785`: `CompletedReviewWorkbench` is the sole completed-review interaction owner behind `model`/`actions`; it keeps selection, filters, rails, local Fix queue, view preferences, draft-save state, and write-pending navigation reporting local. Pierre’s existing hook boundaries remain untouched. Write actions are optional so read-only fixtures retain their original unavailable state.

Renderer-flow work landed in `14c0405` and `34ffb78`: `PreparedReviewFlow` owns model-catalog loading, model/reasoning preferences, run dialog state, run/resume requests, and completed-workbench reloads; `CompletedReviewFlow` owns draft-save, GitHub review, and merge API sequencing. `8a05f23` moves all eight hash-routed browser/development fixtures and their fixture data out of production `App` without changing URLs or test contracts. `4db46c1` moves Inbox, loading/pending, outcome, and saved-review list screen content into `InboxFlow`; `444ff6a` moves the Settings surface and guarded removal dialog into `SettingsFlow`. The final Milestone 3 slice moves direct-entry preview/profile switch/open, saved-session loading, local-record loading, Settings profile/repository sequencing, and Settings-local draft/path/discovery/diagnostic state into those flows. App retains only shared workspace snapshots with profile-generation stale-response protection, the profile-scoped single-flight refresh scheduler, navigation safety, shell, and appearance. `App` is now 507 lines.

Final verification from the latest source: `pnpm lint` passed; `pnpm typecheck` passed; `pnpm test -- --run` passed (279 tests); `pnpm build` passed; `pnpm exec playwright test` passed (31 tests); `pnpm package:mac` passed; `pnpm test:package-smoke` passed. The package build printed its existing optional-platform-dependency notices and skipped signing because identity is explicitly null.

First packaged CDP QA (before the final fixture-only action fix) passed: saved PR #118 opened its prepared Overview/Diff, a completed review opened Findings, rails restored, command palette worked, overflow was zero at 1920×1080/1280×800, and console/page errors were empty. Evidence: `/tmp/patchdesk-architecture-qa-pr118-overview-1920.png`, `/tmp/patchdesk-architecture-qa-pr118-diff-1920x1080.png`, `/tmp/patchdesk-architecture-qa-existing-review-1280x800.png`, `/tmp/patchdesk-architecture-qa-completed-findings-1280x800.png`, `/tmp/patchdesk-architecture-qa-app-rail-restored-1920x1080.png`, `/tmp/patchdesk-architecture-qa-queue-rail-restored-1920x1080.png`, `/tmp/patchdesk-architecture-qa-command-palette-1280x800.png`. Follow-up timing used a visible title and proved #118 appears in 1.448s; the original 120s delay was an invalid non-visible aria-label wait. Evidence: `/tmp/patchdesk-qa-followup-pr118-immediate.png`, `/tmp/patchdesk-qa-followup-pr118-1s.png`, `/tmp/patchdesk-qa-followup-pr118-10s.png`, `/tmp/patchdesk-qa-followup-pr118-precision-success.png`.

A later final tester run used isolated `/tmp/patchdesk-final-user-data-9240-1784874884` with CDP port 9240 and passed. Saved customer-management PR #118 opened prepared Overview/Diff; saved #754 opened completed review; application and queue rails restored; command palette worked; console/page errors were empty; page-level overflow was zero at 1920×1080 and 1280×800. Evidence: `/tmp/patchdesk-final-pr118-overview-1920x1080.png`, `/tmp/patchdesk-final-pr118-diff-1920x1080.png`, `/tmp/patchdesk-final-pr118-diff-1280x800.png`, `/tmp/patchdesk-final-app-rail-restored-1280x800.png`, `/tmp/patchdesk-final-queue-rail-restored-1280x800.png`, `/tmp/patchdesk-final-command-palette-1280x800.png`, `/tmp/patchdesk-final-completed-review-1280x800.png`. No GitHub write, push, or release occurred.

Milestone 3 implementation verification: `pnpm typecheck`, `pnpm lint`, and `pnpm test -- --run tests/renderer/dashboard.ui.test.tsx` passed after moving flow ownership. The focused renderer suite remains 24/24 green, including direct-entry profile switching, repository path picker/save/cancel, repository refresh without an Inbox reload, watchlist removal, saved history loading, and navigation guards. Final source verification passed: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run` (279 tests), `pnpm build`, `pnpm exec playwright test` (31 tests), `pnpm package:mac`, and `pnpm test:package-smoke`. Packaging emitted only the existing optional-platform dependency notices, missed author metadata warning, and intentionally skipped signing with null identity.

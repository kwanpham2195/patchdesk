# Repair the Unified Review Workbench against its specification and design

This ExecPlan is a living implementation spec. Keep `Progress`, `Surprises &
Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current whenever
work stops, a milestone completes, or the implementation changes course. A new
worker must be able to continue from this file and the current worktree without
reading prior conversations or archived plans.

The plan was written at commit `3cfccf6` on 2026-08-03. Run this drift check
before implementation from `/Users/kwanpham/Work/cfw/patchdesk`:

    git diff --stat 3cfccf6..HEAD -- src/domain src/services src/adapters/storage src/adapters/github/github-adapter.ts src/main/desktop-bridge.ts src/main/local-api.ts src/renderer/src src/design tests

If an in-scope file changed, compare the current code with the excerpts and
interfaces below. Stop and record the mismatch in `Surprises & Discoveries` if
an ownership boundary or safety invariant no longer matches. Do not force this
plan onto a different architecture.

## Purpose / Big Picture

The canonical Review route exists, but several required operations are unsafe or
unreachable. The packaged bridge rejects renderer routes, the model can supply
its own final Finding mapping, opening may advance a Review without Refresh,
publication and merge bypass the stable Review gate, completion actions run
before retention, migration omits durable state, and unknown publication
outcomes can replay writes.

The UI also hides active Analysis controls behind Published feedback, disables
safe local drafting when GitHub updates are detected, and omits the selected
Insights, PR Overview, merge, draft-repair, and publication states. Completion
means the protected lifecycle satisfies the specification and all 18 approved
design targets work at 1280px and 1440px.

After this work, a maintainer can open one stable Review, inspect Files or
Insights, keep drafting through detected remote activity, refresh explicitly,
repair unsafe anchors, preview and publish exact feedback, manage permitted
Published feedback, and merge after exact-head revalidation. Merged and closed
Reviews remain readable, while unavailable actions disappear. The complete
journey must work through the protected desktop bridge in development and in a
packaged macOS app.

## Progress

- [x] (2026-08-03) Consolidated the 18 spec/code findings and 16 design findings
  into one repair plan at baseline commit `3cfccf6`.
- [x] (2026-08-03) Archived the five completed implementation plans and marked
  this ExecPlan as the only active implementation plan.
- [x] (2026-08-03) Converted the repair plan to the repository's restartable
  ExecPlan format with seven proof milestones and fourteen concrete steps.
- [x] (2026-08-03) Milestone 1: Protected route parity is implemented,
  reviewer-validated, and verified. The bridge now covers every canonical
  Review route with exact static entries or bounded dynamic-path patterns,
  including publication recovery. Focused bridge/local API tests and the
  delegated Playwright route matrix pass; publication recovery uses durable
  receipt reconciliation and rejects replay.
- [x] (2026-08-03) Milestone 2: Analysis, Refresh, publication, and merge
  authority are repaired and verified. Steps 2–4 now retain Patchdesk-mapped
  Analysis before completion, keep represented revision advancement behind
  explicit Refresh, and route publication/merge through ReviewWriteGate with
  immutable identity and frozen unknown outcomes. The exact milestone command
  passes (15 files, 163 tests).
- [x] (2026-08-03) Reviewer blockers: automatic publication now rebinds its
  immutable authorization to the advancing seeded draft revision before
  consumption, and Published feedback performs a final exact-head read after
  comment/capability checks and immediately before every writer call. Focused
  authorization, advancing-timestamp, ordering, and head-race tests pass.
- [x] (2026-08-03) Milestone 3: Migration, Published feedback permissions,
  and terminal guards are complete. Marker-last migration now runs before
  Review list/open/load; adapter capabilities use authenticated identity,
  repository permission, and branch evidence; mutation services fail closed
  for terminal Reviews and record-specific capability loss.
- [x] (2026-08-03) Migration blocker follow-up: migration now stages the
  represented remote snapshot, retained Analysis, and legacy Walkthrough/
  progress through their existing durable owners before the marker. Existing
  targets win on rerun, and stage hooks cover interruption recovery.
- [x] (2026-08-03) Legacy publication recovery follow-up: startup reconciliation
  now enumerates every Submitted/Applying session independently of the stable
  Review current-session pointer, while explicit publication recovery retains
  its current-session gate. Regression coverage proves an older Submitted
  session is not stranded when migration selects a newer session.
- [x] (2026-08-03) Milestone 4: deterministic unified Review fixtures, compact
  shell geometry, persistent draft dock, and split local/GitHub eligibility are
  implemented. Focused renderer/design tests, lint, and typecheck pass; stale
  browser design tests still reference removed legacy scenarios and require
  migration.
- [x] (2026-08-03) Milestone 5: Insights, Finding focus, and commit detail are
  complete. The Insights surface now uses a selected rail and central document
  with explicit running/current/outdated/failed/not-generated states; current
  Finding disposition and focus actions are exposed only for current mapped
  evidence; immutable commit patches now carry derived file/addition/deletion
  statistics into the diff header.
- [x] (2026-08-03) Milestone 6: Needs-attention repair, PR Overview, merge,
  and publication recovery are complete. All unsafe inline items now block
  publication regardless of inclusion, the dock exposes a focused repair queue,
  PR Overview owns ordered freshness/Insight/merge sections, and confirmed
  publication rotates to a durable empty successor draft. Final validation
  passes 775 tests, lint, typecheck, build, and diff checks; independent review
  found no blockers.
- [x] (2026-08-04) Milestone 7: Full automated and development Electron/browser
  acceptance passes. Live QA covered desktop workflows, publication safety,
  accessibility, responsive geometry at desktop/mobile sizes, and network
  isolation with no GitHub/model writes. Evidence is stored under
  `.agents/tasks/unified-review-workbench/evidence/live-qa/`.

## Surprises & Discoveries

- Observation: The browser fixture surface can accept routes that the packaged
  Electron bridge rejects.
  Evidence: `src/main/local-api.ts` defines draft, publication, Finding,
  Walkthrough, and Published feedback operations that are absent from the exact
  allowlist in `src/main/desktop-bridge.ts`.
- Observation: The main projection already has one `state: "review"` shape with
  Files, Insights, draft, Published feedback, and merge readiness. The largest
  renderer failure is composition, not a missing top-level domain.
  Evidence: `ReviewWorkbenchProjection` in
  `src/services/review-workbench-projection.ts` already exposes these fields,
  while `review-workbench.tsx` mounts competing height-constrained siblings.
- Observation: The current GitHub adapter deliberately projects every Published
  feedback mutation capability as false.
  Evidence: `GitHubAdapter.getPullRequestPublishedFeedback()` assigns
  `canEdit`, `canDelete`, and `canDismiss` as false for every record.
- Observation: The current checkout already contains durable receipt, retained
  Insight, merge, and draft-repair owners. This repair must finish those paths
  instead of creating replacements.
  Evidence: `ReviewWriteController`, `InsightStore`, `MergeWriteController`,
  and `ReviewBatchController` contain the relevant state transitions.
- Observation (2026-08-03): Canonical Review routes include parameterized
  Insight-run and Finding paths, so a static `Set` alone cannot express route
  parity safely.
  Evidence: `requestJson()` callers and `local-api.ts` route registrations;
  `tests/desktop-bridge.test.ts` now proves each bounded full-path pattern and
  rejects unrelated routes through the existing negative cases.
- Observation (2026-08-03): Base UI's `SelectValue` displays opaque option
  values for the Analysis completion control rather than its item label.
  Evidence: the failing renderer regression rendered `OpenPreviewWhenComplete`
  instead of the user-facing label; `analysisCompletionLabel()` now owns the
  closed-trigger copy.
- Observation (2026-08-03): Seeding an empty Analysis draft advances
  `batchContent.updatedAt`, so a completion authorization created before seed
  cannot be consumed against the seeded draft without an explicit identity-
  checked transition. The completion callback now rebinds only the draft
  revision while matching every other immutable authorization field.
- Observation (2026-08-03): Published feedback comment ownership is loaded
  between the initial freshness check and the writer, so the final head read
  must occur after that reload rather than only before it. Dismissal also uses
  an immediate final head read despite having no comment reload.
- Observation (2026-08-03): Existing FakeGitHubAdapter fixtures implement the
  optional Published feedback reader, so an absent fixture must project an
  empty successful read rather than an unavailable read; otherwise unrelated
  refresh tests become unsafe GitHub-read failures.
  Evidence: Milestone 3 focused command initially failed local-api refresh until
  the fake returned an empty complete projection.

Add new discoveries here with the date, affected symbol, and command or test
that exposed them. Do not hide a failed assumption inside a concrete step.

## Decision Log

- Decision: Keep one active ExecPlan that merges specification and design
  repair.
  Rationale: The defects share projection, freshness, publication, and renderer
  boundaries. Separate plans would create conflicting execution order.
  Date/Author: 2026-08-03, Codex with user direction.
- Decision: Preserve the fourteen-step repair order inside seven independently
  testable milestones.
  Rationale: The steps are detailed enough for one worker, while milestones
  give restartable proof points and keep unsafe backend work ahead of UI wiring.
  Date/Author: 2026-08-03, Codex.
- Decision: Treat the specification and ADRs as behavioral authority and the
  selected design as composition authority when they agree.
  Rationale: Exploration images are evidence and inspiration, not extra product
  contracts.
  Date/Author: 2026-08-03, existing task contract.
- Decision: Use deterministic fixtures for model, publication, merge, and
  terminal acceptance.
  Rationale: The complete UI and recovery matrix can be proven without sending
  PR data to a model or performing a live GitHub write.
  Date/Author: 2026-08-03, existing safety contract.
- Decision: Model canonical parameterized Review paths as anchored
  method-and-full-path patterns rather than a prefix allowlist.
  Rationale: This keeps route authorization explicit while supporting only the
  identifier segment required by Insight and Finding operations.
  Date/Author: 2026-08-03, implementation.
- Decision: Rebind only `expectedDraftRevision` after successful automatic
  Analysis seeding, with a complete match against the pre-seed authorization
  identity before saving the new Armed authorization.
  Rationale: The required seed transition changes the draft revision; weakening
  matching or consuming the pre-seed revision would either block the intended
  flow or authorize drift.
  Date/Author: 2026-08-03, implementation.
- Decision: Write one per-profile migration marker only after all Review target
  writes validate successfully; marker absence is the sole resumable signal.
  Rationale: Existing durable session/attempt/batch/Insight owners remain the
  source of truth, while marker-last ordering prevents an interrupted run from
  being treated as complete or overwriting newer Review state.
  Date/Author: 2026-08-03, implementation.
- Decision: Startup recovery may reconcile publication evidence on any eligible
  stored session, but request-scoped recovery must still resolve and validate
  the stable Review current session through ReviewWriteGate.
  Rationale: Migration can select a newer session while an older legacy session
  retains a durable Submitted/Applying boundary; routing startup through the
  current pointer strands that evidence, while bypassing the gate for explicit
  requests would permit stale-session mutation.
  Date/Author: 2026-08-03, implementation.
- Decision: Keep Published feedback capability evidence in the GitHub adapter
  projection and recheck the exact record in the service before each writer.
  Rationale: Renderer-provided ownership text and stale projection flags are
  not authorization evidence; authenticated account, repository permission,
  and branch dismissal policy are required at the process boundary.
  Date/Author: 2026-08-03, implementation.

Record implementation-local choices here. If a new choice changes Review
identity, refresh semantics, model authority, GitHub confirmation, or another
hard-to-reverse architecture boundary, stop and create or update an ADR instead.

## Outcomes & Retrospective

Legacy publication recovery outcome (2026-08-03): `ReviewRecoveryService`
now filters the session scan to Submitted/Applying/outcome-unknown eligible
batches and reconciles each stored session directly during startup. The direct
`reconcilePublication` path still requires the stable Review current-session
owner. The regression migrates an older Submitted session alongside a newer
session, then proves startup installs the older successor draft and archives its
receipt without mutating the newer session. Focused migration/recovery tests (18)
pass, as do `pnpm lint`, `pnpm typecheck`, `pnpm build`, and scoped
`git diff --check`; no files are staged.

Planning outcome as of 2026-08-03: the completed phase plans are archived, the
remaining 18 spec/code findings and 16 design findings have one execution order,
and every slice has focused proof plus a final full-system gate. No product code
has been changed by this planning work.

Reviewer-blocker outcome (2026-08-03): automatic completion now persists
an identity-checked authorization transition from the pre-seed empty draft
revision to the newly seeded revision before ReviewWriteController consumes it.
An advancing-timestamp integration test proves the seeded revision publishes,
while a drifted revision returns `authorization_mismatch` without a writer
call. Published feedback edit, delete, and dismiss each perform a final exact
head read immediately before their writer; ordering and two-read head-race
coverage passes. Full lint/typecheck and the broader gate remain to be run by
closeout.

Milestone 1 outcome (2026-08-03): packaged bridge parity now covers the
canonical Review route surface without a prefix wildcard. The protected local
API rejects missing capability and incorrect origin for each canonical route;
the browser matrix exercises all 31 canonical operations with and without a
capability. Publication recovery reconciles only durable operation evidence and
cannot replay an uncertain write. Independent review artifacts:
`.pi-subagents/artifacts/1edb758d-39a6-45fa-8d2a-4c19ff016b2b_reviewer_output.md`,
`.pi-subagents/artifacts/e12435ab-65e5-4a83-ab47-8175b9c20f2b_reviewer_output.md`.
Remaining: Steps 2–14.

Milestone 6 outcome (2026-08-03): Needs-attention gating now evaluates every
inline item, including excluded items, in `ReviewBatchController`-owned
commands, submission, and publication preview. The expanded dock presents the
first unresolved anchor with original context and explicit Reattach, Convert to
Review body, and confirmed Remove actions, while publication projections retain
Ready/Publishing/Confirmed/Needs confirmation UI and unknown outcomes cannot
publish again. PR Overview now orders summary, revision/freshness, checks,
conversation and Published feedback, Insight status, merge readiness/action,
and the long GitHub description last. Merge is wired through the protected
exact-head route and replaces the workbench with a terminal projection after
success. Confirmed submission persists a successor empty Local batch after
retaining submitted evidence on the session.

Focused verification: `pnpm test -- --run tests/services/review-batch-controller.test.ts tests/services/publication-preview-service.test.ts tests/services/review-submission-service.test.ts tests/services/review-write-controller.test.ts tests/services/review-workbench-projection.test.ts tests/services/merge-write-controller.test.ts tests/renderer/review-draft-dock.ui.test.tsx tests/renderer/merge-confirmation-dialog.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/publication-preview-dialog.ui.test.tsx tests/renderer/published-feedback.ui.test.tsx tests/local-api-auth.test.ts` (154 tests passed), `pnpm lint`, `pnpm typecheck`, and `git diff --check` passed. No staged files; live or real GitHub/model writes were not used.

Milestone 5 outcome (2026-08-03): `ReviewWorkbenchFlow` replaced the legacy
Insight card grid with a selected Overview/Analysis/Walkthrough rail and one
central document. Running suppresses partial results and exposes Cancel only;
failed replacement retains readable evidence, and outdated evidence removes
mutation/current-code actions while offering a latest-revision run. Finding
navigator rows now show actual disposition and selected state, while the
central diff renders severity/title/disposition/location plus Add to review and
reasoned Dismiss actions only for current Analysis findings. `ReviewCommitService`
derives file count, additions, and deletions from the immutable returned patch;
renderer validation and the commit header display those statistics. Focused
Milestone 5 tests (56) plus lint and typecheck pass; no staged files and no live
model/GitHub writes were used. Remaining: Steps 11–14.

Milestone 4 outcome (2026-08-03): `createUnifiedReviewFixture()` now builds
all required Files, Insight, Walkthrough, publication, feedback, and terminal
states from one typed production-shaped Review projection. Design routes feed
those fixtures through `ReviewWorkbenchFlow`; the shell has one bounded
vertical owner with feedback and persistent draft regions, and local draft
editing remains enabled when freshness is `updates_available` while GitHub
writes remain blocked. Focused renderer/design tests (15 tests), design browser
geometry matrix (25 tests), `pnpm lint`, and `pnpm typecheck` pass. The design
browser matrix passes at 1280px and 1440px after replacing stale legacy
scenario assertions.

Milestone 3 outcome (2026-08-03): durable migration is marker-last and
restartable, with existing valid Review targets winning on rerun. The migration
is invoked before list, direct open, and load, and interruption plus second-run
regressions pass. GitHub Published feedback now projects independently computed
comment edit/delete and review dismissal capabilities from authenticated
account, repository permission, and branch protection evidence. The service
reloads exact records, checks capability, rechecks head immediately before the
writer, refreshes after success, and rejects terminal/forged operations.
Insight cancellation, Finding disposition, and Walkthrough progress now use the
same terminal guard. The follow-up stages represented remote snapshot/freshness,
retained Analysis, and retained Walkthrough/progress through their canonical
remote and Insight stores before writing the marker; publication receipts, write
recovery, draft items, and terminal merge evidence remain in the session-owned
durable artifact and are never discarded. Focused migration tests pass. Files
remain intentionally uncommitted alongside prior milestone work; no live GitHub
writes or model runs were used. Remaining: Steps 7–14.

Update this section after every milestone with what became observable, which
commands passed, what remains, and any lesson that should change later
milestones. At completion, include the final commit range, development and
packaged Electron evidence, remaining known limitations, and whether all 34
findings closed.

## Context and Orientation

A **Review** is the stable Patchdesk workspace for one pull request across its
lifetime. A **Review session** is an immutable snapshot bound to one head SHA
and patch. **Represented GitHub state** is the remote snapshot currently shown
inside the Review. Detection may report newer activity, but only explicit
Refresh may replace represented state.

An **Insight** is optional Patchdesk-generated evidence. Analysis produces a
structured result and Findings; Walkthrough produces a guided reading document.
A **Review draft** is local, editable content that has not been confirmed on
GitHub. **Published feedback** is remote-owned review and comment content loaded
from GitHub. A Finding is **current** only when it belongs to the retained
Analysis for the represented session and Patchdesk has mapped it safely to the
immutable patch.

### Authority references

Read these files before editing:

- `.agents/tasks/unified-review-workbench/spec.md` — behavioral contract.
- `.agents/tasks/unified-review-workbench/design/design.md` — selected UI direction and all state layouts.
- `.agents/tasks/unified-review-workbench/2026-08-03-spec-code-review.md` — 18 code and lifecycle findings.
- `.agents/tasks/unified-review-workbench/2026-08-03-design-conformance-review.md` — 16 findings and live evidence.
- `CONTEXT.md` — canonical product vocabulary.
- `docs/adr/0001-manual-github-refresh.md` — detected activity blocks remote writes, not local work.
- `docs/adr/0002-preserve-review-drafts-across-revisions.md` — no-loss draft carry-forward.
- `docs/adr/0003-retain-the-latest-successful-artifacts.md` — replacement retention.
- `docs/adr/0006-separate-draft-and-published-feedback.md` — local versus GitHub ownership.
- `docs/adr/0009-structure-the-analysis-review-body.md` — document order.
- `docs/adr/0010-choose-an-analysis-completion-action-per-run.md` — bounded run authorization.
- `docs/adr/0011-make-analysis-merge-policy-configurable.md` — merge policy boundary.
- `docs/adr/0012-run-insight-types-independently.md` — Analysis and Walkthrough are peers.
- `docs/adr/0013-keep-model-runs-bounded-and-non-authoritative.md` — model authority boundary.

The specification and ADRs own behavior. The selected design owns composition
when it agrees with them. Exploration images are not additional targets.

### Current state

The read model already exposes the correct top-level concepts:

```ts
// src/services/review-workbench-projection.ts:67-96
export type ReviewWorkbenchProjection = {
  readonly state: "review";
  readonly revision: { readonly freshness: /* ... */; readonly refreshedAt: IsoTimestamp };
  readonly insights: { readonly analysis: InsightProjection<ReviewResult>; readonly walkthrough: InsightProjection<NarrativeWalkthrough> };
  readonly draft?: ReviewBatch;
  readonly publishedFeedback: GitHubPublishedFeedback;
  readonly mergeReadiness: MergeReadiness;
};
```

The renderer does not yet compose those concepts correctly:

```tsx
// src/renderer/src/flows/review-workbench-flow.tsx:137-142
slots={{
  insights: <InsightsSlot /* ... */ />,
  publishedFeedback: <PublishedFeedbackSlot /* ... */ />,
  mergeAction: null,
  draftDock: <DraftSlot /* ... */ />,
}}
```

```tsx
// src/renderer/src/components/review-workbench.tsx:240-249
<TabsContent value="insights" className="min-h-0 flex-1 overflow-auto p-6">
  {slots.insights}
</TabsContent>
{slots.publishedFeedback}
{slots.mergeAction}
{slots.draftDock}
```

That sibling composition caused Published feedback to overlap Insights and the
expanded draft at both live widths. The Insight implementation is a card grid
instead of the selected rail and document:

```tsx
// src/renderer/src/flows/review-workbench-flow.tsx:298-331
<div className="grid gap-4 md:grid-cols-2">/* Analysis and Walkthrough cards */</div>
{analysisReaderOpen ? <AnalysisReader /* ... */ /> : null}
{walkthroughReaderOpen ? <NarrativeWalkthrough /* ... */ /> : null}
```

The existing domain and services must be reused rather than replaced:

- `ReviewBatchController` already supports `RepairInlineAnchor`,
  `ConvertInlineToGeneral`, and `RemoveItem`, all serialized against
  `ReviewBatch.updatedAt`.
- `PublicationPreviewService` already rechecks the current GitHub head, but its
  Needs-attention check is incomplete because excluded unsafe items can bypass
  it.
- `ReviewWriteController` and `review-submission-service.ts` already persist the
  two-stage write state and receipts.
- `MergeWriteController`, `merge-service.ts`, and
  `MergeConfirmationDialog` already enforce exact-head verification,
  supported methods, warnings, and explicit confirmation.
- `projectStoredInsight()` already distinguishes `not_generated`, `running`,
  `current`, `outdated`, and `failed`, and retains the prior result during a
  replacement run.

The safety defects are concrete:

```ts
// src/services/insight-run-coordinator.ts:271-282
await completionHandler(/* ... */); // runs before completeInsightRun persists
return completeInsightRun(/* ... */);
```

```ts
// src/services/review-write-controller.ts:94-109
// Publication resolves profile + session + draft revision directly. It does
// not resolve the stable Review through ReviewWriteGate.
```

```ts
// src/services/review-workbench-controller.ts:64-117
// open() prepares and may advance a changed-head session. The explicit Refresh
// service is not the sole owner of revision advancement.
```

```ts
// src/adapters/github/github-adapter.ts:787-795
canDismiss: false;
canEdit: false;
canDelete: false;
```

Repair these through the current owners. Do not create parallel draft,
publication, merge, migration, Insight, diff, or permission state machines.

### Commands used throughout this plan

- Focused renderer: `pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-draft-dock.ui.test.tsx tests/renderer/publication-preview-dialog.ui.test.tsx tests/renderer/published-feedback.ui.test.tsx tests/renderer/merge-confirmation-dialog.ui.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx`
- Protected routes: `pnpm test -- --run tests/desktop-bridge.test.ts tests/local-api-auth.test.ts tests/browser/local-api-workbench.spec.ts`
- Insight authority: `pnpm test -- --run tests/services/insight-run-coordinator.test.ts tests/services/analysis-completion-service.test.ts tests/services/analysis-draft-service.test.ts`
- Review lifecycle: `pnpm test -- --run tests/services/review-workbench-controller.test.ts tests/services/review-refresh-service.test.ts tests/services/review-write-gate.test.ts tests/services/merge-write-controller.test.ts`
- Publication: `pnpm test -- --run tests/services/review-batch-controller.test.ts tests/services/publication-preview-service.test.ts tests/services/review-submission-service.test.ts tests/services/review-write-controller.test.ts`
- Migration and permissions: `pnpm test -- --run tests/services/unified-review-migration.test.ts tests/services/review-workbench-projection.test.ts tests/services/published-feedback-service.test.ts tests/adapters/github-adapter.test.ts`
- Design contract: `pnpm test -- --run tests/design/design-scenarios.test.ts && pnpm test:design`
- Accessibility: `pnpm run test:a11y`
- Full repository gate: `pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm run test:a11y && pnpm run test:performance && pnpm exec playwright test && pnpm run package:mac && pnpm run test:package-smoke && git diff --check`

Expected success for every command is exit 0 with no warnings, type errors,
test failures, browser failures, page errors, or console errors.

### Suggested executor toolkit

- Use the `shadcn` skill for component work. Reuse installed Base UI-backed
  tabs, dialog, alert dialog, sheet, collapsible, scroll area, select, textarea,
  badge, button, and progress primitives.
- Use `ast-grep outline` before changing a source file and after each phase to
  confirm that responsibilities did not drift into new parallel owners.
- Every browser, live app, or packaged Electron test must be delegated by the
  primary agent to a dedicated tester subagent using
  `patchdesk-electron-tester`.

## Interfaces and Dependencies

The repair keeps the current ownership graph. `ReviewWorkbenchProjectionService`
owns the renderer-safe aggregate. `ReviewRefreshService` owns represented
GitHub state and session advancement. `InsightRunCoordinator` and
`InsightStore` own Insight lifecycle and retention. `ReviewBatchController`
owns local draft mutation. `PublicationPreviewService`,
`ReviewWriteController`, and the receipt stores own publication.
`PublishedFeedbackService` owns published comment and review mutation.
`MergeWriteController` and `MergeService` own exact-head merge. Pierre and the
existing Patchdesk wrappers own diff rendering, file selection, scrolling, and
focus.

Do not add a second owner for any of these responsibilities. Extend the typed
interfaces named in the concrete steps and migrate their callers in the same
milestone.

### Required end-state interfaces

The exact field names may follow current repository conventions, but these
typed boundaries must exist when the plan is complete:

- The Analysis provider/invoker returns `ModelReviewResult`. Only Patchdesk
  code may construct the final `ReviewResult`, mapping status, disposition,
  postability, and GitHub coordinates.
- `ReviewWriteGate.requireFresh(profileId, reviewId)` resolves the stable
  Review, current immutable session, represented snapshot, profile, and exact
  head for publication, Published feedback, thread, and merge operations.
- Public publication and merge requests carry `profileId`, `reviewId`, and the
  expected session/head/patch/draft identity. They do not accept a renderer-
  selected session as the operation owner.
- `GitHubReader` exposes a typed bounded read for authenticated repository and
  protected-branch permission evidence. `GitHubPublishedFeedback` continues to
  expose independent `canEdit`, `canDelete`, and `canDismiss` flags per record.
- `CommitDiffProjection` exposes file count, additions, and deletions derived
  from the immutable commit patch and validated by the strict renderer schema.
- Publication confirmation returns durable confirmed evidence, the refreshed
  GitHub-owned Published feedback state or a bounded refresh-required result,
  and a new active empty `ReviewBatch` only after complete confirmation.
- `ReviewWorkbenchProjection` remains the single renderer aggregate with
  `state: "review"`, represented revision/freshness, independent Analysis and
  Walkthrough projections, active draft, Published feedback, PR Overview data,
  and merge readiness.

### In scope

Domain and orchestration files that may change:

- `src/domain/insight-record.ts`
- `src/domain/merge-readiness.ts`
- `src/domain/publication-authorization.ts`
- `src/domain/review.ts`
- `src/domain/github-context.ts`
- `src/domain/review-batch.ts`
- `src/domain/review-result.ts`
- `src/services/analysis-completion-service.ts`
- `src/services/review-batch-controller.ts`
- `src/services/review-commit-service.ts`
- `src/services/review-refresh-service.ts`
- `src/services/review-submission-service.ts`
- `src/services/review-write-gate.ts`
- `src/services/review-write-controller.ts`
- `src/services/review-workbench-controller.ts`
- `src/services/review-workbench-projection.ts`
- `src/services/insight-run-coordinator.ts`
- `src/services/merge-service.ts`
- `src/services/merge-write-controller.ts`
- `src/services/published-feedback-service.ts`
- `src/services/unified-review-migration.ts`
- `src/adapters/github/github-adapter.ts`
- `src/adapters/storage/insight-store.ts`
- `src/adapters/storage/publication-authorization-store.ts`
- `src/adapters/storage/review-remote-store.ts`
- `src/adapters/storage/review-session-store.ts`
- `src/adapters/storage/review-store.ts`
- `src/main/desktop-bridge.ts`
- `src/main/local-api.ts`

Renderer files that may change:

- `src/renderer/src/renderer-contracts.ts`
- `src/renderer/src/flows/review-workbench-flow.tsx`
- `src/renderer/src/hooks/use-insight-run.ts`
- `src/renderer/src/components/review-workbench.tsx`
- `src/renderer/src/components/review-navigator.tsx`
- `src/renderer/src/components/review-draft-dock.tsx`
- `src/renderer/src/components/review-batch-panel.tsx`
- `src/renderer/src/components/analysis-reader.tsx`
- `src/renderer/src/components/narrative-walkthrough.tsx`
- `src/renderer/src/components/pr-overview-sheet.tsx`
- `src/renderer/src/components/publication-preview-dialog.tsx`
- `src/renderer/src/components/published-feedback.tsx`
- `src/renderer/src/components/merge-confirmation-dialog.tsx`
- `src/renderer/src/review-copy.ts`
- `src/renderer/src/styles.css`
- New focused components under `src/renderer/src/components/` only when they
  extract one of these named responsibilities: Insight navigation/document,
  Analysis lifecycle header, or focused draft-anchor repair.

Design and test files that may change:

- `src/design/scenarios.ts`
- `src/design/mock-bridge.ts`
- `src/renderer/src/flows/app-fixtures.tsx`
- `tests/design/design-scenarios.test.ts`
- `tests/renderer/review-workbench-flow.ui.test.tsx`
- `tests/renderer/review-draft-dock.ui.test.tsx`
- `tests/renderer/publication-preview-dialog.ui.test.tsx`
- `tests/renderer/published-feedback.ui.test.tsx`
- `tests/renderer/merge-confirmation-dialog.ui.test.tsx`
- `tests/renderer/narrative-walkthrough.ui.test.tsx`
- Add focused renderer tests for new components beside these suites.
- `tests/services/review-batch-controller.test.ts`
- `tests/services/review-workbench-controller.test.ts`
- `tests/services/review-refresh-service.test.ts`
- `tests/services/review-write-gate.test.ts`
- `tests/services/insight-run-coordinator.test.ts`
- `tests/services/analysis-completion-service.test.ts`
- `tests/services/analysis-draft-service.test.ts`
- `tests/services/review-commit-service.test.ts`
- `tests/services/publication-preview-service.test.ts`
- `tests/services/review-submission-service.test.ts`
- `tests/services/review-write-controller.test.ts` (create; it does not exist at
  the planned commit)
- `tests/services/review-workbench-projection.test.ts`
- `tests/services/merge-write-controller.test.ts`
- `tests/services/published-feedback-service.test.ts`
- `tests/services/unified-review-migration.test.ts`
- `tests/adapters/github-adapter.test.ts`
- `tests/desktop-bridge.test.ts`
- `tests/local-api-auth.test.ts`
- `tests/browser/local-api-workbench.spec.ts`
- `tests/browser/protected-loopback-workflow.spec.ts`
- `tests/browser/design.spec.ts`
- `tests/browser/review-workbench.spec.ts`
- `tests/browser/accessibility.spec.ts`

### Out of scope

- Changing Review identity, immutable-session identity, manual-refresh policy,
  bounded model authority, or GitHub confirmation rules.
- Replacing Pierre diff rendering, tree navigation, scrolling, or focus.
- Adding a new UI or animation dependency.
- Adding Insight history, commit search/grouping/graph, or the rejected draft
  repair and publication-preview alternatives.
- Updating Settings or unrelated Inbox behavior except removing the two audited
  read-only phrases.
- Live GitHub publication, merge, Published feedback mutation, or sending PR
  data to a model during verification. Those require separate explicit
  authorization; deterministic fixtures must prove these states by default.
- Changing GitHub API permissions. If the authenticated account cannot prove a
  capability, the adapter and service must fail closed.

## Plan of Work

Work from the protected lifecycle outward. First make every canonical renderer
operation reachable through the exact desktop bridge. Then repair model-result
authority, explicit Refresh ownership, publication and merge gating, durable
migration, permissions, and terminal guards. Only after those projections and
services stabilize should the renderer fixture matrix, shell, Insights,
Finding focus, repair queue, PR Overview, and publication states be wired.

Finish with semantic browser acceptance and isolated development and packaged
Electron proof. Each concrete step adds a failing regression first and ends
with its named focused gate. A worker may stop after a green milestone, but must
update the living sections and leave the handoff evidence described below.

### Git workflow

- Do not change branches unless the operator authorizes it. If authorized, use
  `fix/unified-review-spec-design-conformance`.
- Make one conventional commit per completed phase, for example
  `fix: preserve the unified review workspace layout`.
- Stage only explicit files from the active phase. Do not push or open a pull
  request unless instructed.
- Preserve all pre-existing dirty and untracked work.

### Per-step worker protocol

The steps below are deliberately ordered and may be handed to different
workers. A worker owns only one step unless the operator explicitly assigns a
larger slice. Before starting a step:

1. Confirm every earlier step is complete through its named verification, not
   only a status claim.
2. Run `git status -sb` and inspect every pre-existing change in the step's
   files. Preserve unrelated work and stop on an inseparable overlap.
3. Run the step's focused verification once as a baseline. Record unrelated
   failures before editing; do not normalize them into the repair.
4. Read every named source symbol and the closest existing test before writing
   a failing regression.
5. Add the regression first, confirm it fails for the stated defect, then make
   the smallest complete production change through the existing owner.

At the end of a step, the worker must return this exact handoff evidence:

- step number and result: `DONE` or `BLOCKED`;
- production and test files changed;
- new named test cases and the defect each proves;
- focused command, exit code, and test count;
- `git diff --check` result;
- remaining pre-existing working-tree changes;
- commit SHA when the operator authorized a commit;
- the exact STOP condition and source evidence when blocked.

Do not run steps concurrently when they touch the same owner. Steps 1 through 6
establish the protected lifecycle and must finish before renderer wiring in
Steps 8 through 13. Step 7 may begin only after the projection contracts from
Steps 2 through 6 stabilize. Step 14 runs only after every earlier focused gate
passes.

## Milestones

All commands in these milestones run from
`/Users/kwanpham/Work/cfw/patchdesk`. Each milestone is a proof point. Do not
mark a milestone complete from source inspection alone.

### Milestone 1: Prove protected route parity

The goal is to make every canonical Review operation reachable through the
packaged Electron bridge without weakening capability or origin enforcement.
Complete Concrete Step 1. The production bridge must enumerate each allowed
method/path pair and continue to reject unknown pairs.

Run:

    pnpm test -- --run tests/desktop-bridge.test.ts tests/local-api-auth.test.ts tests/browser/local-api-workbench.spec.ts

The command must exit 0. Every renderer route must have an allowlist assertion,
valid protected requests must reach the local API, and requests with a missing
capability, bad origin, wrong method, or unknown path must fail closed. This
milestone removes the browser-versus-package mismatch before later UI work adds
more callers.

### Milestone 2: Prove one authority path for Analysis, Refresh, publication, and merge

The goal is to make Patchdesk authoritative for Finding mapping and the stable
Review authoritative for every state advance or GitHub write. Complete Concrete
Steps 2 through 4. Analysis must be retained before any completion action,
existing Review open must not apply a new head, and publication and merge must
pass one Review-owned gate and exact-head check.

Run:

    pnpm test -- --run tests/services/insight-run-coordinator.test.ts tests/services/analysis-completion-service.test.ts tests/services/analysis-draft-service.test.ts tests/services/review-workbench-controller.test.ts tests/services/review-refresh-service.test.ts tests/storage/review-remote-store.test.ts tests/services/review-workbench-projection.test.ts tests/services/review-write-gate.test.ts tests/services/review-batch-controller.test.ts tests/services/review-submission-service.test.ts tests/services/review-write-controller.test.ts tests/services/merge-service.test.ts tests/services/merge-write-controller.test.ts tests/local-api-auth.test.ts tests/renderer/review-workbench-flow.ui.test.tsx

The command must exit 0. Adversarial model output must be remapped or rejected,
only explicit Refresh may advance represented state, false update detection must
be gone, stale or foreign identities must block writes, and uncertain remote
outcomes must remain frozen. This milestone proves the safety boundaries that
all later controls depend on.

### Milestone 3: Prove durable migration, record permissions, and terminal guards

The goal is to make old durable state restart-safe and every Published feedback
or terminal mutation fail closed from forged requests. Complete Concrete Steps
5 and 6. Migration must use marker-last ordering, Published feedback
capabilities must come from current authenticated evidence, and terminal Reviews
must be readable but immutable.

Run:

    pnpm test -- --run tests/services/unified-review-migration.test.ts tests/storage/review-session-store-begin-attempt.test.ts tests/storage/insight-store.test.ts tests/storage/review-store.test.ts tests/services/review-workbench-projection.test.ts tests/adapters/github-adapter.test.ts tests/services/published-feedback-service.test.ts tests/services/review-batch-controller.test.ts tests/services/insight-run-coordinator.test.ts tests/services/review-workbench-controller.test.ts tests/local-api-auth.test.ts tests/renderer/published-feedback.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx

The command must exit 0. Interrupted migration must resume without data loss or
duplicate writes, incomplete permission evidence must hide mutation actions but
not readable feedback, and no direct request may mutate a merged or closed
Review. This milestone removes persistence and authorization ambiguity before
the complete UI matrix is built.

### Milestone 4: Prove the deterministic state matrix and responsive shell

The goal is to replace legacy prepared/completed fixtures with production-shaped
Review states and establish one non-overlapping shell at 1280px and 1440px.
Complete Concrete Steps 7 and 8. Local draft editing must remain available when
updates are detected, while all GitHub writes stay blocked.

Run:

    pnpm test -- --run tests/design/design-scenarios.test.ts tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-draft-dock.ui.test.tsx tests/renderer/published-feedback.ui.test.tsx
    pnpm test:design

Both commands must exit 0. The scenario registry must contain the unified state
matrix, production components must render every fixture, the header must show
complete revision context, the empty draft dock must persist, and the primary
content, Published feedback, and draft dock must not overlap. This milestone
creates a stable visual foundation for detailed Insight and publication work.

### Milestone 5: Prove complete Insight, Finding, and commit navigation

The goal is to make Analysis and Walkthrough peers in one Insight rail and to
finish the current-only navigation details in Files. Complete Concrete Steps 9
and 10. Outdated evidence must remain readable without current-code or mutation
actions.

Run:

    pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx tests/services/insight-run-coordinator.test.ts tests/services/review-workbench-projection.test.ts tests/services/review-commit-service.test.ts

The command must exit 0. Every Analysis and Walkthrough state must have a named
semantic test, the completion trigger must show human language, current
Findings must expose disposition and local actions, and selected commits must
show statistics derived from their immutable patch. This milestone proves that
retained and outdated evidence cannot be confused.

### Milestone 6: Prove repair, merge, publication, and recovery journeys

The goal is to make every high-stakes completion path reachable and
restart-safe. Complete Concrete Steps 11 through 13. Needs-attention items must
have explicit repair actions, PR Overview must own the confirmed exact-head
merge, and publication must show Ready, Publishing, Confirmed, and Needs
confirmation without allowing duplicate writes.

Run:

    pnpm test -- --run tests/services/review-batch-controller.test.ts tests/services/publication-preview-service.test.ts tests/services/review-submission-service.test.ts tests/services/review-write-controller.test.ts tests/services/review-workbench-projection.test.ts tests/services/merge-write-controller.test.ts tests/renderer/review-draft-dock.ui.test.tsx tests/renderer/merge-confirmation-dialog.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/publication-preview-dialog.ui.test.tsx tests/renderer/published-feedback.ui.test.tsx tests/local-api-auth.test.ts

The command must exit 0. Excluding an unsafe item must not bypass the repair
gate, successful merge must return a terminal projection, confirmed publication
must install a new empty draft, and an unknown outcome must retain exact intent
while withholding Publish again. This milestone proves the remote-write user
journeys before full-system QA.

### Milestone 7: Prove full development and packaged acceptance

The goal is to show that the repaired product works across unit, integration,
browser, accessibility, performance, development Electron, and packaged
Electron surfaces. Complete Concrete Step 14. The primary agent must delegate
interactive app testing to a dedicated tester subagent that uses
`patchdesk-electron-tester`, isolated app data, and deterministic fixtures.

Run:

    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm run test:a11y
    pnpm run test:performance
    pnpm exec playwright test
    pnpm run package:mac
    pnpm run test:package-smoke
    git diff --check

Every command must exit 0. At 1280px and 1440px, development and packaged
Electron must show the full Review journey without rejected canonical routes,
overlap, clipped controls, horizontal overflow, page errors, or console errors.
The tester must capture screenshots and accessibility snapshots. This milestone
is the user-visible completion proof; unit tests alone cannot complete it.

## Concrete Steps

Run every command in this section from
`/Users/kwanpham/Work/cfw/patchdesk`. Expected success means exit code 0 and
the behavior stated after the command, not only a generated snapshot.

### Step 1: Lock down the complete protected route surface

Start with a single route inventory. In a temporary note under `/tmp`, list
every `requestJson()` URL used by the canonical Review renderer and every route
registered by `local-api.ts`. For each renderer route, record:

- HTTP method and path;
- whether it reads or writes;
- request parser/schema owner;
- capability/origin enforcement;
- desktop bridge allowlist entry;
- one focused API test;
- one bridge-forwarding or rejection test.

The production desktop bridge must allow the exact canonical routes for Review
load/open, detect/refresh, commit diff, Insight run/status/cancel, Finding
add/dismiss, Walkthrough progress, Analysis draft seed/preview/merge/replace,
draft commands, publication preview/confirm/recover, Published feedback
edit/delete/dismiss, and merge. Keep everything else rejected.

Do not replace the allowlist with a prefix wildcard. A new route must still
require an explicit method/path entry. Keep the current app capability and
allowed-origin checks unchanged.

Add one parameterized test in `tests/desktop-bridge.test.ts` that invokes every
canonical route through the bridge and asserts forwarding. Add negative cases
for wrong method, unknown path, missing capability, and disallowed origin. Add
or extend `tests/browser/local-api-workbench.spec.ts` so the real protected
loopback accepts every renderer operation with a valid capability and rejects
the same operation without it.

**Verify**:

`pnpm test -- --run tests/desktop-bridge.test.ts tests/local-api-auth.test.ts tests/browser/local-api-workbench.spec.ts`

Expected: every renderer route has exactly one allowlist entry and passes
through packaged bridge code; unknown routes and unauthenticated requests fail
closed.

### Step 2: Restore Patchdesk-owned model mapping and retain Analysis before completion actions

Change the Analysis invoker/coordinator boundary so providers can return only
the model-owned schema. `InsightRunCoordinator` must never accept a value that
already claims the final `ReviewResult.mappingStatus` or disposition.

Use this exact order for every Analysis completion:

1. Parse `ModelReviewResult` only.
2. Recompute every Finding mapping from the immutable session patch using
   `mapFindingLocation` and Patchdesk-owned postability rules.
3. Build and validate the final `ReviewResult` locally.
4. Atomically retain the candidate through `completeInsightRun()` if the run,
   session, head, and patch hash are still current.
5. Reload the retained record and current draft revision.
6. Execute the selected completion action against that retained run.
7. If the completion action fails, keep the Analysis retained and return a
   bounded completion failure. Never roll the result back or claim publication.

Delete the direct `parseReviewResult(providerValue)` success path. Add an
adversarial regression where provider output uses the final schema and marks an
invalid coordinate as mapped. The result must be rejected or remapped by
Patchdesk; it may not enter current Findings or the draft as postable.

Implement the exact per-run choices:

- Save as Review draft.
- Open preview when complete, selected by default.
- Publish as Comment.
- Publish as Approve.
- Publish as Request changes.

There is no default `none` transport choice in the UI. Publish choices create
one immutable authorization for that run and event. `useInsightRun.onCompleted`
must fire only after a `completed` terminal status, never after `failed` or
`cancelled`.

Add coordinator-to-draft integration tests for an empty draft, non-empty draft,
merge/replace preview requirement, all three publish events, completion
failure, cancellation, supersession, and detected updates arriving between
retention and the completion action.

**Verify**:

`pnpm test -- --run tests/services/insight-run-coordinator.test.ts tests/services/analysis-completion-service.test.ts tests/services/analysis-draft-service.test.ts tests/renderer/review-workbench-flow.ui.test.tsx`

Expected: model output never owns mapping; every completion action observes the
newly retained run; failed/cancelled runs cannot open a preview.

### Step 3: Make explicit Refresh the sole owner of represented revision advancement

Repair `ReviewWorkbenchController.open()` first. Its behavior must be:

- New Review: prepare the initial immutable session, save the represented remote
  snapshot, and create the stable Review.
- Existing Review: load its represented snapshot and `currentSessionId` without
  fetching or applying a new head.
- Missing/corrupt represented state: return the existing bounded recovery
  failure. Do not silently prepare from live GitHub.

Only `ReviewRefreshService.refresh()` may apply a changed head. It must always
pass the current session as `previousSessionId`, carry every draft item, save the
new session and candidate snapshot, then advance the Review atomically. A
failure before the final Review update leaves the prior Review readable and
current.

Fix detection hashing so both stored and comparison values use one canonical
metadata fingerprint. The comparison must include or consistently exclude the
same optional Published feedback and merge-policy fields. An unchanged remote
state after Published feedback was stored must return
`updatesAvailable: false`.

Add tests for:

- reopening same head;
- reopening after GitHub moved head, with no visible revision change;
- explicit refresh to a new head with draft carry-forward;
- discussion/check/review-state-only refresh without a new session;
- unchanged detection before and after Published feedback exists;
- failed candidate save, failed session save, failed Review advance, and
  restart after each failure;
- authoritative merged and closed refresh results.

**Verify**:

`pnpm test -- --run tests/services/review-workbench-controller.test.ts tests/services/review-refresh-service.test.ts tests/storage/review-remote-store.test.ts tests/services/review-workbench-projection.test.ts`

Expected: open never changes represented state for an existing Review; only an
explicit successful refresh advances a revision; unchanged metadata never
creates a false update marker.

### Step 4: Put publication and merge behind one Review-owned write boundary

Refactor public publication and merge requests to accept `profileId`,
`reviewId`, and expected immutable identity. Do not let a renderer choose an
arbitrary session as the operation owner.

For both operations:

1. Acquire the existing per-Review mutation lock.
2. Call `ReviewWriteGate.requireFresh(profileId, reviewId)`.
3. Resolve the gate's current Review, represented snapshot, current session,
   profile, and exact head.
4. Match the request's expected session, head, patch hash, and draft revision
   against that state.
5. Reject terminal Reviews, detected updates, unavailable/not-refreshed state,
   non-current sessions, mismatched snapshots, unresolved write recovery, and
   stale draft revisions.
6. Perform the operation-specific policy checks.
7. Re-read GitHub head immediately before the first remote mutation.

Publication authorization matching must include authorization ID, profile,
Review, session, head, patch hash, Analysis run, expected draft revision, and
event. Revoke a matching armed authorization after every successful local draft
mutation, refresh/detection safety change, Analysis failure/cancellation,
supersession, or validation failure. Consume it only inside the Review lock
after the complete match succeeds.

For every publication operation, persist intent before the remote call and
persist its receipt immediately after success. If a remote call may have
succeeded but its receipt cannot be saved, persist or reconstruct a frozen
`outcome_unknown` state. No apply, submit, confirm, or automatic completion path
may plan that operation again until recovery reconciles GitHub.

For merge, calculate readiness from the current retained Analysis record and
its current dispositions plus the profile's Advisory, Require acknowledgement,
or Block policy. Added-to-draft Findings remain open for policy; dismissed
Findings do not. Outdated Analysis has no policy effect. GitHub policy,
freshness, required checks, write recovery, and exact head remain
non-configurable blockers. On confirmed merge, save merge evidence and mark the
stable Review terminal before returning the terminal projection.

Add route/service matrices for fresh, updates available, unavailable,
not-refreshed, terminal, foreign session, draft conflict, head race,
authorization mismatch, current open Finding, added Finding, dismissed Finding,
outdated Analysis, every profile policy, merge save failure, and unknown
publication outcome. Create
`tests/services/review-write-controller.test.ts`, using
`tests/services/merge-write-controller.test.ts` for the Review-gate and
identity-mismatch structure and `tests/services/review-submission-service.test.ts`
for receipt and unknown-outcome fixtures. Do not bury controller regressions in
the route suite.

**Verify**:

`pnpm test -- --run tests/services/review-write-gate.test.ts tests/services/review-batch-controller.test.ts tests/services/analysis-completion-service.test.ts tests/services/review-submission-service.test.ts tests/services/review-write-controller.test.ts tests/services/merge-service.test.ts tests/services/merge-write-controller.test.ts tests/local-api-auth.test.ts`

Expected: publication and merge cannot bypass stable Review freshness or
identity; unknown writes remain frozen; successful merge returns a terminal
Review.

### Step 5: Complete the idempotent durable migration

Treat migration as a staged transaction over existing durable owners. Do not
build a second migration-only representation. Before changing code, enumerate
every legacy input shape accepted by `ReviewSessionStore` and every durable
target required by the specification.

For each legacy Review group, migrate:

- stable Review identity and current immutable session;
- represented remote snapshot and freshness evidence;
- active local draft, every item, anchor attention, and receipts;
- submitted/partial/unknown publication evidence;
- latest successful Analysis and its revision;
- latest successful Walkthrough and reading progress;
- Insight replacement failure/recovery state;
- profile Analysis merge policy with Require acknowledgement as the default;
- merged or closed terminal evidence;
- bounded preparation/run/write recovery state.

Invoke migration before list, direct open, load by Review ID, and load by legacy
session identity. Use marker-last ordering: write and validate every target,
then write the completion marker. A crash before the marker must be safe to
rerun. Existing migrated records win only after strict identity validation;
never overwrite newer valid target state with older legacy data.

Add fixtures for empty profile, one session, multiple revisions, completed
Analysis, completed Walkthrough with progress, local draft, submitted review,
partial publication, unknown outcome, terminal merged, terminal closed,
invalid/quarantined source, interruption after every stage, direct-open-first,
and a second idempotent run.

**Verify**:

`pnpm test -- --run tests/services/unified-review-migration.test.ts tests/storage/review-session-store-begin-attempt.test.ts tests/storage/insight-store.test.ts tests/storage/review-store.test.ts tests/services/review-workbench-projection.test.ts tests/local-api-auth.test.ts`

Expected: no valid durable artifact disappears, direct open cannot skip
migration, interruption is recoverable, and a second run writes nothing.

### Step 6: Enforce Published feedback permissions and terminal behavior at every boundary

Replace hard-coded Published feedback capability flags with authenticated,
record-specific evidence available from GitHub. Keep this evidence in the
GitHub adapter/domain boundary, not in renderer heuristics:

1. Add a typed, bounded repository-permission read to `GitHubReader` and
   `GitHubAdapter`. Parse only the authenticated account's effective repository
   role/capabilities needed here; reject missing, malformed, or paginated policy
   evidence rather than casting it.
2. Resolve the authenticated account with `resolveAuthenticatedAccount()` and
   require it to match the profile before projecting any mutation capability.
3. Set a comment's `canEdit` and `canDelete` only when its record author is the
   authenticated account and GitHub permission evidence proves the requested
   Pull requests write operation is available. Compute the two flags
   independently even if GitHub currently gives them the same answer.
4. Set a review's `canDismiss` only when GitHub proves repository write/admin
   access and, for a protected base branch, the authenticated account satisfies
   the branch's allowed-dismisser/admin rule. Reuse or extend the bounded
   merge-policy/branch-protection read seam; do not infer dismissal from review
   authorship or comment permissions.
5. If ownership, repository permission, protected-branch dismissal policy, or
   authenticated identity is unavailable or incomplete, project the affected
   capability as `false`. Do not turn a permission-read failure into a
   workbench-load failure when safe read-only Published feedback can still be
   shown.

GitHub's REST contracts require Pull requests write permission for updating or
deleting a review comment and for dismissing a review. Protected branches add
administrator or explicitly allowed-dismisser restrictions. Treat these as the
minimum adapter contract, and confirm the endpoint behavior against:

- <https://docs.github.com/en/rest/pulls/comments>
- <https://docs.github.com/en/rest/pulls/reviews>

Do not add generic `canWrite` or `isMaintainer` booleans. The safe projection
must continue to expose the three record-specific capabilities independently.

Before each mutation, `PublishedFeedbackService` must:

1. pass `ReviewWriteGate.requireFresh()`;
2. reload Published feedback and authenticated permission evidence from GitHub,
   not only `getPullRequestComments()`;
3. find the exact comment or review ID in that reload and prove the matching
   `canEdit`, `canDelete`, or `canDismiss` capability;
4. recheck the exact head immediately before the write;
5. perform the confirmed mutation;
6. explicitly refresh and report `refresh_required` if the write succeeded but
   the refreshed projection could not be loaded.

Do not infer edit/delete permission from author text alone. Move the current
head check so it occurs after capability reload and immediately before the
writer call. Add the same final head check to `dismissReview()`, which currently
omits it. Review dismissal is distinct from comment deletion and requires its
own capability plus non-empty message and explicit confirmation.

Add adapter tests for authenticated owner with sufficient permission,
authenticated owner without sufficient permission, a foreign author, missing
permission data, malformed permission data, protected branch with an allowed
dismisser, protected branch with a denied dismisser, and an unprotected branch.
Add service tests proving stale-head rejection happens after capability reload,
forged IDs fail closed, a capability that disappeared since projection blocks
the write, every destructive action requires confirmation, and a successful
remote write followed by refresh failure returns `refresh_required` without
replaying the write.

Add one shared terminal guard to every local or remote mutation boundary:
Insight run, draft edit, Analysis-to-draft action, publication, Published
feedback mutation, thread mutation, Refresh, and merge. Services must reject a
terminal Review even if a renderer request is forged. The renderer must omit
these actions rather than render disabled controls; retained files, Insights,
discussion, Published feedback, and terminal evidence remain readable.

**Verify**:

`pnpm test -- --run tests/adapters/github-adapter.test.ts tests/services/published-feedback-service.test.ts tests/services/review-batch-controller.test.ts tests/services/insight-run-coordinator.test.ts tests/services/review-workbench-controller.test.ts tests/local-api-auth.test.ts tests/renderer/published-feedback.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx`

Expected: each permitted action is reachable only when current authenticated,
record-specific capability and freshness are proven; incomplete permission
evidence fails closed without hiding readable feedback; direct requests cannot
mutate a terminal Review; terminal controls are absent.

### Step 7: Replace legacy fixtures with a deterministic acceptance matrix

Start with failing tests. Replace `review-prepared`, `review-running`, and
`review-completed` in `src/design/scenarios.ts`, `src/design/mock-bridge.ts`, and
`app-fixtures.tsx` with production-shaped unified Review fixtures. Use one
fixture factory whose inputs are typed state, not copied JSX.

The minimum permanent scenarios are:

- Files: default, Finding selected, commit selected, Updates available with an
  editable local draft, expanded draft, Needs attention, PR Overview, merged,
  and closed.
- Insights Overview.
- Analysis: Running first run, Current, Outdated, Failed first run,
  Replacement Running with retained result, and replacement failure with
  retained result.
- Walkthrough: Current and Outdated.
- Publication: Ready, Publishing, Confirmed, and Needs confirmation.
- Published feedback present together with collapsed and expanded draft states.

Render every workbench composition at 1440px and 1280px. Add bounding-box
assertions that primary content, Published feedback, and the draft dock have
non-overlapping rectangles. Assert the document and workbench do not overflow
horizontally and that the intended content owner scrolls vertically.

Do not make fixtures use alternate product components. Each scenario must pass
through the real `ReviewWorkbenchFlow` and production renderer contracts. Use
the mock bridge only for deterministic loopback responses and state advances.

**Verify**:

`pnpm test -- --run tests/design/design-scenarios.test.ts`

Expected: the registry contains the unified matrix and no prepared, completed,
model-review, or read-only workbench state.

### Step 8: Repair shell geometry, draft persistence, local-edit eligibility, and header copy

Change `ReviewWorkbench` so there is one vertical owner:

1. compact header;
2. Files/Insights tab row;
3. one `minmax(0, 1fr)` primary viewport;
4. Published feedback in a bounded, collapsible region inside the scroll owner
   or the PR Overview, never as an absolutely competing sibling;
5. persistent bottom Review draft dock.

The dock must remain visible for every active Review, including an empty local
draft and the new draft created after confirmed publication. Opening it reduces
the primary viewport height. It may not cover the tab row, Insights actions,
Published feedback, or the diff.

Split eligibility in `review-workbench-flow.tsx` and component props:

- `canEditDraft`: open Review plus local batch state; independent of remote
  freshness.
- `canWriteGitHub`: open Review, fresh exact revision, no unresolved
  Needs-attention items, no active/uncertain publication, and the relevant
  action's existing policy checks.

Use `canEditDraft` for body, decision, inclusion, item editing, add/remove,
convert, and repair controls. Use `canWriteGitHub` for publication preview,
Published feedback mutation, thread writes, and merge. Keep inline authoring
available against the represented immutable patch while updates wait; the
server remains authoritative if a coordinate is invalid.

Compact the header to the selected density and include PR number/title,
repository, base branch, head branch, short head SHA, `refreshedAt`, freshness,
checks, and PR Overview. Refresh is primary only for Updates available.

Replace the audited phrases:

- `Starting a review is read-only` with task-oriented local/confirmation copy.
- `Stored unified patch · read only` with snapshot identity and explicit
  publication-boundary copy.

**Verify**:

`pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/review-draft-dock.ui.test.tsx tests/renderer/published-feedback.ui.test.tsx`

Expected: local draft controls stay enabled for Updates available, GitHub write
controls stay disabled, an empty draft dock remains present, and fixture
geometry has no overlap at either width.

### Step 9: Build the selected Insight rail and complete Analysis and Walkthrough lifecycle views

Replace the two-card dashboard with a stable two-column Insights surface:

- left rail: Overview, Analysis, Walkthrough, each with status, retained
  revision, and recency;
- central document: exactly one selected Overview or Insight projection;
- stable workbench header, primary tabs, Files state, and draft dock.

Keep the run controls with the selected Insight rather than as global controls.
The completion control exposes Save draft, Open preview, and the three Publish
events from Step 2. Its closed trigger renders the selected task-language label,
never an internal token. Open preview remains the default.

Map the existing Insight projection into explicit views:

- Running: revision, start time, bounded phase/progress/elapsed data available
  from the run projection, optional current file, and Cancel only. No partial
  result.
- Current: verdict, mapped Finding count, highest priority, actions, and local
  Review body/Findings tabs. Render one readable document in the ADR-0009 order:
  Review Scope, Pull Request Overview, Reviewed Changes, optional Verification,
  Findings, Verdict, and optional Human Reviewer Callouts.
- Outdated: retained and current revisions together, readable retained content,
  primary Run for latest revision, no old coordinate navigation, draft action,
  Finding projection, dismissal, publication, or merge-policy effect.
- Failed: bounded error, whether draft/result changed, safe incident ID when
  present, technical disclosure, Retry Analysis, and Change run options. A
  first-run failure remains Failed rather than reverting to Not generated.
- Replacement Running/Failed: compact progress or failure strip above a fully
  readable retained result; suppress publish/draft replacement actions until
  the candidate validates.

Place `NarrativeWalkthrough` in that same central document. Current retains the
outline, reader, shared diff preferences, progress, and optional Open in Files.
Outdated keeps reading/progress but removes coordinate links and promotes Run
for latest revision.

Do not add a renderer-only lifecycle enum. Extend the main-process safe run
projection only if the selected Running or Failed view lacks bounded fields;
never expose raw provider responses, prompts, local paths, argv, or stack
traces.

**Verify**:

`pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx tests/services/insight-run-coordinator.test.ts tests/services/review-workbench-projection.test.ts`

Expected: every Analysis and Walkthrough state has one named deterministic test;
outdated actions are absent; retained results survive replacement failure; the
completion trigger shows human copy.

### Step 10: Complete Finding focus and commit detail

In `ReviewNavigator`, replace the constant `Mapped` badge with the actual
`open`, `added`, or `dismissed` disposition and expose selected state with
`aria-current` or `aria-pressed`. Mapping remains implicit because the list
already contains only current safely mapped Findings.

When a Finding is selected, add a compact central Finding header above the diff
with severity, title, disposition, file/line, `Add to review`, and `Dismiss`.
Adding creates an independent draft copy. Dismissal requires a short reason.
Those controls are present only for current Analysis. Preserve Pierre focus and
exact evidence navigation.

Extend `CommitDiffProjection` and the strict renderer schema with file count,
additions, and deletions computed from the already returned immutable commit
patch. Show title, position, author, short SHA, relative time, file count, and
`+additions/-deletions` in the central header. Do not change newest-first rows or
add commit persistence/search/grouping.

**Verify**:

`pnpm test -- --run tests/services/review-commit-service.test.ts tests/renderer/review-workbench-flow.ui.test.tsx`

Expected: commit statistics derive from the returned patch; Finding state and
draft inclusion remain distinct; outdated Analysis exposes neither action.

### Step 11: Wire the focused Needs-attention repair queue

Use the existing commands instead of changing the draft domain. In the expanded
dock:

- collect every inline item with `postability === "needs_attention"`, regardless
  of inclusion;
- focus the first unresolved item on open and advance after success;
- show original anchor/context from `attention` and carried-forward data;
- `Reattach` enters an explicit Files line-selection mode and sends
  `RepairInlineAnchor` with a fingerprint computed from the current immutable
  patch;
- `Convert to Review body` sends `ConvertInlineToGeneral` and preserves the
  text, ID, provenance, carry-forward evidence, and Finding link;
- `Remove` opens `AlertDialog` and sends `RemoveItem` only after confirmation.

Preview, apply, submit, and publication are hard-disabled while any item needs
attention. Excluding an unsafe item does not resolve its anchor and cannot
bypass the block. Update `PublicationPreviewService` and
`review-submission-service.ts` to enforce the same all-items rule if the UI gate
is bypassed.

**Verify**:

`pnpm test -- --run tests/services/review-batch-controller.test.ts tests/services/publication-preview-service.test.ts tests/renderer/review-draft-dock.ui.test.tsx`

Expected: reattach, convert, confirmed remove, automatic advance, cancellation,
and the hard preview gate all have named tests.

### Step 12: Reorder PR Overview and wire exact-head merge

Keep the existing Base UI `Sheet`; its overlay, focus trap, Escape handling, and
focus restoration already passed live QA. Extend `CanonicalReviewOverview` with
revision/freshness, refresh action, Analysis status, Walkthrough status, and the
existing typed merge action.

Render this order:

1. Summary.
2. Revision/freshness with reviewed head, current head when known, refreshed
   time, update state, and Refresh.
3. Checks.
4. Discussion/review state and Published feedback summary.
5. Analysis and Walkthrough status/actions.
6. Merge readiness and merge action.
7. Long GitHub description last.

In `ReviewWorkbenchFlow`, call the existing `POST /v1/reviews/merge` route from
`MergeConfirmationDialog`. Pass the exact represented head, available methods,
and acknowledged warnings. Keep the action absent for terminal Reviews and
disabled for non-fresh state, blockers, or unresolved write recovery. On
success, replace the workbench with the returned terminal projection rather
than patching only button state.

Do not weaken `MergeWriteController` or duplicate readiness in the renderer.

**Verify**:

`pnpm test -- --run tests/renderer/merge-confirmation-dialog.ui.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx tests/services/merge-write-controller.test.ts tests/local-api-auth.test.ts`

Expected: Ready, Needs acknowledgement, Blocked, Updates available, merged, and
closed fixtures show only valid actions; exact-head and acknowledgement remain
server-enforced.

### Step 13: Implement the four publication projections and rotate to a successor draft

Keep the exact main-process preview payload and two-stage write protocol. Turn
`PublicationPreviewDialog` into the selected roughly 1040px read-only ledger:

- Ready: exact body, inline comments with code context, thread actions, event,
  current head, warnings, Back to draft, and one Publish action.
- Publishing: keep the same payload visible; show ordered bounded progress;
  disable close, Escape, backdrop, Back, cancellation, and duplicate Publish.
- Confirmed: show confirmed completion, then refresh GitHub-owned Published
  feedback and expose View published feedback plus Close.
- Needs confirmation: retain the exact intended payload; group durable evidence
  as confirmed, prepared, or not confirmed; lock the draft and conflicting
  writes; offer Check GitHub again and Open on GitHub; never offer Publish again
  before reconciliation.

The current `confirmPublication()` leaves the submitted batch as the active
draft. Repair the service boundary so complete confirmed submission archives or
retains the old receipt evidence in its existing durable owner and atomically
installs `createEmptyReviewBatch()` as the session's active `batchContent`.
Return both the successor draft and enough bounded publication state for the
Confirmed view. Do not synthesize Published feedback from the local payload;
refresh it from GitHub.

For `PartialFailure` with `outcome_unknown`, project Needs confirmation from the
stored operation, failure category, and receipts. Add or finish
`POST /v1/reviews/publication/recover` using the existing recovery/write owners
if the route is absent. Recovery must reconcile GitHub state before allowing a
new publication attempt. No raw receipt IDs or remote payloads reach copy.

**Verify**:

`pnpm test -- --run tests/services/publication-preview-service.test.ts tests/services/review-submission-service.test.ts tests/services/review-write-controller.test.ts tests/services/review-workbench-projection.test.ts tests/renderer/publication-preview-dialog.ui.test.tsx tests/renderer/published-feedback.ui.test.tsx tests/local-api-auth.test.ts`

Expected: Ready, active write, confirmed successor draft, known rejection, and
unknown outcome/reconciliation are deterministic; active and unknown writes
cannot be dismissed or repeated.

### Step 14: Complete accessibility, responsive acceptance, and cleanup

Finish the selected semantics across the real surfaces:

- semantic Files/Insights and Files/Findings/Commits tabs;
- Insight rail selection announced independently from status;
- keyboard operation for run/cancel/retry, Finding actions, repair queue,
  publication, and merge;
- focus preserved while Insight polling and refresh update background state;
- focus restored to the invoking control after Insight detail, PR Overview, and
  publication close;
- bounded polite live regions for Analysis, Walkthrough, publication, and
  recovery without moving focus;
- status expressed in text, not color alone;
- reduced-motion behavior for disclosure, progress, and state transitions.

Delete obsolete card-grid code, legacy fixture branches, and dead prepared,
completed, model-review, and read-only copy after callers migrate. Do not retain
compatibility aliases for private renderer APIs.

Run the design matrix at 1440px and 1280px. The primary agent must dispatch a
dedicated tester subagent using `patchdesk-electron-tester` for development and
packaged Electron proof. Use isolated app data and CDP state. Exercise at least
Files, Insights Overview, one Running or fixture-driven active state, Failed,
expanded draft, Needs attention, PR Overview, publication fixture states,
Published feedback, merged, and closed. Prove the packaged bridge forwards the
canonical fixture-backed routes from Step 1. Capture screenshots and
accessibility snapshots, and verify no page/console errors. Do not perform a
real GitHub write or model run without fresh explicit authorization.

**Verify**:

`pnpm lint && pnpm typecheck && pnpm test -- --run && pnpm build && pnpm run test:a11y && pnpm run test:performance && pnpm exec playwright test && pnpm run package:mac && pnpm run test:package-smoke && git diff --check`

Expected: all gates exit 0. The dedicated tester reports no rejected canonical
bridge route, overlap, clipped control, document-level horizontal overflow,
page error, or console error at either width in development or packaged Electron.

## Validation and Acceptance

Acceptance is behavioral. A green typecheck or snapshot does not prove the
repair. Each finding must map to a named focused regression, and the final
journey must be visible in the production component tree through the protected
development and packaged Electron surfaces.

### Finding coverage

#### Spec/code review

- P1-1 packaged bridge route rejection: Step 1.
- P1-2 model-supplied final Finding mapping: Step 2.
- P1-3 publication and merge freshness bypass: Step 4.
- P1-4 open advances a changed head without Refresh: Step 3.
- P1-5 completion actions run before retention: Step 2.
- P1-6 incomplete authorization and unknown-outcome recovery: Steps 4 and 13.
- P1-7 Needs-attention bypass and missing repair UI: Steps 4 and 11.
- P1-8 unreachable merge and legacy readiness: Steps 4 and 12.
- P1-9 incomplete durable migration: Step 5.
- P1-10 no successor draft after publication: Steps 4 and 13.
- P2-1 wrong completion choices/default: Steps 2 and 9.
- P2-2 absent or disabled persistent draft: Step 8.
- P2-3 incomplete Outdated Insight boundaries: Step 9.
- P2-4 false update detection after Published feedback: Step 3.
- P2-5 hard-coded Published feedback capabilities: Step 6.
- P2-6 freshness and terminal presentation: Steps 6 and 8.
- P2-7 navigation, preview, and focus gaps: Steps 9, 10, 12, 13, and 14.
- P2-8 missing integrated acceptance matrices: Steps 1, 7, and 14.

#### Design-conformance review

- P1-01 Insights information architecture: Step 9.
- P1-02 Analysis lifecycle states: Steps 7 and 9.
- P1-03 Updates available disables local draft work: Step 8.
- P1-04 Needs-attention recovery and preview gate: Step 11.
- P1-05 PR Overview hierarchy: Step 12.
- P1-06 unreachable merge: Steps 4 and 12.
- P1-07 publication and recovery states: Steps 4 and 13.
- P1-08 persistent empty/successor draft: Steps 8 and 13.
- P1-09 Published feedback overlap: Steps 7 and 8.
- P2-01 incomplete/tall header: Step 8.
- P2-02 legacy read-only language: Steps 8 and 14.
- P2-03 Finding disposition: Step 10.
- P2-04 commit statistics: Step 10.
- P2-05 legacy visual fixtures: Step 7.
- P2-06 incomplete accessibility evidence: Steps 7 and 14.
- P2-07 raw completion token: Steps 2 and 9.

### Test plan

Add tests before each implementation slice. The final suite must include:

- A desktop bridge/local API route matrix for every canonical renderer call.
- Adversarial model-output tests proving Patchdesk always owns Finding mapping.
- Open/Refresh tests proving only explicit Refresh advances represented state.
- Review gate matrices for publication, Published feedback, thread mutation,
  and merge across freshness, identity, terminal, and head-race cases.
- Publication intent/receipt/reconciliation tests that prove unknown outcomes
  cannot replay and confirmed outcomes create a successor draft.
- Restartable migration fixtures for every durable artifact and failure stage.
- Authenticated capability tests for each Published feedback mutation.
- Projection/service tests for every Insight status, current-only Finding
  actions, successor empty draft, publication unknown-outcome lock, merge action
  availability, and commit statistics.
- Renderer tests for all 18 approved target states, local versus remote-write
  eligibility, repair queue actions, exact publication ledger states, PR
  Overview order, focus restoration, and human completion labels.
- Browser tests at 1440px and 1280px with bounding-box non-overlap assertions,
  keyboard-only journeys, reduced motion, no horizontal overflow, and the full
  unified journey.
- Live development and packaged Electron proof by the required tester subagent.
  Deterministic fixtures are the acceptance source for publication and merge;
  no real write is needed.

Do not approve snapshot-only coverage. Every selected state needs semantic
assertions for its status, action availability, and safety boundary.

### Acceptance conditions

- All 18 spec/code findings and all 16 design findings map to passing focused
      tests and no item is deferred.
- Every canonical renderer route is explicitly allowed by the desktop
      bridge and protected by capability/origin checks.
- Providers cannot supply final Finding mapping, disposition, postability,
      or GitHub coordinates.
- Existing Review open never advances represented state; explicit Refresh
      is the sole revision-advance owner.
- Publication, Published feedback mutation, thread mutation, and merge all
      resolve the stable Review through `ReviewWriteGate` and recheck exact head.
- Migration preserves every required artifact, survives interruption, runs
      before list/open/load, and is idempotent.
- Published feedback actions appear and execute only when authenticated
      record-specific capability is proven.
- All 18 approved design targets have deterministic production-component
      scenarios; the audit result can be updated from 0 complete passes.
- Published feedback, primary content, and the draft never overlap at
      1280px or 1440px, collapsed or expanded.
- Updates available preserves local draft editing while every GitHub write
      remains blocked.
- Insights uses the stable rail and one central document; every Analysis
      and Walkthrough lifecycle state is explicit.
- Outdated evidence cannot navigate, mutate a draft, publish, dismiss a
      Finding, or affect merge policy.
- Needs attention supports reattach, convert, confirmed remove, automatic
      advance, and an all-items hard preview/publication block.
- PR Overview uses the selected order and owns the existing confirmed
      SHA-bound merge action.
- Publication exposes Ready, Publishing, Confirmed, and Needs confirmation;
      active/uncertain writes cannot be closed or repeated.
- Confirmed publication retains durable evidence, refreshes GitHub-owned
      Published feedback, and exposes a new empty local draft.
- Prepared, completed, model-review, and read-only workbench copy and fixture
      branches are absent.
- `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`,
      `pnpm exec playwright test`, `pnpm run package:mac`, and
      `pnpm run test:package-smoke` all exit 0.
- Dedicated development and packaged Electron QA passes with evidence and
      no real remote write.
- Only authorized in-scope files plus this task package are modified.
- The repair plan is marked DONE in the task package `README.md`.

## Idempotence and Recovery

Focused tests, design fixtures, and read-only validation commands are safe to
rerun. Migration must be safe to restart after every staged write because its
completion marker is written last. A second successful migration run must make
no durable changes. Review Refresh must leave the prior represented state
readable until the replacement session, snapshot, and stable Review pointer are
all durable.

Publication and merge are not blindly repeatable. Persist intent before each
remote mutation and a receipt immediately after success. If the remote result
cannot be proven, retain `outcome_unknown`, lock conflicting writes, and
reconcile through GitHub reads before exposing the action again. Never repair an
uncertain write by deleting its local evidence or submitting the same payload
again.

If a focused step fails, keep its new regression and revert only the worker's
own incomplete production edits through a scoped patch. Do not reset, clean,
restore, or stash the shared checkout. Record the failure and exact worktree
state in the living sections before another worker continues.

### Stop conditions

Stop and report; do not improvise if:

- The design/spec/ADR authority conflicts on a behavior not resolved by this
  plan.
- A step requires changing Review or Review-session identity, automatic GitHub
  refresh semantics, model authority, or explicit write confirmation.
- The implementation would need a second draft, publication, merge, Insight,
  diff, tree, dialog, or focus owner.
- Confirmed publication cannot retain old durable write evidence while creating
  a successor draft with the existing storage model. Propose the smallest typed
  storage extension before editing.
- Reconciliation of an unknown publication outcome cannot be proven through
  existing GitHub read APIs. Do not expose Publish again.
- A visual target requires real GitHub mutation or model execution instead of a
  production-component fixture.
- Live QA cannot be delegated to the required tester subagent.
- An in-scope verification fails twice after a focused correction.
- Required work expands outside the explicit scope.

## Artifacts and Notes

For every completed milestone, add a dated note here with the commit SHA or
explicit uncommitted file list, focused command result, test count, and links to
any screenshots or accessibility snapshots. Keep large logs and images in the
task package's existing `evidence/` directory; record only concise evidence and
paths in this plan.

- 2026-08-03 — Step 2, in progress and uncommitted: retained-result ordering
  and renderer completion controls changed in
  `src/services/insight-run-coordinator.ts`,
  `src/renderer/src/hooks/use-insight-run.ts`,
  `src/renderer/src/flows/review-workbench-flow.tsx`, and focused tests.
  `pnpm typecheck` passed. `pnpm test -- --run tests/services/insight-run-coordinator.test.ts tests/services/analysis-completion-service.test.ts tests/services/analysis-draft-service.test.ts tests/renderer/review-workbench-flow.ui.test.tsx` passed (4 files, 28 tests). `git diff --check` passed.
- 2026-08-03 — Step 2, uncommitted: `src/services/insight-run-coordinator.ts`,
  `src/services/analysis-completion-service.ts`, `src/renderer/src/flows/review-workbench-flow.tsx`,
  and `tests/services/insight-run-coordinator.test.ts` preserve Patchdesk-owned
  mapping and make retained Analysis observable before completion handlers.
  Focused proof passed as part of the Milestone 2 command.
- 2026-08-03 — Step 3, uncommitted: `src/services/review-refresh-service.ts`,
  `src/services/review-workbench-controller.ts`, and projection/hash seams keep
  open from applying live heads and compare canonical represented metadata.
  Focused proof passed as part of the Milestone 2 command.
- 2026-08-03 — Step 4, uncommitted: `src/services/review-write-gate.ts`,
  `src/services/review-write-controller.ts`, `src/services/merge-write-controller.ts`,
  `src/services/publication-preview-service.ts`, `src/services/review-batch-controller.ts`,
  and `tests/services/review-write-controller.test.ts` bind writes to Review,
  exact session/head/patch/draft identity, per-Review serialization, and frozen
  outcomes. Focused proof passed as part of the Milestone 2 command.
- 2026-08-03 — Milestone 2 reviewer-finding repair, uncommitted: completion
  callbacks now carry head, patch, and analysis-run identity into automatic
  publication; every persisted publication intent re-reads the exact head
  before its GitHub mutation; detection fingerprints optional Published
  feedback and merge policy only when the current reader supplies them.
  Changed `src/services/insight-run-coordinator.ts`, `src/main/local-api.ts`,
  `src/services/review-submission-service.ts`,
  `src/services/review-refresh-service.ts`, and focused regression tests.
  Focused proof: 4 files, 44 tests passed; `pnpm lint`, `pnpm typecheck`, and
  `git diff --check` passed.
- 2026-08-03 — Milestone 3 final proof: Steps 5–6 passed the exact focused
  command with 13 files and 180 tests. `pnpm lint`, `pnpm typecheck`, and
  `git diff --check` passed. Added
  interruption/marker-last migration coverage and record-specific Published
  feedback capability/forged-ID coverage in
  `tests/services/unified-review-migration.test.ts` and
  `tests/services/published-feedback-service.test.ts`. No GitHub writes or
  model runs were used.
- 2026-08-03 — Milestone 2 final proof: the exact command above passed with 16
  files and 171 tests; `pnpm lint` and `pnpm typecheck` passed. No GitHub
  writes or model runs were used.
- 2026-08-03 — Milestone 1, uncommitted: `src/main/desktop-bridge.ts`,
  `tests/desktop-bridge.test.ts`, and `tests/local-api-auth.test.ts`.
  `pnpm test -- --run tests/desktop-bridge.test.ts tests/local-api-auth.test.ts tests/browser/local-api-workbench.spec.ts` passed (2 files, 82 tests);
  `git diff --check` passed. Dedicated tester ran
  `pnpm exec playwright test tests/browser/local-api-workbench.spec.ts`: 2
  passed; its fixture-only evidence is
  `.pi-subagents/artifacts/3d071188_electron-tester_0_output.md`. Route
  inventory: `/tmp/patchdesk-unified-review-route-inventory.md`.

The planning baseline is commit `3cfccf6`. The two source audits are
`.agents/tasks/unified-review-workbench/2026-08-03-spec-code-review.md` and
`.agents/tasks/unified-review-workbench/2026-08-03-design-conformance-review.md`.
The selected UI reference is
`.agents/tasks/unified-review-workbench/design/design.md`. Historical phase
plans live in `.agents/tasks/unified-review-workbench/plans/archive/` and must
not be executed.

- 2026-08-04 — Startup migration-failure follow-up, uncommitted: `src/main/app-lifecycle.ts`, `src/main/local-api.ts`, and `tests/local-api-auth.test.ts`. Startup now returns the bounded `migration-failed` result and does not construct or run gated publication recovery when profile listing or migration fails. The integration regression seeds a legacy `Submitted` batch, corrupts the migration marker, verifies startup aborts, preserves `Submitted`, and confirms no stable Review owner was created. `pnpm test -- --run tests/local-api-auth.test.ts tests/services/unified-review-migration.test.ts tests/main-lifecycle.test.ts` passed (3 files, 73 tests); `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. No GitHub writes or model runs were used.

- 2026-08-04 — Packaged smoke acceptance repair, uncommitted: updated
  `scripts/package-smoke.mjs` from removed legacy `Review complete` and
  `centraldigital/patchdesk#42` selectors to the canonical rendered Review
  state marker (`Review state is current.`) and current PR heading (`#42
  Protect review writes`). `pnpm package:mac` passed, followed by
  `pnpm test:package-smoke` passing against `release/mac-arm64/Patchdesk.app`
  with no renderer failures. Full `pnpm test -- --run` passed (106 files,
  775 tests); `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `git diff
  --check` passed. No GitHub writes or model runs were used.

### Maintenance notes

The Review workbench should have one shell, one scroll/height owner, and one
projection per durable state. Future Insight types belong in the existing rail
and central document. Future publication changes must preserve exact payload
visibility and the rule that an unknown outcome locks repeat writes. Reviewers
should scrutinize local-versus-remote eligibility, outdated action suppression,
successor-draft durability, modal closeability during writes, and both desktop
widths before accepting the implementation.

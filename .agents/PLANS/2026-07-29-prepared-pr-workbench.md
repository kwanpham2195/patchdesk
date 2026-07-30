# Make a prepared PR a complete, optional-AI review workbench

This ExecPlan is a living implementation specification. Keep `Progress`,
`Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective`
current as work proceeds. It supersedes only the conflicting
completed-review-only parts of
`.agents/PLANS/2026-07-27-recovery-settings-walkthrough.md`; its recovery and
safe local-storage work remains valid.

## Purpose / Big Picture

Opening a pull request in Patchdesk prepares one immutable local snapshot. From
that point, a maintainer can use normal pull-request operations without first
running AI analysis: read the description, inspect checks and existing threads,
draft inline comments, submit a chosen GitHub review, and merge when GitHub
allows it. AI review and narrative walkthrough are optional, separately started
ways to add insight to that same snapshot; neither is a prerequisite for the
normal workflow or starts the other.

The Settings dialog will also receive the accepted spacious two-column General
layout. It retains the existing shadcn/Base UI components, behavior, and
scrolling, while making padding, control sizes, dividers, and footer spacing
consistent.

The user-visible proof is a prepared PR with a failing non-required check:
the maintainer can inspect its diff and description, select a changed line,
write a local comment, generate a walkthrough without running a review, and
use normal confirmed GitHub actions. A required failed check still prevents a
merge. The PR workbench has one left rail for files, a wide diff, and an
optional PR overview on the right. The Settings modal is readable without a
crowded footer or clipped content.

## Progress

- [x] 2026-07-29 — Package QA found and corrected the completed-review-only
  walkthrough assumption; the current implementation remains uncommitted.
- [x] 2026-07-29 — Research confirmed Codiff treats its walkthrough as a
  diff-reading mode, and Patchdesk's approved packet says prepared snapshot.
- [x] 2026-07-29 — Product decisions recorded: optional AI, snapshot-owned
  review batch, concise human/model provenance, normal actions before review,
  and selected Settings layout direction.
- [x] 2026-07-29 — Verified installed `@pierre/diffs@1.2.12` exposes line
  selection and gutter utility callbacks needed for local inline comments.
- [x] 2026-07-29 — Matthew approved the refined second Product Design/ImageGen
  Settings mock as the visual baseline, with consistent shadcn spacing.
- [x] 2026-07-29 — Matthew approved the final PR workbench direction: remove
  the unused Workspace sidebar, retain only the file tree as the left rail,
  and use the spacious accordion-style PR overview. The final mock is the
  visual baseline for this surface.
- [x] 2026-07-29 — Product journey audit completed against an isolated
  packaged app, current renderer code, and labeled Design fixtures. Its
  approved scope additions are recorded in Milestones 1, 4, 5, and 6.
- [x] 2026-07-29 — Copied both approved ImageGen baselines and the seven
  audit screenshots used by this plan into `fixtures/screen-states/` so future
  implementation does not depend on temporary Codex or `/tmp` paths.
- [x] 2026-07-29 — Added the scoped disclosure-motion implementation plan for
  the future PR overview accordion and Walkthrough Support only; it explicitly
  excludes motion from diff, file, keyboard, and Settings interactions.
- [x] 2026-07-30 — Clarified that Review Settings selects only enabled runtime
  models and falls back safely when a saved local choice is no longer enabled.
- [x] 2026-07-29 — Milestone 0 implemented locally: prepared snapshots now
  create a snapshot-owned editable batch; v2/v3 data migrates to v4 item
  provenance; human items persist across optional model reruns; the obsolete
  ReviewDraft controller, route, and renderer bridge were removed.
- [x] 2026-07-29 — Milestone 1 core contract implemented locally: prepared
  projections include GitHub context, batch, freshness, and merge readiness;
  no-AI merge no longer requires a visible model result; batch submission uses
  the authenticated `/v1/reviews/submit-batch` route.
- [x] 2026-07-30 — Completed the shared PR overview drawer, local diff
  composer, opt-in walkthrough, General/Workspace Settings split, scoped
  disclosure motion, visual comparisons, package smoke, and fresh isolated
  packaged QA. The isolated profile had no prepared PR, so drawer and
  walkthrough interaction was verified through deterministic browser and
  Design suites.

## Surprises & Discoveries

- Observation: `ReviewBatchItem.InlineComment` already distinguishes
  `manual` and `finding`, but `ReviewBatch` is keyed to `attemptId`. That makes
  a human draft impossible before the first AI attempt and incorrectly makes a
  local batch block later review runs.
  Evidence: `src/domain/review-batch.ts`, `src/domain/review-session.ts`,
  `src/services/review-batch-controller.ts`, and
  `src/services/review-completion-service.ts`.

- Observation: prepared projections contain current PR metadata and checks but
  omit GitHub threads, merge readiness, and the batch. The completed projection
  is the only route that assembles those normal PR facilities.
  Evidence: `src/services/review-workbench-projection.ts`.

- Observation: a complete safe Markdown PR-description component exists but
  is not mounted in either workbench.
  Evidence: `src/renderer/src/components/pull-request-description.tsx` has no
  production renderer caller.

- Observation: `MergeWriteController` refuses to merge unless
  `visibleResult` exists, even though its final GitHub checks and head read are
  sufficient for a no-AI merge.
  Evidence: `src/services/merge-write-controller.ts` and
  `src/services/merge-service.ts`.

- Observation: Pierre already renders persisted annotations in
  `ReviewDiffView`, and its installed `CodeView` accepts `enableLineSelection`,
  `onLineSelected`, selection lifecycle callbacks, and
  `onGutterUtilityClick`. No second diff renderer or custom pointer hit testing
  is necessary.
  Evidence: `src/renderer/src/components/review-diff-view.tsx` and
  `node_modules/@pierre/diffs/dist/components/CodeView.d.ts`.

- Observation: the current Settings modal correctly constrains its internal
  scroll and footer, but its cards, tabs, and footer still use inconsistent
  spacing that reads as cramped.
  Evidence: `src/renderer/src/components/settings-modal.tsx` and the packaged
  QA screenshot supplied on 2026-07-29.

- Observation: the approved Settings mock currently lives in Codex generated
  images rather than the repository. A later visual comparison cannot rely on
  a transient generated-image path.
  Evidence: `/Users/kwanpham/.codex/generated_images/019fac84-8b00-7a23-a5c7-daeb06467072/exec-668416d8-015f-471d-804e-825223aa124a.png`.

- Observation: the PR workbench's Workspace sidebar repeats the current
  workspace and exposes only Inbox. It consumes width needed by the file tree
  and diff without supporting the prepared-PR task.
  Evidence: the supplied workbench capture and the approved final Product
  Design mock.

- Observation: the packaged default My inbox can have no visible rows while
  sibling queues show active work. In the audit fixture, Checks failing showed
  three PRs and All open showed five.
  Evidence: `.agents/qa/2026-07-29-product-journey-audit.md` and its isolated
  packaged captures.

- Observation: Settings General mixes appearance preferences with Workspace
  profile/GitHub setup, and its subtitle explains modal mechanics rather than
  a user task. The Design landing card for Review prepared also failed to
  navigate even though its direct scenario route worked.
  Evidence: `.agents/qa/2026-07-29-product-journey-audit.md`.

## Decision Log

- Decision: A prepared immutable PR snapshot, not a completed AI review, is
  the entry point for all normal PR operations, walkthroughs, and optional AI
  review. Rationale: a maintainer must be able to work normally before, after,
  or without local analysis. Date/Author: 2026-07-29, Matthew and Codex.

- Decision: Keep one snapshot-owned review batch. It contains human and model
  items with the same item structure; provenance is local origin, not the
  GitHub author. Rationale: one draft, one confirmation path, and one source
  of truth avoid parallel comment stores. Date/Author: 2026-07-29, Matthew and
  Codex.

- Decision: Use concise provenance only where it adds information. A changed
  model suggestion reads `Model draft · edited by you`; ordinary human drafts
  have no provenance badge. Rationale: preserve honest origin without making
  the review surface noisy. Date/Author: 2026-07-29, Matthew and Codex.

- Decision: A rerun replaces only model items attributable to the rerun. It
  never deletes human drafts. Rationale: human review work is durable local
  intent and must not be collateral damage from optional AI analysis.
  Date/Author: 2026-07-29, Matthew and Codex.

- Decision: Permit a merge before local AI analysis when the current GitHub
  head is mergeable and required GitHub checks pass. Show a non-blocking `No
  local Patchdesk review has run for this snapshot` notice and retain the
  existing explicit merge confirmation. Rationale: AI review is optional;
  GitHub remains the authority for merge eligibility. Date/Author: 2026-07-29,
  Matthew and Codex.

- Decision: A walkthrough is generated from a current stored patch in
  `Created`, `Running`, `ReviewCompleted`, or `ReviewFailed` state. It is stale
  only when snapshot identity or patch content changes, not when an optional
  review changes state. Rationale: both features are independent readers of
  the same immutable diff. Date/Author: 2026-07-29, Matthew and Codex.

- Decision: The current `Review context` affordance becomes a dismissible
  right-side `PR overview`, closed by default. Rationale: the diff remains the
  primary reading surface while description, checks, threads, drafts, and
  protected actions remain available without an AI result. Date/Author:
  2026-07-29, Matthew and Codex.

- Decision: Remove the Workspace sidebar from the PR workbench. Keep Back and
  compact workspace/inbox access in the application header. The file tree is
  the only left rail, so the diff receives the reclaimed horizontal space.
  Rationale: the repeated sidebar does not support review work and makes the
  primary diff unnecessarily narrow. Date/Author: 2026-07-29, Matthew and
  Codex.

- Decision: Do not keep `Inspect failing checks` as a persistent header
  button. Checks live in PR overview. When the overview is closed, a compact
  check status/count beside the snapshot opens it focused on Checks. The
  header also omits `View diff` while the diff is visible. Rationale: both
  persistent buttons duplicate the current reading surface. Date/Author:
  2026-07-29, Matthew and Codex.

- Decision: The final ImageGen PR-workbench mock is a visual acceptance
  baseline. It combines the selected accordion overview with calmer spacing,
  no Workspace sidebar, a file-tree-only left rail, and a wide diff. Store a
  repository copy and compare Design and packaged captures beside it before
  accepting the workbench. Date/Author: 2026-07-29, Matthew and Codex.

- Decision: When My inbox is empty but another queue has work, show a direct
  task-focused empty state with one action to open that queue. Do not silently
  switch the selected queue. Rationale: the current default can imply there is
  no work despite active PRs elsewhere. Date/Author: 2026-07-29, Matthew and
  Codex.

- Decision: General Settings contains appearance and diff-theme preferences
  only. Active profile and profile/GitHub setup move to Workspace. Remove
  modal-mechanics copy from the Settings header. Rationale: each section must
  answer one user task rather than expose implementation details. Date/Author:
  2026-07-29, Matthew and Codex.

- Decision: Review Settings exposes Default model as an enabled-runtime-model
  select, never a free-text identifier. It uses the existing Base UI Select and
  current `/v1/reviews/models` catalog; the saved choice and reasoning remain
  profile-scoped local preferences. If a saved model is no longer enabled,
  select the runtime default (or first enabled model) instead. Rationale: a
  preference must be valid and understandable before a review is started, while
  preserving per-run override in the review dialog. Date/Author: 2026-07-30,
  Matthew and Codex.

- Decision: A ready walkthrough auto-selects its first chapter and shows its
  narrative plus focused diff in the initial viewport. Support remains
  available but starts collapsed. Rationale: reading is the primary task;
  navigation and supporting details must not displace it. Date/Author:
  2026-07-29, Matthew and Codex.

- Decision: Use Pierre line/range selection plus its gutter utility to open a
  compact shadcn composer beside the selected diff evidence. The right-side
  overview aggregates drafts; it is not the primary authoring surface.
  Rationale: the source evidence stays visible while the all-drafts workflow
  remains easy to inspect. Date/Author: 2026-07-29, Matthew and Codex.

- Decision: General Settings uses the accepted spacious two-column design:
  consistent modal/frame padding, section separators, 48px controls, aligned
  control edges, and a protected footer. Existing shadcn/Base UI primitives
  remain mandatory. Date/Author: 2026-07-29, Matthew and Codex.

- Decision: Use the installed `@base-ui/react@^1.6.0` Collapsible primitive
  plus CSS transitions for the two planned disclosure surfaces. Do not add
  Motion/Framer Motion: this is a small accessible primitive-state transition,
  not a spring, gesture, layout-animation, or exit-animation task. Rationale:
  Base UI already owns accessibility and exposes the lifecycle attributes the
  scoped treatment needs. Date/Author: 2026-07-29, Matthew and Codex.

- Decision: the approved refined ImageGen Settings mock is a visual acceptance
  baseline, not only design inspiration. Store a repository copy, capture the
  exact General state at the same 1064x1478 viewport, create a side-by-side
  comparison, and inspect it before the UI is accepted. Date/Author:
  2026-07-29, Matthew and Codex.

## Outcomes & Retrospective

Implementation began by moving durable ownership to the prepared snapshot. The
main lesson from QA and the product discussion is that Patchdesk accidentally treated a local AI review as
the lifecycle owner of a PR. The immutable prepared snapshot is the correct
owner. This plan moves AI outputs into that snapshot rather than making
ordinary human work wait for them.

Verification completed with `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`
(80 files / 546 tests), the full Playwright suite (64 tests), `pnpm package:mac`,
and `pnpm test:package-smoke`. Fresh isolated packaged QA confirmed launch,
the General Settings controls, and Escape focus restoration without remote
writes. The final package was tested with profile
`/tmp/patchdesk-qa-confirmation-1HJCxp` on CDP port 9244, then stopped and
cleaned up by the tester.

## Context and Orientation

Patchdesk is an Electron application with a privileged main process and a
sandboxed renderer. The renderer talks only to the authenticated loopback API;
it must never gain GitHub credentials, filesystem paths, or direct write
access. Every GitHub write stays behind the existing local API and an explicit
user confirmation in the UI.

A **prepared snapshot** is the read-only stored patch, PR identity, and head
SHA created by `ReviewSessionPreparation`. `ReviewSessionKey` includes the
head SHA, so a changed head produces a new session rather than mutating the
old snapshot. A **review item** is a local intended GitHub action: inline
comment, thread reply, or thread-state change. Its **provenance** is `human`
or `model`; the actual GitHub author remains the configured GitHub account.
The glossary in `CONTEXT.md` is the canonical short definition.

Relevant current paths are:

- `src/domain/review-session.ts`: immutable snapshot/session state and current
  attempt lifecycle.
- `src/domain/review-batch.ts`: durable items, GitHub-write state, receipts,
  and strict parse boundary. It currently requires `attemptId` and must become
  snapshot-owned.
- `src/services/review-session-preparation.ts`: creates/resumes one snapshot.
- `src/services/review-workbench-projection.ts`: prepares renderer-safe
  prepared/completed data. It currently keeps threads and merge readiness in
  completed-only output.
- `src/services/review-completion-service.ts`,
  `src/services/review-batch-controller.ts`, and
  `src/services/review-write-controller.ts`: model-result batch creation,
  durable local edits, and confirmed writes.
- `src/services/merge-write-controller.ts` and `src/services/merge-service.ts`:
  final fresh-head GitHub verification and merge policy.
- `src/services/narrative-walkthrough-service.ts`: in-memory walkthrough
  records bound to snapshot identity; it currently requires `ReviewCompleted`.
- `src/renderer/src/flows/prepared-review-flow.tsx` and
  `src/renderer/src/flows/completed-review-flow.tsx`: currently split prepared
  and completed interactions.
- `src/renderer/src/components/review-diff-view.tsx`: Pierre-backed shared
  diff surface. It already renders annotations.
- `src/renderer/src/components/pull-request-description.tsx`,
  `review-batch-panel.tsx`, `review-submission-dialog.tsx`, and
  `merge-confirmation-dialog.tsx`: reusable safe UI pieces presently mounted
  only in the completed workbench.
- `src/renderer/src/components/settings-modal.tsx`,
  `src/renderer/src/flows/settings-flow.tsx`, and
  `src/design/design-settings-overlay.tsx`: Settings composition and Design
  reference.

The worktree already has unrelated and prior QA changes. Preserve them. Do not
reset, clean, broadly stage, or overwrite files outside this plan. The project
uses shadcn wrappers backed by Base UI; compose `Dialog`, `Tabs`, `ScrollArea`,
`Sheet`, `Popover`, `Field`, `Textarea`, and `AlertDialog` from
`src/renderer/src/components/ui/` rather than adding another component system.

## Plan of Work

First establish the snapshot-owned review-item contract in the domain and
storage parser. Write an ADR because moving batch ownership from model attempts
to prepared snapshots is durable, surprising, and changes recovery semantics.
Migrate existing persisted AI batches to model provenance while leaving old
saved reviews readable. Delete the legacy `ReviewDraft` bridge once all current
callers use the unified batch; do not retain a second draft representation.

Then project current PR data for every prepared snapshot and extract a shared
workbench composition. The prepared and completed states may differ in whether
they show findings, but both must share PR overview, batch, description,
threads, checks, comment authoring, and protected actions. The overview is a
right-side sheet closed by default. It contains safe rendered Markdown,
checks, threads, local batch controls, and merge readiness in that order. On
the PR workbench, remove the legacy Workspace sidebar. Keep only the file tree
at left, the diff in the center, and the optional overview at right. The
header has no persistent `View diff` or `Inspect failing checks` button while
the corresponding context is already present.

Make active Inbox work discoverable without changing a user's selected queue.
When My inbox has no rows but another existing queue has rows, show an empty
state that names the nearest actionable queue and opens it only after a user
click. Keep the Inbox application rail unchanged in this plan; the approved
sidebar removal applies only to the PR workbench, where it is redundant with
the file tree.

Enable Pierre selection only where local items are editable. A selected changed
line/range opens a compact shadcn composer in the gutter. Saving updates the
snapshot batch through the existing authenticated API; it never posts to
GitHub. The same batch drives rendered annotations and the overview draft list.

Decouple walkthrough eligibility and controller placement from completed
results. Generation must use the prepared patch and snapshot hash only. Extract
the model dialog/controller and focused takeover so it can mount from either
workbench state. It uses the shared batch for comments and leaves normal file
selection untouched. Hide the redundant `View diff` control while that diff is
already visible.

Finally apply the accepted Settings spacing treatment, update the Design
scenario, and run a full desktop/package test pass with dedicated interactive
package QA. Use an isolated user-data directory and clear only the isolated
review data after every live scenario.

## Milestones

### Milestone 0 — Lock durable ownership and migration

Goal: make one snapshot-owned batch safe before any renderer action can create
a human draft.

Work: add `docs/adr/0001-snapshot-owned-review-batch.md`; evolve
`ReviewBatch` to include the snapshot identity needed for safe writes and an
optional model-attempt reference only on model provenance; create/reuse an
empty local batch during snapshot preparation; migrate valid v3 attempt-owned
batches to model items. Refactor session rerun gates so an editable local batch
does not block an AI run, but an applying, ambiguous, pending, or submitted
remote transaction retains its existing safety protection. A new PR head has a
new session; the old snapshot's human items remain readable and non-postable,
never silently copied or deleted.

Commands, from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/domain/review-session.test.ts tests/services/review-batch-controller.test.ts tests/services/review-session-preparation.test.ts
    pnpm typecheck

Expected result: old fixture data migrates/read-parses, new prepared sessions
have an editable local batch, and starting/re-running an AI review preserves
human items. This reduces the risk of lost comments before UI exposure.

### Milestone 1 — Project normal PR operations before AI review

Goal: a prepared snapshot has the same current GitHub context necessary for
normal PR operations as a completed one.

Work: change `ReviewWorkbenchProjectionService` to read and safely project PR
description, threads, checks, batch, freshness, and merge readiness for both
states. Make merge readiness accept optional model findings: preserve
high-severity model warnings when they exist, but do not invent them when no
review ran. Remove `visibleResult` as a precondition in
`MergeWriteController`; retain its last-moment GitHub head/check re-read and
explicit acknowledgement. Update local API/renderer contracts and tests,
including new `tests/services/merge-write-controller.test.ts` coverage for a
prepared no-AI merge path. In `MaintainerInbox`, add the My-inbox empty state
only when the selected view has no rows and at least one visible sibling queue
has work. Use existing queue selection behavior; do not add a new navigation
model or auto-switch the view.

Commands:

    pnpm test -- --run tests/services/review-workbench-projection.test.ts tests/services/merge-service.test.ts tests/services/merge-write-controller.test.ts tests/local-api-auth.test.ts tests/renderer/dashboard.ui.test.tsx
    pnpm typecheck

Expected result: a prepared PR exposes description, threads, checks, a local
batch, and merge readiness. A required failing check blocks merge; a failing
non-required check does not block opening, commenting, reviewing, walkthrough,
or an otherwise eligible merge. An empty My inbox names and links to active
work without changing the selected queue automatically. This proves AI is no
longer the PR-workflow gate and that the main queue cannot falsely look empty.

### Milestone 2 — Build the shared prepared PR workbench and overview

Goal: make normal PR actions discoverable while keeping the diff primary.

Work: extract shared PR workbench actions from
`CompletedReviewWorkbench` instead of copying them into
`PreparedReviewFlow`. Replace the static `Review context` sheet with a closed
by default `PR overview` sheet. Mount `PullRequestDescription`, `ReviewChecks`,
existing threads, `ReviewBatchPanel`, `ReviewSubmissionDialog`, and
`MergeConfirmationDialog` through the same actions in prepared and completed
states. Include the compact advisory only when no local model review exists.
Keep all GitHub writes confirmation-gated and fresh-head guarded. Remove the
Workspace sidebar for this workbench route, retaining Back and compact
workspace/inbox access in the application header. Make the file tree the only
left rail. The header must omit `View diff` when the diff is already selected
and must not render a persistent `Inspect failing checks` action. Show a
compact check status/count beside the snapshot only when the overview is
closed; it opens the overview focused on Checks.

Implement the final overview as a 430px right `Sheet` that is closed by
default. Its identity block is compact. Its body uses accordion rows in this
order: Description (initially open), Checks (initially open), Existing
threads, and Your local review. Use 20-24px section rhythm, 16px internal
spacing, simple dividers/outlined rows, and no nested card grid. Keep the
`No local Patchdesk review has run for this snapshot` advisory above the fixed
footer. The footer contains the existing confirmation-gated `Create pending
review` and `Merge` actions. Apply `plans/001-disclosure-motion.md`
to those four rows only; the Sheet retains its existing entrance transition.

The approved source image is stored at
`fixtures/screen-states/pr-workbench-overview-approved-2026-07-29.png`.
Capture the equivalent open-overview Design state at 1611x976. Add a small,
deterministic `sharp` helper at
`scripts/compare-pr-workbench-overview.mjs` that preserves both images at
native scale and writes a labeled side-by-side result at
`test-results/pr-workbench-overview-vs-approved.png`. Inspect that combined
image with `view_image`, then repeat the comparison with the isolated packaged
app before accepting this milestone.

Commands:

    pnpm test -- --run tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/completed-review-flow.ui.test.tsx tests/renderer/renderer-contracts.test.ts
    pnpm test:design

Expected visual artifact commands, from the same directory after the Design
and package harnesses have produced matching screenshots:

    node scripts/compare-pr-workbench-overview.mjs fixtures/screen-states/pr-workbench-overview-approved-2026-07-29.png test-results/patchdesk-design-pr-workbench-overview-1611x976.png test-results/pr-workbench-overview-vs-approved.png
    node scripts/compare-pr-workbench-overview.mjs fixtures/screen-states/pr-workbench-overview-approved-2026-07-29.png /tmp/patchdesk-qa-<run>/pr-workbench-overview-1611x976.png /tmp/patchdesk-qa-<run>/pr-workbench-overview-vs-approved.png

Expected result: opening a prepared PR shows its title and diff; opening PR
overview reveals safe PR context and actions without starting a model. The
Workspace sidebar is absent, the diff is wider, and neither duplicate header
button appears. The side-by-side capture visibly matches the approved layout.
This proves normal work is accessible from the correct lifecycle and that the
new composition is not only a source-level change.

### Milestone 3 — Add Pierre-backed human comment authoring

Goal: a maintainer can draft an exact line/range comment directly from a
prepared diff.

Work: extend `ReviewDiffView` and `DiffWorkbench` with an optional local-item
authoring callback. Use Pierre's controlled selection and gutter utility;
render a compact shadcn `Popover`/composer beside the selected changed range.
It must include a textarea, Save local comment, and Cancel; Escape cancels and
the keyboard submit shortcut is documented and tested. On save, append a
human-provenance `InlineComment` to the snapshot batch, clear selection, and
render it using the current annotation seam. Do not enable composer controls
for stale, discarded, merged, or non-postable evidence. Preserve selection,
passive tree following, all-files virtualization, hydration, and the `<200ms`
1,000-file selection ceiling. Add focused
`tests/renderer/review-diff-view.ui.test.tsx` coverage for the composer and
selection lifecycle.

Commands:

    pnpm test -- --run tests/renderer/review-diff-view.ui.test.tsx tests/renderer/docked-diff-state.ui.test.tsx tests/services/review-batch-controller.test.ts
    pnpm test:performance

Expected result: selecting a changed range creates one local human draft,
visible both as an annotation and in PR overview, with no GitHub network write.
This proves the single-batch model on the real diff renderer.

### Milestone 4 — Make review and walkthrough optional diff readers

Goal: review and walkthrough work independently from the prepared snapshot.

Work: replace `ReviewCompleted` checks in
`NarrativeWalkthroughService.loadSnapshot` and its post-generation freshness
guard with eligibility based on readable stored patch, session eligibility,
head SHA, and patch hash. Extract the walkthrough dialog/controller from
`CompletedReviewFlow`; mount it from prepared and completed workbenches. Reuse
the shared batch action for walkthrough comments. Update review completion to
append/replace model-provenance items without deleting human items, and show
the concise provenance only after a human changes a model item. Keep raw patch
filtering/reparse for Pierre and do not mutate Files mode state.

In `NarrativeWalkthrough`, initialize the current section to the first
available chapter section. Render its narrative and focused diff before
Support. Keep Support accessible but collapsed until a user opens it. Preserve
the existing reviewed controls and Back to files behavior. Apply
`plans/001-disclosure-motion.md` to Support only; chapter switching,
focused-diff updates, and keyboard reading navigation remain instant.

Commands:

    pnpm test -- --run tests/services/narrative-walkthrough-service.test.ts tests/services/review-completion-service.test.ts tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx
    pnpm exec playwright test tests/browser/milestone-12.spec.ts

Expected result: a prepared PR can generate/open a walkthrough without an AI
review; an AI run may complete during generation without falsely staling the
guide; reruns preserve human comments. The walkthrough immediately displays a
selected explanation and diff rather than only its chapter controls. This
proves the diff—not completion—is the shared lifecycle boundary and the
walkthrough begins with reading rather than navigation.

### Milestone 5 — Apply the Settings visual decision and prove the packaged app

Goal: make Settings comfortable at normal desktop height without changing its
behavior.

Work: update `SettingsModal` and General content layout to use a consistent
spacing scale: 40px modal frame, 32px header-to-tabs and section vertical
space, 24px column gap, 16px field gap, 48px controls, 12px controls, 16px
tabs, one muted border separator per section, and 32px footer padding. Use the
selected two-column structure for General only; responsive layouts stack before
controls become cramped. Keep the internal `ScrollArea`, focus return, dirty
guard, and Workspace/Review/Data sections. Update the Settings Design overlay
and visual/accessibility coverage. Keep General to Appearance and Diff theme.
Move Active profile and profile/GitHub setup to Workspace, alongside
Watchlist. Remove modal-mechanics copy from both the Settings header and
footer; retain only a brief task-focused subtitle if one is useful. In Review,
replace the free-text Default model input with the existing Base UI `Select`,
populated on entry from `GET /v1/reviews/models`. List only currently enabled
models, persist the selected model and reasoning to the existing profile-scoped
local preference, and use the runtime default (or first enabled model) when a
saved model is unavailable. Disable the selector with a clear unavailable
state when the catalog cannot load; do not accept arbitrary model IDs. Retain
the model selector in the Run review dialog as the per-run override. Add
settings-flow and renderer coverage for catalog success, unavailable catalog,
and invalid saved-preference fallback. The approved source image is
stored at `fixtures/screen-states/settings-general-approved-2026-07-29.png`;
do not regenerate or substitute it. Capture the matching Design General state at
1064x1478, build a side-by-side canvas with `sharp` at
`test-results/settings-general-vs-approved.png`, and inspect that combined
image with `view_image`. Repeat the same comparison with the isolated packaged
app screenshot. Fix visible differences in modal width, header/tabs rhythm,
two-column alignment, control geometry, dividers, footer protection, and
clipping before considering the milestone complete.

Commands:

    pnpm test -- --run tests/renderer/settings-modal.ui.test.tsx
    pnpm test:design
    pnpm test:a11y

Expected visual artifact commands, from the same directory after the Design
and package test harness has produced the two screenshots:

    node scripts/compare-settings-general.mjs fixtures/screen-states/settings-general-approved-2026-07-29.png test-results/patchdesk-design-settings-general-1064x1478.png test-results/settings-general-vs-approved.png
    node scripts/compare-settings-general.mjs fixtures/screen-states/settings-general-approved-2026-07-29.png /tmp/patchdesk-qa-<run>/settings-general-1064x1478.png /tmp/patchdesk-qa-<run>/settings-general-vs-approved.png

`scripts/compare-settings-general.mjs` is a small deterministic `sharp`
helper added by this milestone. It must preserve each image at native scale,
place them left-to-right with clear `Approved` and `Implemented` labels, and
never modify either source image.

Expected result: no footer overlap, no clipped controls, and consistent spacing
at desktop and short-height viewports. The side-by-side output visibly matches
the approved two-column hierarchy and shadcn rhythm before it is accepted.
Appearance changes no longer require scanning profile/GitHub setup. This proves
the visual change did not weaken modal behavior or accessibility. Review
Settings offers a valid selectable default model without starting a review.

### Milestone 6 — Full regression and real-user package QA

Goal: prove the combined workflow in the packaged Electron application, not
only through fixtures.

Work: update docs/specs and the old recovery ExecPlan to say prepared snapshot,
not completed snapshot; add changelog entry for the user-visible behavior. Run
all local gates. A dedicated `electron-tester` subagent launches an isolated
package via CDP, uses `agent-browser`, and returns screenshots/evidence. Test
PR #717 or #754 with failing checks: prepare, inspect description/checks,
draft a human comment, clear it or retain it intentionally, generate a
walkthrough without review, run an optional DeepSeek Flash low review if the
model remains available, confirm human/model batch coexistence, and verify
merge stays confirmation-gated. The tester clears only isolated app review
data/cache after each scenario. Add a browser regression test that opens every
Design scenario card from the landing screen and asserts its route/state is
reachable. The audit found the Review prepared card did not navigate despite
the direct route working.

Commands:

    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm exec playwright test
    pnpm test:design
    pnpm test:a11y
    pnpm test:performance
    pnpm package:mac
    pnpm test:package-smoke

Expected result: all commands pass. Dedicated tester evidence proves the live
prepared-PR flow, Settings spacing, data cleanup, and isolated packaged launch.
This is the handoff proof; source tests alone are insufficient.

## Concrete Steps

1. From `/Users/kwanpham/Work/cfw/patchdesk`, re-read this plan, `AGENTS.md`,
   `CONTEXT.md`, relevant docs/ADR files, and `git status -sb`. Do not disturb
   existing dirty work.
2. Complete Milestone 0 before changing renderer entry points. Make the
   migration deterministic and add regression tests before modifying write
   controllers.
3. Complete Milestones 1 and 2 together enough to exercise a prepared
   projection with deterministic fixtures. Do not attach a GitHub write action
   until the existing confirmation component is mounted. In Milestone 2, store
   the approved PR-workbench mock, compare the matching Design capture, and
   repeat that comparison in the isolated package before accepting the route.
4. Use Milestone 3 to prove Pierre selection in the Design app and renderer
   tests before enabling it in packaged QA.
5. Complete Milestone 4 only after a prepared batch supports human items; do
   not create a walkthrough-specific draft path. Include the first-chapter
   walkthrough state in the prepared-flow proof.
6. Apply the Settings-only visual work in Milestone 5. Do not redesign
   Workspace, Review, or Data & recovery beyond responsive consistency.
7. Update this plan's `Progress`, `Surprises & Discoveries`, and `Decision
   Log` after each milestone. Stop for user review if a new irreversible
   product choice appears.

## Validation and Acceptance

Acceptance is behavioral:

- Opening a PR never runs a model or writes to GitHub.
- If My inbox is empty while another visible queue has work, the empty state
  names that work and offers one explicit queue-selection action. It never
  changes the user's selected queue automatically.
- The prepared PR workbench has no Workspace sidebar. Its only left rail is
  the file tree, and the reclaimed space keeps the diff wide and readable.
- The prepared diff shows the PR title, description through PR overview,
  checks, existing threads, and a closed-by-default overview control. The
  overview uses the approved accordion order and fixed protected footer.
- While the diff is visible, neither `View diff` nor `Inspect failing checks`
  is a persistent header action. A closed overview exposes check state through
  a compact snapshot status/count that opens Checks.
- A user can select a changed new/old line range, create a local human inline
  item, edit/remove it in one batch, and see no GitHub write until a confirmed
  pending-review or reply action.
- A model result contributes model-provenance items to the same batch. Editing
  one shows `Model draft · edited by you`; human items survive rerun.
- Walkthrough can generate from a stored prepared diff regardless of non-model
  review completion; invalid snapshot/head/patch remains safely stale.
- A ready walkthrough opens with its first chapter's explanation and focused
  diff visible. Support is available but does not dominate the initial view.
- `View diff` never appears as an action while the diff is already visible.
- Merge can be initiated before AI review only after live GitHub readiness is
  fresh, with the no-local-review advisory and explicit confirmation. Required
  checks, stale head, closed/draft/conflicting PR, and GitHub review blocks
  still prevent merge.
- Settings General has the selected spacious two-column layout, stacks safely
  on narrow screens, scrolls internally, and retains correct focus/dirty guard.
- Settings General contains only appearance and diff-theme preferences. Active
  profile and profile/GitHub setup are in Workspace, and Settings does not
  display modal-mechanics copy as user guidance.
- Review Settings lists only enabled runtime models in a Base UI selector; it
  never accepts a free-text model identifier. A stale saved preference falls
  back to the runtime default or first enabled model, and changing it never
  starts work.
- The Design and packaged Settings screenshots are each compared beside
  `fixtures/screen-states/settings-general-approved-2026-07-29.png` at the
  identical viewport. The checked comparison has no visible hierarchy,
  spacing, border/radius, control-height, footer, or clipping regression.
- The Design and packaged PR-workbench screenshots are each compared beside
  `fixtures/screen-states/pr-workbench-overview-approved-2026-07-29.png` at
  1611x976. The checked comparison has no sidebar, no redundant header
  controls, and no visible hierarchy, spacing, panel-width, or clipping
  regression.
- Every Design landing scenario card opens its registered route. This is
  browser-tested so the permanent visual reference remains usable for manual
  regression checks.
- All renderer/model interactions stay inside the sandboxed renderer and all
  GitHub writes stay main-process-confirmed.

## Idempotence and Recovery

Opening the same PR/head repeatedly resumes the same prepared snapshot and its
batch. Starting a walkthrough or review remains manual and may be retried;
token and snapshot/hash checks prevent a late result from replacing a newer
one. Repeating a local item edit uses expected revision compare-and-set and
returns a conflict rather than overwriting another edit.

No command in this plan may use `git reset --hard`, `git clean`, broad restore,
or broad staging. If a schema migration fails to parse a stored session, keep
the source file, mark that batch unavailable/read-only, record safe diagnostics,
and never delete human data automatically. Applying/partial GitHub writes stay
recoverable with their existing receipts and cannot be silently retried. The
isolated QA profile is disposable; only it may be cleared after tests.

## Artifacts and Notes

- Superseded recovery plan: `.agents/PLANS/2026-07-27-recovery-settings-walkthrough.md`.
- Glossary: `CONTEXT.md`.
- Research: `.agents/tasks/narrative-walkthrough/05-research-prepared-diff-entry.md`.
- Existing walkthrough packet: `.agents/tasks/narrative-walkthrough/spec.md`.
- Prior Pierre workbench design: `docs/superpowers/specs/2026-07-24-pierre-review-workbench-design.md`.
- Prior recovery/observability design: `docs/superpowers/specs/2026-07-26-review-recovery-observability-design.md`.
- Prior package QA notes: `.agents/qa/2026-07-29-package-qa-progress.md` and
  `.agents/qa/2026-07-29-package-qa-memory.md`.
- Product journey audit: `.agents/qa/2026-07-29-product-journey-audit.md`.
- Scoped motion implementation plan: `plans/001-disclosure-motion.md`.
- Audit visual evidence, captured during the audit and preserved here:
  - `fixtures/screen-states/audit/2026-07-29/01-packaged-inbox-default.png`
  - `fixtures/screen-states/audit/2026-07-29/02-packaged-checks-failing.png`
  - `fixtures/screen-states/audit/2026-07-29/03-design-review-prepared.png`
  - `fixtures/screen-states/audit/2026-07-29/04-design-review-context.png`
  - `fixtures/screen-states/audit/2026-07-29/05-design-review-completed.png`
  - `fixtures/screen-states/audit/2026-07-29/06-design-walkthrough-ready.png`
  - `fixtures/screen-states/audit/2026-07-29/07-packaged-settings-general.png`
  The Design captures are mock-only evidence; the packaged captures are the
  current product evidence. Do not use either group as a substitute for the
  isolated packaged QA required by Milestone 6.
- Selected Settings direction: the second Product Design mock, refined to a
  two-column shadcn composition with consistent spacing. Its immutable
  repository baseline is
  `fixtures/screen-states/settings-general-approved-2026-07-29.png`. The numeric spacing
  contract and side-by-side visual comparison are both required.
- Selected PR-workbench direction: the final Product Design mock with no
  Workspace sidebar, a file-tree-only left rail, and an accordion PR overview.
  Its immutable repository baseline is
  `fixtures/screen-states/pr-workbench-overview-approved-2026-07-29.png`. The same-viewport
  Design and packaged comparisons are required.
- Required package evidence should be stored under a dated `.agents/qa/`
  directory and include command output, approved-versus-implemented comparison
  images, app profile path, CDP port, and explicit post-test isolated-data
  cleanup result without secrets.

## Interfaces and Dependencies

At completion, the following contracts should exist:

    type ReviewItemProvenance =
      | { readonly kind: "human" }
      | { readonly kind: "model"; readonly attemptId: ReviewAttemptId; readonly findingId?: FindingId };

    type SnapshotReviewBatch = {
      readonly sessionId: ReviewSessionId;
      readonly snapshot: { readonly headSha: GitSha; readonly patchHash: ContentHash };
      readonly state: ReviewBatchState;
      readonly items: ReadonlyArray<ReviewBatchItem>;
      // existing summary, event, receipt, and revision fields remain
    };

    type ReviewDiffAuthoringActions = {
      readonly canAddInlineComment: boolean;
      readonly onAddInlineComment: (input: {
        readonly path: RepoRelativePath;
        readonly startLine: number;
        readonly line: number;
        readonly side: "new" | "old";
        readonly body: string;
      }) => Promise<void>;
    };

    type PreparedWorkbenchProjection = {
      // existing session, patch, PR and recovery fields
      readonly batch?: ReviewBatch;
      readonly comments: GitHubComments;
      readonly mergeReadiness: MergeReadiness;
      readonly localReviewStatus: "not_run" | "running" | "completed" | "failed";
    };

`@pierre/diffs@1.2.12` is the selected diff dependency. Use its `CodeView`
selection and annotation APIs; do not add a separate diff or comment-rendering
library. Use existing shadcn/Base UI wrappers and the current authenticated
local API routes, evolving their schemas rather than adding renderer-to-GitHub
access.

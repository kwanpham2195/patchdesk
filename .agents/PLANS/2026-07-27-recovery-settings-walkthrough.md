# Review recovery, Settings, and narrative walkthrough implementation

This ExecPlan is a living implementation specification. Keep `Progress`,
`Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective`
current as work proceeds. It consolidates the recovery and observability plan
from `docs/superpowers/plans/2026-07-26-review-recovery-observability.md`, the
Settings redesign proposal in
`docs/superpowers/specs/2026-07-26-settings-redesign-design.md`, and the
narrative walkthrough feature packet in
`.agents/tasks/narrative-walkthrough/`. This ExecPlan is the approved
implementation handoff for their combined scope. PR-description
generation remains a separate design/spec and is intentionally not part of
this implementation plan.

## Purpose / Big Picture

After this work, a maintainer can open a PR even when another PR has damaged
local review data. Patchdesk will show one clear next step: `Run review`, `Reconnect`, `Start
again`, `Try again`, or `Prepare again`. It will not guess that a review is
running from a missing process-local run handle, and it will not expose
quarantine folders, worktrees, attempts, runtime names, file paths, raw phases,
or lifecycle labels in ordinary UI. Internal recovery facts select a
user-oriented message and next action; they are never presented as a state
machine for maintainers to interpret.

Settings will have two global local-data operations: `Clear cache` and `Clear
local review data`. The first removes rebuildable cache while retaining review
records and diagnostics. The second removes discarded, quarantined, and
older-version local review data while retaining running and recoverable
reviews. Both operations are explicit, idempotent, retryable, and unrelated to
GitHub writes.

Once a prepared snapshot has a stable stored patch, the maintainer can explicitly
choose `Generate walkthrough`. A model-and-reasoning dialog appears before any
work starts. A new finite Flue workflow creates bounded semantic sections from
the stored patch. The main process validates the result against that exact
snapshot, assigns every unmentioned hunk to Support, and exposes only a safe
projection to the renderer. A focused takeover lets the maintainer read
sections, mark walkthrough sections reviewed, and create the same inline draft
comments available in Files mode. `Back to files` restores the existing file
selection, passive follow state, inspector state, and diff preferences.

The user-visible proof is one local review workbench containing truthful
recovery actions, a globally accessible Settings modal with two simple local
data controls, and a manually requested narrative takeover. No LLM generation
starts after a review run completes or merely because a snapshot is opened.

## Global Constraints

- Settings is an overlay, not a destination: it opens from any route as a
  centered modal, always starts on General, and returns to the exact underlying
  route.
- Use the existing shadcn/Base UI components in
  `src/renderer/src/components/ui/` and compose them; do not invent a parallel
  modal, tabs, field, scroll, toast, or form component system. The project is
  `base-nova` with `@base-ui/react`; follow the local shadcn composition,
  semantic-color, Field/FieldGroup, Dialog, Tabs, ScrollArea, AlertDialog, and
  focus rules.
- Renderer code never receives Node.js, `gh`, credentials, app-owned review
  artifact paths, raw Flue output, direct GitHub write access, or internal
  storage/lifecycle state. The Profile/Workspace editor is the narrow exception:
  it may display and edit the selected profile's configured workspace/rule paths
  through the existing profile API and directory picker, never review artifacts
  or diagnostic paths. Recovery projections contain only concise display copy,
  tone, and at most one next action.
- All LLM workflows are manual, model/reasoning-selected, snapshot-bound, and
  structured-output workflows. They never auto-run, auto-comment, or auto-merge.
- Global config remains strict global state. Profile configuration,
  profile-scoped review preferences, watchlist data, and local review data stay
  in their existing stores.
- GitHub writes require explicit user confirmation and a main-process recheck of
  the expected body/`HEAD` or review write revision.
- The accepted `src/design/` baseline is normative for every later renderer
  milestone: retain the chapter rail with continuous reading surface; do not
  add the rejected linear picker, a full-page Settings destination, or the
  superseded `settings-default` scenario. A visual or interaction divergence
  requires a new Design scenario, screenshot evidence, and Decision Log entry
  before production code changes.
- Recovery presentation has one status line and one action slot. The renderer
  maps stable notice/action keys through `src/renderer/src/review-copy.ts` and
  never derives or displays lifecycle, storage, attempt, session, quarantine,
  worktree, runtime, path, or raw-error vocabulary.
- Settings presentation is always a centered General-first overlay over the
  unchanged route. Data & recovery contains only `Clear cache` and `Clear local
  review data`, in that order, with the exact retention copy defined in Step 3.
- Walkthrough presentation is manual and dialog-gated: Model and Reasoning are
  selected before generation; progress, ready, failure, stale, Support,
  Reviewed, keyboard/Prev/Next, and `Back to files` follow the accepted rail
  interactions. Opening or completing a review never starts generation.

## Progress

- [x] 2026-07-26 — Existing recovery/observability and narrative walkthrough research and specs are available in the repository.
- [x] 2026-07-26 — The recovery implementation plan and narrative implementation plan were reconciled into this ExecPlan.
- [x] 2026-07-26 — Settings redesign proposal was reconciled into this aligned workstream.
- [x] 2026-07-26 — The UI implementation constraint is recorded: compose existing shadcn/Base UI primitives; do not invent parallel controls.
- [x] 2026-07-27 — Milestone 0 Design gate built and live-validated in
  `src/design/`: shared `src/renderer/src/review-copy.ts` copy map;
  display-safe recovery/cleanup/walkthrough fixtures; exactly 22 permanent
  Design scenarios (`10` retained + `7` recovery/Settings + `5` walkthrough);
  chapter rail + continuous reading surface retained after temporary rail and
  linear comparison screenshots, with the rejected linear source removed;
  `pnpm test:design` passes 25/25 with console-error checks, visible-copy and
  interaction assertions; dedicated `$aside-browser` QA verified 22 live
  scenarios, recovery actions, General-first Settings, cleanup confirmations,
  walkthrough lifecycle, Support, Back to files, and keyboard navigation with
  zero page or console errors. Production routes/services/storage/Flue/Electron
  remain untouched.
- [x] Implement the recovery domain, storage cleanup, copy contract, and diagnostics.
- [x] Implement the global Settings modal, profile/workspace behavior, and cleanup migration.
- [x] Implement the snapshot-bound walkthrough domain, Flue workflow, main-process service, and authenticated API.
- [x] Implement the renderer dialog, focused takeover, Pierre hunk surface, and draft parity.
- [x] Run focused tests, the full desktop gate, browser coverage, packaged smoke, and dedicated packaged UI QA. Final evidence is in `.superpowers/sdd/2026-07-27-recovery-settings-walkthrough/task-9-report.md`.
- [x] Update this section and `Outcomes & Retrospective` after every milestone; Milestone 9 is complete with live GitHub PR data explicitly limited to deterministic fixtures.

## Surprises & Discoveries

- Observation: `ReviewRunRegistry.find(owner)` already exists and returns an
  owned process-local run. The missing piece is injecting it into
  `ReviewWorkbenchProjectionService` so projection can distinguish a live run
  from an interrupted one.
  Evidence: `src/services/review-run-registry.ts` has `find` and
  `findByRunId`; `src/services/review-workbench-projection.ts` currently does
  not accept the registry.

- Observation: Settings is the only renderer caller of the old storage
  overview, discard, and quarantine-delete routes.
  Evidence: `src/renderer/src/flows/settings-flow.tsx` owns the storage action
  union and the `GET /v1/storage`, `/v1/storage/discard`, and
  `/v1/storage/quarantine/delete` requests; the remaining references are
  route/bridge tests.

- Observation: action labels are persisted in maintainer-inbox cache contracts.
  Changing those labels in the domain would invalidate old cache files without
  helping users. Presentation copy must therefore map from action kind in the
  renderer while tolerant parsing preserves old labels.
  Evidence: `src/domain/maintainer-inbox.ts`,
  `src/renderer/src/renderer-contracts.ts`, and
  `src/adapters/storage/maintainer-inbox-cache-store.ts` repeat the literal
  labels.

- Observation: Pierre is patch/file oriented, not a safe renderer for an
  arbitrary filtered `FileDiffMetadata.hunks` array. Walkthrough blocks must
  filter immutable raw patch text and reparse it before rendering.
  Evidence: the Pierre integration research in
  `.agents/tasks/narrative-walkthrough/04-research-pierre.md` and the existing
  `ReviewDiffView` virtual stream.

- Observation: `CompletedReviewFlow` already owns the safe batch update path,
  so walkthrough comments should call that callback instead of creating a
  second draft store.
  Evidence: `src/renderer/src/flows/completed-review-flow.tsx` sends
  `AddInlineComment` through `POST /v1/reviews/batch`.

- Observation: Settings is currently a full-page `SettingsFlow` that mixes
  appearance, profile editing, workspace paths, GitHub access, storage
  cleanup, and Watchlist management. The app shell special-cases Settings by
  changing the main pane to `overflow-y-auto`.
  Evidence: `src/renderer/src/flows/settings-flow.tsx` and
  `src/renderer/src/components/app-shell.tsx`.

- Observation: The project already uses the Base UI implementation of shadcn
  components, including `Dialog`, `Tabs`, `ScrollArea`, `Field`, `AlertDialog`,
  `Select`, and `Button`. The Settings redesign can be composed from those
  wrappers without adding a new UI primitive.
  Evidence: `components.json` is `base-nova`; `package.json` includes
  `@base-ui/react`; `src/renderer/src/components/ui/` contains the relevant
  components.

- Observation: `src/design/` is the cheapest design-first surface for all
  recovery, Settings, and walkthrough interactions. It already reuses renderer
  primitives, has a typed mock bridge, runs in a browser at `pnpm dev:design`,
  and its scenario registry maps to URL handles. A recovery, Settings, or
  walkthrough interaction can be explored with deterministic mock data rather
  than a domain, adapter, or Electron change. The Design gate locks the visual
  and interaction surface before real implementation.
  Evidence: `src/design/scenarios.ts`, `src/design/mock-bridge.ts`,
  `src/design/design-app.tsx`.


## Decision Log

- Decision: Implement recovery and migration before exposing walkthrough
  generation. Rationale: walkthrough generation must never run against a
  quarantined, stale, or interrupted snapshot, and its stale-result behavior
  depends on explicit snapshot identity. Date/Author: 2026-07-26, Matthew and
  Codex.

- Decision: Keep user-facing Git and LLM vocabulary (`PR`, `HEAD`, `Reviewed
  HEAD`, `Current HEAD`, `Reviewed SHA`, `read-only`, model, `Reasoning`, and
  `Low`/`Medium`/`High`) while removing implementation vocabulary. Rationale:
  maintainers understand basic GitHub, Git, and LLM concepts; simplification
  should remove internal leakage, not useful decision-making terms. Date/Author:
  2026-07-26, Matthew and Codex.

- Decision: Make the local-storage migration breaking and idempotent. Remove
  per-review Settings controls and obsolete storage routes after callers and
  tests migrate. Rationale: keeping ambiguous saved-review controls and
  compatibility shims would preserve the failure modes this work is intended
  to remove. Date/Author: 2026-07-26, Matthew and Codex.

- Decision: Keep walkthrough lifecycle records in memory and bind each result
  to `{ profileId, sessionId, headSha, patchHash }`. Rationale: V1 does not
  promise guide history; in-memory state prevents stale explanations from
  being mistaken for a new snapshot while avoiding a second durable store.
  Date/Author: 2026-07-26, Matthew and Codex.

- Decision: Keep narrative generation manual and separate from
  `workflow:review-pr`. Rationale: reviewers request an explanation after they
choose to read a prepared snapshot; automatic generation would add cost,
  latency, and an unrequested model action. Date/Author: 2026-07-26, narrative
  walkthrough specification.

- Decision: Add one user-safe recovery decision to renderer projections rather
  than deriving actions from `currentAttemptId` or `runId`. Rationale: those
  fields are historical or process-local linkage, not truth about user
  actionability; multiple capability booleans let the UI expose contradictory
  controls.
  Date/Author: 2026-07-26, recovery/observability specification.

- Decision: Make Settings a centered modal that always opens on General,
  instead of a full-page route. Rationale: users should change theme, profile,
  or preferences from any inbox/workbench without losing their current route;
  internal modal scrolling fixes the existing long-page scroll problem.
  Date/Author: 2026-07-26, Matthew and Codex.

- Decision: Profile switching applies immediately when the profile draft is
  clean; dirty drafts require Save, Discard, or Cancel. Rationale: switching
  should be fast while never silently losing workspace edits. Date/Author:
  2026-07-26, Matthew and Codex.

- Decision: Compose Settings UI from existing shadcn/Base UI wrappers only.
  Rationale: the project already has Base UI primitives and accessibility/
  styling conventions; a parallel custom modal or form system would create
  inconsistent behavior and increase maintenance. Date/Author: 2026-07-26,
  Matthew and Codex.

- Decision: Use `src/design/` as the Milestone 0 design gate for recovery,
  Settings, and walkthrough before production integration. Rationale:
  `src/design/` already reuses renderer primitives and its mock bridge is the
  cheapest way to compare interactions without touching persistence, GitHub,
  Electron, or a model. The accepted permanent scenarios become the screenshot
  evidence that implementation must match. Date/Author: 2026-07-27, Matthew
  and Codex.

- Decision: Milestone 0 retains 22 permanent Design scenarios: the 10 retained
  existing scenarios, seven recovery/Settings scenarios (including the
  replacement for `settings-default`), and five walkthrough lifecycle scenarios. It compares two temporary walkthrough reading layouts before
  retaining the selected one; the rejected comparison is removed, not preserved
  as a museum. `settings-recovery` supersedes `settings-default`. Rationale:
  one source of truth for friendly copy and chosen interaction behavior.
  Date/Author: 2026-07-27, Matthew and Codex.

- Decision: The workbench mock carries an explicit display-safe `recoveryView`
  fixture (notice key, tone, and optional action key); the renderer reads it
  directly rather than re-deriving from `latestReview.state` +
  `currentAttemptId` + a mocked registry. Rationale: the Design app is for
  visual iteration, not production derivation; production recovery decisions
  are tested in the production suite. One display fixture per scenario, one
  source of truth per screenshot. Date/Author: 2026-07-27, Matthew and Codex.

- Decision: Recovery action buttons on the workbench share a single
  primary action slot; the status line above the button is the tone
  carrier (colored dot). `Run review` and `Reconnect` are primary blue.
  `Start again` and `Try again` are outline secondary. `Prepare again`
  is outline amber. Rationale: scannable, the user always knows where
  to look, and the only action that signals broken local data
  (`Prepare again`) is visually distinct without making the whole
  workbench alarmist. Date/Author: 2026-07-27, Matthew and Codex.

- Decision: Settings → Data & recovery is a single card with two
  outline buttons stacked in severity order (`Clear cache` on top,
  `Clear local review data` below in outline-destructive). Each
  opens an `AlertDialog` with explicit "X stays, Y goes" copy. The
  card title is "Local review data". Rationale: severity ordering
  matches maintainer expectations; explicit copy satisfies the plan's
  "Confirmations state exactly: ... preserves or removes" rule.
  Date/Author: 2026-07-27, Matthew and Codex.
- Decision: Walkthrough reading layout is the chapter rail with
  continuous reading surface (persistent left rail, per-section
  prose, bounded hunk previews, Support coverage, Reviewed controls,
  and persistent `Back to files`). The linear section picker was
  considered and removed after the side-by-side Design comparison
  showed it forced more vertical scanning and obscured keyboard
  navigation affordances. The permanent `walkthrough-ready` scenario
  is the rail; the linear picker is not retained as a museum.
  Date/Author: 2026-07-27, Matthew and Codex.

## Outcomes & Retrospective

### Milestone 0 — Design gate (built and validated 2026-07-27)

The complete Design gate is implemented in `src/design/` as the acceptance
surface for recovery, Settings, and walkthrough before any storage, local API,
workflow, or Electron work. The temporary chapter-rail and linear-picker
scenarios used the same fixture; the rail was selected, comparison screenshots
were preserved under `.superpowers/sdd/2026-07-27-recovery-settings-walkthrough/screenshots/`,
and the rejected linear source and routes were removed.

The accepted gate proves:

- exactly 22 permanent scenarios: 10 retained existing, seven recovery/Settings
  scenarios (including the `settings-default` replacement), and five walkthrough
  lifecycle scenarios;
- display-safe recovery fixtures and one friendly copy map;
- recovery actions, cleanup confirmations, manual generation, generating
  progress, ready, failure/stale retry, Support, Reviewed controls, keyboard
  navigation, and Back to files through deterministic Design interactions; and
- screenshot-backed browser evidence with no visible lifecycle/storage terms.

Evidence: `pnpm test:design` — 25/25; `pnpm typecheck`; `pnpm lint
--max-warnings=0`; `pnpm test -- --run` — 394/394; and dedicated `$aside-browser`
QA with 36 screenshots and zero page/console errors. The live QA report is at
`.superpowers/sdd/2026-07-27-recovery-settings-walkthrough/aside-qa/report.md`.
Keyboard follow-up evidence is at
`.superpowers/sdd/2026-07-27-recovery-settings-walkthrough/aside-qa/keyboard-follow-up.md`.

#### Design adherence lock

Every later milestone must preserve the 22-scenario registry, shared friendly
copy map, one-action recovery slot, centered General-first Settings overlay,
exact cleanup confirmations, persistent chapter rail, Support, Reviewed
controls, keyboard navigation, and `Back to files` return behavior. A change to
any of those choices requires a new Design scenario, screenshots, and a
Decision Log entry before implementation proceeds.

### Production implementation completed through Milestone 9

Milestones 1–9 are implemented. The final Milestone 9 proof covers the
snapshot migration, protected local API, Settings overlay, profile and cleanup
flows, manual walkthrough generation, chapter navigation, Support, Reviewed
controls, local inline drafts, and Files-state restoration. Browser and
accessibility evidence uses deterministic fixtures; live PR data for #717,
#754, and #716 was not available in this local run and is not claimed here.

Final verification records exact commands, pass counts, packaged evidence, and
remaining environmental limitations in
`.superpowers/sdd/2026-07-27-recovery-settings-walkthrough/task-9-report.md`.

## Context and Orientation

Patchdesk is an Electron application with three trust boundaries:

1. `src/domain/` contains pure types, parsers, and invariants.
2. `src/services/` coordinates storage, GitHub reads, workflows, and recovery.
3. `src/adapters/` performs GitHub, Pi/Flue, and filesystem I/O.

The privileged main process exposes an authenticated Hono loopback API from
`src/main/local-api.ts`. The sandboxed preload allowlist in
`src/main/desktop-bridge.ts` is the only renderer path to that API. The
renderer is isolated and must not receive Node.js, filesystem, process, raw
Flue, credentials, or absolute-path access. Do not add a public review route to
`src/app.ts`.

A durable **review record** identifies repository, PR, and reviewed `HEAD`.
Preparation creates the stored patch and related artifacts. A **review
attempt** is one explicit model run. A process-local `runId` is only a live
handle owned by the current process; `currentAttemptId` is historical linkage.
An **interrupted** attempt is not corrupt review data. **Quarantine** is an
internal evidence-preservation location for invalid local data; it maps to
`Needs preparation` or omission in normal UI.

The existing `ReviewWorkbenchProjectionService` builds renderer-safe prepared
and completed projections. It currently exposes `currentAttemptId` but no
single recovery decision. The existing `ReviewRunRegistry` already
supports `find(owner)`. The existing `SafeRunPanel` treats a missing `runId` as
“not running,” which is the behavior being removed.

The existing Settings implementation is a full-page `SettingsFlow` mounted
when `destination.kind === "settings"`. It contains appearance, diff theme,
profile/workspace editing, GitHub access, storage management, and Watchlist
controls. The app already has Base UI shadcn wrappers in
`src/renderer/src/components/ui/`, configured by `components.json` as the
`base-nova` style with `@base-ui/react`. The redesign must compose those
wrappers rather than add bespoke overlay or form primitives.

The narrative walkthrough is a read-only reading mode over one completed,
stored patch. The model receives bounded aliases for parsed patch hunks, never
invents paths or line numbers, and returns structured JSON. The main process
normalizes it. The renderer never renders raw model output.

## Plan of Work

Implement the work in this order:

1. Use `src/design/` to compare, select, and screenshot the recovery, Settings,
   and walkthrough interaction design before production integration.
2. Establish the renderer copy contract and recovery/storage domain contracts.
3. Implement safe artifact removal, the global centered Settings modal, and
   cleanup route migration using existing shadcn/Base UI primitives.
4. Project the user-safe recovery decision, persist diagnostics, and reconcile
   old local data without relaunching workflows.
5. Define and test the snapshot-bound walkthrough domain and raw-patch hunk
   filtering.
6. Add the isolated walkthrough Flue workflow and fixed-command adapter.
7. Add the main-process walkthrough service, authenticated API, and production
   runtime wiring.
8. Add strict renderer contracts, explicit model/reasoning selection, and the
   manual Generate walkthrough entry point.
9. Add the focused takeover and reparsed Pierre blocks without changing Files
   mode.
10. Migrate persisted/cache data, run the end-to-end/browser/package gates, and
    obtain dedicated packaged UI evidence.

Recovery work is a prerequisite for narrative work, but it does not start
walkthrough generation. The narrative API must reject any session whose
prepared patch or snapshot identity is unavailable, stale, or not a completed
read-only snapshot.

Settings and walkthrough generation share the same profile/recovery projection
but remain independent user actions. Opening Settings never starts an LLM
workflow.

## Milestones

### Milestone 0 — Design-first UI acceptance (built and validated 2026-07-27)

Goal: use the browser-only `src/design/` prototype to make and verify every
user-facing choice before wiring storage, local API, Flue, or Electron behavior.
The gate was completed before any production service, route, persistence, or
workflow work. All later milestones must reproduce its accepted interaction and
copy baseline.

#### Design gate (accepted)

The completed Design pass covered the complete maintainer journey, not only
recovery and Settings. It compared two temporary layouts over the same fixture:
a persistent chapter rail with continuous reading surface and a linear section
picker above the reading surface. The rail is recorded in the Decision Log; the
linear source and route were removed after comparison.

The permanent registry contains exactly 22 scenarios: the 10 retained existing scenarios,
seven recovery/Settings scenarios (`workbench-reconnect`, `workbench-start-again`,
`workbench-try-again`, `workbench-prepare-again`, `inbox-recovery-states`,
`settings-recovery`, `dialog-clear-local-data`), and five walkthrough scenarios
(`walkthrough-generate-dialog`, `walkthrough-generating`, `walkthrough-ready`,
`walkthrough-failed`, `walkthrough-stale`).

Files to add or modify:

- `src/design/scenarios.ts` — permanent scenario IDs and temporary comparison
  IDs while the walkthrough layout decision is open.
- `src/design/main.tsx` — Settings overlay and Design-only walkthrough scenario
  wiring; do not route production `AppDestination` through Settings.
- `src/design/design-app.tsx` — direct scenario render paths, including the
  temporary comparison and the selected permanent walkthrough reference.
- `src/design/design-walkthrough-scenario.tsx` — deterministic, browser-only
  walkthrough fixture composed from existing renderer primitives; no Electron,
  GitHub, filesystem, or model calls.
- `src/design/mock-bridge.ts` — display-safe recovery, Settings, and
  walkthrough fixtures. A recovery fixture has only notice key, tone, and
  optional action key; no technical state, paths, IDs, or raw errors.
- `src/renderer/src/review-copy.ts` — the renderer's single friendly copy map;
  creating it here is allowed, but it is not wired to production API data until
  Milestone 1.
- `tests/browser/design.spec.ts` — visit all permanent scenarios, check the
  selected walkthrough interaction, capture screenshots, and assert recovery,
  Settings, and walkthrough UI omit storage/lifecycle terminology.

Run:

    pnpm test:design

Gate evidence: screenshots under `test-results/` show the two candidate
walkthrough layouts, the selected layout is recorded in the Decision Log, and
the permanent 22 scenarios build, open without console errors, and pass their
visible-copy assertions. Recovery shows one reassurance and one next action;
Settings confirmations show what stays; walkthrough generation makes its
read-only behavior, progress, retry, and return path obvious. The final
`pnpm test:design` run passes 25/25. Dedicated `$aside-browser` QA verifies
all 22 live scenarios, the Settings and walkthrough interactions, Support,
Back to files, and keyboard navigation with zero page/console errors. This
accepted evidence is the visual contract for Milestones 1–9.

Why this reduces risk: visual and interaction mistakes are corrected in the
fast, deterministic Design surface rather than after trust-boundary or
persistence work is already coupled to the UI.

### Milestone 1 — Honest contracts and safe local-data ownership

Goal: establish stable presentation labels, user-safe recovery decisions, and
path-checked cleanup behavior that implements the accepted Design baseline.

#### Design adherence lock

- Keep `src/renderer/src/review-copy.ts` as the only renderer mapping from
  stable notice/action keys to visible copy. Persisted labels are tolerated only
  at the cache boundary and never selected by UI logic.
- Recovery projections contain only the accepted display-safe shape:
  `{ noticeKey, tone, actionKey? }`. The workbench has one status line and one
  action slot: `Run review`/`Reconnect` use the primary blue treatment,
  `Start again`/`Try again` use outline secondary, and `Prepare again` uses
  outline amber. Do not expose multiple capability booleans or internal state.
- Add copy-contract tests for every Design recovery scenario and assert that
  `session`, `attempt`, `quarantine`, `worktree`, `runtime`, paths, and raw
  errors cannot reach visible UI.

#### 1a. Real implementation

Work: add the renderer copy map, a pure recovery decision module, durable
attempt/preparation reconciliation, an exclusive profile lifecycle gate, and
idempotent local-data removal. The projection exposes a single display-safe
next action rather than multiple booleans that callers can combine incorrectly.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/review-copy.test.ts tests/services/storage-management-service.test.ts tests/domain/review-recovery.test.ts

Expected result: the new focused tests pass; action labels are selected by
action kind rather than persisted display text; discarded/quarantined data can
be removed; running and recoverable sessions remain.

Why this reduces risk: later route and renderer changes consume explicit
contracts rather than duplicating cleanup rules or guessing state from storage
details.

### Milestone 2 — Global Settings modal and cleanup migration

Goal: make Settings available from every route, fix its scroll ownership, and
remove the per-review storage-management surface.

#### Design adherence lock

- `settingsOpen` is overlay state only. Gear, `⌘,`, and Navigate preserve the
  exact underlying `AppDestination`, selected PR, workbench state, and opener
  focus. There is no Settings destination or full-page replacement.
- The overlay is centered, labelled, focus-trapped, independently scrollable,
  and General-first on every open, including cleanup deep links. Compose only
  the existing Base UI Dialog/Tabs/ScrollArea/Field/Alert/AlertDialog/Select/
  Button/Separator wrappers.
- Data & recovery is one `Local review data` card with exactly two outline
  actions in severity order: `Clear cache`, then `Clear local review data`.
  Use the exact confirmations: “This removes rebuildable local files. Your
  saved reviews and diagnostic reports stay.” and “This removes discarded and
  unusable local review data. Reviews you can still open or resume, and
  diagnostic reports, stay.” No storage lists, Discard control, quarantine
  control, or internal terminology may appear.
- Settings screenshots and browser assertions must prove General-first,
  independent scroll, focus return, route preservation, and both confirmation
  bodies before this milestone is accepted.

Work: make `settingsOpen` independent overlay state in
`src/renderer/src/app.tsx`; keep `AppDestination` and the mounted workbench
unchanged while the overlay is open; create a centered
`src/renderer/src/components/settings-modal.tsx` using the existing shadcn/Base
UI `Dialog`, `Tabs`, `ScrollArea`, `Field`, `Alert`, `AlertDialog`, `Select`,
`Button`, and `Separator` wrappers; split the long SettingsFlow into focused
section components; always start on General; apply theme changes immediately;
switch clean profiles immediately; require Save/Discard/Cancel for dirty
profile drafts; move Watchlist out of Settings; include profile-scoped Review
preferences; and replace storage overview state with the two global cleanup
actions.

Add `POST /v1/storage/clear-local-data`; retain
`POST /v1/storage/cache/clear`; remove old Settings-only overview/discard/
quarantine-delete routes after callers and allowlist tests migrate.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/profile-settings.test.tsx tests/desktop-bridge.test.ts tests/local-api-auth.test.ts

Expected result: the gear, `⌘,`, and Navigate open a centered modal over the
current route on General; the modal scrolls independently; appearance and diff
theme apply immediately; clean profile switching reloads the workspace without
stale PR state; dirty drafts require an explicit decision; Watchlist is no
longer buried in Settings; Data & recovery renders only `Clear cache` and
`Clear local review data`; failures keep confirmation context for retry; old
routes are rejected or no longer exposed.

Why this reduces risk: the cleanup policy becomes global, explicit, and
testable without allowing users to manage internal session/quarantine records.

### Milestone 3 — Truthful recovery and bounded diagnostics

Goal: make open/run/reconnect/retry behavior reflect durable state and owned
process state, and preserve enough redacted evidence to debug failures.

#### Design adherence lock

- Map the pure decisions directly to the Design recovery matrix: `Preparing`
  has no button; usable/discarded snapshots show `Ready to review` + `Run review`;
  owned live runs show `Review in progress` + `Reconnect`; unowned/interrupted
  runs show `Review was interrupted` + `Start again`; failed runs show `Review
  couldn’t finish` + `Try again`; invalid rebuildable evidence shows `Review needs
  preparation` + `Prepare again`.
- `PreparedReviewFlow` and `SafeRunPanel` render only the shared friendly copy
and one action slot. Remove “not running”, “may still be running in the
background”, Agent, Mode, Access, and all storage/lifecycle vocabulary from the
user surface. Keep incident IDs/support export behind explicit safe actions.
- Diagnostics may retain technical evidence only inside bounded redacted JSONL
and support bundles; the Design projection must contain no path, raw stack,
credential, complete diff, attempt ID, or operation ID.

Work: introduce a durable `ReviewPreparationOperation` journal and an
`Interrupted` attempt transition; inject `ReviewRunRegistry`, the preparation
journal reader, and the pure recovery decision module into
`ReviewWorkbenchProjectionService`; make `PreparedReviewFlow` and `SafeRunPanel`
render its display-safe recovery view; add `ReviewDiagnosticEvent`, bounded
JSONL storage, and a sanitized support-bundle export. Reconcile stranded
preparation journals and previous-process running attempts idempotently, then
record safe boundary failures from cleanup, profile reload, and walkthrough
generation.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/domain/review-recovery.test.ts tests/services/review-workbench-projection.test.ts tests/services/review-run-coordinator.test.ts tests/services/review-diagnostic-service.test.ts tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/safe-run-panel.ui.test.tsx

Expected result: ready/discarded sessions show `Run review`; owned live runs
show `Reconnect`; unowned running attempts show `Start again`; failed attempts
show `Try again`; invalid preparation shows `Prepare again`; no copy says a
review may still be running merely because an attempt pointer exists. Diagnostic
events contain incident IDs and redacted details without credentials, full
diffs, or absolute paths.

Why this reduces risk: walkthrough generation will only be enabled for a
truthful prepared snapshot with a stable stored patch and will inherit the same safe lifecycle
projection.

### Milestone 4 — Snapshot-bound walkthrough domain

Goal: make model output fail closed and guarantee that every source hunk is
visible exactly once.

#### Design adherence lock

- The normalized result must support the accepted chapter-rail reading model:
  ordered chapters/sections, bounded prose, explicit hunk groups, and a derived
  Support section. Do not introduce a linear-picker-only state shape.
- Preserve the Design fixture's invariants in production: every source hunk is
  shown once across primary sections or Support; section order is stable;
  unknown/duplicate/overlapping aliases fail closed; and snapshot identity is
  explicit before the renderer can enter ready.
- Keep normalized data renderer-safe: no raw model prose outside bounded fields,
  arbitrary paths, untrusted line ranges, patch paths, or technical lifecycle
  details cross the projection boundary.

Work: create `src/domain/narrative-walkthrough.ts` and its tests. Define the
snapshot key, bounded raw schema, normalized chapters/sections/Support, hunk
aliases, coverage invariant, and `filterNarrativePatchToHunks`.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/domain/narrative-walkthrough.test.ts tests/domain/review-domain.test.ts

Expected result: valid aliases resolve; unknown, duplicate, and overlapping
aliases are discarded deterministically; every parsed patch hunk belongs to one
primary section or Support; malformed or empty primary output returns a safe
error; filtered raw patches reparse with original file headers and correct line
coordinates.

Why this reduces risk: the untrusted model cannot make the renderer omit code,
show an arbitrary path, or display stale line references.

### Milestone 5 — Isolated Flue generation

Goal: add structured walkthrough generation without changing review execution.

#### Design adherence lock

- Prompt for semantic chapters that fit the selected persistent rail and
  continuous reading surface: explain behavior before consequences/tests, use
  aliases exactly, and route mechanical/low-signal changes to Support. Do not
  prompt for or return a linear section-picker workflow.
- The workflow remains read-only and finite. It receives only main-process
  artifacts plus explicit Model/Reasoning, never starts from review completion
  or snapshot open, and cannot create comments, mutate drafts, or write GitHub.
- Preserve the Design lifecycle copy as the future renderer contract:
  generation is requested after the model/reasoning dialog, progress is visible,
  failures offer retry, and stale results offer regeneration for the current
  snapshot.

Work: create `src/workflows/generate-walkthrough.ts` and
`src/services/flue-cli-walkthrough-invoker.ts`. The workflow reads only the
main-process-supplied patch/context artifacts and explicit model/reasoning.
The adapter invokes the fixed `workflow:generate-walkthrough` command, keeps
stderr/events behind the adapter, and parses only terminal JSON.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/services/flue-cli-walkthrough-invoker.test.ts tests/services/flue-cli-review-invoker.test.ts

Expected result: the walkthrough adapter uses the exact fixed command and
schema-backed output; existing `workflow:review-pr` invocation is unchanged;
raw model text never reaches renderer state.

Why this reduces risk: provider behavior is isolated behind one testable
adapter and cannot silently mutate review sessions or GitHub data.

### Milestone 6 — Main-process service and authenticated walkthrough API

Goal: bind generation to one stored snapshot and make retries/stale results
safe.

#### Design adherence lock

- Expose only the manual, authenticated generate/load seam behind the existing
  local API. Opening or completing a review must never call this service.
- Lifecycle responses are renderer-safe projections matching the Design states
  `idle`, `generating`, `ready`, `failed`, and `stale`; each non-ready state
  carries concise next-step copy rather than raw errors, paths, run IDs, or
  workflow names. Preserve the Design actions: retry failed generation and
  regenerate a stale snapshot.
- The service must publish only a result whose `{ profileId, sessionId,
  headSha, patchHash }` still matches the request. A late result is ignored,
  not shown as a stale success, and never mutates review drafts or GitHub state.

Work: create `src/services/narrative-walkthrough-service.ts`; add
`POST /v1/reviews/walkthrough/generate` and
`POST /v1/reviews/walkthrough/load` in `src/main/local-api.ts`; add a separate
production walkthrough invoker in `src/main/electron-main.ts` that cannot call
review completion or failure services; update the `src/main/desktop-bridge.ts`
route allowlist and authorization tests.
The service hashes the stored patch before and after invocation, increments a
per-session generation token, and updates a record only if generation token
and snapshot still match. It records generation failures through diagnostics.

Use these renderer-safe lifecycle values: `idle`, `generating`, `ready`,
`failed`, and `stale`. Map invalid request to 400, missing profile/session to
404, stale snapshot to 409, and unavailable workflow to 503. Accept only
`profileId`, `sessionId`, `model`, and `reasoning` from HTTP; never accept a
workflow path or filesystem path from the renderer.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/services/narrative-walkthrough-service.test.ts tests/local-api-auth.test.ts tests/main-desktop-hardening.test.ts

Expected result: a second request supersedes a first late result; changed
patch hashes return `stale`; API capability/origin checks reject unauthorized
requests; the service refuses non-completed or missing snapshots and never
starts automatically.

Why this reduces risk: stale model explanations, cross-session responses, and
renderer-controlled process access are prevented at the main-process boundary.

### Milestone 7 — Renderer contract, model dialog, and manual entry point

Goal: let a maintainer choose a model and reasoning level deliberately before
generation.

#### Design adherence lock

- The completed stable snapshot is the only entry point. The action is visibly
  `Generate walkthrough`; it is absent or disabled in preparation, running,
  failed, stale, and unavailable states according to the recovery projection.
- The dialog must match the accepted Design reference: title `Generate a
  read-only walkthrough`, explicit read-only/no-GitHub-write explanation,
  `Model` and `Reasoning` controls, `Low`/`Medium`/`High` values, and confirm
  label `Generate read-only walkthrough`. No request or preference write occurs
  before the explicit confirmation.
- Unavailable catalogs use the existing friendly local-review explanation and
  never expose provider/runtime names. Retry and stale regeneration remain
  bound to the same validated snapshot identity.

Work: extend `src/renderer/src/renderer-contracts.ts` and
`src/renderer/src/renderer-models.ts` with strict walkthrough and recovery
projections. In `src/renderer/src/flows/completed-review-flow.tsx`, load the
active Pi catalog, restore the valid per-profile model/reasoning preference,
show a `Generate walkthrough` dialog, and call the walkthrough API only after
confirmation. Save the preference only after a valid selection is confirmed.
Disable the action with the same clear unavailable-catalog copy used by local
review. Do not run from preparation, running, failed, or stale workbench
states.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/renderer-contracts.test.ts tests/renderer/completed-review-flow.ui.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx

Expected result: malformed projections never enter React state; no generation
request occurs when the completed workbench opens; the dialog exposes Model and
`Reasoning` with `Low`, `Medium`, and `High`; unavailable models block the
confirm action clearly; retry stays bound to the same snapshot.

Why this reduces risk: user intent, model selection, and snapshot readiness are
explicit instead of being inferred from completion or run state.

### Milestone 8 — Focused takeover and hunk-scoped Pierre surface

Goal: provide a readable narrative mode without mutating Files mode.

#### Design adherence lock

- Implement only the accepted chapter rail + continuous reading surface:
  persistent chapter navigation, one active section, bounded hunk previews,
  Support coverage, Reviewed controls, Previous/Next, and a persistent
  `Back to files`. Do not add the rejected linear picker or a second takeover
  layout.
- `Back to files` closes takeover and restores the exact Files state. Opening
  takeover and moving through sections must not write selected path, passive
  follow state, inspector state, collapsed paths, diff surface, or diff-view
  preferences. ArrowLeft/ArrowRight and j/k work only inside the takeover and
  not inside inputs, selects, or annotation editors; end keys are no-ops.
- Walkthrough comments use the existing `AddInlineComment` batch path. Pierre
  receives only filtered, reparsed raw patches; Support receives every
  uncovered hunk. No walkthrough comment store, parsed-hunk-array filtering,
  virtual-stream mutation, or GitHub-write bypass is allowed.
- Renderer tests must cover the Design acceptance sequence: dialog → generating
  → ready → chapter navigation → section/Support Reviewed → inline draft →
  Back to files with Files state intact.

Work: create `src/renderer/src/components/narrative-walkthrough.tsx` and
`narrative-walkthrough-diff.tsx`; add isolated state to
`src/renderer/src/components/completed-review-workbench.tsx`; extract shared
annotation projection from `review-diff-view.tsx` only if safe. Render review
focus, chapter/section rail, Support, Reviewed controls, Prev/Next keyboard
navigation, and `Back to files`. For each section, filter the immutable raw
patch by normalized hunk IDs, reparse it, and render Pierre with existing theme,
split/unified, wrap, context, and inline annotation preferences. Use unique
block keys because one file may appear in multiple sections.

Route `AddInlineComment` through the existing `updateBatch` callback. Do not
create a walkthrough comment store. Do not filter a parsed hunk array, add
hunk-item types to the virtual `CodeView`, or route takeover navigation through
Files-mode scroll/follow callbacks.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/narrative-walkthrough-diff.test.tsx tests/renderer/review-workbench.ui.test.tsx tests/renderer/docked-diff-state.ui.test.tsx tests/renderer/diff-workbench.ui.test.tsx

Expected result: section progress is independent from file viewed state;
Support renders all uncovered hunks; inline drafts appear in the existing
batch; Back to files restores selected path, passive active path, inspector,
and current diff controls.

Why this reduces risk: the new surface is additive and cannot corrupt the
performance-sensitive all-files virtual stream or existing review comments.

### Milestone 8 — Focused takeover outcome (accepted 2026-07-27)

The chapter-rail takeover is implemented additively over the completed workbench.
It keeps the Files subtree mounted and hidden, so selection, passive active-file
state, inspector state, collapsed paths, diff surface, scroll/context state, and
profile-scoped diff preferences survive the return. Walkthrough sections and
Support each filter the immutable raw patch by normalized aliases before
reparsing through the existing ReviewDiffView/Pierre path. Source-session
hydration, Context, split/unified, wrap, and inline/draft annotations use the
existing diff surface; local takeover controls never persist Files preferences.

The takeover owns section navigation/review state, supports ArrowLeft/ArrowRight
and j/k outside editors, renders Support coverage, anchors deletion-only drafts
on the old side, and restores the opener after Back to files. StrictMode-safe
focus tests cover no initial focus steal and heading focus after navigation.

Evidence: commits `599d9cd`, `cbc265d`, `3102c76`, `ef5e666`, and `5b435aa`;
exact Milestone 8 command passes 5 files/31 tests; extended renderer command
passes 7 files/57 tests; `pnpm typecheck` and `pnpm lint` pass; final independent
re-review is APPROVED. Live/browser/package proof remains Milestone 9.

### Milestone 9 — Migration, browser proof, and packaged evidence

Goal: prove the complete user journey and retire ambiguous old local state.

#### Design adherence lock

- Treat the 22 permanent Design scenarios and their screenshots as the browser
  acceptance matrix. Production routes must reproduce the same friendly copy,
  one-action recovery slot, centered General-first Settings overlay, exact
  cleanup confirmations, chapter rail, Support, Reviewed controls, and
  Back-to-files behavior.
- Browser and accessibility proof must assert that no visible surface contains
  `session`, `attempt`, `quarantine`, `worktree`, `runtime`, raw errors, paths,
  or workflow/provider internals. Any intentional visual or interaction
  divergence requires a new Design scenario, screenshot baseline, and Decision
  Log entry before this milestone continues.
- The end-to-end walkthrough remains manual: click Generate, choose Model and
  Reasoning, observe progress, navigate the rail, review a section and Support,
  add an inline draft through the existing batch surface, and return to Files.
  Opening a completed workbench alone must produce zero generation requests.

Work: add tolerant cache parsing and versioned, idempotent session migration;
convert stranded attempts to interrupted; quarantine invalid sessions with
diagnostics; normalize discarded sessions to fresh-attempt eligibility; remove
renderer action decisions based on `currentAttemptId`; add browser fixtures for
PR #717, #754, and #716 scenarios; prove the global Settings modal, profile
switch, independent scroll, cleanup actions, and narrative journey; preserve
the 1,000-file selection ceiling.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/storage/maintainer-inbox-cache-store.test.ts tests/storage/review-session-store-begin-attempt.test.ts tests/services/review-recovery-service.test.ts tests/services/review-preparation-journal.test.ts
    pnpm exec playwright test tests/browser/milestone-5.spec.ts tests/browser/milestone-9.spec.ts tests/browser/performance.spec.ts
    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm package:mac
    pnpm test:package-smoke

Expected result: old cache labels remain readable but renderer uses new copy;
restarting migration does not delete protected reviews or create duplicate
attempts; the browser can prepare/open #717, shows `Run review` for #754, and
shows `Reconnect` or `Start again` truthfully for #716. The walkthrough journey
can generate, navigate, mark a section reviewed, create an inline draft, and
return to Files. All static, unit, browser, build, package, and smoke gates
pass.

Why this reduces risk: the fixes are proven against the reported failure
shapes and the real desktop/package boundaries, not only isolated components.

## Concrete Steps

The following steps are the executable order. Work from
`/Users/kwanpham/Work/cfw/patchdesk`. Preserve unrelated dirty files, including
the existing `app-shell.tsx`, `.agents/tasks/codex-subscription-provider/`,
`.agents/tasks/narrative-walkthrough/` source/research files, and
`tests/renderer/app-shell.ui.test.tsx` changes. Stage only explicit paths.

### Step 0: Build and accept the complete Design baseline

Do this before changing production routes, services, storage, workflows, or
Electron composition. Work only in `src/design/`, the shared renderer copy map,
and Design browser tests. Compose the temporary walkthrough comparison from
existing UI primitives; it has deterministic fixture data and no bridge call,
filesystem access, GitHub access, or model request.

1. Create `walkthrough-ready-rail` and `walkthrough-ready-linear` temporary
   comparison scenarios over the same fixture. Capture both and record the
   selected reading layout in the Decision Log.
2. Remove the rejected comparison. Register the 22 permanent scenarios listed
   in Milestone 0, including all five walkthrough lifecycle scenarios.
3. Wire `settings-recovery` to the Settings overlay fixture in
   `src/design/main.tsx`; do not retain `settings-default` as a second final
   Settings reference.
4. Make Design recovery fixtures display-safe and use the shared copy map. Make
   Design walkthrough fixtures show the read-only generation dialog, progress,
   selected layout, friendly failure/retry, stale regeneration, Support, and
   Back to files.
5. Extend `tests/browser/design.spec.ts` to visit every permanent scenario,
   capture its screenshot, fail on console errors, and assert visible UI omits
   `session`, `attempt`, `quarantine`, `worktree`, `runtime`, and raw error
   terms.

Run from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test:design

Expected result: the comparison screenshots identify the chosen walkthrough
layout; the Decision Log records that choice; all 22 permanent scenarios build,
open, and capture successfully in `test-results/`. Do not begin Step 1 until
that evidence is recorded. Any later production UI divergence requires a new
Design scenario, screenshot, and Decision Log entry before implementation.

### Step 1: Establish user-safe recovery contracts

Create `src/domain/review-recovery.ts` as a pure decision module. It consumes a
validated durable session, its latest attempt, an optional active preparation
operation, and an optional registry-owned live run. It returns exactly one
`ReviewRecoveryDecision`; it does not return display strings, paths, IDs, or
multiple capability booleans:

    type ReviewRecoveryAction =
      | "run_review"
      | "reconnect"
      | "start_again"
      | "try_again"
      | "prepare_again";

    type ReviewRecoveryDecision =
      | { readonly _tag: "Preparing" }
      | { readonly _tag: "Actionable"; readonly action: ReviewRecoveryAction }
      | { readonly _tag: "Unavailable" };

Keep `ReviewSessionState` focused on the durable snapshot lifecycle. Add
`Interrupted` to `ReviewAttemptState`; redesign the existing
`ReviewPreparationJournal` from cleanup-only evidence into a durable
`ReviewPreparationOperation` reader/writer, rather than inventing overlapping
session states. It records the review identity, safe phase, and terminal
outcome; `activeFor(profileId, sessionId)` returns a parsed active operation to
the projection service. Startup first reconciles preparation operations, then
reconciles attempts, so an abandoned preparation becomes the user-safe
`prepare_again` decision without relaunching work. A journal may be deleted
only after the referenced `session.json` has been parsed and validated.

Add `scanSessionEntries(profileId)` to `ReviewSessionStore`: it returns valid
sessions plus path-safe invalid entry candidates instead of silently skipping
parse failures. `ReviewRecoveryService` quarantines each invalid candidate,
records a diagnostic, and continues scanning so one corrupt entry cannot block
other reviews. Define and test these legal mappings:

- active preparation journal → `Preparing` → “Preparing review”; no button;
- usable snapshot with no active attempt or a discarded attempt → `run_review`
  → “Ready to review” / `Run review`;
- running attempt with a registry-owned run → `reconnect` → “Review in
  progress” / `Reconnect`;
- running attempt without an owned run, or a persisted interrupted attempt →
  `start_again` → “Review was interrupted” / `Start again`;
- failed attempt → `try_again` → “Review couldn’t finish” / `Try again`;
- invalid or quarantined evidence that is safe to rebuild → `prepare_again` →
  “Review needs preparation” / `Prepare again`;
- merged or unavailable review → `Unavailable` and omission from ordinary
  action lists.

Create `src/renderer/src/review-copy.ts` as the sole renderer mapping from
stable action/notice keys to that copy and tone. Replace reads of persisted
`recommendedAction.label`; preserve old labels only in tolerant cache parsing.
Keep `Selected PR`, `PRs`, `HEAD`, `Reviewed HEAD`, `Current HEAD`, `Reviewed
SHA`, `Reasoning`, and `Low`/`Medium`/`High`; never render `session`, `attempt`,
`quarantine`, `runtime`, storage phase, or error category.

Write failing domain-table and renderer-copy tests before implementation. Run:

    pnpm test -- --run tests/renderer/review-copy.test.ts tests/domain/review-recovery.test.ts tests/renderer/maintainer-inbox.ui.test.tsx

### Step 2: Serialize safe cleanup and review lifecycle mutation

Create `src/services/review-lifecycle-gate.ts`. The composition root owns one
gate instance; preparation start/reconciliation, review-run creation, attempt
completion/failure persistence, migration/quarantine, and both cleanup commands
enter `withProfileLock(profileId, operation)`. Hold the lock through state
classification and filesystem/worktree mutation so a newly started review
cannot be deleted after a stale pre-check. The long-running Flue process runs
outside the lock, but completion/failure re-enters it and applies its durable
transition only when the attempt is still current. The Electron single-instance
guard prevents a second application process; this gate structurally serializes
concurrent requests within that process.

In `src/adapters/storage/review-artifact-storage.ts`, add idempotent,
path-checked `removeSession(profileId, sessionId)` and
`removeQuarantined(profileId, entryName)`. Parse identifiers and entry names,
resolve them beneath their app-owned root, and reject any path that escapes the
root. Do not accept renderer-supplied paths.

In `src/services/storage-management-service.ts`, perform `clearCache` and
`clearLocalData(profileId)` inside the profile lock. Re-list and classify
records after acquiring the lock. `Clear cache` removes only unprotected
rebuildable cache; `Clear local review data` additionally removes discarded,
quarantined, and older-version evidence. Both preserve every review a user can
open, resume, retry, or prepare, plus diagnostics. Prune Git registrations only
after successful cache removal. Missing disposable entries are success; a
partial filesystem or Git failure is a typed failure whose retry reruns the
same safe classification.

Add behavior tests for lock ordering, a run that races cleanup, discarded and
quarantined removal, protected records, malformed names, missing entries, and
partial retry. Run:

    pnpm test -- --run tests/services/review-lifecycle-gate.test.ts tests/services/storage-management-service.test.ts tests/storage

### Step 3: Deliver the global Settings overlay and friendly cleanup controls

Use only the local shadcn/Base UI wrappers under
`src/renderer/src/components/ui/`; do not fetch or introduce a parallel modal,
form, tabs, scroll, or confirmation primitive.

In `src/renderer/src/app.tsx`, replace Settings navigation with independent
`settingsOpen` and opener-focus state. Opening from the gear, `⌘,`, or Navigate
must not change `AppDestination` or clear a workbench. Normalize the legacy
`destination.kind === "settings"` route to the overlay over a safe fallback,
then delete the route and app-shell overflow special case once callers migrate.
`settings-modal.tsx` always begins on General, owns a labelled scroll region,
traps focus, returns it to the opener, and opens a dirty-draft dialog on Escape,
close, or profile switch. A dirty draft compares the current form with its last
loaded/saved baseline; Save failure keeps the draft, validation error, and
focus in the modal; Cancel changes nothing.

Keep Review preferences in Settings as profile-scoped defaults for model and
reasoning. They never start work. Move Watchlist controls out of Settings.

Data & recovery has exactly two actions and no storage list or internal
terminology. Use this exact confirmation copy:

- **Clear cache?** — “This removes rebuildable local files. Your saved reviews
  and diagnostic reports stay.” Confirm: `Clear cache`.
- **Clear local review data?** — “This removes discarded and unusable local
  review data. Reviews you can still open or resume, and diagnostic reports,
  stay.” Confirm: `Clear local data`.

Both dialogs disable their controls while pending, retain the explanation and a
retryable error after failure, and close only on success.

In `src/main/local-api.ts`, add `POST /v1/storage/clear-local-data` with
`{ profileId }`. Retain `POST /v1/storage/cache/clear`. After all callers and
tests migrate, delete `GET /v1/storage`, `POST /v1/storage/discard`, and
`POST /v1/storage/quarantine/delete`; update the actual route allowlist in
`src/main/desktop-bridge.ts` and the authorization tests in the same change.

Run:

    pnpm test -- --run tests/renderer/profile-settings.test.tsx tests/renderer/app-shell.ui.test.tsx tests/desktop-bridge.test.ts tests/local-api-auth.test.ts

### Step 4: Project friendly recovery and safe diagnostics

Modify `src/services/review-workbench-projection.ts` to consume the existing
`ReviewRunRegistry`, the preparation-operation reader, and
`ReviewRecoveryDecision`. Wire those dependencies from the composition root.
Do not persist `runId`; do not infer actionability from `currentAttemptId`.
Project only a display-safe recovery DTO: a neutral/positive/warning/destructive
tone, a renderer-mapped notice key, and zero or one action key. The HTTP and
renderer contracts reject any path, raw failure, operation/attempt identifier,
or internal state field.

Modify `src/renderer/src/renderer-models.ts`,
`src/renderer/src/renderer-contracts.ts`,
`src/renderer/src/flows/prepared-review-flow.tsx`, and
`src/renderer/src/components/safe-run-panel.tsx` to render the Step 1 copy
matrix. Remove “This review is not running”, “may still be running in the
background”, Agent, Mode, and Access. Model and Reasoning remain optional
review context, not recovery diagnostics.

Create `src/domain/review-diagnostic.ts` and
`src/services/review-diagnostic-service.ts`. Store bounded redacted JSONL
inside app-owned review data. Events can retain internal category, phase,
identifiers, timing, retryability, and a redacted detail for support; ordinary
UI sees only a concise failure message and an optional `Copy incident ID` or
`Export support bundle` action. The bundle contains recent sanitized events and
sanitized review metadata, never credentials, complete diffs, raw stack traces,
untrusted PR text, or absolute paths. Record preparation, run, recovery,
migration, cleanup, and walkthrough boundary failures.

Add tests in `tests/services/review-workbench-projection.test.ts`,
`tests/services/review-run-coordinator.test.ts`,
`tests/services/review-diagnostic-service.test.ts`,
`tests/services/review-session-preparation.test.ts`, and
`tests/services/review-failure-service.test.ts` for every copy/action mapping,
redaction, bundle contents, orphan reconciliation, and no-internal-field
renderer projection. Run the focused Milestone 3 suite.

### Step 5: Define the walkthrough domain and raw patch filter

Create `src/domain/narrative-walkthrough.ts` with a snapshot type:

    type NarrativeSnapshot = {
      readonly profileId: WorkspaceProfileId;
      readonly sessionId: ReviewSessionId;
      readonly headSha: GitSha;
      readonly patchHash: ContentHash;
    };

Expose `normalizeNarrativeWalkthrough(raw, patch, snapshot)` and
`filterNarrativePatchToHunks(patch, hunkIds)`. Use stable request-local aliases
in parsed patch order. Bound title/prose/chapter/section/hunk sizes. Preserve
the first valid hunk placement; remove unknown, duplicate, and overlapping
references; reject output with no valid primary section; derive Support from
all remaining parsed hunks. Preserve original file headers and raw `@@` blocks
in source order, then reparse; never mutate parsed Pierre metadata.

Create `tests/domain/narrative-walkthrough.test.ts` for one-file and two-file
coverage, non-contiguous hunk filtering, unknown/duplicate references, bounds,
overlap, and stale snapshot identity. Run:

    pnpm test -- --run tests/domain/narrative-walkthrough.test.ts tests/domain/review-domain.test.ts

### Step 6: Add the finite Flue workflow and adapter

Create `src/workflows/generate-walkthrough.ts` with a strict input schema
containing profile/session IDs, patch/context paths supplied by main, selected
model, and `low`/`medium`/`high` reasoning. Prompt for a small semantic
sequence: explain behavior before consequences/tests, use aliases exactly,
and put mechanical or low-signal changes in Support. Scale targets to hunk
count and cap timeout by input size with a hard maximum.

Create `src/services/flue-cli-walkthrough-invoker.ts` around the fixed argv:

    [runtimeExecutable, cliPath, "run", "workflow:generate-walkthrough", "--input", JSON.stringify(input)]

The invoker has its own input/result types and never imports
`ReviewCompletionService`, `ReviewFailureService`, or the review invoker.
Parse only terminal JSON through the raw schema. Keep stderr and event output
inside the main process. Accept caller-owned cancellation in a final options
object; classify cancellation before ordinary execution failure. Return
`execution_failed`, `cancelled`, or `invalid_result`, never model prose. Test
the fixed command, output parsing, timeout/cancellation, isolation from review
persistence, and existing review command non-regression in
`tests/services/flue-cli-walkthrough-invoker.test.ts`.

Run:

    pnpm test -- --run tests/services/flue-cli-walkthrough-invoker.test.ts tests/services/flue-cli-review-invoker.test.ts

### Step 7: Add snapshot-bound service and local API

Create `src/services/narrative-walkthrough-service.ts` with an in-memory record
per profile/session. `generate` loads the session and patch only in main,
requires a completed stable snapshot, hashes the patch before invocation and
before publishing, and increments a generation token for every request or
retry. A late completion publishes only when token and snapshot still match.
`load` returns `stale` when the stored hash/head differs. Do not mutate session,
attempt, draft, or GitHub state.

Add a distinct `walkthroughs: NarrativeWalkthroughService` dependency to the
`LocalApiConfiguration` seam in `src/main/local-api.ts`; its two authenticated
routes call only that dependency, never the review workflow invoker. In
`src/main/electron-main.ts`, build it through a dedicated
`createWalkthroughInvoker()` composition path that constructs only
`FlueCliWalkthroughInvoker` and `NarrativeWalkthroughService`; it must not
construct or invoke review completion/failure persistence. Add matching
`src/main/desktop-bridge.ts` allowlist entries. Request bodies contain only
profile/session/model/reasoning. Return 400/404/409/503
mappings described in Milestone 6. Include a display-safe lifecycle projection
and optional incident ID, never patch paths, internal state names, or raw
errors.

Test `tests/services/narrative-walkthrough-service.test.ts` for stale-result
suppression, retry, invalid output, missing session, patch mutation, and
generation isolation. Extend `tests/local-api-auth.test.ts` for capability,
origin, input validation, and error mapping. Run the Milestone 6 command.

### Step 8: Add renderer contracts, explicit generation dialog, and takeover

Extend renderer parsing with a strict discriminated walkthrough lifecycle and
the recovery projection. Reject malformed hunk IDs, paths, line ranges, and
snapshot identities at the boundary.

In `src/renderer/src/flows/completed-review-flow.tsx`, add the manual
`Generate walkthrough` action to the completed stable snapshot only. Fetch
`/v1/reviews/models`, restore the existing per-profile execution preference
when still enabled, and show `Model` and `Reasoning` controls before the
request. The confirm button says `Generate read-only walkthrough`. Use the
existing `requestJson` helper, ignore responses for an unmounted or changed
session, and show `Retry generation` for failed/invalid output or `Generate
walkthrough` for stale snapshots. Do not auto-request from an effect.

Create `src/renderer/src/components/narrative-walkthrough.tsx` with local
`currentSectionId` and `reviewedSectionIds`. Render focus, a labelled chapter
rail, section prose, exact hunk groups, Support, Reviewed controls, and a
persistent `Back to files` button. `ArrowLeft`/`ArrowRight` and `j`/`k` move to
the previous/next enabled section only when focus is inside the takeover and
not in an input, textarea, select, or code annotation editor. At either end,
the key is a no-op and the previous/next control is disabled. After a keyboard
move, focus the new section heading; Escape returns focus to `Back to files`
without closing the takeover. `Back to files` restores focus to the Files-mode
control that opened it. Create `narrative-walkthrough-diff.tsx` to call the raw
patch filter and render reparsed Pierre blocks with existing view preferences
and draft annotations. Use unique block IDs when a file appears in multiple
sections.

Add `walkthroughOpen` only to `CompletedReviewWorkbench`; opening it must not
write `selectedPath`, `activePath`, collapsed paths, passive scroll-follow,
inspector selection, current diff surface, or review-view preferences. `Back to
files` only closes takeover state.

Use existing batch actions for inline comments:

    updateBatch({
      _tag: "AddInlineComment",
      anchor: { path, startLine, line, side },
      body,
    });

Do not add a walkthrough comment store, mutate `ReviewDiffView`'s virtual
stream, or shallow-filter Pierre hunk metadata.

Add tests in `tests/renderer/renderer-contracts.test.ts`,
`tests/renderer/narrative-walkthrough.ui.test.tsx`,
`tests/renderer/narrative-walkthrough-diff.test.tsx`,
`tests/renderer/completed-review-flow.ui.test.tsx`,
`tests/renderer/docked-diff-state.ui.test.tsx`, and existing workbench suites.
The tests must prove no request before click, model/reasoning selection,
generating/ready/failed/stale states, independent progress, Support coverage,
draft parity, keyboard navigation, and return-state preservation.

Run:

    pnpm test -- --run tests/renderer/renderer-contracts.test.ts tests/renderer/completed-review-flow.ui.test.tsx tests/renderer/narrative-walkthrough.ui.test.tsx tests/renderer/narrative-walkthrough-diff.test.tsx tests/renderer/docked-diff-state.ui.test.tsx

### Step 9: Migrate local state and cover reported scenarios

Update `src/adapters/storage/maintainer-inbox-cache-store.ts` to accept old
action labels and normalize them to action kinds before renderer presentation.
Update `src/adapters/storage/review-session-store.ts`,
`src/services/review-recovery-service.ts`, and
`src/services/review-preparation-journal.ts` with an explicit version marker.
The migration must preserve the existing review-session snapshot model, add
only the `Interrupted` attempt transition and preparation-operation journal
needed by Step 1, convert old-process active attempts to interrupted, make
discarded sessions eligible for new attempts, quarantine invalid sessions with
diagnostics, and be safe to rerun after partial failure. Persisted technical
states are mapped to the Step 1 decision before any renderer projection; do not
add them to API copy or browser fixtures.

Add fixtures/tests in:

    tests/storage/maintainer-inbox-cache-store.test.ts
    tests/storage/review-session-store-begin-attempt.test.ts
    tests/services/review-recovery-service.test.ts
    tests/services/review-preparation-journal.test.ts

Update `tests/browser/milestone-5.spec.ts` for prepare/open/recovery actions and
`tests/browser/milestone-9.spec.ts` for Settings and walkthrough flows. Use
deterministic fixtures for the three reported PR states
when live GitHub data is unavailable:

1. PR #717 has invalid local data and can be prepared again without blocking
   another PR.
2. PR #754 opens its prepared snapshot and exposes `Run review` when the prior
   attempt is discarded or absent.
3. PR #716 reports `Reconnect` only when the current process owns the run;
   otherwise it reports `Start again`, never “not running” with a background
   guess.

Walkthrough browser proof must click Generate, select model/reasoning, wait for
ready, navigate sections, mark one reviewed, create an inline draft, click Back
to files, and verify Files state remains intact. Assert no generation request
occurs on workbench open. Keep the existing 1,000-file selection performance
ceiling below 200 ms.

Settings browser proof must open the centered modal from dashboard, inbox, and
workbench; assert General is the first section every time; change appearance
without changing the underlying route; switch a clean profile immediately;
exercise dirty-draft Save/Discard/Cancel; scroll a long Workspace section
without scrolling the page behind it; and run both Data & recovery
confirmations.

Extend `tests/browser/accessibility.spec.ts` with axe checks for the Settings
modal and walkthrough takeover. Assert the modal has an accessible name,
initial focus, focus trap, focus return, and a labelled independently scrollable
region; assert the walkthrough rail, section headings, Reviewed controls,
disabled previous/next controls, key bindings, editor exclusion, and `Back to
files` focus return. Run `pnpm test:a11y` after those fixtures are added; the
existing dashboard/workbench-only accessibility suite is not evidence for these
new surfaces.

### Step 10: Run full verification and packaged QA

From `/Users/kwanpham/Work/cfw/patchdesk`, run the required desktop order:

    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm test:design
    pnpm exec playwright test
    pnpm test:a11y
    pnpm package:mac
    pnpm test:package-smoke

Before any interactive packaged-app verification, use a dedicated tester
subagent as required by `AGENTS.md`. The tester launches
`release/mac-arm64/Patchdesk.app/Contents/MacOS/Patchdesk` with an isolated
user-data directory and remote debugging port, uses `agent-browser` over CDP,
and returns screenshots/evidence for recovery actions, centered Settings modal
entry/scroll/profile switching, cleanup controls, walkthrough generation,
inline drafting, and Back to files.
The primary agent must not drive the live packaged UI.

Finally run:

    git diff --check
    git status -sb

Confirm unrelated dirty files remain untouched. Record any inaccessible live
PR data or tester/packaged-environment blocker in `Surprises & Discoveries`
and the final verification report rather than claiming the behavior was
verified.

## Validation and Acceptance

Acceptance is behavioral:

- Opening one invalid local review does not prevent a healthy review from
  opening. Invalid data is preserved internally, diagnosed, omitted from normal
  lists, and presented as `Needs preparation` when preparation is safe.
- A durable `currentAttemptId` or missing process-local `runId` never decides
  whether `Run review` is shown. Reconnect appears only for a registry-owned
  live run. Interrupted and failed attempts expose a truthful next action.
- Every visible error has an action or is intentionally omitted from ordinary
  lists. Ordinary UI shows only concise action copy and, where needed, an
  incident ID; category, phase, timestamps, and other technical evidence stay
  inside the sanitized support bundle. No raw stack trace, credential, path,
  full diff, or untrusted PR text leaks.
- Settings opens as a centered modal from any supported route, always starts on
  General, preserves the underlying route, and scrolls independently. Theme
  changes apply immediately; clean profile switching applies immediately;
  dirty profile drafts require Save, Discard, or Cancel. Settings uses only
  existing shadcn/Base UI components and local composition rules.
- Settings contains no saved-review lists, older-version lists, Discard, or
  quarantine controls. Its two confirmation dialogs use the exact Step 3 copy;
  `Clear cache` retains saved reviews and diagnostics, while `Clear local
  review data` removes only disposable local review data and retains every
  review a user can still open, resume, retry, or prepare.
- Generate walkthrough is manual, available for a prepared snapshot with a
  stable stored patch, and preceded by model/reasoning selection. Opening or completing a
  review does not call the generation API.
- Normalized walkthrough output has bounded prose and covers every source hunk
  exactly once across primary sections and Support. Unknown, duplicate,
  overlapping, stale, or malformed references fail closed.
- Focused takeover progress is independent from Files viewed state. Pierre
  receives reparsed bounded patches, current diff preferences, and existing
  annotations. Inline drafts use the existing batch store and GitHub-write
  confirmation boundary.
- Back to files restores prior explicit selection, passive follow state,
  inspector state, and diff controls. The 1,000-file selection test remains
  below 200 ms.
- Static, unit, browser, build, package, smoke, and dedicated tester evidence
  are recorded with exact commands and outcomes.

## Idempotence and Recovery

All filesystem deletion uses app-owned, path-checked roots. Removing a missing
disposable entry is success. A partial cleanup reports failure and can be
retried; it never claims success after a failed filesystem or Git operation.
Running/preparing/recoverable records are classified at operation execution
time, so a state change during an earlier Settings render cannot cause unsafe
deletion.

Startup and load reconciliation is idempotent. Re-running migration never
deletes protected records, duplicates attempts, or re-quarantines an already
quarantined entry. A stranded preparation journal becomes a recoverable
interrupted/preparation state without relaunching a workflow.

Walkthrough generation is retry-safe. Every request receives a new generation
token; late results are ignored when a newer request exists or when patch hash,
HEAD, profile, or session identity changed. A stale record is discarded from
the renderer and the user is offered generation for the current snapshot.
Walkthrough state is in memory only, so application restart or local-data
cleanup cannot leave a durable narrative explaining a different patch.

If a focused test fails, keep the failing fixture, update `Surprises &
Discoveries`, and fix the smallest owning layer. Do not relax capability/origin
guards, renderer sandboxing, path checks, or the performance ceiling to make a
test pass.

Settings is safe to reopen and close repeatedly. Global preference writes are
idempotent; profile selection reloads from the selected profile rather than
merging stale in-memory data. A failed profile save leaves the draft available
for correction. A modal crash or reload cannot change the underlying route.

## Artifacts and Notes

The source packet remains available at:

- `.agents/tasks/narrative-walkthrough/00-sources.md`
- `.agents/tasks/narrative-walkthrough/01-research-patchdesk.md`
- `.agents/tasks/narrative-walkthrough/02-research-codiff.md`
- `.agents/tasks/narrative-walkthrough/03-research-plannotator.md`
- `.agents/tasks/narrative-walkthrough/04-research-pierre.md`
- `.agents/tasks/narrative-walkthrough/spec.md`
- `docs/superpowers/specs/2026-07-26-review-recovery-observability-design.md`
- `docs/superpowers/specs/2026-07-26-settings-redesign-design.md`

The superseded recovery plan remains at
`docs/superpowers/plans/2026-07-26-review-recovery-observability.md` as the
historical source for the consolidated workstream. This file is the execution
source of truth for the combined recovery, Settings, and narrative work. The
PR-description design remains a separate spec and is not implemented by this
plan. Update this file if an in-scope implementation decision changes.

At each milestone, append concise evidence here or in the relevant test
artifact: command, working directory, result, and any blocker. Do not paste
secrets, raw diffs, local paths from user machines, or full model output.

## Interfaces and Dependencies

The implementation must end with these boundaries:

- `src/domain/review-recovery.ts` exports the pure one-action
  `ReviewRecoveryDecision`; `src/services/review-workbench-projection.ts`
  consumes `ReviewRunRegistry.find(owner)` and the preparation reader, then
  emits only display-safe notice, tone, and optional action fields.
- `src/domain/review-diagnostic.ts` and
  `src/services/review-diagnostic-service.ts` provide bounded redacted local
  diagnostic events, incident IDs, and sanitized support-bundle export; normal
  UI receives no diagnostic state beyond an optional incident ID.
- `src/services/review-lifecycle-gate.ts` serializes profile lifecycle
  mutations. `src/adapters/storage/review-artifact-storage.ts` owns validated,
  idempotent artifact removal; `src/services/storage-management-service.ts`
  owns retention classification and `clearLocalData(profileId)` inside that
  gate.
- `src/main/local-api.ts` exposes only authenticated, origin-bound
  `POST /v1/storage/clear-local-data`, `POST /v1/storage/cache/clear`,
  `POST /v1/reviews/walkthrough/generate`,
  `POST /v1/reviews/walkthrough/load` for the new flows. Obsolete Settings-only
  routes are gone after migration.
- `src/renderer/src/app.tsx` owns independent `settingsOpen` and opener-focus
  state. `src/renderer/src/components/settings-modal.tsx` owns the centered
  global overlay, General-first section state, focus return, dirty-close guards,
  and bounded scrolling. It composes existing shadcn/Base UI wrappers
  from `src/renderer/src/components/ui/`; it does not create a parallel UI
  primitive system.
- `src/renderer/src/flows/settings-flow.tsx` and focused section components own
  profile/workspace forms, immediate global preference updates, profile switch
  reload, GitHub access test, and the two cleanup actions. Watchlist remains in
  its dedicated surface.
- `src/domain/narrative-walkthrough.ts` exports
  `NarrativeSnapshot`, bounded normalized walkthrough types,
  `normalizeNarrativeWalkthrough`, and `filterNarrativePatchToHunks`.
- `src/workflows/generate-walkthrough.ts` owns the read-only structured-output
  schema and prompt; `src/services/flue-cli-walkthrough-invoker.ts` owns the
  fixed Flue command, caller-owned cancellation, and terminal-output parsing.
  It is a separate dependency graph from review completion/failure persistence.
- `src/services/narrative-walkthrough-service.ts` owns snapshot binding,
  generation tokens, normalization, stale suppression, in-memory lifecycle,
  and diagnostic recording.
- `src/renderer/src/renderer-contracts.ts` rejects unsafe recovery and
  walkthrough projections. `CompletedReviewFlow` owns model/reasoning
  selection and API calls. `CompletedReviewWorkbench` owns takeover visibility
  without changing Files-mode state.
- `src/renderer/src/components/narrative-walkthrough-diff.tsx` renders only
  reparsed, bounded raw patches through Pierre and routes comments through the
  existing `AddInlineComment` batch command.
- Dependencies remain the existing TypeScript, React, Valibot, Hono, Flue,
  Pierre, `@base-ui/react` through the local shadcn wrappers, Vitest, Testing
  Library, Playwright, and Electron toolchain. Do not add a new persistence
  store, public review API, model provider, custom modal/form/scroll primitive,
  or GitHub write path for these features.

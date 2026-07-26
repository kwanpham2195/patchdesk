# Review recovery and narrative walkthrough implementation

This ExecPlan is a living implementation specification. Keep `Progress`,
`Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective`
current as work proceeds. It consolidates the recovery and observability plan
from `docs/superpowers/plans/2026-07-26-review-recovery-observability.md` with
the narrative walkthrough feature packet in this directory. The walkthrough
must be implemented against the recovery model described here; neither plan is
an independent replacement for the other.

## Purpose / Big Picture

After this work, a maintainer can open a PR even when another PR has damaged
local review data. Patchdesk will show honest, actionable states: `Run review`,
`Reconnect`, `Start again`, `Try again`, or `Prepare again`. It will not guess
that a review is running from a missing process-local run handle, and it will
not expose quarantine folders, worktrees, attempts, runtime names, or file
paths in ordinary UI.

Settings will have two global local-data operations: `Clear cache` and `Clear
local review data`. The first removes rebuildable cache while retaining review
records and diagnostics. The second removes discarded, quarantined, and
older-version local review data while retaining running and recoverable
reviews. Both operations are explicit, idempotent, retryable, and unrelated to
GitHub writes.

Once a review has a stable completed snapshot, the maintainer can explicitly
choose `Generate walkthrough`. A model-and-reasoning dialog appears before any
work starts. A new finite Flue workflow creates bounded semantic sections from
the stored patch. The main process validates the result against that exact
snapshot, assigns every unmentioned hunk to Support, and exposes only a safe
projection to the renderer. A focused takeover lets the maintainer read
sections, mark walkthrough sections reviewed, and create the same inline draft
comments available in Files mode. `Back to files` restores the existing file
selection, passive follow state, inspector state, and diff preferences.

The user-visible proof is one local review workbench containing truthful
recovery actions, two simple Settings controls, and a manually requested
narrative takeover. Generation never starts after a review run completes or
merely because a snapshot is opened.

## Progress

- [x] 2026-07-26 — Existing recovery/observability and narrative walkthrough research and specs are available in the repository.
- [x] 2026-07-26 — The recovery implementation plan and narrative implementation plan were reconciled into this ExecPlan.
- [ ] Implement the recovery domain, storage cleanup, copy contract, and diagnostics.
- [ ] Implement the snapshot-bound walkthrough domain, Flue workflow, main-process service, and authenticated API.
- [ ] Implement the renderer dialog, focused takeover, Pierre hunk surface, and draft parity.
- [ ] Run focused tests, the full desktop gate, browser coverage, packaged smoke, and dedicated packaged UI QA.
- [ ] Update this section and `Outcomes & Retrospective` after every milestone.

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
  choose to read a completed snapshot; automatic generation would add cost,
  latency, and an unrequested model action. Date/Author: 2026-07-26, narrative
  walkthrough specification.

- Decision: Add recovery capabilities to renderer projections rather than
  deriving actions from `currentAttemptId` or `runId`. Rationale: those fields
  are historical or process-local linkage, not truth about user actionability.
  Date/Author: 2026-07-26, recovery/observability specification.

## Outcomes & Retrospective

Implementation has not started. At each completed milestone, record the
observable proof, commands run, failures or compromises, and whether the next
milestone still has the same dependencies. At completion, record any remaining
live-data or packaged-app limitations instead of claiming unverified PR
scenarios.

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
explicit recovery capabilities. The existing `ReviewRunRegistry` already
supports `find(owner)`. The existing `SafeRunPanel` treats a missing `runId` as
“not running,” which is the behavior being removed.

The narrative walkthrough is a read-only reading mode over one completed,
stored patch. The model receives bounded aliases for parsed patch hunks, never
invents paths or line numbers, and returns structured JSON. The main process
normalizes it. The renderer never renders raw model output.

## Plan of Work

Implement the work in this order:

1. Establish the renderer copy contract and recovery/storage domain contracts.
2. Implement safe artifact removal, global Settings cleanup, and route
   migration.
3. Project explicit recovery state, persist diagnostics, and reconcile old
   local data without relaunching workflows.
4. Define and test the snapshot-bound walkthrough domain and raw-patch hunk
   filtering.
5. Add the isolated Flue workflow and fixed-command adapter.
6. Add the main-process walkthrough service, authenticated API, and production
   runtime wiring.
7. Add strict renderer contracts, explicit model/reasoning selection, and the
   manual Generate walkthrough entry point.
8. Add the focused takeover and reparsed Pierre blocks without changing Files
   mode.
9. Migrate persisted/cache data, run the end-to-end/browser/package gates, and
   obtain dedicated packaged UI evidence.

Recovery work is a prerequisite for narrative work, but it does not start
walkthrough generation. The narrative API must reject any session whose
prepared patch or snapshot identity is unavailable, stale, or not a completed
read-only snapshot.

## Milestones

### Milestone 1 — Honest contracts and safe local-data ownership

Goal: establish stable presentation labels, typed recovery states, and
path-checked cleanup behavior before changing UI.

Work: add the renderer-only copy map; add `ReviewRecoveryState` and
`ReviewRecoveryCapabilities`; add idempotent removal methods and
`StorageManagementService.clearLocalData(profileId)`.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/review-copy.test.ts tests/services/storage-management-service.test.ts tests/domain/review-recovery.test.ts

Expected result: the new focused tests pass; action labels are selected by
action kind rather than persisted display text; discarded/quarantined data can
be removed; running and recoverable sessions remain.

Why this reduces risk: later route and renderer changes consume explicit
contracts rather than duplicating cleanup rules or guessing state from storage
details.

### Milestone 2 — Settings cleanup and route migration

Goal: simplify Settings to two global actions and remove the per-review
management surface.

Work: replace storage overview state in `settings-flow.tsx`; add
`POST /v1/storage/clear-local-data`; retain
`POST /v1/storage/cache/clear`; remove old Settings-only overview/discard/
quarantine-delete routes after callers and allowlist tests migrate.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/renderer/profile-settings.test.tsx tests/desktop-bridge.test.ts tests/local-api-auth.test.ts

Expected result: Settings renders only `Clear cache` and `Clear local review
data`, each with explicit confirmation; failures keep the confirmation context
open for retry; old routes are rejected or no longer exposed.

Why this reduces risk: the cleanup policy becomes global, explicit, and
testable without allowing users to manage internal session/quarantine records.

### Milestone 3 — Truthful recovery and bounded diagnostics

Goal: make open/run/reconnect/retry behavior reflect durable state and owned
process state, and preserve enough redacted evidence to debug failures.

Work: inject `ReviewRunRegistry` into
`ReviewWorkbenchProjectionService`; project recovery state and capabilities;
make `PreparedReviewFlow` and `SafeRunPanel` use those capabilities; add
`ReviewDiagnosticEvent` and a bounded JSONL diagnostic service; reconcile
stranded preparation journals and prior-process attempts as interrupted.

Commands from `/Users/kwanpham/Work/cfw/patchdesk`:

    pnpm test -- --run tests/domain/review-recovery.test.ts tests/services/review-workbench-projection.test.ts tests/services/review-run-coordinator.test.ts tests/services/review-diagnostic-service.test.ts tests/renderer/prepared-review-flow.ui.test.tsx tests/renderer/safe-run-panel.ui.test.tsx

Expected result: ready/discarded sessions show `Run review`; owned live runs
show `Reconnect`; unowned running attempts show `Start again`; failed attempts
show `Try again`; invalid preparation shows `Prepare again`; no copy says a
review may still be running merely because an attempt pointer exists. Diagnostic
events contain incident IDs and redacted details without credentials, full
diffs, or absolute paths.

Why this reduces risk: walkthrough generation will only be enabled for a
truthful, stable completed snapshot and will inherit the same safe lifecycle
projection.

### Milestone 4 — Snapshot-bound walkthrough domain

Goal: make model output fail closed and guarantee that every source hunk is
visible exactly once.

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

Work: create `src/services/narrative-walkthrough-service.ts`; add
`POST /v1/reviews/walkthrough/generate` and
`POST /v1/reviews/walkthrough/load` in `src/main/local-api.ts`; add production
invoker wiring in `src/main/electron-main.ts`; update preload route allowlists.
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

### Milestone 9 — Migration, browser proof, and packaged evidence

Goal: prove the complete user journey and retire ambiguous old local state.

Work: add tolerant cache parsing and versioned, idempotent session migration;
convert stranded attempts to interrupted; quarantine invalid sessions with
diagnostics; normalize discarded sessions to fresh-attempt eligibility; remove
renderer action decisions based on `currentAttemptId`; add browser fixtures for
PR #717, #754, and #716 scenarios; preserve the 1,000-file selection ceiling.

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

### Step 1: Establish copy and recovery contracts

Create `src/renderer/src/review-copy.ts` with functions such as
`reviewActionLabel(kind)` and `reviewStatusLabel(status)`. Map action kinds to
`Run review`, `Review updates`, `View review`, `Open merge readiness`, `Review
author response`, and `Inspect failing checks`. Keep domain/cache labels
unchanged. Replace renderer reads of `row.recommendedAction.label` with the
map. Keep `Selected PR`, `PRs`, `HEAD`, `Reviewed HEAD`, `Current HEAD`,
`Reviewed SHA`, `Reasoning`, and `Low`/`Medium`/`High`; remove `pull request`
from compact labels and do not introduce `session`, `attempt`, `agent`, or
`runtime` copy.

Create `src/domain/review-recovery.ts` with:

    type ReviewRecoveryState =
      | "preparing" | "ready" | "running" | "completed"
      | "failed" | "interrupted" | "needs_preparation";

    type ReviewRecoveryCapabilities = {
      readonly canRun: boolean;
      readonly canReconnect: boolean;
      readonly canRetry: boolean;
      readonly canPrepare: boolean;
    };

The pure mapper must map `Running + registry hit` to reconnectable running,
`Running + no registry hit` to interrupted/start-again, failed attempts to
retryable failed, and quarantined/invalid records to needs-preparation. A
merged or otherwise unavailable review has no run capability and is omitted
from ordinary action lists.

Write tests before implementation. Run:

    pnpm test -- --run tests/renderer/review-copy.test.ts tests/domain/review-recovery.test.ts tests/renderer/maintainer-inbox.ui.test.tsx

### Step 2: Own safe artifact deletion and local-data cleanup

In `src/adapters/storage/review-artifact-storage.ts`, add idempotent,
path-checked `removeSession(profileId, sessionId)` and
`removeQuarantined(profileId, entryName)`. Validate identifiers and quarantine
names against app-owned roots before deletion. Do not accept arbitrary paths.

In `src/services/storage-management-service.ts`, add
`clearLocalData(profileId)`. At execution time protect `preparing`, `running`,
`ready`, `completed`, `failed`, `interrupted`, and `stale` records. Remove only
discarded records, quarantined/older-version evidence, and unprotected
rebuildable cache worktrees. Prune Git worktree registrations only after
successful cache removal. Keep `clearCache` protection for running sessions
and recorded-running operations. Missing disposable entries count as already
clean; partial failure returns an error and remains safe to retry.

Add tests for discarded removal, quarantine removal, protection, malformed
names, missing entries, and partial retry. Run:

    pnpm test -- --run tests/services/storage-management-service.test.ts tests/storage

### Step 3: Replace Settings controls and migrate routes

In `src/renderer/src/flows/settings-flow.tsx`, remove saved-review lists,
older-version lists, per-review Discard, quarantine deletion, and storage
overview parsing. Keep one `Local review data` card with `Clear cache` and
`Clear local review data`. Confirmations state exactly what each preserves or
removes. Disable while pending and close only after success.

In `src/main/local-api.ts`, add `POST /v1/storage/clear-local-data` with
`{ profileId }`. Keep `POST /v1/storage/cache/clear`. Remove `GET /v1/storage`,
`POST /v1/storage/discard`, and `POST /v1/storage/quarantine/delete` after all
renderer callers and tests migrate. Update the desktop bridge allowlist and
authorization tests. Do not remove the service methods until no caller or test
needs them; delete obsolete paths rather than leaving misleading shims.

Run:

    pnpm test -- --run tests/renderer/profile-settings.test.tsx tests/desktop-bridge.test.ts tests/local-api-auth.test.ts

### Step 4: Project truthful recovery and diagnostics

Modify `src/services/review-workbench-projection.ts` to accept the existing
`ReviewRunRegistry` and add recovery state/capabilities to
`WorkbenchSessionProjection`. Wire the same registry from `src/main/local-api.ts`.
Do not persist `runId`; do not infer actionability from
`currentAttemptId === undefined`.

Modify `src/renderer/src/renderer-models.ts`,
`src/renderer/src/renderer-contracts.ts`,
`src/renderer/src/flows/prepared-review-flow.tsx`, and
`src/renderer/src/components/safe-run-panel.tsx` so actions use capabilities.
Remove “This review is not running” and “may still be running in the
background.” Use `Starting review`, `Reviewing`, `Review complete`, `Review
failed`, `Connection lost`, `Review interrupted`, `Reconnect`, `Start again`,
and `Try again`. Hide Agent/Mode/Access by default; keep model and Reasoning
under optional details if they help a maintainer.

Create `src/domain/review-diagnostic.ts` and
`src/services/review-diagnostic-service.ts`. Append bounded JSONL under the
app-owned review directory. Events include incident ID, category, phase,
retryable flag, review/operation/attempt identifiers, timestamp, duration, and
redacted detail. Never store credentials, complete diffs, raw stack traces,
untrusted PR text, or absolute paths in renderer responses. Record preparation,
run, recovery, migration, and walkthrough-generation boundary failures.

Add tests in `tests/services/review-workbench-projection.test.ts`,
`tests/services/review-run-coordinator.test.ts`,
`tests/services/review-diagnostic-service.test.ts`,
`tests/services/review-session-preparation.test.ts`, and
`tests/services/review-failure-service.test.ts`. Run the focused suite from
Milestone 3.

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

Parse only terminal JSON through the raw schema. Keep stderr and event output
inside the main process. Return `execution_failed` or `invalid_result` rather
than model prose. Test the fixed command, output parsing, timeout, and
existing review command non-regression in
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

Add authenticated `POST /v1/reviews/walkthrough/generate` and
`POST /v1/reviews/walkthrough/load` in `src/main/local-api.ts`, production
invoker wiring in `src/main/electron-main.ts`, and matching
`src/main/desktop-bridge.ts` allowlist entries. Request bodies contain only
profile/session/model/reasoning. Return 400/404/409/503 mappings described in
Milestone 6. Include the user-safe lifecycle projection and optional incident
ID/recovery message, never patch paths or raw errors.

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
`currentSectionId` and `reviewedSectionIds`. Render focus, chapter rail,
section prose, exact hunk groups, Support, Reviewed controls, bounded
Prev/Next keyboard navigation, and persistent `Back to files`. Create
`narrative-walkthrough-diff.tsx` to call the raw patch filter and render
reparsed Pierre blocks with existing view preferences and draft annotations.
Use unique block IDs when a file appears in multiple sections.

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
The migration must split records/attempts, convert old-process active attempts
to interrupted, make discarded sessions eligible for new attempts, quarantine
invalid sessions with diagnostics, and be safe to rerun after partial failure.

Add fixtures/tests in:

    tests/storage/maintainer-inbox-cache-store.test.ts
    tests/storage/review-session-store-begin-attempt.test.ts
    tests/services/review-recovery-service.test.ts
    tests/services/review-preparation-journal.test.ts

Update `tests/browser/milestone-5.spec.ts` for prepare/open/recovery actions and
`tests/browser/milestone-9.spec.ts` for the walkthrough flow. Use deterministic
fixtures for the three reported PR states when live GitHub data is unavailable:

1. PR #717 has invalid local data and can be prepared again without blocking
   another PR.
2. PR #754 opens its completed snapshot and exposes `Run review` when the prior
   attempt is discarded or absent.
3. PR #716 reports `Reconnect` only when the current process owns the run;
   otherwise it reports `Start again`, never “not running” with a background
   guess.

Walkthrough browser proof must click Generate, select model/reasoning, wait for
ready, navigate sections, mark one reviewed, create an inline draft, click Back
to files, and verify Files state remains intact. Assert no generation request
occurs on workbench open. Keep the existing 1,000-file selection performance
ceiling below 200 ms.

### Step 10: Run full verification and packaged QA

From `/Users/kwanpham/Work/cfw/patchdesk`, run the required desktop order:

    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm exec playwright test
    pnpm package:mac
    pnpm test:package-smoke

Before any interactive packaged-app verification, use a dedicated tester
subagent as required by `AGENTS.md`. The tester launches
`release/mac-arm64/Patchdesk.app/Contents/MacOS/Patchdesk` with an isolated
user-data directory and remote debugging port, uses `agent-browser` over CDP,
and returns screenshots/evidence for recovery actions, Settings controls,
walkthrough generation, inline drafting, and Back to files. The primary agent
must not drive the live packaged UI.

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
  lists. Diagnostics expose incident ID, category, phase, and timestamp only;
  no raw stack trace, credential, path, full diff, or untrusted PR text leaks.
- Settings contains no saved-review lists, older-version lists, Discard, or
  quarantine controls. `Clear cache` retains durable reviews, attempts,
  quarantined evidence, and diagnostics. `Clear local review data` removes
  only discarded/quarantined/older-version data and retains running/recoverable
  reviews.
- Generate walkthrough is manual, available only for a stable completed
  snapshot, and preceded by model/reasoning selection. Opening or completing a
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

## Artifacts and Notes

The source packet remains available at:

- `.agents/tasks/narrative-walkthrough/00-sources.md`
- `.agents/tasks/narrative-walkthrough/01-research-patchdesk.md`
- `.agents/tasks/narrative-walkthrough/02-research-codiff.md`
- `.agents/tasks/narrative-walkthrough/03-research-plannotator.md`
- `.agents/tasks/narrative-walkthrough/04-research-pierre.md`
- `.agents/tasks/narrative-walkthrough/spec.md`
- `docs/superpowers/specs/2026-07-26-review-recovery-observability-design.md`

The superseded recovery plan remains at
`docs/superpowers/plans/2026-07-26-review-recovery-observability.md` as the
historical source for the consolidated workstream. This file is the execution
source of truth for the combined feature and should be updated if an
implementation decision changes.

At each milestone, append concise evidence here or in the relevant test
artifact: command, working directory, result, and any blocker. Do not paste
secrets, raw diffs, local paths from user machines, or full model output.

## Interfaces and Dependencies

The implementation must end with these boundaries:

- `src/domain/review-recovery.ts` exports explicit recovery state and
  capability types; `src/services/review-workbench-projection.ts` consumes the
  existing `ReviewRunRegistry.find(owner)` dependency.
- `src/domain/review-diagnostic.ts` and
  `src/services/review-diagnostic-service.ts` provide bounded redacted local
  diagnostic events and incident IDs.
- `src/adapters/storage/review-artifact-storage.ts` owns validated,
  idempotent artifact removal; `src/services/storage-management-service.ts`
  owns retention classification and `clearLocalData(profileId)`.
- `src/main/local-api.ts` exposes only authenticated, origin-bound
  `POST /v1/storage/clear-local-data`, `POST /v1/storage/cache/clear`,
  `POST /v1/reviews/walkthrough/generate`, and
  `POST /v1/reviews/walkthrough/load` for the new flows. Obsolete Settings-only
  routes are gone after migration.
- `src/domain/narrative-walkthrough.ts` exports
  `NarrativeSnapshot`, bounded normalized walkthrough types,
  `normalizeNarrativeWalkthrough`, and `filterNarrativePatchToHunks`.
- `src/workflows/generate-walkthrough.ts` owns the read-only structured-output
  schema and prompt; `src/services/flue-cli-walkthrough-invoker.ts` owns the
  fixed Flue command and terminal-output parsing.
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
  Pierre, Vitest, Testing Library, Playwright, and Electron toolchain. Do not
  add a new persistence store, public review API, model provider, or GitHub
  write path for this feature.

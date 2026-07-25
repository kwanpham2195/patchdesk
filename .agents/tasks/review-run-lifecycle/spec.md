---
created_at: 2026-07-25
repos: patchdesk
status: approved-design
sources:
  - ../pierre-tree-diff-comments/03-research-current-review-flow.md
---

# Review-run lifecycle UX: design

## Problem

Starting a review drops the returned `attemptId` in the renderer, so the
workbench never enters live progress. Users reach progress only through an
inbox detour, and a failed run is a dead end: nothing persists the failure,
the session stays `Running` forever, the inbox keeps saying "View review
progress", and retry is impossible without an app restart. Several loading
and error states are also invisible or misleading.

Research: `../pierre-tree-diff-comments/03-research-current-review-flow.md`.

## Scope

Three layers, one spec, two PRs.

- **L1 — Core defect (renderer).** Propagate both `runId` and `attemptId`
  from `POST /v1/reviews/run` into the workbench so `SafeRunPanel` enters
  live progress immediately. PR 1.
- **L3 — Loading-state polish (renderer).** Honest starting, finalizing,
  disconnected, reconnect, and post-restart states. PR 1, same files as L1.
- **L2 — Failure lifecycle (main + renderer).** Persist live run failures as
  session `ReviewFailed` (schema already exists), show a failure banner, make
  retry work, keep the inbox honest. PR 2.

## Lifecycle state map

Every moment of the flow and what the user sees after this work.

**Moment 0 — Ready.** Unchanged: "Ready to review" card, Run review button,
model/reasoning dialog.

**Moment 1 — Starting.** Today the dialog closes instantly and the start POST
leaves dead air; a start error renders only on the "ready" section and is
invisible from diff/checks. New: the dialog stays open with a disabled,
spinning "Starting…" confirm button. On 202 the dialog closes into live
progress. On error the message shows inside the dialog, with the existing
refresh-and-reopen action for 409 (head changed).

**Moment 2 — Live progress.** Unchanged: `SafeRunPanel` polling with status,
step, elapsed, activity log, metadata. The initial `connecting` placeholder
already covers the first-poll gap.

**Moment 3 — Run failed.** Today: in-memory projection fails, nothing
persists, session stays `Running`, retry impossible (execution rejects
`Running`; resume returns the same failed registry run). New: on workflow
failure the main process persists attempt `Failed` and session
`ReviewFailed { attemptId, error }`. The renderer treats a `failed`
projection like completion: reload the workbench, land on "Ready to review"
with a failure banner ("Review run failed: *message*. You can start a new
run.") and a working Run review button (fresh attempt via the normal route).

**Moment 4 — Poll disconnected.** Keep automatic backoff. Add a "Check again
now" button. Copy: "Lost the local run connection — retrying automatically."
A later successful poll resumes normal handling.

**Moment 5 — Finalizing.** When the projection reaches `completed`, show
"Finalizing review…" (spinner, "Saving results") while `/v1/reviews/load`
runs. On load error show "Could not load the result — Retry" instead of
today's misleading "lost connection" message. Retry repeats the load.

**Moment 6 — Reopen mid-run (same process).** The run is usually still alive
and `resumePreparedRun` reattaches via the idempotent coordinator, but the
panel says "This review is not running". New copy when the persisted session
is `Running`: "This review may still be running in the background." Button:
"Reconnect". Same resume path underneath; if the run settled meanwhile, the
terminal-state handling takes over.

**Moment 7 — After app restart.** Reconciliation already marks the attempt
`Failed` and the session `Stale (orphaned_run)`; resume-after-restart works
today. What's missing is explanation: the workbench projection surfaces the
last run outcome, and the recovery panel says "Patchdesk restarted before
this review finished — start again." Same "last run outcome" surface as
Moment 3's banner.

**Moment 8 — Head changed.** Unchanged: 409 at start, current-head recheck at
GitHub write time.

## Changes by layer

**L1 (renderer).**

- `prepared-review-flow.tsx`: `isRunStart` validates `{ runId, attemptId }`;
  `startRun` returns both; `startOwnedRun` patches
  `{ runId, session: { ...workbench.session, currentAttemptId: attemptId } }`.
- `app.tsx`: the prepared-flow patch merge is shallow, so the session object
  travels whole; widen the patch type to `{ runId?, session? }`, mirroring
  the completed-flow patch shape.

**L3 (renderer).**

- `prepared-review-flow.tsx`: dialog busy state during the start POST; start
  errors render inside the dialog (visible from every section).
- `safe-run-panel.tsx`: "Finalizing review…" state around the completion
  reload with its own retry; "Check again now" button and new copy for the
  disconnected state; session-state-aware recovery copy ("Reconnect" vs
  "Start review").
- Workbench projection surfaces the last run outcome (failure message /
  orphaned-run reason) so the ready card can render the Moment 3 / Moment 7
  banner. Renderer passes it through; no new persistence.

**L2 (main + renderer).**

- New `ReviewFailureService` (main process, mirroring
  `ReviewCompletionService`): on workflow failure, load session + attempt,
  transition attempt to `Failed` and session to `ReviewFailed`, save both.
- `ReviewRunCoordinator.execute` calls it on the error path, alongside the
  existing in-memory `fail()` projection update. Wired in `electron-main`
  composition.
- Renderer: a `failed` projection triggers the same workbench reload as
  `completed` (generalize `onCompleted` to an on-settled callback); the
  reloaded workbench shows the Moment 3 banner.
- Verify during planning: `beginAttempt` accepts a `ReviewFailed` session;
  inbox projection maps `ReviewFailed` to a "start again" action instead of
  "View review progress".

## Boundaries that do not change

- `runId` stays process-local and is never persisted;
  `/v1/reviews/load` never returns a live run handle.
- Reopening a session never auto-restarts a workflow; startup reconciliation
  never relaunches.
- Provider events, prompts, tool output, and credentials stay behind the
  safe-run projection.
- GitHub writes keep the current-head recheck and explicit confirmation.
- Completion still validates findings against the immutable patch.

## Error handling

- Start POST failures: dialog-local error; 409 adds refresh-and-reopen.
- Workflow failure: persisted `ReviewFailed` + banner + working retry.
- Completion/failure reload failure: "Could not load the result — Retry".
- Poll failure: auto-backoff plus manual "Check again now".
- Resume failure (recovery branch): surface an error in the panel instead of
  today's silent no-op.

## Testing

- L1 regression: drive `PreparedReviewFlow` through `/v1/reviews/run`, assert
  `SafeRunPanel` polls immediately with both identifiers; reopen through
  `/v1/reviews/load` and assert the recovery branch.
- L1: start-POST failure renders inside the dialog from the diff section.
- L3: disconnected panel retries manually; finalizing state shows during
  reload and its retry repeats the load; recovery copy follows session state.
- L2: coordinator failure persists attempt `Failed` + session `ReviewFailed`;
  a failed projection reloads the workbench to the banner; a fresh attempt
  starts from `ReviewFailed`; inbox no longer projects "View review progress"
  for a failed session.
- Repo gate: `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`,
  `pnpm build`, `pnpm exec playwright test`.

## Out of scope

- Bidirectional tree/diff scroll following, Pierre tree adoption, inline diff
  comments (tracked under `pierre-tree-diff-comments`).
- Mid-run head-change warnings (surfaced at start and at submit already).
- Any GitHub write-path change.

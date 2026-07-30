# Existing Patchdesk review flows — current-state research

**Status:** Complete

**Date:** 2026-07-30

**Question:** How does the current Patchdesk journey work from inbox entry through prepared review, optional walkthrough, completed analysis, local review actions, and GitHub publishing?

## Scope and evidence

This is a source- and test-grounded map of the current checkout. It does not propose product changes and it does not treat the Design app as production behavior.

The worktree already contains broad in-flight changes across renderer, service, test, and documentation files. The findings below describe the code that is currently checked out, not a clean historical baseline. No live UI behavior was used as evidence in this note.

Primary sources:

- `CONTEXT.md` — glossary for snapshots, review items, and review batches.
- `docs/adr/0001-patchdesk-design-uses-a-browser-mock-boundary.md` — Design app boundary.
- `docs/adr/0002-snapshot-owned-review-batch.md` — local batch ownership and write boundary.
- `.agents/tasks/narrative-walkthrough/05-research-prepared-diff-entry.md` — prior prepared-diff walkthrough research.
- `docs/superpowers/specs/2026-07-30-review-workbench-journey-simplification-design.md` — approved product direction, used only as a comparison point.

Production flow sources:

- `src/renderer/src/app.tsx:155-195,361-527`
- `src/renderer/src/flows/inbox-flow.tsx:50-207,211-305`
- `src/renderer/src/components/maintainer-inbox.tsx:64-329,350-392`
- `src/services/review-workbench-controller.ts:28-81`
- `src/services/review-session-preparation.ts:93-99,106-182`
- `src/services/review-workbench-projection.ts:155-290,311-435,438-477`
- `src/renderer/src/flows/prepared-review-flow.tsx:101-338,352-511,515-928`
- `src/renderer/src/components/safe-run-panel.tsx:20-180`
- `src/renderer/src/flows/completed-review-flow.tsx:52-248`
- `src/renderer/src/components/completed-review-workbench.tsx:122-421,436-576,577-766`
- `src/renderer/src/components/pr-overview-sheet.tsx:47-143`
- `src/renderer/src/components/review-batch-panel.tsx:45-173`
- `src/renderer/src/components/merge-confirmation-dialog.tsx:15-69`
- `src/renderer/src/hooks/use-walkthrough-controller.ts:7-95`
- `src/services/narrative-walkthrough-service.ts:15-22,87-198,271-331`
- `src/renderer/src/components/narrative-walkthrough.tsx:88-124,240-527`

Test sources:

- `tests/renderer/prepared-review-flow.ui.test.tsx:37-293`
- `tests/renderer/completed-review-flow.ui.test.tsx:145-175,341-356`
- `tests/browser/milestone-9.spec.ts:6-100`
- `tests/browser/milestone-10.spec.ts:6-24`
- `tests/browser/milestone-11.spec.ts:6-19`
- `tests/browser/milestone-12.spec.ts:6-62`

## Current journey map

```text
Dashboard load
  -> Maintainer inbox
  -> row click or row action
  -> /v1/reviews/open
  -> prepared Files surface
       -> optional walkthrough generation
       -> optional local analysis
       -> live run or recovery state
       -> completed review workbench
            -> Files and findings
            -> PR overview sheet
                 -> local review batch
                 -> explicit GitHub review confirmation
                 -> explicit merge confirmation
```

The important lifecycle boundary is the prepared snapshot. Opening a pull request prepares or resumes the immutable local snapshot; it does not itself start model analysis. The model run and walkthrough are separate actions.

## 1. Inbox entry

`App` loads profiles and the inbox through the authenticated local API, then routes normal product content through `InboxFlow` (`src/renderer/src/app.tsx:155-195,502-524`). The inbox supports refresh state, error/empty states, filters, sorting, saved views, a selected row, and a review-details inspector.

The visible inbox is not a passive selection screen. Each row is a button whose click both selects the row and immediately invokes its recommended action (`src/renderer/src/components/maintainer-inbox.tsx:350-360`). The action mapping is:

- `run_review` → open a full review.
- `review_updates` → open a comparison preview, then open an incremental review after confirmation.
- `continue_review` → open the saved session.
- `open_saved_review` → open the saved session.
- `open_merge_readiness` → open the saved session.
- `open_discussion` → open the saved session.

The same action is also available from the inspector, which shows author, branches, current and reviewed heads, checks, change statistics, local review state, and a one-action button (`src/renderer/src/components/maintainer-inbox.tsx:363-367`). The inspector repeats the broad safety copy that starting a review is read-only and that GitHub writes require separate confirmation.

There is also a direct-entry path. The user enters `owner/repository#123`, previews it, may be asked to switch workspace profile, and then opens the pull request (`src/renderer/src/flows/inbox-flow.tsx:88-148,192-207`).

## 2. Opening and preparing a snapshot

`POST /v1/reviews/open` is handled by `ReviewWorkbenchController.open` (`src/services/review-workbench-controller.ts:28-66`). It validates the reference, prepares or resumes the session, and then projects the workbench.

`ReviewSessionPreparation` reads the current pull request head, derives the session identity from that head, and either resumes a readable stored session or prepares a new immutable session (`src/services/review-session-preparation.ts:93-99,106-182`). Starting a model attempt is explicitly separate from this preparation step.

The projection chooses the renderer flow by whether the session has a visible result:

- no visible result → `state: "review_started"`, the prepared flow;
- visible result → `state: "completed"`, the completed flow (`src/services/review-workbench-projection.ts:155-166,223-236`).

The prepared projection reads the saved patch and current GitHub context, calculates freshness, exposes checks/comments/batch/merge readiness, and derives one recovery view when needed (`src/services/review-workbench-projection.ts:238-290`).

## 3. Prepared review and Files flow

`PreparedReviewFlow` opens on the stored diff whenever a patch is available and the route was not explicitly opened at Checks (`src/renderer/src/flows/prepared-review-flow.tsx:352-360`). The Files surface is rendered by `DiffWorkbench` (`src/renderer/src/flows/prepared-review-flow.tsx:685-701`). Local inline-comment authoring is enabled when the snapshot is fresh and its batch is local.

The current prepared header contains several independent controls:

- checks status, which opens the PR overview focused on checks;
- `Refresh GitHub state`;
- `PR overview`;
- `Generate walkthrough` or `Open walkthrough`;
- a recovery/run action such as `Run review`, `Reconnect`, `Start again`, `Try again`, or `Prepare again` (`src/renderer/src/flows/prepared-review-flow.tsx:531-628`).

Refresh is a remote read. If the head changed, the flow reopens preparation using the previous session as context (`src/renderer/src/flows/prepared-review-flow.tsx:172-190,307-328`). The saved review remains readable while current GitHub state is unavailable or stale (`src/renderer/src/flows/prepared-review-flow.tsx:630-637`).

The prepared flow also renders the PR overview sheet, which contains description, checks, existing threads, local review-batch context, and merge/publish surfaces (`src/renderer/src/flows/prepared-review-flow.tsx:580-599`; `src/renderer/src/components/pr-overview-sheet.tsx:81-143`). If there is no local model review, the sheet says so, but the local batch surface may still be present when a batch exists.

## 4. Starting, observing, and recovering analysis

The prepared flow uses a model-selection dialog before starting analysis. It loads the model catalog and saved execution preference, sends `POST /v1/reviews/run` only after confirmation, and records the returned run identifier (`src/renderer/src/flows/prepared-review-flow.tsx:110-170,297-305,776-868`). The local API starts the review execution and returns both `runId` and `attemptId` (`src/main/local-api.ts:489-511`).

When a run is attached, `SafeRunPanel` polls the local run projection. It shows queued/connecting/running progress, a disconnected state with `Check again now`, and terminal completion/failure states. On completion or failure it reloads the workbench (`src/renderer/src/components/safe-run-panel.tsx:55-83,110-180`; `src/renderer/src/flows/prepared-review-flow.tsx:331-338,751-770`).

Recovery is selected from durable session/attempt state and process ownership. The domain decision currently maps:

- created, discarded, or completed session → `run_review`;
- running session with an owned live process → `reconnect`;
- running session without an owned live process → `start_again`;
- interrupted attempt → `start_again`;
- failed attempt/session → `try_again`;
- stale session → `prepare_again` (`src/domain/review-recovery.ts:46-75`).

The renderer maps those stable keys to user copy such as `Run review`, `Start again`, and `Try again` (`src/renderer/src/review-copy.ts:36-81`). The current recovery component provides the action itself, but does not add explicit `Back to inbox` or `View snapshot` controls inside the recovery panel (`src/renderer/src/components/safe-run-panel.tsx:91-107`).

One layout detail matters: `SafeRunPanel` is only rendered in the prepared flow when the user is not currently viewing the diff or Checks (`src/renderer/src/flows/prepared-review-flow.tsx:703-770`). The prepared header still exposes the recovery action, but live run details are not shown in the Files surface itself.

## 5. Completed review workbench

After a run settles, `App` routes a completed projection to `CompletedReviewFlow` (`src/renderer/src/app.tsx:490-500`). That flow owns remote refresh, local review-batch mutations, apply/submit calls, merge calls, and the walkthrough controller (`src/renderer/src/flows/completed-review-flow.tsx:52-71,73-179,181-245`).

The completed workbench remains Files-first. Its header shows `Review complete`, the result verdict, GitHub freshness, checks, PR overview, refresh, and the pull request identity (`src/renderer/src/components/completed-review-workbench.tsx:345-421`). The main surface provides:

- a changed-files rail;
- selected finding and file navigation;
- previous/next finding controls;
- a findings dialog;
- a mobile Files sheet;
- the parsed diff with model-finding and local-draft annotations (`src/renderer/src/components/completed-review-workbench.tsx:577-766`).

The completed workbench does not place GitHub write buttons in its main header. The PR overview sheet is the shared read-and-confirmation surface. It groups Description, Checks, Existing threads, and Your local review, then places review-write and merge actions in the sheet footer (`src/renderer/src/components/pr-overview-sheet.tsx:81-143`).

## 6. Walkthrough flow

Walkthrough generation is manually started. The controller loads the model catalog, restores a valid saved model/reasoning choice, opens the dialog, and only calls `/v1/reviews/walkthrough/generate` after the user confirms (`src/renderer/src/hooks/use-walkthrough-controller.ts:24-95`). The renderer tests explicitly assert that opening the workbench does not generate a walkthrough automatically (`tests/renderer/completed-review-flow.ui.test.tsx:145-157`).

The service treats the walkthrough as a reader of the stored patch. It records a generating projection, invokes the workflow, checks token/head/patch freshness before publishing the result, and exposes ready, failed, or stale projections (`src/services/narrative-walkthrough-service.ts:87-180,182-250`). The current checkout accepts readable `Created`, `Running`, `ReviewCompleted`, and `ReviewFailed` sessions as walkthrough sources (`src/services/narrative-walkthrough-service.ts:271-331`).

The production renderer has two similar walkthrough presentations:

- prepared flow renders the ready takeover directly from `PreparedReviewFlow` (`src/renderer/src/flows/prepared-review-flow.tsx:478-511`);
- completed flow renders a banner, generation dialog, and ready takeover inside `CompletedReviewWorkbench` (`src/renderer/src/components/completed-review-workbench.tsx:436-576`).

The ready takeover has a chapter rail, Support section, reading surface, navigation, and section-progress controls (`src/renderer/src/components/narrative-walkthrough.tsx:240-527`). It returns to Files and preserves the selected workbench context in the completed-flow tests (`tests/browser/milestone-9.spec.ts:31-100`).

The current behavior is not purely read-only in the narrow interaction sense:

- the walkthrough exposes `Mark section reviewed` and `Mark Support reviewed` controls (`src/renderer/src/components/narrative-walkthrough.tsx:287-365,422-527`);
- completed walkthrough state is held in component-local state (`src/renderer/src/components/completed-review-workbench.tsx:205-208`);
- the completed flow passes local comment authoring into walkthrough diff blocks when the batch is local and fresh (`src/renderer/src/components/completed-review-workbench.tsx:536-553`);
- the browser fixture proves that a user can add a local comment from the walkthrough and that it enters the review batch (`tests/browser/milestone-9.spec.ts:57-73`).

The prepared flow passes an empty reviewed-section list and no-op review-mark callbacks into the same component (`src/renderer/src/flows/prepared-review-flow.tsx:484-511`). Therefore the prepared and completed walkthroughs do not have the same local reading-progress behavior.

There is a service and API route for loading a stored walkthrough (`src/main/local-api.ts:560-565`; `src/services/narrative-walkthrough-service.ts:182-198`), but the renderer controller does not call `/v1/reviews/walkthrough/load`; its initialization only loads the model catalog (`src/renderer/src/hooks/use-walkthrough-controller.ts:34-58`). The current renderer tests explicitly assert that no walkthrough load request is made on workbench open (`tests/renderer/completed-review-flow.ui.test.tsx:145-157,341-356`). In practice, the ready/failed/stale walkthrough projection is held in the current renderer session rather than restored when the workbench is reopened.

## 7. Local review batch and GitHub writes

The local review batch is shown inside the PR overview. It lists local actions, allows local inline-comment authoring from a mapped finding, and says that comments stay local until the user confirms a GitHub write (`src/renderer/src/components/review-batch-panel.tsx:45-99`). The batch is snapshot-owned and is designed to preserve human items across model runs (`docs/adr/0002-snapshot-owned-review-batch.md`).

The write sequence is deliberately multi-step:

1. `Create pending review` opens a confirmation dialog and creates the pending GitHub review.
2. `Submit pending review` opens a second dialog, requires a review event and acknowledgement, then submits the pending review (`src/renderer/src/components/review-batch-panel.tsx:102-173`).
3. `Prepare merge confirmation` opens a merge dialog, shows the exact pull request/head/method, and requires acknowledgement when warnings exist (`src/renderer/src/components/merge-confirmation-dialog.tsx:44-57`).

Freshness blocks writes. The completed workbench treats any non-fresh state as write-blocked, and the overview disables or replaces write/merge actions with explanatory copy (`src/renderer/src/components/completed-review-workbench.tsx:228-230`; `src/renderer/src/components/pr-overview-sheet.tsx:109-138`).

The current confirmation language is still generic in two places:

- the batch shows a count of planned actions rather than a breakdown into inline comments, replies, and thread-state changes (`src/renderer/src/components/review-batch-panel.tsx:82-96`);
- merge warnings are rendered under `Merge warnings` as underscore-replaced strings rather than named concrete warnings (`src/renderer/src/components/merge-confirmation-dialog.tsx:52-54`).

The browser tests confirm that both review-write confirmation steps and merge acknowledgement are required (`tests/browser/milestone-10.spec.ts:6-23`; `tests/browser/milestone-11.spec.ts:6-17`).

## What the current implementation already establishes

- Opening a pull request prepares/resumes a snapshot before model analysis.
- The prepared and completed surfaces both start from Files/diff evidence.
- Analysis and walkthrough generation are manually started and separate.
- GitHub reads, local draft changes, and GitHub writes are separate boundaries.
- Current-head freshness blocks posting and merge while preserving local readability.
- Review rows expose a single recommended next action based on durable state.
- The browser suite covers manual walkthrough generation, return-to-Files behavior, explicit review-write confirmation, and merge acknowledgement.

## Current friction and inconsistency to carry into product design

These are observations, not decisions:

1. The same journey uses competing vocabulary: `Run review`, `Start read-only review`, `Review complete`, `Generate walkthrough`, `Open walkthrough`, and `Generate another walkthrough` appear across inbox, prepared, and completed surfaces.
2. The prepared header keeps Checks, Refresh, PR overview, walkthrough, and recovery/run actions together, while completed review moves some of the same concepts into a banner or overview sheet.
3. Clicking an inbox row immediately performs its recommended action, and the inspector repeats that action. This reduces one step for the common path but gives the user little separation between selecting a PR and starting/opening a review.
4. The walkthrough is called read-only because it does not directly write to GitHub, but the current ready surface can mark reading state and add local review-batch comments. That distinction is not obvious from the label.
5. Walkthrough state is not restored from the available load endpoint, so a reopened workbench starts with an idle renderer projection even when the service supports a stored projection.
6. Prepared and completed flows duplicate walkthrough presentation logic, and their section-progress behavior is different.
7. Publish and merge are safely gated but nested in the PR overview and use broad summaries/warnings, so the user must navigate into the overview to understand the exact publish state.
8. Recovery panels provide the recovery action but do not include explicit snapshot/inbox exits in the panel itself. Live progress also disappears from the prepared surface while Files or Checks is displayed.

## Not established by this research

- No telemetry or user-interview evidence was available, so this note cannot rank which friction costs users the most.
- No live GitHub or packaged-Electron session was used, so this note does not claim that every current API-backed state is visually reachable in a real profile.
- No architecture change is implied. The next product-design step should decide the user-facing journey and then map each decision onto these existing flow/component boundaries.

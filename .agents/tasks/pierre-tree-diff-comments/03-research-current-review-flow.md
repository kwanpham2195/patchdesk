---
created_at: 2026-07-25
status: draft
scope: current Patchdesk review flow from inbox entry through local execution, reopen, completion, and GitHub submission
sources:
  - 01-research-pierre-tree-diff-comments.md
  - 02-research-pierre-tree-diff-scroll.md
---

# Current review-flow research

## Question

What does the current Patchdesk review flow do, and where does the live-run
state move between the renderer, local API, persisted session, and process-local
run registry?

## Current flow

1. **Inbox entry**

   The inbox loads persisted sessions and projects the latest review state. A
   current-head session whose persisted attempt is `Starting` or `Running` is
   labelled `running` and receives the primary action `View review progress`.
   This action opens the saved session; it does not start a run.

   Evidence: `src/domain/maintainer-inbox.ts:53-123`,
   `src/services/maintainer-inbox-service.ts:127-156`,
   `src/renderer/src/flows/inbox-flow.tsx:150-179`.

2. **Prepare or reopen an immutable session**

   `POST /v1/reviews/open` reads the current pull request, derives a
   head-specific session ID, and either resumes an existing prepared session
   or creates the immutable patch, worktree, context, review-input, and debug
   artifacts. Preparation deliberately does not allocate an attempt or invoke
   the model.

   `POST /v1/reviews/load` only projects the saved session and current safe
   workbench data. It never restarts a workflow.

   Evidence: `src/services/review-session-preparation.ts:83-153`,
   `src/services/review-workbench-controller.ts:34-64`,
   `src/services/review-workbench-projection.ts:204-263`.

3. **Choose the model**

   The prepared renderer requests `GET /v1/reviews/models`, restores the last
   valid model/reasoning preference, and opens the `Run local review` dialog.
   The copy correctly says that analysis is read-only and will not write to
   GitHub.

   Evidence: `src/renderer/src/flows/prepared-review-flow.tsx:77-112`,
   `src/renderer/src/flows/prepared-review-flow.tsx:236-260`.

4. **Start the review**

   The renderer sends `POST /v1/reviews/run` with only the profile, session,
   selected model, and reasoning. The main process then:

   - validates the model against the main-process catalog;
   - verifies that the saved session is runnable and its GitHub head is still
     current;
   - allocates the next attempt and persists the session as `Running` with a
     `currentAttemptId`;
   - persists the attempt as `Starting`; and
   - creates a process-local owned run and starts the workflow asynchronously.

   The HTTP response contains `runId`, `attemptId`, `model`, and `reasoning`.

   Evidence: `src/renderer/src/flows/prepared-review-flow.tsx:114-153`,
   `src/main/local-api.ts:366-405`,
   `src/services/review-execution-service.ts:52-113`,
   `src/adapters/storage/review-session-store.ts:295-349`.

5. **Run and observe progress**

   The owned run starts with a safe queued projection. The coordinator updates
   coarse activity such as preparing, inspecting, validating, drafting, and
   completion. The renderer polls
   `/v1/runs/:runId?sessionId=...&attemptId=...`; provider events, prompts, tool
   output, and credentials remain behind the projection boundary.

   The production Flue adapter executes the finite `workflow:review-pr` CLI
   workflow and returns a structured result. It does not expose a durable
   provider run ID, so Patchdesk intentionally uses its own process-local run
   ID and does not fabricate a Flue ID.

   Evidence: `src/services/review-run-coordinator.ts:37-167`,
   `src/main/local-api.ts:470-492`,
   `src/renderer/src/components/safe-run-panel.tsx:42-71`,
   `src/services/flue-cli-review-invoker.ts:11-35`,
   `src/main/electron-main.ts:93-121`.

6. **Persist completion**

   On a completed projection, the renderer reloads `/v1/reviews/load`. The main
   process validates and maps model findings against the immutable patch,
   completes the attempt, persists the result, and creates a local review
   batch. The workbench then changes from `review_started` to `completed`.

   Evidence: `src/renderer/src/components/safe-run-panel.tsx:55-59`,
   `src/services/review-completion-service.ts:16-63`,
   `src/domain/review-session.ts:303-347`,
   `src/services/review-workbench-projection.ts:266-389`.

7. **Edit, apply, and submit**

   The completed workbench can update the local batch, create a pending GitHub
   review, submit it, refresh remote context, and merge through separate
   explicit routes. GitHub writes perform a current-head check and require the
   renderer acknowledgement/confirmation boundary.

   Evidence: `src/renderer/src/flows/completed-review-flow.tsx:50-151`,
   `src/services/review-submission-service.ts:30-130`,
   `src/services/review-write-controller.ts:58-109`.

## Current lifecycle mismatch

The expected start response and the renderer state update are not aligned.

`POST /v1/reviews/run` returns both `runId` and `attemptId`, but
`PreparedReviewFlow.startRun()` narrows the response to only `runId`, and
`startOwnedRun()` patches only `{ runId }`. The current workbench therefore
keeps `workbench.session.currentAttemptId` undefined even after the server has
persisted a running attempt.

Because the prepared flow renders `SafeRunPanel` only when
`currentAttemptId` is defined, the immediate post-start workbench does not
enter the live-progress branch. A later inbox refresh sees the persisted
`Running` session and offers `View review progress`, which explains how the
reported screen is reached.

Evidence: `src/renderer/src/flows/prepared-review-flow.tsx:114-154`,
`src/renderer/src/flows/prepared-review-flow.tsx:205-234`,
`src/main/local-api.ts:382-400`.

There is a second intentional boundary: `runId` belongs to the process-local
`ReviewRunRegistry`. `/v1/reviews/load` returns the persisted `currentAttemptId`
but does not return a live `runId`. If the app is reopened or the process-local
run is gone, `SafeRunPanel` correctly refuses to pretend that a live run exists
and shows the explicit `Start review` recovery action.

Evidence: `src/services/review-run-registry.ts:1-38`,
`src/services/review-workbench-projection.ts:393-405`,
`src/renderer/src/components/safe-run-panel.tsx:79-89`.

At API startup, persisted `Running` attempts are reconciled as orphaned and
marked stale/failed rather than relaunched. This is the intended safety rule
for an app restart, but it means the inbox should not describe that state as
continuable until the reconciliation has completed.

Evidence: `src/main/local-api.ts:145-155`,
`src/services/review-recovery-service.ts:6-34`,
`src/services/review-workbench.ts:128-161`.

## Test coverage found

The focused suite passes:

```text
pnpm test -- --run tests/renderer/safe-run-panel.ui.test.tsx tests/services/review-run-coordinator.test.ts tests/storage/review-session-store-begin-attempt.test.ts tests/domain/maintainer-inbox.test.ts
Test Files 4 passed; Tests 16 passed
```

Those tests cover the safe run panel, process-local coordinator, attempt
allocation, and inbox action projection independently. I found no test that
drives `PreparedReviewFlow` through `/v1/reviews/run`, applies both returned
identifiers to the workbench, then reopens the same session through
`/v1/reviews/load`.

## Current-state conclusion

The intended flow is:

```text
prepare session
  -> choose model
  -> start attempt and owned run
  -> show live safe progress
  -> persist result and local batch
  -> edit/apply/submit explicitly
```

The current implementation actually behaves as:

```text
prepare session
  -> choose model
  -> persist Running attempt + start owned run
  -> renderer stores runId but drops attemptId
  -> workbench does not enter live-progress state
  -> inbox later says View review progress
  -> reopen has attemptId but no process-local runId
  -> explicit Start review is required
```

This is a renderer lifecycle-state propagation defect at the start boundary,
combined with the intentional non-persistence of live run handles. No
application behavior was changed by this research.

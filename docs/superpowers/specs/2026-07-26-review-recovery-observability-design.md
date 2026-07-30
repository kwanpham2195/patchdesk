# Review recovery and observability

**Status:** Proposed; awaiting implementation approval

## Summary

Patchdesk currently collapses several different failures into a generic preparation or run error. Durable review data, preparation work, and review attempts are also represented by overlapping state, which produces misleading behavior:

- an invalid saved session can prevent a pull request from opening;
- a discarded review can hide the `Run review` action;
- opening a review can appear stuck while preparation is still running;
- reopening after a restart can show “not running” without explaining whether the run was interrupted, failed, or can be reconnected.

This design separates durable review identity, preparation operations, review attempts, and diagnostics. It makes recovery automatic and non-blocking while keeping internal storage states out of the normal user experience.

## Goals

- Keep healthy reviews usable when another review has broken local state.
- Make every recovery action explicit, safe, and understandable.
- Let users reopen immediately instead of waiting on long-running preparation.
- Make discarded reviews eligible for a fresh attempt.
- Provide enough structured evidence to debug failures without exposing secrets or implementation details.
- Simplify Settings to global cleanup actions that do not require users to manage individual review records.
- Support a breaking local-storage migration instead of preserving ambiguous state forever.

## Non-goals

- Automatically relaunch a review after an application restart.
- Expose journals, quarantine folders, attempt IDs, stack traces, or storage paths in normal UI.
- Treat a failed review attempt as corrupt review data.
- Add per-review cleanup controls to Settings.

## Product contract

The renderer receives a user-oriented recovery projection. It should expose only states for which the user has a meaningful action:

- **Preparing:** preparation is in progress; show progress and allow leaving the workbench.
- **Ready:** the user can run a review.
- **Running:** the attempt is active; reconnect is available when the current process owns the run.
- **Interrupted:** the run stopped or the app restarted before completion; offer reconnect when possible, otherwise start again.
- **Failed:** the attempt finished with an error; offer retry or a new attempt when retryable.
- **Needs preparation:** local review data is not usable; offer `Prepare again`.

If no user action is possible, the review is omitted from ordinary lists. Technical details remain available through an optional diagnostics/support surface.

The word **quarantine** is internal terminology. User-facing copy should use phrases such as `Needs preparation`, `Review interrupted`, or `Some reviews were skipped`.

## Audience and copy contract

Patchdesk is for maintainers who understand basic GitHub, Git, and LLM concepts. Simplification must remove implementation leakage, not useful domain language.

Keep these concepts visible when they help a user make a decision:

- `PR` and `PRs` instead of the longer `pull request` in compact labels;
- `HEAD`, `Reviewed HEAD`, `Current HEAD`, and `Reviewed SHA`;
- branches, checks, `read-only`, model, and `Reasoning`;
- `Low`, `Medium`, and `High` reasoning choices.

Preferred user-facing labels include:

- `Selected PR`;
- `Inspect failing checks`;
- `Run review`;
- `Reconnect`, `Start again`, and `Try again`.

Failed checks are review context, not a review gate. Patchdesk offers `Run review` for a failed-check PR and continues to show its check details. A walkthrough remains available from a prepared snapshot with a stable stored patch. Failed checks still block merge readiness.

Keep implementation terms out of ordinary UI: `quarantine`, `worktree`, `checkout`, `session`, `attempt`, `runtime`, `agent`, and `lifecycle`. These belong in diagnostics only.

## Internal model

### Review record

The durable review record identifies the repository, pull request, reviewed snapshot, and current user-facing availability. It must not infer availability from an attempt pointer.

Suggested availability states:

`preparing`, `ready`, `running`, `completed`, `failed`, `interrupted`, `quarantined`.

`quarantined` is an internal storage state and is mapped to `Needs preparation` or omitted from normal lists.

### Preparation operation

Each open/prepare request has an operation ID, start and finish timestamps, current phase, and outcome. Phases should distinguish at least:

`load`, `validate`, `fetch`, `worktree`, `materialize`, `project`, and `cleanup`.

The operation journal is durable until the operation reaches a terminal state. Startup and load-time reconciliation must handle abandoned journals idempotently.

### Review attempt

Each explicit run is a separate attempt with its own status, timestamps, error, and optional process-local run handle. A `currentAttemptId` is historical linkage only; it must never determine whether `Run review` is visible.

An attempt may be `queued`, `running`, `succeeded`, `failed`, or `interrupted`. A discarded review can always create a new attempt unless the review is merged or otherwise unavailable.

### Diagnostic event

Every operation and attempt emits structured local events containing:

- stable error code and category;
- lifecycle phase;
- retryable flag;
- operation/attempt/review identifiers;
- timestamps and duration;
- redacted technical context;
- a support-facing incident ID.

## Recovery policy

Validation runs at startup and whenever a review is loaded. If Patchdesk cannot trust local review data:

1. Preserve the original data under an internal quarantine location.
2. Record the reason and failed phase in diagnostics.
3. Exclude the invalid record from ordinary queries.
4. Return a fresh `Needs preparation` projection when re-preparation is safe.
5. Never block unrelated reviews.

Quarantine is not deletion. It preserves evidence for support and migration analysis. It is also not used for ordinary run failures; those remain visible as failed attempts.

Recovery actions map to typed outcomes:

- invalid saved session → `Prepare again`;
- interrupted preparation → `Prepare again`;
- active same-process run without a live view → `Reconnect`;
- interrupted run after restart → `Start again`;
- retryable provider/execution failure → `Retry`;
- non-actionable internal failure → omit from normal lists and retain diagnostics.

## Request and navigation flow

Opening a PR and running a review are separate commands.

1. `Open review` creates/loads the review record and returns a stable review identity as soon as minimum metadata is available.
2. The renderer navigates to the workbench immediately.
3. Preparation progress and recovery actions render inside the workbench.
4. `Run review` explicitly creates an attempt.
5. The workbench remains open while the attempt runs and receives progress updates.
6. Reopening projects the durable state and reports `Running`, `Interrupted`, or `Failed` explicitly; it never guesses from a missing process-local run handle.

This removes dead-air navigation and prevents the misleading “This review is not running” state.

## User-facing diagnostics

Normal users see concise, action-oriented copy. An optional details surface may show the failure category, phase, timestamp, and incident ID. It should not show raw stack traces, local paths, credentials, or untrusted PR text by default.

Settings may provide:

- a local diagnostics viewer;
- `Copy incident ID`;
- a sanitized `Export debug bundle` action.

The bundle should include recent structured events and sanitized review metadata, but not secrets or complete diffs unless the user explicitly opts in.

## Settings and local-data cleanup

Settings should not expose saved-review lists, older-version review lists, quarantine folders, or per-review cleanup controls. It keeps one compact `Local review data` card with two global actions:

- **Clear cache:** remove rebuildable checkout/worktree cache and reconcile interrupted operations. Durable review records, attempts, quarantined evidence, and diagnostics remain.
- **Clear local review data:** remove discarded review records and quarantined/older-version evidence, including their attempts and artifacts. Running and recoverable reviews remain.

The labels are intentionally global. Users do not need to understand the distinction between sessions, attempts, journals, and quarantine storage.

Both operations are explicit and idempotent. A missing disposable entry is already clean. The UI disables the action while a storage operation is pending, keeps the confirmation context available after a failure, and closes it only after a successful response.

The cleanup service owns the retention classification and evaluates protected records at execution time:

- protect `preparing`, `running`, `ready`, `completed`, `failed`, `interrupted`, and `stale` reviews;
- remove `discarded` review directories and their stored attempts/artifacts;
- remove quarantined and older-version entries;
- remove rebuildable cache worktrees that are not protected by an active operation;
- prune Git worktree registrations only after cache removal.

Every filesystem boundary remains path-checked and app-owned. Partial progress is safe to retry. A storage or Git failure returns an error and never claims success. No cleanup operation changes GitHub data or review lifecycle transitions.

## Migration

Use a versioned local-storage migration:

- split existing session data into review records and attempts;
- normalize discarded sessions so they can start a new attempt;
- convert active attempts left by a previous process into `interrupted`;
- quarantine invalid sessions and preserve migration diagnostics;
- remove the Saved reviews and older-version Settings projections and retain only the two global cleanup operations;
- remove renderer logic that uses `currentAttemptId === undefined` as the run-button condition.

The migration must be idempotent and safe to rerun after a partial application.

## Verification

Add focused regression coverage for:

- invalid saved spans being quarantined and re-preparable;
- stranded preparation journals;
- discarded reviews showing `Run review` and creating a new attempt;
- immediate navigation while preparation is pending;
- reconnect versus interrupted-after-restart behavior;
- failed attempts retaining retry/new-attempt actions;
- skipped non-actionable records;
- diagnostics redaction;
- Settings showing only the two global cleanup actions;
- clear-cache preserving durable review data;
- clear-local-review-data removing discarded/quarantined data while preserving recoverable reviews.

Verify the real desktop and packaged surfaces after implementation, including the three reported pull-request scenarios.

## Acceptance criteria

- No invalid local review record blocks opening another review.
- No renderer action is derived solely from `currentAttemptId` or a process-local run ID.
- Every visible error has a user action or is intentionally hidden from normal lists.
- A user can recover #717 by preparing again, #754 by starting a fresh attempt, and #716 by reconnecting or starting again.
- Support can obtain a sanitized diagnostic bundle without manually inspecting application directories.
- Settings has no per-review cleanup controls or saved-review management lists.
- Clear cache does not delete durable review data, and clear local review data preserves running/recoverable reviews.

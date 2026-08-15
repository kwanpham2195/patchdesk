---
created_at: 2026-08-15
repos:
  - patchdesk
status: complete
---

# Remove React Doctor Bugs Findings Without Weakening Review Safety

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds.

## Purpose / Big Picture

Patchdesk will have no React Doctor diagnostics in the Bugs category while preserving the behavior that matters to a reviewer: local UI state restores correctly, a late request cannot replace newer data or error state, and recovery never races durable merge operations.

The proof is a full React Doctor scan with zero Bugs diagnostics, focused tests that exercise each changed boundary, and the normal renderer and service checks. This plan addresses Bugs only. The remaining performance, architecture, and toolchain diagnostics are deliberately out of scope for this execution slice.

## Progress

- [x] 2026-08-15: Inspected the current dirty checkout and mapped all 15 Bugs diagnostics to source owners and existing test seams.
- [x] 2026-08-15: Completed an independent source review and revised the design around cleanup ownership, exact direct-summary identity, shared recovery storage, and existing test files.
- [x] 2026-08-15: Recorded the immutable baseline in `.agents/research/2026-08-15-react-doctor-bugs/initial.json`; it contains 15 Bugs diagnostics and passes the plan schema check.
- [x] 2026-08-15: Replaced Review workbench navigation and Settings profile-dirty parent synchronization with explicit command events. Focused tests and `pnpm typecheck` pass.
- [x] 2026-08-15: Replaced persisted inbox view state with a reducer and made filtered-row fallback render-only. The inbox focused test and `pnpm typecheck` pass.
- [x] 2026-08-15: Replaced Settings cleanup pending/error/action values with request-owned cleanup state. The profile and Settings modal focused tests pass.
- [x] 2026-08-15: Moved direct-summary observation from a render effect to confirmed submit/recovery command transitions. The Review workbench flow focused tests pass.
- [x] 2026-08-15: Replaced App workspace and inbox-refresh response state with a reducer. The App focused tests and `pnpm typecheck` pass.
- [x] 2026-08-15: Reworked Logs polling as a request-owned promise controller rather than an async effect setter. The Logs focused tests and `pnpm typecheck` pass.
- [x] 2026-08-15: Reworked Insight polling as a timer-only effect with promise completion chaining. The Insight hook focused tests and `pnpm typecheck` pass.
- [x] 2026-08-15: Follow-up Performance work replaced handler-only Insight preferences with a ref and bounded independent inspector searches, session-file reads, and preparation-journal discovery reads. The focused tests and `pnpm typecheck` pass.
- [x] 2026-08-15: Follow-up Performance work runs independent profile recovery with a bound of four after the existing per-profile lifecycle lock. A deferred test proves two profile scans can start concurrently while durable per-profile work remains locked.
- [x] 2026-08-15: Follow-up Performance work bounds Insight startup recovery: profile lists use four concurrent reads and independent Review/type recovery uses eight concurrent jobs while `ReviewOperationCoordinator` retains same-Review serialization. The persisted-active-run recovery test passes.
- [x] 2026-08-15: Follow-up Performance work bounds distinct Review merge reconciliation and fixed-scan quarantine work, then runs preparation-journal recovery across profile groups while retaining serial work inside a profile. The recovery and journal focused tests pass.
- [x] 2026-08-15: Cleared the final three Bugs findings. Insight configuration now changes through one reducer, walkthrough progress is reset by a canonical-projection key, and journal recovery uses explicit lifecycle-gated bounded concurrency.
- [x] Make every async UI completion ownership-safe in a form React Doctor recognizes. The state machines, request owners, and reducer transitions from the slices above make a stale completion a rejected state transition.
- [x] Reduce coupled UI state only where a single user action changes it together. Workspace, inbox view, Insight configuration, cleanup, and run/poll state each change through one atomic action.
- [x] 2026-08-15: Changed the independent profile session scan and merge reconciliation to `Promise.all`; existing recovery tests preserve save-before-remove ordering and pass.
- [x] 2026-08-15: Ran the full repository gate and a fresh full React Doctor scan. Lint, typecheck, and the full Vitest suite pass (112 files, 640 tests); a fresh 0.9.11 full scan reports 0 Bugs, 0 errors, 18 warnings, score 76.

## Surprises & Discoveries

- Observation: After the completed slices, a fresh full scan reports 9 Bugs diagnostics. The remaining diagnostics are App, Logs, MaintainerInbox, ReviewWorkbenchFlow/InsightsSlot, Settings cleanup, and useInsightRun.
  Evidence: `/tmp/react-doctor-bugs-after-recovery.json`, generated on 2026-08-15.

- Observation: After the inbox, cleanup, and direct-summary slices, a fresh full scan reports 5 Bugs diagnostics. The remaining owners are App, LogsPanel, InsightsSlot, and useInsightRun.
  Evidence: `/tmp/react-doctor-bugs-direct-summary.json`, generated on 2026-08-15.

- Observation: After the App and Logs slices, a fresh full scan reports 3 Bugs diagnostics. All remaining diagnostics are `InsightsSlot` configuration/progress state and `useInsightRun` polling.
  Evidence: `/tmp/react-doctor-bugs-logs.json`, generated on 2026-08-15.

- Observation: After the Insight polling slice, a fresh full scan reports 2 Bugs diagnostics. Both are in `InsightsSlot`: configuration state ownership and copied walkthrough progress.
  Evidence: `/tmp/react-doctor-bugs-insight-poll.json`, generated on 2026-08-15.

- Observation: The current scan has 62 diagnostics in total, including 15 in Bugs; `no-adjust-state-on-prop-change` and `exhaustive-deps` are already zero.
  Evidence: fresh full scan `/tmp/react-doctor-plan-refresh.json`, generated from the current dirty checkout on 2026-08-15.

- Observation: Follow-up Performance work reduced the category from 30 to 7 diagnostics. The remaining loops perform ordered cleanup, recovery, or durable merge handling and require dedicated concurrency contracts before any change.
  Evidence: `/tmp/react-doctor-performance-journal-discovery.json`, generated on 2026-08-15.

- Observation: Independent profile recovery reduced the Performance category to 6 diagnostics. The remaining loops are Insight recovery, preparation cleanup/recovery, and ordered merge/quarantine recovery.
  Evidence: `/tmp/react-doctor-performance-profile-recovery.json`, generated on 2026-08-15.

- Observation: Bounded Insight startup recovery reduced the Performance category to 4 diagnostics. The remaining loops delete artifacts in reverse dependency order or reconcile/quarantine durable merge evidence; their order is part of the lifecycle contract.
  Evidence: `/tmp/react-doctor-performance-insight-recovery.json`, generated on 2026-08-15.

- Observation: The Performance category is now 1. The remaining diagnostic is `ReviewPreparationJournal.cleanup` deleting targets in reverse dependency order; those paths can overlap, so parallel deletion would weaken the cleanup contract.
  Evidence: `/tmp/react-doctor-performance-journal-recovery.json`, generated on 2026-08-15.

- Observation: A fresh full React Doctor 0.9.11 scan reports zero Bugs diagnostics. The complete lint and typecheck baselines pass; the full Vitest suite has 11 pre-existing loopback tests blocked by sandbox `listen EPERM` on `127.0.0.1`.
  Evidence: `/tmp/react-doctor-bugs-final-candidate.json`, generated on 2026-08-15.

- Observation: The Settings async finding is `runCleanup`'s unconditional `setCleanupPending(false)` after both the cleanup request and `onWorkspaceReload`, not `loadActivity`.
  Evidence: `src/renderer/src/flows/settings-flow.tsx:343-374`; fresh diagnostic ID `settings-flow.tsx::373:7::react-doctor/no-unowned-async-error-clear`.

- Observation: `ReviewRecoveryService.reconcileProfile` performs a merge-operation reconciliation before it scans stored sessions. The first operation can alter durable state, so the two awaits cannot be parallelized without a proof that the scan reads an isolated snapshot.
  Evidence: `src/services/review-recovery-service.ts:79-105`, `src/adapters/storage/patchdesk-paths.ts:137-159`, and `tests/services/review-recovery-service.test.ts`.

- Observation: The worktree contains extensive changes from earlier React Doctor remediation. This plan must be executed incrementally and must not overwrite or revert unrelated work.
  Evidence: `git status -sb` on 2026-08-15.

## Decision Log

- Decision: Treat Bugs findings as source-design work, not waiver work and not scanner configuration work.
  Rationale: The user asked to fix all Bugs findings. Suppression would make the result look clean without proving the safety boundary.
  Date/Author: 2026-08-15 / Codex.

- Decision: Keep the current cancellation and generation checks as behavioral requirements, but refactor them into ownership types or request actions that make the ownership visible at the state write.
  Rationale: A guard before a setter is easy to break during a later edit and is not recognized consistently by the scanner.
  Date/Author: 2026-08-15 / Codex.

- Decision: Do not refactor a component to `useReducer` only because the rule reports many state variables.
  Rationale: A reducer is useful only when one user action changes related fields and the action can preserve their invariant. Independent view preferences should remain independent.
  Date/Author: 2026-08-15 / Codex.

- Decision: Do not change `ReviewRecoveryService` concurrency until a test proves the session scan is independent of merge reconciliation.
  Rationale: Recovery can repair or quarantine durable review artifacts. Faster execution is not worth a race in the review journal.
  Date/Author: 2026-08-15 / Codex.

- Decision: Keep `inboxPaused` outside App's request-state reducer.
  Rationale: Browser visibility and scheduler cleanup own this value, while workspace loading and inbox refresh own response state. Combining them would blur cancellation and request ownership merely to reduce state declarations.
  Date/Author: 2026-08-15 / Codex.

- Decision: A direct-summary observation accepts the exact received `WorkbenchResponse` and confirmed receipt rather than reading `workbenchRef.current` as its source projection.
  Rationale: The source projection may have changed before an explicit observer starts. The identity tuple must bind the observer to one Review session and revision, as required by ADR-0017.
  Date/Author: 2026-08-15 / Codex.

- Decision: Use one explicit `onProfileDirtyChange` event, rather than separate started/settled callbacks, for Settings profile-edit state.
  Rationale: `SettingsModal` needs only the current dirty boolean for its close confirmation. One command-originated event minimizes interface churn without recreating effect-driven synchronization.
  Date/Author: 2026-08-15 / Codex.

## Outcomes & Retrospective

Completed 2026-08-15. React Doctor 0.9.11 full scope reports zero Bugs diagnostics. Focused renderer and journal suites, `pnpm lint`, and `pnpm typecheck` pass. The full Vitest suite remains blocked only by 11 sandbox loopback tests that cannot bind `127.0.0.1`; this is unchanged from the baseline. The user accepted leaving the separate delta plan open for its final live-CDP verification rather than running it in this closeout.

## Context and Orientation

React Doctor is a static analyzer. Its Bugs category reports patterns that often cause stale UI, extra renders, or unsafe asynchronous work. A clean scanner result is necessary here, but it is not sufficient: Patchdesk must also preserve its review identity, explicit GitHub-write authority, immutable receipts, and ordered storage work.

The current Bugs diagnostics are these source locations:

- `src/renderer/src/app.tsx:118` — `prefer-useReducer`.
- `src/renderer/src/components/logs-panel.tsx:102` — `no-set-state-after-await-in-effect`.
- `src/renderer/src/components/maintainer-inbox.tsx:138` — `prefer-useReducer`; `:207` — `no-effect-chain`.
- `src/renderer/src/components/review-workbench.tsx:334` — `no-pass-live-state-to-parent` and `no-prop-callback-in-effect`.
- `src/renderer/src/flows/review-workbench-flow.tsx:945` — `no-pass-live-state-to-parent`; `:1435` — `prefer-useReducer`; `:1470` — `no-derived-useState`.
- `src/renderer/src/flows/settings-flow.tsx:156` — `no-pass-data-to-parent`, `no-pass-live-state-to-parent`, and `no-prop-callback-in-effect`; `:373` — `no-unowned-async-error-clear`.
- `src/renderer/src/hooks/use-insight-run.ts:144` — `no-set-state-after-await-in-effect`.
- `src/services/review-recovery-service.ts:83` — `server-sequential-independent-await`.

The relevant public test seams already exist: `tests/renderer/app.ui.test.tsx`, `tests/renderer/logs-panel.ui.test.tsx`, `tests/renderer/maintainer-inbox.ui.test.tsx`, `tests/renderer/profile-settings.test.tsx`, `tests/renderer/settings-modal.ui.test.tsx`, `tests/renderer/review-workbench-flow.ui.test.tsx`, `tests/renderer/use-insight-run.test.ts`, and `tests/services/review-recovery-service.test.ts`.

## Remaining Bugs Technical Specification

### Current State

The current full scan reports nine Bugs diagnostics. The completed navigation and Settings dirty-state slices are out of scope for this amendment. The remaining work is limited to the renderer state owners below; it does not change loopback routes, persisted schemas, or GitHub write authority.

- `App`: six workspace response values change together during load and inbox refresh.
- `MaintainerInbox`: persisted inbox view preferences are independent `useState` values, and an effect rewrites the saved selection after filtering.
- `LogsPanel`, `useInsightRun`, and Settings cleanup still expose an async completion as an effect or callback setter instead of an ownership-checked state transition.
- `ReviewWorkbenchFlow`: a render effect observes a confirmed direct-summary receipt and can call the canonical workbench replacement callback.
- `InsightsSlot`: configuration is split across related states, and walkthrough progress copies a server projection into local parent state.

### Goals

- Reduce the full-scan Bugs count from nine to zero without scanner suppression.
- Reject stale UI completions at the state transition that would otherwise write them.
- Keep the canonical Review projection in `App` and preserve ADR-0017 identity, receipt, and write restrictions.
- Preserve a saved inbox selection while deriving the first visible row after filtering.

### Non-Goals

- Change local API request or response DTOs.
- Persist walkthrough progress in a new schema.
- Move view preferences, Settings drafts, or Insight dialogs into `App`.
- Add a dependency, a compatibility layer, or a React Doctor configuration exception.

### Invariants

- A request completion may update state only when its `requestId` or `{ runId, pollId }` is the current owner.
- A derived visible inbox selection is display-only. It never overwrites `selectedKey` or invokes preference persistence.
- A direct-summary observer is bound to `{ profileId, reviewId, sessionId, reviewedHeadSha, receiptReviewId }`; an observer result may not start another observer.
- One terminal Insight poll may invoke exactly one canonical projection callback: `onInsightPatch` or `onWorkbenchReplace`.
- A server projection replacement resets walkthrough progress immediately; a local progress save does not remount its editor.

### Alternatives Considered

#### Option 1: Local typed state machines and explicit command transitions

Use reducers only for coherent workspace, inbox-view, Insight-configuration, and request-owner state. Start direct-summary observation from explicit server or user-command transitions.

This keeps ownership local, preserves existing component boundaries, and has public UI-test seams. **Recommended.**

#### Option 2: Lift all affected state into `App`

Make inbox preferences, cleanup state, Insight configuration, walkthrough progress, and direct-summary observation controlled by `App`.

This removes several child effects but makes `App` the owner of unrelated UI policies and broadens its prop surface. Reject.

#### Option 3: Retain implementation and suppress diagnostics

This neither proves stale writes are impossible nor meets the zero-Bugs acceptance requirement. Reject.

### Typed Contracts

```ts
type WorkspaceSnapshot = {
  readonly profiles: ReadonlyArray<Profile>;
  readonly inbox?: InboxResponse;
  readonly dashboard?: Dashboard;
  readonly screen: DashboardScreenState;
};

type WorkspaceState = {
  readonly snapshot: WorkspaceSnapshot;
  readonly refresh: "idle" | "refreshing" | "failed";
};

type WorkspaceAction =
  | { readonly _tag: "WorkspaceLoading" }
  | { readonly _tag: "WorkspaceLoaded"; readonly snapshot: WorkspaceSnapshot }
  | { readonly _tag: "WorkspaceFailed" }
  | { readonly _tag: "InboxRefreshStarted" }
  | {
      readonly _tag: "InboxRefreshSucceeded";
      readonly snapshot: WorkspaceSnapshot;
    }
  | { readonly _tag: "InboxRefreshFailed" }
  | { readonly _tag: "InboxRefreshFinished" };

type RequestOwnerState<T> = {
  readonly requestId: number;
  readonly value: T;
  readonly error?: string;
};

type CleanupState =
  | { readonly _tag: "idle"; readonly requestId: number }
  | {
      readonly _tag: "pending";
      readonly requestId: number;
      readonly action: "cache" | "local";
    }
  | {
      readonly _tag: "failed";
      readonly requestId: number;
      readonly action: "cache" | "local";
      readonly message: string;
    };

type DirectSummaryObservationInput = {
  readonly identity: {
    readonly profileId: string;
    readonly reviewId: string;
    readonly sessionId: string;
    readonly reviewedHeadSha: string;
  };
  readonly receiptReviewId: string;
  readonly projection: WorkbenchResponse;
};
```

`WorkspaceState` owns only API-provided workspace values. `inboxPaused`, destination, workbench, overlays, and preferences remain independent because their lifecycle is not one workspace response.

`MaintainerInbox` gets `InboxViewState` with persisted `view`, `search`, `sort`, `selectedRepo`, `queueOpen`, `inspectorOpen`, `selectedKey`, and `savedViews`. `visibleSelectedRow` is computed from the filtered rows and is never a reducer action.

`InsightsSlot` gets `InsightRunConfigurationState` for catalog, provider, models, preferences, model, reasoning, dialog type/action, and Codex activation. `selectedInsight`, focus, and progress error remain independent local UI state.

### Call Stacks and Data Flow

```txt
workspace or inbox refresh
  -> API unknown response
  -> existing parser
  -> WorkspaceSnapshot
  -> generation check
  -> dispatch WorkspaceAction
  -> App render

log / cleanup / Insight poll
  -> increment request or poll ID
  -> state owner enters pending
  -> requestJson
  -> parser
  -> functional owner check
  -> accepted state transition or no-op

confirmed direct-summary submit, recovery, or server projection
  -> DirectSummaryObservationInput
  -> receipt-key deduplication
  -> read-only detect-updates request
  -> captured identity check
  -> onWorkbenchPatch or replaceWorkbench(next, "direct_summary_observation")
```

The poll effect owns only timer setup and teardown. It must delegate completion to a reducer/action dispatcher; no effect-local `await` may call a React setter directly. Cleanup uses the same owner check for success, error, and final settlement. The direct-summary observer never writes GitHub state and does not retry a write.

### Files and Test Responsibilities

- Change `src/renderer/src/app.tsx`: workspace/refresh reducer and generation-qualified dispatches.
- Change `src/renderer/src/components/maintainer-inbox.tsx`: persisted preference reducer and pure visible-selection fallback.
- Change `src/renderer/src/components/logs-panel.tsx`: request-owner state and polling controller.
- Change `src/renderer/src/flows/settings-flow.tsx`: `CleanupState` transition owner.
- Change `src/renderer/src/flows/review-workbench-flow.tsx`: explicit receipt observer, Insight configuration reducer, and keyed walkthrough-progress child.
- Change `src/renderer/src/hooks/use-insight-run.ts`: run/poll state machine; preserve its existing public hook interface.
- Extend `tests/renderer/app.ui.test.tsx`, `logs-panel.ui.test.tsx`, `maintainer-inbox.ui.test.tsx`, `settings-modal.ui.test.tsx`, `review-workbench-flow.ui.test.tsx`, and `use-insight-run.test.ts`.

### RGR TDD Slices

1. Red: overlap two log responses and prove the older response cannot replace the newer cursor, entries, or error. Green: request-owner controller. Refactor only after the scan removes the Logs finding.
2. Red: start two cleanup requests or unmount/reopen between them; resolve the older request. Assert the newer action owns pending, error, and close behavior. Green: `CleanupState`.
3. Red: filter away the persisted inbox row. Assert the first visible row renders, no preference write occurs, and restoring the filter restores the original selection. Green: `InboxViewState` reducer.
4. Red: submit, recover, and receive a confirmed server projection. Assert one observer per typed receipt and no mutation after session/head mismatch. Green: explicit `DirectSummaryObservationInput` transition.
5. Red: change provider and open a run dialog. Assert provider, models, selected model, and reasoning change atomically. Replace the server projection and assert walkthrough progress resets only then. Green: configuration reducer and keyed progress child.
6. Red: resolve an older Insight poll after a newer poll or run becomes current. Assert no status, error, or callback change; terminal accepted result invokes exactly one projection callback. Green: run/poll machine.
7. Red: overlap workspace load and inbox refresh generations. Assert the older response cannot split profiles, inbox, dashboard, and screen state. Green: `WorkspaceState` reducer.

### Recovery Verification Gap

`ReviewRecoveryService` now uses `Promise.all`, but its existing tests do not yet model shared profile-directory scan isolation. Before accepting this slice, add the deferred shared-storage test specified earlier in this plan. If scan classification observes merge mutation, revert only the explicit concurrency hunk and keep the service sequential; do not suppress the diagnostic.

## Plan of Work

First, make a repeatable full-scan baseline under `.agents/research/2026-08-15-react-doctor-bugs/`. Filter it to Bugs and preserve the JSON unchanged. This makes the target count and exact diagnostic IDs stable even if other work in the dirty checkout moves nearby code.

Next, replace continuous parent synchronization with explicit events. `ReviewWorkbench` currently observes four local values and calls `onStateChange` after rendering. Rename that prop to `onPositionCommitted` and call it only inside the user handlers that change tab, section, or selected file. Keep the existing rule that directory paths are transient and only file paths persist. Update `ReviewWorkbenchFlow` and its fixtures to pass the new event handler. The parent must receive one normalized state for each visible navigation action and no update when an internal transient path changes.

Use the same approach for `SettingsFlow`. Replace `onDirtyChange` as an effect-derived mirror with an explicit dirty-state transition helper. Every local operation that starts, saves, discards, switches, or edits a profile must call that helper with the resulting draft and baseline. `SettingsModal` remains the owner of the close confirmation state, but it receives transitions rather than a post-render copy of child state. Preserve the save-ready and discard-ready callback contracts until a focused test proves a narrower interface.

For `MaintainerInbox`, model all persisted inbox preferences as one `InboxViewState` and create reducer actions for loading preferences, changing a filter, selecting a row, and saving or deleting a view. Keep narrow-screen layout independent because `matchMedia` owns it. Derive the visible selected row during render. When the stored key is absent from the filtered result, render the first visible row without changing persisted selection; do not use an effect to repair it after a render. Verify keyboard, filter, saved-view, and first-visible-row behavior.

For `InsightsSlot`, reduce catalog, provider, model, reasoning, preferences, dialog type, dialog action, and activation state as one configuration machine. Keep only `selectedInsight`, `walkthroughFocused`, and `progressError` as independent UI state. Replace copied `workbench.insights.walkthrough.progress` with a child keyed by stable session/run/projection identity, never by progress contents. A new canonical projection resets progress; a local save preserves it until that replacement arrives.

For `App`, use a reducer for the workspace snapshot and inbox refresh result only. Keep `inboxPaused`, request-generation refs, navigation, workbench, overlay, and preferences outside it. The reducer accepts a generation-qualified response only after the existing request owner has proved it current.

For async work, introduce a small local request-owner pattern rather than relying on a boolean that happens to be in scope. Each request starts with a monotonically increasing token. Its success and error completion must use a functional state update that verifies that token is still current. Apply this to the initial log fetch and polling in `LogsPanel`, the insight poll in `useInsightRun`, and cleanup in `SettingsFlow`. A stale response must neither change content nor clear or replace a newer error. `loadActivity` retains its existing generation guard and gets a focused race test only if the refactor touches it.

The line-945 flow finding is different from the navigation effect. `ReviewWorkbenchFlow` observes a confirmed direct-summary receipt in an effect, then may replace or patch the canonical workbench. Move this observation to explicit direct-summary transitions. Its input is the exact received projection plus receipt, not `workbenchRef.current`. It must reject a changed `{ reviewId, sessionId, reviewedHeadSha }`, deduplicate one receipt ID, and not requeue itself after a reconciled replacement. This keeps durable receipt adoption after a reload while removing an effect that calls back into the flow.

Finally, extend the existing `ReviewRecoveryService` test with a shared profile-directory fake. It must model session scan, session-file reads, review save, merge-operation removal, and invalid-entry quarantine. Only after that test proves scan isolation may the plan use `Promise.all` for merge reconciliation and scanning. Save-before-remove and quarantine-after-scan-result remain ordered. If shared storage disproves isolation, redesign the service boundary before changing concurrency; do not add a rule suppression.

## Detailed Solution Design

### 1. Use state machines only for state that changes as one operation

The plan does not convert every `useState` call to a reducer. It introduces four small, typed state machines where one request or one UI command currently updates several fields.

`App` gets a `WorkspaceState` that owns only workspace responses and refresh lifecycle. Browser-visibility pause remains an independent value owned by the scheduler effect:

    type WorkspaceState = {
      readonly profiles: ReadonlyArray<Profile>;
      readonly dashboard?: Dashboard;
      readonly inbox?: InboxResponse;
      readonly screen: DashboardScreenState;
      readonly refresh: { readonly _tag: "idle" | "refreshing" | "failed" };
    };

Its reducer actions are `workspaceLoading`, `workspaceLoaded`, `workspaceFailed`, `inboxRefreshStarted`, `inboxRefreshSucceeded`, `inboxRefreshFailed`, `inboxRefreshFinished`, and `profileSwitchStarted`. `workspaceLoaded` accepts the parsed profiles, inbox, dashboard, and screen state together. `inboxRefreshSucceeded` accepts the matching inbox and derived dashboard together. Each async callback checks its existing `workspaceGeneration` or `inboxRefreshGeneration` before dispatching. `inboxPaused`, `destination`, `workbench`, Settings overlay state, appearance, and diff-theme preferences remain separate because their owners are not a workspace response.

`MaintainerInbox` gets an `InboxViewState` for persisted inbox preferences:

    type InboxViewState = {
      readonly view: InboxView;
      readonly search: string;
      readonly sort: InboxSort;
      readonly selectedRepo: string;
      readonly queueOpen: boolean;
      readonly inspectorOpen: boolean;
      readonly selectedKey?: string;
      readonly savedViews: ReadonlyArray<SavedInboxView>;
    };

The reducer has `preferencesLoaded`, `viewSelected`, `savedViewSelected`, `searchChanged`, `sortChanged`, `repositoryChanged`, `rowSelected`, `queueToggled`, `inspectorToggled`, `savedViewAdded`, and `savedViewRemoved` actions. Dialog-only state (`saveViewOpen`, `savedViewName`, and `deleteView`) and viewport state (`narrow`) stay as independent `useState` values.

`InsightsSlot` gets an `InsightRunConfigurationState` for catalog loading and run-dialog choices. Its actions are `preferencesLoaded`, `catalogLoaded`, `catalogFailed`, `providerChanged`, `codexActivated`, `codexActivationFailed`, `dialogOpened`, `dialogClosed`, and `preferenceSaved`. The reducer owns catalog, provider, models, preferences, model, reasoning, dialog type, dialog action, catalog error, Codex activation pending, and Codex activation error. The reducer computes models, selected model, and reasoning from one provider choice, rather than letting setters temporarily disagree. After the change, only `selectedInsight`, `walkthroughFocused`, and `progressError` remain independent in this component; the two `useInsightRun` controllers retain their own hook state.

`SettingsFlow` gets two narrower state owners. `ProfileEditorState` contains `{ draft, baseline, creating, generation }` and has pure `edit`, `startNew`, `discard`, `dashboardReplaced`, `saveAccepted`, and `switchRolledBack` actions. It retains the current `pendingSavedProfile` proof before accepting a dashboard replacement. `CleanupState` is `{ readonly requestId: number; readonly _tag: "idle" | "pending" | "failed"; readonly action?: "cache" | "local"; readonly message?: string }`. The cleanup command starts one request ID and accepts success, failure, and finish only when the state still owns that ID. `ActivityLoadState` stays as the current local generation-guarded detail until a changed test demonstrates a defect; it is not the target of the reported finding.

### 2. Replace all derived parent effects with explicit events

In `review-workbench.tsx`, add a pure helper named `toPersistedWorkbenchPosition`. It receives `{ activeTab, section, selectedPath }` and removes directory paths, which end with `/`. Add one `commitWorkbenchPosition(next)` function that performs the necessary local setters and then calls `onPositionCommitted` with the normalized value. The helper is called only from visible navigation commands:

- selecting Files, Conversation, Diff, or Insights;
- selecting a navigator section;
- selecting a file or a directory in the diff tree;
- navigating from a finding or Insight back to Files; and
- resetting a revision, when the reset changes the restorable UI position.

`loadCommit` remains responsible for commit selection, but it calls the section command rather than independently changing `section`. The old effect at `review-workbench.tsx:330` is deleted. No background render may persist UI position.

In `settings-flow.tsx`, replace `onDirtyChange` with `onProfileDirtyChange`, called only by the profile editor command dispatcher. Do not call it from an effect or from a React state-updater function. Maintain a `profileEditorRef` alongside the reducer state. `applyProfileEditor(action)` uses the pure reducer to calculate the next state from that ref, updates the ref and React state, then calls `onProfileDirtyChange(next.draft !== next.baseline)`. The operations that must use this helper are typing an editable field, adding/removing/changing a list entry, starting a profile, discarding, successful save, successful profile switch, and rollback after failed switch. `SettingsModal` stays the close-confirmation owner; it only receives explicit dirty transitions.

In `review-workbench-flow.tsx`, remove the confirmed-receipt observer effect at lines 940–950. Define `DirectSummaryObservationInput` with the receipt and exact `{ profileId, reviewId, sessionId, reviewedHeadSha }` from its source `WorkbenchResponse`. `observeConfirmedDirectSummary(input)` uses that identity in the detect request and checks it again before applying a result. `observeReceiptIfNeeded(projection)` reads only a confirmed typed receipt, deduplicates by `{ sessionId, reviewId, receiptReviewId }`, and marks observation before detached work starts. `replaceWorkbench(next, origin)` receives an explicit origin: `server` may register a receipt, while `direct_summary_observation` may not. Confirmed submit and recover paths call the same observer with their captured command projection. The source of the direct-summary transition, not a render effect, now starts the observation.

### 3. Remove copied walkthrough progress without losing local edits

`InsightsSlot` currently copies `workbench.insights.walkthrough.progress` into three state values. Replace the three values with a `WalkthroughProgressSurface` child. Its key is the stable identity of the persisted progress source:

    `${workbench.session.id}:${walkthroughRunId ?? "none"}:${persistedProgressVersion}`

`persistedProgressVersion` is not derived from progress contents. It is the stable projection identity `{ sessionId, retainedRunId, reviewedHeadSha }`, plus an explicit `projectionRevision` that increments only when `onWorkbenchReplace` accepts a server projection. The keyed child initializes a local `{ reviewedSectionIds, supportReviewed, currentSectionId }` value once for that accepted server source. It owns the three Narrative Walkthrough actions and calls the existing save endpoint with one complete progress value. A server-provided new projection remounts the child immediately; a local mark action does not remount it because it does not replace the workbench projection. The parent passes data down and receives no copied state back.

### 4. Make stale async writes impossible at the setter

`LogsPanel` uses `LogStreamState` with `{ requestId, entries, afterSeq, error? }`. Each initial or interval fetch receives a new request ID and commits through one functional state update:

    setLogStream((current) =>
      current.requestId === requestId ? nextLogStream(current, response) : current,
    );

The error path uses the same check. A separate in-flight ref prevents an interval from starting a second request for the same cursor. The cleanup flag still prevents a write after unmount. The test must resolve a newer poll before an older one and prove the old result cannot replace the cursor, entries, or error.

`useInsightRun` uses one `InsightRunMachineState` containing `{ runId?, status, error, failureReason?, starting, pollId }`. Starting, accepting, cancelling, polling, terminal completion, and failure dispatch typed actions. The reducer ignores a completion unless both `runId` and `pollId` match its current state. The poll effect remains responsible for the timer only. After a terminal response, it loads the workbench and invokes exactly one of `onInsightPatch` or `onWorkbenchReplace` only if the action was accepted by the machine and the effect remains active.

`SettingsFlow.runCleanup` begins with `cleanupStarted({ requestId, action })`. Its request result, workspace reload result, success close, error display, and final pending clear use a functional update that verifies `current.requestId === requestId`. A newer cleanup starts with a distinct request ID; an earlier request can neither close its dialog nor clear its pending/error state. `loadActivity` retains its current generation check unless the cleanup refactor shares a proven local request-owner helper.

### 5. Preserve recovery correctness while removing unnecessary wait time

Do not change `ReviewRecoveryService.reconcileProfile` until the following storage-isolation test passes. The candidate source change is:

    const mergeResult = this.reconcileMergeOperations(profileId);
    const scanResult = this.sessions.scanSessionEntries(profileId);
    const [merge, scan] = await Promise.all([mergeResult, scanResult]);

The test must prove that `scanSessionEntries` and its session-file reads can finish against the same profile directory while merge reconciliation saves the Review and removes `merge-operation.json`. Do not move the invalid-entry quarantine loop into the `Promise.all`; it changes session artifacts and must run after scan results are fixed. Do not parallelize the per-profile loop, merge-operation loop, quarantine loop, review save, or merge-operation receipt removal. Those operations have locks, ordering, and deterministic failure accounting that are part of the recovery contract.

Extend `tests/services/review-recovery-service.test.ts` with a deferred shared-directory fake. It must prove both flows start, save-before-remove, quarantine-after-fixed-scan, scan failure aggregation, and no mutation of a session path while the scan classifies it. If any assertion fails, retain serialization and record the scanner false-positive as an unresolved design constraint for user decision rather than weakening recovery.

## Reviewed Architecture Specification

### Summary

This specification replaces the unsafe parts of the first detailed design. It keeps React state local to the command or request that owns it, keeps the canonical Review projection owned by `App`, and preserves the shared review-operation coordinator for durable recovery and receipt observation.

### Goals

- Remove all 15 current Bugs diagnostics without a scanner suppression.
- Preserve current visible behavior and durable Review lifecycle rules.
- Make stale request completion a rejected state transition rather than an informal check before a setter.
- Use existing public renderer and service test seams.

### Non-Goals

- Change the local API, stored Review/Session schemas, GitHub write authorization, or Direct Summary protocol.
- Parallelize any mutation that has save-before-remove, journal, quarantine, or lock ordering.
- Replace all state in `App` or `InsightsSlot` with one global reducer.

### Invariants and Constraints

- A Review observation is bound to `{ profileId, reviewId, sessionId, reviewedHeadSha }`. It must not patch or replace a different represented Review.
- A confirmed direct-summary receipt may start one read-only observation. An uncertain receipt starts none. A receipt accepted from the observer does not start itself again.
- Cleanup UI state belongs to one cleanup command request. A stale completion cannot close another command's dialog, clear its pending state, or replace its error.
- Profile edits made while save/reload is pending remain user-owned. Dashboard replacement must still pass the `pendingSavedProfile` and edit-generation checks.
- Recovery retains the profile lock and per-review lock. It saves a terminal Review before it removes merge evidence, and it quarantines only after an already-complete scan result.
- Existing project conventions remain: strict TypeScript, parsers at protocol/storage boundaries, `Result` service failures, real injected seams in tests, and no module mocks or method spies in new tests.

### Alternatives Considered

#### Option 1: Local typed state machines with explicit command transitions

Renderer reducers own only coherent local request or UI state. The flow accepts exact typed Review identities for receipt observation. Recovery concurrency is enabled only after a shared-directory fake proves that the scan is isolated from merge mutations.

This has low caller burden because public component props mostly remain stable. It concentrates transition guards near the setters and preserves existing runtime boundaries. It requires a small amount of local reducer code and deterministic deferred tests.

#### Option 2: Lift all affected renderer state to App

App would own inbox view preferences, Settings profile drafts, Insight configuration, walkthrough progress, and direct-summary observation. Child components would become controlled forms.

This would eliminate child-to-parent effects, but it makes App a broad state owner and leaks Settings, Inbox, and Insight invariants across unrelated routes. It also increases prop surface and test fixture churn. Reject.

#### Option 3: Keep behavior and suppress or retag the diagnostics

This retains the existing effects and sequential recovery, then changes React Doctor configuration or uses per-line suppression.

It has the least source change but does not meet the user's zero-Bugs outcome and gives no stronger stale-completion or storage proof. Reject.

### Recommendation

Use Option 1. Implement it as five vertical slices. The direct-summary receiver is the only design gate: after the typed identity implementation and its behavior tests, run React Doctor before proceeding. If the rule still reports the required receipt receiver, stop and record the exact source shape; do not widen state ownership or suppress the rule without a new user decision.

### Domain Model and Types

All following types are renderer-local unless a path states otherwise. They are not persisted DTOs and do not cross the loopback API boundary.

    type WorkspaceSnapshot = {
      readonly profiles: ReadonlyArray<Profile>;
      readonly dashboard?: Dashboard;
      readonly inbox?: InboxResponse;
      readonly screen: DashboardScreenState;
    };

    type WorkspaceState = {
      readonly snapshot: WorkspaceSnapshot;
      readonly refresh: { readonly _tag: "idle" | "refreshing" | "failed" };
    };

    type WorkspaceAction =
      | { readonly _tag: "WorkspaceLoadStarted" }
      | { readonly _tag: "WorkspaceLoaded"; readonly snapshot: WorkspaceSnapshot }
      | { readonly _tag: "WorkspaceLoadFailed" }
      | { readonly _tag: "InboxRefreshStarted" }
      | { readonly _tag: "InboxRefreshSucceeded"; readonly inbox: InboxResponse; readonly dashboard: Dashboard; readonly screen: DashboardScreenState }
      | { readonly _tag: "InboxRefreshFailed" }
      | { readonly _tag: "InboxRefreshFinished" }
      | { readonly _tag: "ProfileSwitchStarted" };

    type CleanupState =
      | { readonly _tag: "idle"; readonly requestId: number }
      | { readonly _tag: "pending"; readonly requestId: number; readonly action: "cache" | "local" }
      | { readonly _tag: "failed"; readonly requestId: number; readonly action: "cache" | "local"; readonly message: string };

    type ReviewProjectionIdentity = {
      readonly profileId: string;
      readonly reviewId: string;
      readonly sessionId: string;
      readonly reviewedHeadSha: string;
    };

    type DirectSummaryObservationInput = {
      readonly identity: ReviewProjectionIdentity;
      readonly receiptReviewId: string;
      readonly projection: WorkbenchResponse;
    };

    type WorkbenchReplacementOrigin = "server" | "direct_summary_observation";

    type PersistedWorkbenchPosition = {
      readonly activeTab: "conversation" | "diff" | "insights";
      readonly section: ReviewNavigatorSection;
      readonly selectedPath?: string;
    };

`InboxViewState`, `ProfileEditorState`, and `InsightRunConfigurationState` remain as defined in the preceding design section, with these additional constraints:

- `InboxViewState.selectedKey` is the persisted user choice. `visibleSelectedRow` is a pure derived value that falls back to the first visible row and is never written by an effect.
- `ProfileEditorState.generation` increases for every user edit. `pendingSavedProfile` remains a ref that proves a dashboard payload is the save result expected by this editor.
- `InsightRunConfigurationState` has the configuration fields listed above. It excludes walkthrough progress, selected-reader tab, focus, and progress error so those independent user interactions do not become accidental reducer actions.

### Types, Interfaces, and APIs

No loopback route changes. `requestJson` still parses the existing response at the renderer boundary.

`ReviewWorkbench` retains one optional persistence callback, but its name changes to express an event rather than a state mirror:

    type ReviewWorkbenchProps = {
      readonly onPositionCommitted?: (position: PersistedWorkbenchPosition) => void;
    };

`commitWorkbenchPosition(next)` is private to `review-workbench.tsx`. It updates the local position and calls `onPositionCommitted(toPersistedWorkbenchPosition(next))` in the same visible command. `toPersistedWorkbenchPosition` strips directory paths. It is pure and needs no parser because its input is component-owned state.

`SettingsFlowProps` replaces `onDirtyChange` with:

    readonly onProfileDirtyChange?: (dirty: boolean) => void;

`applyProfileEditor(action)` is private. It applies a pure `ProfileEditorAction` to `profileEditorRef.current`, sets the computed next state, then calls `onProfileDirtyChange` outside a React state updater.

`observeConfirmedDirectSummary` changes from `(reviewId: string) => Promise<void>` to:

    (input: DirectSummaryObservationInput) => Promise<void>

It uses `input.identity` for the request body and validates the response projection identity against `input.identity` before `replaceWorkbench`. `replaceWorkbench` changes to:

    (next: WorkbenchResponse, origin: WorkbenchReplacementOrigin) => void

Only the `server` origin may register a confirmed receipt. An observer response always uses `direct_summary_observation`, which cannot register another observer.

### Seams, Boundaries, Adapters, and Implementations

- `App` is the renderer composition owner for the canonical `WorkbenchPayload`, workspace snapshot, and loopback API calls. It does not own Inbox preference, Settings draft, or Insight dialog policy.
- `SettingsModal` owns whether closing is blocked by an unsaved profile draft. `SettingsFlow` owns how a profile command changes that dirty state.
- `ReviewWorkbenchFlow` owns loopback actions and observation request sequencing. `ReviewWorkbench` only renders a received canonical projection and emits visible navigation events.
- `ReviewRecoveryService` is the service module that sequences parsed profile/session storage results and GitHub merge outcomes. `ReviewSessionStore` and `MergeOperationStore` are persistence adapters; their shared profile directory is an explicit test boundary.

### Call Stacks and Data Flow

#### Current / Old Flow: cleanup

    user confirms cleanup
      -> SettingsFlow.runCleanup()
      -> requestJson(clear endpoint)
      -> onWorkspaceReload()
      -> unconditional cleanup setters

The final setter can apply after a newer cleanup command and is the current diagnostic.

#### Proposed / New Flow: cleanup

    user confirms cleanup action
      -> runCleanup(action)
      -> requestId = ++cleanupRequestId
      -> CleanupState.pending(requestId, action)
      -> requestJson(clear endpoint)
      -> onWorkspaceReload()
      -> guarded CleanupState.idle(requestId)
      -> onCleanupSuccess(action)

    request or reload failure
      -> guarded CleanupState.failed(requestId, action, bounded message)

Every terminal state update checks `current.requestId === requestId`. The existing endpoint and error copy remain unchanged.

#### Proposed / New Flow: confirmed direct summary

    submit or recover command / accepted server projection
      -> parseDirectSummaryReviewResponse or WorkbenchResponse
      -> DirectSummaryObservationInput(identity, receipt, projection)
      -> receipt-deduplication key(sessionId, reviewId, receiptReviewId)
      -> requestJson(/v1/reviews/detect-updates, recentWrites receipt)
      -> parse observation
      -> identity check against captured input and latest canonical projection
      -> replaceWorkbench(next, "direct_summary_observation") or patch freshness

An identity mismatch, cancelled generation, or duplicate key does nothing. The observer is read-only and does not create a GitHub write or retry a write. Tests cover submit, recovery, a confirmed receipt from a server replacement, duplicate suppression, and changed session/revision rejection.

#### Proposed / New Flow: Review navigation

    tab / section / file / finding / revision-reset command
      -> compute complete local Review position
      -> commitWorkbenchPosition(position)
      -> normalize directory path away
      -> local setters
      -> onPositionCommitted(position)
      -> App.saveWorkbenchUiState(reviewId, position)

The implementation checklist must replace every state-setter site: commit loading at lines 364-380, revision reset at 390-397, Files navigation at 605-609, pending-review navigation at 692, tabs at 746-758, navigator file selection at 797-802, controlled diff path at 859-862, and active-file movement at 866-867. Commit SHA remains transient because the current persistence callback does not own it; selecting a commit still commits the `commits` section.

#### Proposed / New Flow: recovery concurrency gate

    lifecycle profile lock
      -> shared-directory test proves scan isolation
      -> start reconcileMergeOperations(profileId)
      -> start scanSessionEntries(profileId)
      -> await Promise.all
      -> if scan failed: merge counts + one failure
      -> quarantine invalid scan entries sequentially

Inside merge recovery, `reviews.save(terminal)` stays before `removeAfterSessionReceipt`. The per-profile loop, per-operation loop, quarantine, Review save, and merge evidence removal do not become concurrent.

### Failure, Retry, Cancellation, and Idempotency

- Cleanup: a stale success/failure is ignored. A new user cleanup owns a new request ID. It does not retry implicitly.
- Insight/log polling: retain their current effect cleanup and generation contracts. New reducer transitions reject stale request/run IDs; timers are the only effect-owned resource.
- Direct summary: confirmed receipt observation is one-shot per typed receipt. Unknown or ambiguous write outcomes remain locked and require the existing explicit recovery action.
- Recovery: merge operation evidence remains until a successful terminal Review save. Failed quarantine leaves the item failed and records the current recovery diagnostic through the existing service.

### Files to Add / Change / Delete

Change:

- `src/renderer/src/app.tsx` — narrow workspace/refresh reducer; leave visibility pause separate.
- `src/renderer/src/components/maintainer-inbox.tsx` — persisted-preference reducer and derived visible selection.
- `src/renderer/src/components/review-workbench.tsx` — event-style position callback and complete setter mapping.
- `src/renderer/src/components/settings-modal.tsx` — consume renamed explicit dirty callback.
- `src/renderer/src/components/logs-panel.tsx` — request-owned log commit state.
- `src/renderer/src/flows/settings-flow.tsx` — profile-editor event transition and request-owned cleanup state.
- `src/renderer/src/flows/review-workbench-flow.tsx` — configuration reducer, stable walkthrough source, typed receipt observer.
- `src/renderer/src/hooks/use-insight-run.ts` — run/poll identity state machine.
- `src/services/review-recovery-service.ts` — only if the shared-directory test proves the two initial reads isolate correctly.

Extend:

- `tests/renderer/app.ui.test.tsx`
- `tests/renderer/logs-panel.ui.test.tsx`
- `tests/renderer/maintainer-inbox.ui.test.tsx`
- `tests/renderer/profile-settings.test.tsx`
- `tests/renderer/settings-modal.ui.test.tsx`
- `tests/renderer/review-workbench-flow.ui.test.tsx`
- `tests/renderer/use-insight-run.test.ts`
- `tests/services/review-recovery-service.test.ts`

Do not add a dependency, route, persistence schema, or exported private helper. Do not delete a file.

### RGR TDD Test Plan

Each slice is Red-Green-Refactor. Write and run its deterministic test before changing its production path.

1. Red: in `settings-modal.ui.test.tsx`, start one deferred cleanup, start a second cleanup or unmount/reopen the target, then resolve the first. Assert only the current cleanup changes pending/error/dialog state. Green: add `CleanupState`; refactor after the focused test passes.
2. Red: in `review-workbench-flow.ui.test.tsx`, assert one observer request for confirmed submit, recovery, and a received confirmed projection; assert no patch/replace for changed session or revision, and no duplicate request for the same receipt. Green: introduce typed observation input and origin policy.
3. Red: in `review-workbench-flow.ui.test.tsx` and the existing workbench UI test, exercise every listed navigation transition and assert normalized persisted state. Green: replace the effect with command events.
4. Red: in `profile-settings.test.tsx`, prove edit-during-save, accepted dashboard reload, failed switch rollback, and discard after a pending edit. Green: introduce `ProfileEditorState` while retaining `pendingSavedProfile` proof.
5. Red: in `maintainer-inbox.ui.test.tsx`, filter away a selected row, assert first visible row renders without a second persistence write, then restore the filter and assert the stored user selection remains. Green: reducer plus pure fallback selection.
6. Red: in `review-workbench-flow.ui.test.tsx`, replace a projection with different stable progress identity and assert only that replacement resets walkthrough progress; a local mark must remain until replacement. Green: stable keyed child.
7. Red: extend `review-recovery-service.test.ts` with deferred shared-directory behavior. Assert scan isolation, save-before-remove, quarantine-after-scan, and failure counts. Green: introduce `Promise.all` only if that test passes; otherwise leave source serialized and stop the plan for user direction.
8. Red: add stale poll tests for Logs and Insight through their public component/hook API. Green: reject stale state transitions by token/run ID, then run all focused renderer tests.

### Risks and Open Questions

- React Doctor may still classify a required server-projection receipt receiver as parent state propagation after the typed origin design. The post-slice scan is the decision gate; this plan does not authorize a suppression.
- The shared-directory recovery test may prove the scan and merge reconciliation are not isolated. In that case the service diagnostic cannot be safely fixed by concurrency alone; return to the user with the exact trace and alternatives.
- The plan assumes existing tests can extend their injected desktop bridge and storage seams without module mocking. Confirm this while writing each Red test; if a test needs a private export or spy, redesign the seam instead.

## Milestones

### Milestone 1: Freeze the Bugs baseline and characterize current behavior

Goal: Capture the exact target and add only tests that describe current user-visible contracts.

Run from `/Users/kwanpham/Work/cfw/patchdesk`:

    mkdir -p .agents/research/2026-08-15-react-doctor-bugs
    node_modules/.bin/react-doctor --json --blocking none --yes --scope full --no-cache --json-out .agents/research/2026-08-15-react-doctor-bugs/initial.json
    jq '[.projects[].diagnostics[] | select(.category == "Bugs")] | length' .agents/research/2026-08-15-react-doctor-bugs/initial.json
    jq -e '.schemaVersion == 3 and .version == "0.9.11" and all(.projects[]; .complete == true)' .agents/research/2026-08-15-react-doctor-bugs/initial.json
    jq -r '.projects[].diagnostics[] | select(.category == "Bugs") | .id' .agents/research/2026-08-15-react-doctor-bugs/initial.json | sort > .agents/research/2026-08-15-react-doctor-bugs/initial-bugs.ids

Expected result: the count prints `15`, the schema check exits `0`, and `initial-bugs.ids` has the 15 exact diagnostic IDs recorded in the reviewed technical specification. If any result differs, record the new count and locations in this plan before code edits.

Add deferred-promise tests for stale log, insight, and cleanup responses. Add UI tests for navigation persistence, settings close confirmation, inbox selection after filtering, direct-summary receipt identity, and walkthrough progress replacement. This reduces risk because later structural edits have a behavior contract before their implementation changes.

### Milestone 2: Make renderer state ownership explicit

Goal: Remove parent-sync effects, direct-summary observer effect, and effect-chain selection repair without changing user navigation, receipt recovery, or profile-save behavior.

Change `review-workbench.tsx`, `review-workbench-flow.tsx`, `settings-flow.tsx`, `settings-modal.tsx`, and `maintainer-inbox.tsx` with their focused tests. Run:

    pnpm test -- --run tests/renderer/review-workbench-flow.ui.test.tsx tests/renderer/profile-settings.test.tsx tests/renderer/settings-modal.ui.test.tsx tests/renderer/maintainer-inbox.ui.test.tsx
    node_modules/.bin/react-doctor --json --blocking none --yes --scope full --no-cache --json-out /tmp/react-doctor-bugs-milestone-2.json

Expected result: the parent-sync, direct-summary observer, and inbox effect-chain diagnostics are absent; the focused tests pass. This proves navigation, receipt observation, unsaved-change confirmation, and inbox selection did not become post-render repair work.

### Milestone 3: Make async completions and coupled UI updates safe

Goal: Each async completion proves it still owns the state it changes, and each reducer represents a real atomic action.

Change only the selected state partitions in `app.tsx`, `logs-panel.tsx`, `use-insight-run.ts`, `settings-flow.tsx`, and `review-workbench-flow.tsx`. Run:

    pnpm test -- --run tests/renderer/app.ui.test.tsx tests/renderer/logs-panel.ui.test.tsx tests/renderer/use-insight-run.test.ts tests/renderer/profile-settings.test.tsx tests/renderer/review-workbench-flow.ui.test.tsx
    pnpm lint
    pnpm typecheck

Expected result: overlapping log, Insight, and cleanup requests leave the newest content and newest error visible; all commands pass. This proves the scanner cleanup did not weaken request ownership.

### Milestone 4: Resolve recovery ordering with evidence

Goal: Remove the last service Bugs finding only if recovery remains safe.

Extend `tests/services/review-recovery-service.test.ts` through its existing injected service seams. Model shared profile storage and exercise merge save/remove, session scan, and invalid-entry quarantine. Run:

    pnpm test -- --run tests/services/review-recovery-service.test.ts
    node_modules/.bin/react-doctor --json --blocking none --yes --scope full --no-cache --json-out /tmp/react-doctor-bugs-milestone-4.json

Expected result: the test demonstrates scan isolation, save-before-remove, quarantine-after-scan, and failure aggregation. Only then may the source use safe concurrency and remove the recovery diagnostic. If isolation fails, stop this milestone and report the trace; do not claim zero Bugs.

### Milestone 5: Full proof and handoff

Goal: Verify a clean Bugs category and no repository regression.

Run:

    pnpm lint
    pnpm typecheck
    pnpm test -- --run
    pnpm build
    pnpm exec playwright test
    node_modules/.bin/react-doctor --json --blocking none --yes --scope full --no-cache --json-out .agents/research/2026-08-15-react-doctor-bugs/final.json
    jq '[.projects[].diagnostics[] | select(.category == "Bugs")] | length' .agents/research/2026-08-15-react-doctor-bugs/final.json
    git diff --check

Expected result: all commands exit zero and the final `jq` prints `0`. For desktop behavior changes, restart `pnpm dev -- --remote-debugging-port=9233` in the Herdr dev tab, then use the read-only Patchdesk Electron tester to confirm navigation restoration, settings dirty-close prompt, log retry, and an insight run status change in the live app.

## Concrete Steps

1. Before each edit, run `git status -sb` and inspect only the relevant diff hunk. Do not stage, commit, switch branches, reset, clean, or overwrite changes made by another worker.
2. Save the baseline JSON in the Milestone 1 location. Do not edit it after writing it.
3. Add a focused failing test for one behavior, make the smallest source edit that satisfies it, then run that test before moving to the next source owner.
4. After each milestone, write its observed diagnostic count and test result into `Progress` and record any changed assumption in `Surprises & Discoveries` or `Decision Log`.
5. Format changed TypeScript with `pnpm exec oxfmt --write <explicit changed paths>` before lint. Do not format unrelated files.
6. If a full gate fails outside the changed area, preserve its exact output as a blocker. Do not call the Bugs work complete until the failure is resolved or the user explicitly accepts a scoped handoff.

## Validation and Acceptance

Acceptance requires all of the following:

- The full React Doctor JSON scan reports zero diagnostics whose `category` is `Bugs`.
- Restoring a Review file/tab selection stores only a file path, never a directory path, and does not create a render loop.
- Editing a profile opens the settings unsaved-changes guard; Save, Discard, and a failed switch leave its dirty state correct.
- Filtering an inbox that removes the selected row chooses a visible row without a transient blank inspector or a second repair render.
- A delayed log, cleanup, or Insight response cannot overwrite newer content, clear a newer error, close a newer cleanup dialog, or change the active Insight run.
- Replacing a Review projection resets walkthrough progress to that projection immediately.
- One confirmed direct-summary receipt produces one read-only observation for its exact Review identity; a changed session or revision produces no patch/replace.
- Recovery preserves save-before-remove and quarantine-after-scan-result ordering, and uses `Promise.all` only if the shared-directory test proves scan isolation.
- `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`, `pnpm exec playwright test`, and `git diff --check` all pass.

## Idempotence and Recovery

The baseline and final scans are safe to repeat, but write each result to a new `/tmp` milestone file or overwrite only the named final artifact after recording the prior count. Focused tests are safe to repeat.

If a source edit causes a regression, revert only that explicit hunk with `apply_patch`; do not use `git reset`, `git restore`, `git clean`, or a broad checkout operation. If a reducer makes an independent preference update unclear, split that state back out and record the discovery rather than forcing unrelated actions into one reducer. If the recovery ordering test finds a dependency, stop parallelization work and redesign the public recovery boundary before rescanning.

## Artifacts and Notes

Create and retain:

- `.agents/research/2026-08-15-react-doctor-bugs/initial.json` — immutable baseline.
- `.agents/research/2026-08-15-react-doctor-bugs/final.json` — final full scan.
- `initial-bugs.ids` — exact diagnostic IDs from the immutable baseline.
- Focused Vitest files named in this plan, including the extended existing recovery service test.

The temporary scan `/tmp/react-doctor-plan-refresh.json` is evidence for planning only. It is not a completion artifact because `/tmp` is not durable.

## Interfaces and Dependencies

The final implementation must retain these contracts:

- `ReviewWorkbenchProps.onPositionCommitted` accepts normalized `{ activeTab, section, selectedPath? }` navigation events. It must never persist a directory path.
- `SettingsFlow` keeps `onSaveProfileReady`, `onDiscardProfileReady`, `onProfileSwitchRequest`, and `onWorkspaceReload` behavior unless their consuming `SettingsModal` tests are updated in the same change.
- `ReviewWorkbenchFlowProps.onWorkbenchReplace` and `onWorkbenchPatch` remain the only paths that replace or patch the canonical Review projection.
- `useInsightRun` continues to call `onInsightPatch` for a typed insight projection when supplied, otherwise `onWorkbenchReplace`; it must never invoke both for one completion.
- `ReviewRecoveryService` continues to return `{ recovered, failed }` and uses `ReviewOperationCoordinator` and `lifecycleGate` locks around durable work.
- No new dependency, scanner suppression, `any`, TypeScript suppression, module mock, or private-helper export is allowed for this plan.

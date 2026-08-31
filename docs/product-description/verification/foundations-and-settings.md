# Verification: foundations and Settings

How to run this file: start a clean default macOS Patchdesk profile with no pending GitHub write, no Dirty draft, and no running Insight. Use a disposable profile and local root for profile, storage, and cleanup rows. `mouse`, `keyboard`, and `desktop menu` mean real input in the app window; `offline` and `write` require the disposable conditions described in [the protocol](README.md#required-conditions). Leave every Result as `—` until a live pass.

## foundations/task-lifecycle-and-interruption.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TASK-01 | P1 | mouse | A tracked pending action shows feature-local progress and the titlebar busy bar remains until overlapping tracked work settles. ([Begin an action](../foundations/task-lifecycle-and-interruption.md#begin-an-action)). | Open a Pull requests listing and arrange two independent reads or one read plus a tracked load. | 1. Start the first action.<br>2. Start the second allowed action before the first settles.<br>3. Let them settle in reverse order. | The owning controls show their own pending states; the titlebar bar remains while either tracked action is pending and clears only after both settle. | blocked — no controlled overlapping-action fixture; only a single refresh pending state was observable. |
| TASK-02 | P1 | offline, write | A confirmed failure is retryable when safe, while an uncertain GitHub write enters recovery instead of automatic retry. ([Settle](../foundations/task-lifecycle-and-interruption.md#settle)). | Use a disposable read failure and a separately approved disposable write whose response can be made uncertain. | 1. Trigger the confirmed read failure and record its error.<br>2. Trigger the approved write interruption.<br>3. Observe both settled surfaces. | The read shows a bounded retry path; the uncertain write shows reconciliation or recovery, remains locked, and is not submitted again automatically. | blocked — controlled offline read and approved outcome-unknown write were not available. |

Not checkable by hand:

- Exact internal queue and lock ordering; observe only the user-visible pending and settled states.

## foundations/navigation-and-overlays.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NAV-01 | P1 | keyboard | Settings opens as an overlay above either primary destination and normally returns focus to its opener. ([Arrive](../foundations/navigation-and-overlays.md#arrive)). | Be on Pull requests with a focused control that opens Settings. | 1. Open Settings with the focused control.<br>2. Switch to Logs.<br>3. Close Settings.<br>4. Repeat from a Review workbench opener. | Settings overlays the current destination, opens on the requested section, and focus returns to the control that opened it. | blocked — Settings over Pull requests was visible; Review-workbench opening and focus return were unavailable. |
| NAV-02 | P1 | mouse | A Dirty workspace-profile draft requires Save, Discard changes, or Cancel before Settings closes or the active profile changes. ([While the action runs](../foundations/navigation-and-overlays.md#while-the-action-runs)). | Open Settings > Workspace with a disposable profile. | 1. Change the profile label without saving.<br>2. Click Close.<br>3. Choose Cancel and confirm the draft remains.<br>4. Repeat and choose Discard changes. | The guard offers the three choices; Cancel keeps the draft and Discard closes or continues without the unsaved edit. | pass — Close showed Save, Discard changes, and Cancel; Cancel preserved the draft and Discard closed it. |
| NAV-03 | P1 | macOS window, desktop menu, write | A pending GitHub write blocks navigation and native window close until its final result arrives. ([Settle](../foundations/navigation-and-overlays.md#settle)). | Use an approved disposable GitHub write and keep it pending. | 1. Begin the write.<br>2. Choose another destination and invoke native window close.<br>3. Let the write settle. | Navigation and close are blocked with a wait message while pending; after settlement the normal destination/close action can proceed. | blocked — requires an approved pending GitHub write and native macOS close. |

Not checkable by hand:

- Whether every platform-level close path uses the same native prompt implementation; check only the supported macOS window behavior.

## foundations/workspace-profile-and-identity.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PROFILE-01 | P1 | keyboard | Saving a profile trims valid values, rejects blank list entries, and keeps edits typed after save began as a newer Dirty draft. ([Begin an action](../foundations/workspace-profile-and-identity.md#begin-an-action)). | Open Settings > Workspace with a disposable profile. | 1. Add surrounding spaces to a scalar and a valid list entry.<br>2. Add a blank list entry and attempt Save.<br>3. Remove the blank entry and save while typing a further label edit before the response. | Blank list input is rejected; accepted values are normalized; the post-submit edit remains Dirty rather than being overwritten by the older save. | blocked — blank list rejection was visible, but profile save returned HTTP 400, so normalization and concurrent edit preservation could not be checked. |
| PROFILE-02 | P1 | mouse | Switching profiles applies the selected profile and reloads Pull requests under its identity without reusing the prior workbench. ([Settle](../foundations/workspace-profile-and-identity.md#settle)). | Have two disposable profiles with different labels or watched repositories. | 1. Open the profile switcher.<br>2. Select the second profile.<br>3. Wait for reload. | The active profile label and Pull requests scope change together; the prior Review workbench is not shown under the new profile. | blocked — only one isolated profile was available. |

Not checkable by hand:

- Credential absence in persisted files; verify with a safe fixture or storage inspection only when the test environment permits it.

## foundations/review-session-and-revision.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REV-01 | P1 | mouse, write | A Review remains bound to one immutable represented revision; a changed head or base prevents adoption of mixed evidence. ([While the action runs](../foundations/review-session-and-revision.md#while-the-action-runs)). | Open a disposable Pull request with a prepared Review and approved permission to update its branch. | 1. Start a Review refresh or preparation.<br>2. Change the pull request head or base before the operation settles.<br>3. Observe the workbench. | Patchdesk refuses the mixed candidate, keeps the prior readable session, and reports revision change or unavailable evidence. | blocked — no prepared writable pull request or controlled revision change was available. |
| REV-02 | P1 | mouse | A terminal Review remains readable but rejects further Review or merge writes. ([Edge cases](../foundations/review-session-and-revision.md#edge-cases)). | Use a disposable pull request that is authoritatively merged or closed. | 1. Refresh or reopen the Review.<br>2. Inspect the terminal state.<br>3. Look for Review and merge actions. | Terminal state is visible; write controls are absent or disabled and no write is attempted. | blocked — no terminal saved Review was available. |

Not checkable by hand:

- Canonical patch-hash derivation; inspect only its visible freshness consequence.

## foundations/persistence-and-recovery.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| STORE-01 | P1 | mouse | Config, Local data, Cache, Logs, and Diagnostics have separate retention behavior. ([Arrive](../foundations/persistence-and-recovery.md#arrive)). | Use a disposable profile with one stored Review and a represented worktree. | 1. Open Settings > Data & recovery.<br>2. Read the Clear cache and Clear local review data confirmations without confirming.<br>3. Open Logs and Review activity. | The copy distinguishes rebuildable Cache, durable Review data, app Logs, and redacted Diagnostics; no data changes before confirmation. | blocked — cleanup copy, Logs, and empty Review activity were visible, but no stored Review or represented worktree fixture was available. |
| STORE-02 | P1 | offline | Interrupted or invalid durable state is recovered, quarantined, or locked rather than silently adopted. ([Settle](../foundations/persistence-and-recovery.md#settle)). | Use a disposable test root with an interrupted preparation, orphaned Insight, corrupt session, or uncertain write supplied by the test harness. | 1. Restart the app.<br>2. Return to the affected Review or Settings surface.<br>3. Observe the recovery state. | The app shows a bounded recovered, retryable, quarantined, or reconciliation state; it does not show partial state as confirmed. | blocked — no interrupted or corrupt durable-state fixture was available. |
| STORE-03 | P1 | destructive | Retention removes only terminal/orphaned sessions older than 14 days and quarantine entries older than 30 days. ([Edge cases](../foundations/persistence-and-recovery.md#edge-cases)). | Use a disposable data root with records just inside and just beyond both retention thresholds. | 1. Start the app and allow the scheduled sweep.<br>2. Inspect the records through the approved test harness or safe listing.<br>3. Compare each age boundary. | Records at or below each threshold remain; older eligible records are removed; active records remain protected. | blocked — no approved destructive aged-record fixture was available. |

Not checkable by hand:

- Atomic fsync and path-ownership invariants; verify through the storage test harness, not destructive production data.

## settings/workspace-profile-editor.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SETUP-01 | P1 | mouse | A blank workspace-profile list entry is rejected before save, and Discard restores the last saved baseline. ([While the action runs](../settings/workspace-profile-editor.md#while-the-action-runs)). | Open Settings > Workspace with a disposable profile containing one valid list entry. | 1. Add a blank list entry.<br>2. Attempt Save.<br>3. Remove the blank entry and save.<br>4. Edit the profile again and choose Discard changes. | The blank list entry prevents the save; after a valid save, Discard restores the saved baseline. | blocked — blank list input was rejected and the dirty guard worked, but a valid profile save failed with HTTP 400, so the saved baseline could not be established. |
| SETUP-02 | P1 | keyboard | A profile switch with a Dirty draft requires an explicit Save, Discard, or Cancel choice. ([Cancel and interrupt](../settings/workspace-profile-editor.md#cancel-and-interrupt)). | Have two disposable profiles and a Dirty draft in the first. | 1. Start switching to the second profile.<br>2. Choose Cancel and verify the first draft remains.<br>3. Repeat and choose Save. | Cancel stays on the first profile; Save completes before switching and the second profile becomes active. | blocked — requires two disposable profiles; only one isolated profile was available. |
| SETUP-03 | P1 | mouse | Malformed or empty scalar profile input currently reaches the main process and returns the generic `Profile update failed` request error (suspected defect). ([While the action runs](../settings/workspace-profile-editor.md#while-the-action-runs)). | Open Settings > Workspace with a disposable profile and a valid saved baseline. | 1. Enter a malformed host or empty scalar value.<br>2. Attempt Save.<br>3. Record the visible error and whether the field receives inline guidance. | The current behavior is a generic `Profile update failed` request error rather than field guidance. If live verification confirms this loses the user's intended edit or is a product defect, record a fail and triage entry for `SETUP-03`. | fail — malformed GitHub host reached PUT /v1/profiles, returned HTTP 400 and only generic Profile update failed guidance; no field guidance appeared. Evidence: /private/tmp/patchdesk-product-verification-malformed-host.png. |
| SETUP-04 | P1 | mouse | Clicking New profile while an existing profile draft is Dirty currently replaces the draft without Save, Discard changes, or Cancel (suspected defect). ([Cancel and interrupt](../settings/workspace-profile-editor.md#cancel-and-interrupt)). | Open Settings > Workspace, change a saved profile field without saving, and keep the draft Dirty. | 1. Click New profile.<br>2. Observe whether a guard appears.<br>3. Inspect the new profile and return to the original profile if possible. | The current behavior is that New profile replaces the Dirty draft without a Save/Discard/Cancel choice. If live verification confirms work loss, record a fail and triage entry for `SETUP-04`. | fail — New profile replaced the Dirty draft without a Save, Discard changes, or Cancel guard. Evidence: /private/tmp/patchdesk-product-verification-new-profile.png. |

Not checkable by hand:

- Whether all account-detection failure causes are distinguishable in the UI; record only visible guidance.

## settings/appearance-and-diff-theme.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| APPEAR-01 | P2 | mouse | Appearance offers System, Light, and Dark and applies the chosen mode immediately. ([Arrive](../settings/appearance-and-diff-theme.md#arrive)). | Open Settings > General. | 1. Record the current mode.<br>2. Choose Light, then Dark, then System.<br>3. Observe the window after each choice. | The document mode changes immediately for each choice; System follows the macOS color-scheme setting. | pass — Light, Dark, and System applied immediately; System followed the current dark macOS scheme. |
| APPEAR-02 | P1 | keyboard | Light and Dark Diff themes apply independently to a mounted diff, and a failed save leaves the visible choice active with Retry. ([While the action runs](../settings/appearance-and-diff-theme.md#while-the-action-runs)). | Open a disposable Review diff and Settings > General; use a settings persistence failure fixture for the second run. | 1. Change only Light appearance and inspect the mounted diff in Light mode.<br>2. Change only Dark appearance and inspect Dark mode.<br>3. Trigger a persistence failure. | The mounted diff repaints without changing Review state; one side remains unchanged when the other changes; save failure keeps the visible value and offers Retry. | blocked — no mounted Review diff or settings-persistence failure fixture was available. |

Not checkable by hand:

- Complete installed-theme catalog coverage; verify only selectors and a chosen mounted theme.

## settings/review-defaults.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEFAULT-01 | P1 | mouse | Review Settings stores a profile-scoped Pi Analysis model and reasoning default without starting an Insight. ([Begin an action](../settings/review-defaults.md#begin-an-action)). | Open Settings > Review with a disposable profile and an available Pi catalog. | 1. Choose a different model.<br>2. Choose Extra high reasoning.<br>3. Leave Settings without starting Analysis.<br>4. Reopen the section. | The choices are restored for that profile; no Insight run or provider child starts. | blocked — the catalog rendered and no Insight started, but without a saved profile the changed reasoning choice did not persist. |
| DEFAULT-02 | P1 | offline | A stored Codex Analysis preference is not overwritten merely by opening Pi-only Review Settings. ([Edge cases](../settings/review-defaults.md#edge-cases)). | Seed a disposable profile with a Codex Analysis preference and a Pi catalog. | 1. Open Settings > Review.<br>2. Inspect the displayed default and Codex availability.<br>3. Close and reopen an Insight run dialog without starting it. | Settings may show a Pi fallback and Codex status, but the stored Codex preference remains unchanged until an explicit run choice replaces it. | blocked — no seeded Codex Analysis preference fixture was available. |

Not checkable by hand:

- Provider credentials and external PATH state; record the visible availability guidance only.

## settings/data-and-recovery.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DATA-01 | P1 | destructive | Clear cache and Clear local review data have separate confirmations and retention promises. ([Arrive](../settings/data-and-recovery.md#arrive)). | Use a disposable profile with a saved Review, Cache files, and Diagnostic records. | 1. Open Settings > Data & recovery.<br>2. Choose Clear cache and read its confirmation; cancel.<br>3. Choose Clear local review data and read its confirmation; cancel. | The two dialogs name different effects; neither changes data when cancelled. | pass — the cache dialog promised to remove rebuildable files while retaining Reviews and diagnostics; the local-data dialog promised to remove completed and failed Reviews while retaining active work and diagnostics; both were cancelled. |
| DATA-02 | P1 | destructive | Clear local review data protects active work and Diagnostics, while a successful cleanup reloads workspace data and closes Settings. ([Settle](../settings/data-and-recovery.md#settle)). | Use disposable local data with an active Review or preparation and Diagnostic records; obtain explicit approval before any destructive confirmation. | 1. Confirm Clear local review data.<br>2. Wait for settlement.<br>3. Reopen the profile and activity surfaces. | Eligible completed/failed data is removed; active work and Diagnostics remain; workspace data reloads and Settings closes. | blocked — destructive confirmation was not approved or run. |

Not checkable by hand:

- Exact filesystem deletion order; use the storage harness rather than inspecting or deleting real user data.

## settings/logs-and-diagnostics.md

| ID | P | Required condition | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LOG-01 | P1 | keyboard | Logs is an app-wide main/renderer tail with pause, level/process filters, and a bounded visible list. ([Arrive](../settings/logs-and-diagnostics.md#arrive)). | Open Settings > Logs with seeded main and renderer log entries. | 1. Observe the initial entries.<br>2. Filter by Error and Main.<br>3. Pause, wait through one poll interval, then Resume. | Filters change only the visible projection; Pause prevents future polls; Resume continues from the latest cursor without duplicate rows. | pass — 84 visible rows stayed fixed while paused; resume added the next row, and level/process filters changed only the visible projection. |
| LOG-02 | P1 | mouse | Review activity is profile-scoped and more strictly redacted than app Logs. ([While the action runs](../settings/logs-and-diagnostics.md#while-the-action-runs)). | Use a disposable profile with safe Diagnostic events and app-log entries containing paths, error detail, and credential-shaped fixtures. | 1. Load Review activity in Data & recovery.<br>2. Open Logs and compare the entries.<br>3. Inspect visible messages and metadata. | Activity shows bounded lifecycle milestones without prompts, tokens, provider output, diff bodies, or sensitive paths; app Logs may retain local paths/error detail but masks credentials. | blocked — Review activity loaded as empty, so stricter redaction could not be compared against seeded sensitive fixtures. |

Not checkable by hand:

- Full redaction implementation coverage; use the dedicated domain/service tests for exhaustive patterns and record only visible results here.

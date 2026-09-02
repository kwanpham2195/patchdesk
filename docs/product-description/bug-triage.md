# Bug triage

A consolidated record of defects raised by the product documents and verification checklists. The original reproduce and code-cause notes below describe the `3100615` source snapshot. All eight defects were fixed in later commits. Post-fix evidence is distinguished from the original live observations so the historical report remains auditable.

## Summary

Eight distinct defects are fixed after deduplication: one former high-severity work-loss risk and seven former medium-severity correctness, focus, or feedback risks. The largest cluster was workspace setup, switching, and discovery. The fixes have canonical automated coverage; B-01, B-02, and B-07 also have post-fix desktop evidence. B-08 has an exact automated Reply-textarea test and supporting desktop input evidence, but its exact Reply-textarea live rerun remains outstanding.

| ID   | Title                                                                       | Severity | Area                           | Resolution                    | Issue |
| ---- | --------------------------------------------------------------------------- | -------- | ------------------------------ | ----------------------------- | ----- |
| B-01 | New profile replaces a Dirty draft without a choice                         | high     | Settings / Workspace           | fixed (`31284f3`)             | —     |
| B-02 | Scalar profile validation falls through to a generic request error          | medium   | Settings / Workspace           | fixed (`8dce9e7`)             | —     |
| B-03 | Open Review recommendation preempts ready-to-merge action                   | medium   | Pull requests                  | fixed (`b66a0a9`), superseded | —     |
| B-04 | Stale Review-opening error remains on the first-run screen                  | medium   | First run / Pull requests      | fixed (`8d372ab`)             | —     |
| B-05 | Repository grouping treats a path prefix as containment                     | medium   | Settings / Workspace discovery | fixed (`c59d249`)             | —     |
| B-06 | A failed root scan is omitted from an otherwise successful discovery result | medium   | Workspace discovery            | fixed (`c49045d`)             | —     |
| B-07 | Profile switch can leave the Repository picker unset after rows reload      | medium   | Pull requests / Workspace      | fixed (`c1ce7a2`)             | —     |
| B-08 | Navigate shortcut opens from a focused Review reply editor                  | medium   | Review workbench / Keyboard    | fixed (`75fadec`)             | —     |

## High

### B-01: New profile replaces a Dirty draft without a choice

- **Where the user meets it:** Settings > Workspace, after editing an existing profile and clicking New profile.
- **What happens / what was expected:** The New profile action replaces the mounted draft immediately. A Dirty draft should first offer Save, Discard changes, or Cancel, as close and profile switching do.
- **Reproduce:** On a mouse-driven macOS app, open a saved profile; change its label or another field without saving; click New profile; inspect whether the old draft and any guard remain.
- **Why (from the code):** `src/renderer/src/flows/settings-workspace-section.tsx:247-250` wires New profile directly to `startNewProfile`. `src/renderer/src/flows/settings-workspace-profile-draft.ts:261-267` immediately creates a blank draft, replaces the baseline, and marks it dirty; it has no Save/Discard/Cancel branch. The existing profile-switch guard is separate at `src/renderer/src/flows/settings-workspace-profile-draft.ts:213-218`.
- **Severity:** `high`. The action can discard maintainer work with no recovery choice.
- **Decision needed:** `fix`. Route New profile through the same Dirty-draft guard used by close and profile switching, or make the replacement behavior an explicit product decision with a recoverable confirmation.
- **Affected documents/checklists:** [`Workspace profile editor`](settings/workspace-profile-editor.md#cancel-and-interrupt), [`SETUP-04`](verification/foundations-and-settings.md#settingsworkspace-profile-editormd).
- **Status:** fixed by `31284f3`; canonical regression: `tests/renderer/profile-settings.test.tsx`. Post-fix live pass: `SETUP-04` guard offers Cancel and Discard changes, with evidence in `/private/tmp/patchdesk-followup-verification-evidence/followup-b01-guard.png` and `/private/tmp/patchdesk-followup-verification-evidence/followup-b01-discard-new.png`.
- **Issue:** —

## Medium

### B-02: Scalar profile validation falls through to a generic request error

- **Where the user meets it:** Settings > Workspace, after entering an empty or malformed scalar such as GitHub host, account, profile ID, or label and pressing Save.
- **What happens / what was expected:** List fields have inline blank-entry validation, but scalar values are trimmed and sent to the main process. A malformed or empty scalar can return the generic Profile update failed request error rather than field-specific guidance. The expected product behavior is an actionable field-level validation message before the request.
- **Reproduce:** In a disposable profile, clear or malform one scalar field; press Save; record whether the request is rejected locally with field guidance or reaches the generic error alert.
- **Why (from the code):** `src/renderer/src/flows/settings-workspace-profile-draft.ts:342-369` trims scalar fields and validates only the list helpers; `:372-379` contains the explicit blank-entry error. A request rejection is caught generically at `src/renderer/src/flows/settings-workspace-profile-draft.ts:170-175`, while `src/renderer/src/flows/settings-workspace-section.tsx:298-302` renders the generic Profile update failed alert. The main-process JSON boundary accepts unknown field values before domain parsing at `src/services/dashboard-controller.ts:76-84,198-224`.
- **Severity:** `medium`. The user can recover by correcting the field, but the error does not identify the invalid input and may require trial and error.
- **Decision needed:** `fix`. Validate scalar fields in the editor or map typed invalid-input failures to the affected field before sending the request.
- **Affected documents/checklists:** [`Workspace profile editor`](settings/workspace-profile-editor.md#open-questions-and-verification), [`SETUP-03`](verification/foundations-and-settings.md#settingsworkspace-profile-editormd).
- **Status:** fixed by `8dce9e7`; canonical regression: `tests/renderer/profile-settings.test.tsx`. Post-fix live pass: `SETUP-03` reports field-associated validation before a request; evidence: `/private/tmp/patchdesk-followup-verification-evidence/followup-b02-invalid.png` and `/private/tmp/patchdesk-followup-verification-evidence/followup-b02-one-field-corrected.png`.
- **Issue:** —

### B-03: Open Review recommendation preempts ready-to-merge action

- **Where the user meets it:** A Pull requests row with a Fresh matching saved Review, passing required checks, and GitHub mergeability `mergeable`.
- **What happens / what was expected:** The row receives the `ready_to_merge` category, but the primary recommendation returns Open Review first because a matching saved Review is checked before ready-to-merge. The expected action ordering is a deliberate product choice that should not hide merge readiness when all readiness evidence is present.
- **Reproduce:** Use a disposable repository with one open pull request, a saved Review matching its current head, Fresh listing data, passing checks, and mergeable state; inspect the row's single recommended action.
- **Why (from the code):** `src/domain/maintainer-inbox.ts:177-183` emits `ready_to_merge` for the stated conditions. `src/domain/maintainer-inbox.ts:295-309` returns Open Review for any matching Review before `:310-319` can return Open merge readiness. The pinned domain coverage confirms the category conditions in `tests/domain/maintainer-inbox.test.ts:76-110`, but does not assert recommendation priority for the combined case.
- **Severity:** `medium`. The row remains usable, but the primary action can conceal a consequential readiness path.
- **Decision needed:** `fix`. Decide and encode whether merge readiness, Review reopening, or a combined action should win when both are true.
- **Affected documents/checklists:** [`Repository listing`](pull-requests/repository-listing.md#edge-cases), [`LIST-02`](verification/pull-requests.md#pull-requestsrepository-listingmd).
- **Status:** fixed by `b66a0a9`; canonical regression: `tests/domain/maintainer-inbox.test.ts` and `tests/services/maintainer-inbox-cache-secondary-action.test.ts`. Automated coverage proves the primary Review action and separate read-only merge-readiness action. No exact ready live fixture was available. Superseded 2026-09-02: the inspector now has one Open action and the separate merge-readiness action was removed; `tests/services/maintainer-inbox-cache-secondary-action.test.ts` no longer exists. Ready to merge remains a category.
- **Issue:** —

### B-04: Stale Review-opening error remains on the first-run screen

- **Where the user meets it:** The Pull requests screen after opening a Review fails, then the active profile clears or reloads into first-run state.
- **What happens / what was expected:** The local `openError` remains mounted and is passed into the BootstrapOutcome first-run branch, so an old Could not open review alert can appear above the new setup state. The expected behavior is to clear or re-scope an opening error when the active profile and screen identity change.
- **Reproduce:** Use a disposable row whose Review opening fails; switch or clear the active profile so the screen enters first-run; inspect whether the old alert remains above the setup card.
- **Why (from the code):** `src/renderer/src/flows/inbox-flow.tsx:274-288` stores the opening error as a flow prop and renders it in the normal inbox branch. The bootstrap branch receives `openError` at `:161-170` and renders the same alert at `:345-396`. The component comment explicitly notes that local state can survive a cleared profile at `src/renderer/src/flows/inbox-flow.tsx:363-368`. The pinned regression test observes the behavior in `tests/renderer/inbox-flow.ui.test.tsx:536-603`.
- **Severity:** `medium`. It is recoverable, but the first-run screen can show an error for a different profile and mislead the next action.
- **Decision needed:** `fix`. Clear opening errors on profile/screen identity changes or key the flow state to the active profile.
- **Affected documents/checklists:** [`First-run setup`](first-run/setup-checklist.md#open-questions-and-verification), [`Opening a Review`](pull-requests/opening-a-review.md#open-questions-and-verification), [`OPEN-03`](verification/pull-requests.md#pull-requestsopening-a-reviewmd).
- **Status:** fixed by `8d372ab`; canonical regression: `tests/renderer/inbox-flow.ui.test.tsx`. Automated coverage proves opening state is profile-scoped; no exact first-run failure fixture was rerun manually.
- **Issue:** —

### B-05: Repository grouping treats a path prefix as containment

- **Where the user meets it:** Settings > Workspace discovery when saved roots include `/workspace/app` and a watched repository is located at `/workspace/app-two`.
- **What happens / what was expected:** The grouping helper uses raw string `startsWith`, so `/workspace/app-two` can be grouped under `/workspace/app`. Containment should require a directory boundary (`/workspace/app/`) or an exact root match.
- **Reproduce:** In a disposable profile, save `/workspace/app` as a root and add a watched repository whose local path is `/workspace/app-two/repo`; inspect the root group and the outside-roots group.
- **Why (from the code):** `src/renderer/src/flows/settings-workspace-repositories.tsx:53-58` documents grouping “by path prefix,” and `:61-80` assigns an entry when `entry.localPath.startsWith(root)`. The pinned test only covers a true descendant path at `tests/renderer/settings-workspace-repositories.test.ts:9-32`; it has no sibling-prefix boundary case.
- **Severity:** `medium`. The repository remains in the watchlist but appears under the wrong workspace scope, which can mislead discovery and profile editing.
- **Decision needed:** `fix`. Use path-aware containment with a directory boundary and add a sibling-prefix regression case.
- **Affected documents/checklists:** [`Repository discovery`](first-run/repository-discovery.md#edge-cases), [`DISC-01`](verification/pull-requests.md#first-runrepository-discoverymd).
- **Status:** fixed by `c59d249`; canonical regression: `tests/renderer/settings-workspace-repositories.test.ts`. Automated coverage covers exact roots, sibling prefixes, duplicate roots, and nested roots; no exact manual fixture was rerun.
- **Issue:** —

### B-06: A failed root scan is omitted from an otherwise successful discovery result

- **Where the user meets it:** Settings > Workspace discovery with multiple saved workspace roots when one `find` command fails and another succeeds.
- **What happens / what was expected:** The failing root contributes no directories, while successful roots still produce a successful aggregate response. The UI can therefore show zero candidates for the failed root without explaining that its scan failed. The expected behavior is a per-root failure or an aggregate result that preserves the failed root's status.
- **Reproduce:** Use two disposable saved roots; make the scan command fail for one root and succeed with no repositories for the other; inspect each root's status and whether the failure is distinguishable from zero found.
- **Why (from the code):** `src/adapters/github/workspace-origin-finder.ts:18-37` runs root scans concurrently and `flatMap`s only successful results, turning a command error into no directories. `src/adapters/github/workspace-origin-finder.ts:39-60` then returns only the collected origins. `src/services/dashboard-service.ts:30-46` receives only that array and returns `ok(discovered)`, leaving no error channel for a failed root. The renderer can display a scan error only when the whole suggestions request is in an error state at `src/renderer/src/flows/settings-workspace-root-discovery.tsx:66-80,103-110`.
- **Severity:** `medium`. A maintainer can believe a root is empty and miss repositories without a clear recovery action.
- **Decision needed:** `fix`. Preserve per-root scan outcomes or expose an aggregate partial/error status that cannot be rendered as zero candidates.
- **Affected documents/checklists:** [`Repository discovery`](first-run/repository-discovery.md#while-the-action-runs), [`DISC-01`](verification/pull-requests.md#first-runrepository-discoverymd).
- **Status:** fixed by `c49045d`; canonical regression: `tests/adapters/workspace-origin-finder.test.ts`, `tests/services/profile-dashboard-services.test.ts`, and `tests/renderer/workspace-root-discovery.ui.test.tsx`; protected-loopback browser coverage also proves partial ready/failed roots. No controlled desktop failing-root fixture was available.
- **Issue:** —

### B-07: Profile switch can leave the Repository picker unset after rows reload

- **Where the user meets it:** Switching between two saved workspace profiles from the titlebar or Settings while returning to Pull requests.
- **What happens / what was expected:** The active profile label and its Pull request rows reload, but the Repository picker can stay at `Select a repository` until the maintainer selects the already-watched repository manually. A profile switch should reconcile the picker to that profile's saved repository, or to its first watched repository, before presenting the settled rows.
- **Reproduce:** Create two disposable profiles, give the first a watched repository, switch to the second, then switch back to the first and wait for Pull requests to settle; compare the picker with the rows already shown.
- **Why (from the code):** `src/renderer/src/components/maintainer-inbox.tsx:337-379` renders the placeholder when selected-repository state is absent. `src/renderer/src/app.tsx:179-206` resets the inbox request and workspace state during profile switch, while `src/renderer/src/hooks/use-workspace-inbox.ts:141-156` and `src/renderer/src/inbox-request.ts:194-208` defer repository correction until the new profile is confirmed. The live trace proves the settled state can remain unset, but a focused state trace is still needed to identify which reconciliation callback is skipped.
- **Severity:** `medium`. Rows are readable and the maintainer can recover with one manual selection, but the scope control disagrees with the loaded data and can misstate which repository is active.
- **Decision needed:** `fix`. Ensure profile-switch settlement writes the new profile's saved-or-first watched repository into the request and picker before or with the inbox rows.
- **Affected documents/checklists:** [`Workspace profile and identity`](foundations/workspace-profile-and-identity.md#settle), [`PROFILE-02`](verification/foundations-and-settings.md#foundationsworkspace-profile-and-identitymd), [`Selected repository`](pull-requests/selected-repository.md#arrive).
- **Status:** fixed by `c1ce7a2`; canonical regression: `tests/renderer/use-workspace-inbox.test.ts`. Post-fix live pass: `PROFILE-02` settled A/B/A switches each show the matching Repository picker and rows. Evidence: `/private/tmp/patchdesk-followup-verification-evidence/followup-b07-a-initial.png`, `/private/tmp/patchdesk-followup-verification-evidence/followup-b07-b-settled-2.png`, and `/private/tmp/patchdesk-followup-verification-evidence/followup-b07-a-return-settled.png`.
- **Issue:** —

### B-08: Navigate shortcut opens from a focused Review reply editor

- **Where the user meets it:** A Review diff with focus in an inline thread's Reply textarea.
- **What happens / what was expected:** Pressing Meta+K opens Navigate even though the Reply editor owns focus. Global navigation shortcuts should not take over text entry.
- **Reproduce:** Open a disposable Review with an inline thread; focus its Reply textarea; press Meta+K; inspect whether Navigate opens and whether focus remains in the editor.
- **Why (from the code):** `src/renderer/src/components/app-shell.tsx:99-107` installs a window-level Meta/Ctrl+K handler that calls `preventDefault()` and opens Navigate without checking the event target or focused editable element. `src/renderer/src/components/review-diff-authoring.tsx:354-360` handles Meta/Ctrl+Enter locally but does not shield the editor from the global K handler.
- **Severity:** `medium`. The draft remains present, but an ordinary editor keystroke opens an unrelated overlay and interrupts Review writing.
- **Decision needed:** `fix`. Ignore the Navigate shortcut when focus is in an input, textarea, content-editable control, or another editor-owned surface.
- **Affected documents/checklists:** [`Keyboard, focus, and desktop behavior`](cross-cutting/keyboard-focus-and-desktop.md#begin-an-action), [`FOCUS-01`](verification/insights-and-cross-cutting.md#cross-cuttingkeyboard-focus-and-desktopmd).
- **Status:** fixed by `75fadec`; canonical textarea regression: `tests/renderer/app-shell.ui.test.tsx`. Supporting post-fix desktop input evidence is `/private/tmp/patchdesk-followup-verification-evidence/followup-b08-input-meta-k.png`. The exact Reply-textarea live rerun is still missing.
- **Issue:** —

## Not filed

No candidates were rejected or merged: all eight map to distinct user-visible symptoms or state mismatches and are now fixed. The thread-resolution HTTP 403 and inconclusive reverse diff-navigation attempts remain verification blockers rather than separate triage entries because their product causes were not established. No GitHub issue or external tracker entry has been created.

The original source snapshot was verified at application commit `3100615`. This follow-up records later fix commits, canonical tests, and current-HEAD live evidence.

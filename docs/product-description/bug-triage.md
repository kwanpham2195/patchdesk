# Bug triage

A consolidated list of suspected defects raised by the product documents and verification checklists. Every entry below has static evidence at application-source commit `3100615`; none has been reproduced in the running desktop app. The list is for product decisions: fix an established mismatch, or document an intentional trade-off before marking the related checklist item verified.

## Summary

Six distinct candidates remain after deduplication: one high-severity work-loss risk and five medium-severity correctness or feedback risks. The largest cluster is workspace setup and discovery (four entries), followed by Pull requests presentation and first-run recovery. The source tests provide static boundary evidence for several candidates, but no entry is live-confirmed.

| ID | Title | Severity | Area | Decision needed | Issue |
| --- | --- | --- | --- | --- | --- |
| B-01 | New profile replaces a Dirty draft without a choice | high | Settings / Workspace | fix | — |
| B-02 | Scalar profile validation falls through to a generic request error | medium | Settings / Workspace | fix | — |
| B-03 | Open Review recommendation preempts ready-to-merge action | medium | Pull requests | fix | — |
| B-04 | Stale Review-opening error remains on the first-run screen | medium | First run / Pull requests | fix | — |
| B-05 | Repository grouping treats a path prefix as containment | medium | Settings / Workspace discovery | fix | — |
| B-06 | A failed root scan is omitted from an otherwise successful discovery result | medium | Workspace discovery | fix | — |

## High

### B-01: New profile replaces a Dirty draft without a choice

- **Where the user meets it:** Settings > Workspace, after editing an existing profile and clicking New profile.
- **What happens / what was expected:** The New profile action replaces the mounted draft immediately. A Dirty draft should first offer Save, Discard changes, or Cancel, as close and profile switching do.
- **Reproduce:** On a mouse-driven macOS app, open a saved profile; change its label or another field without saving; click New profile; inspect whether the old draft and any guard remain.
- **Why (from the code):** `src/renderer/src/flows/settings-workspace-section.tsx:247-250` wires New profile directly to `startNewProfile`. `src/renderer/src/flows/settings-workspace-profile-draft.ts:261-267` immediately creates a blank draft, replaces the baseline, and marks it dirty; it has no Save/Discard/Cancel branch. The existing profile-switch guard is separate at `src/renderer/src/flows/settings-workspace-profile-draft.ts:213-218`.
- **Severity:** `high`. The action can discard maintainer work with no recovery choice.
- **Decision needed:** `fix`. Route New profile through the same Dirty-draft guard used by close and profile switching, or make the replacement behavior an explicit product decision with a recoverable confirmation.
- **Affected documents/checklists:** [`Workspace profile editor`](settings/workspace-profile-editor.md#cancel-and-interrupt), [`SETUP-04`](verification/foundations-and-settings.md#settingsworkspace-profile-editormd).
- **Status:** `suspected - static evidence, live unverified`.
- **Issue:** —

### B-02: Scalar profile validation falls through to a generic request error

- **Where the user meets it:** Settings > Workspace, after entering an empty or malformed scalar such as GitHub host, account, profile ID, or label and pressing Save.
- **What happens / what was expected:** List fields have inline blank-entry validation, but scalar values are trimmed and sent to the main process. A malformed or empty scalar can return the generic Profile update failed request error rather than field-specific guidance. The expected product behavior is an actionable field-level validation message before the request.
- **Reproduce:** In a disposable profile, clear or malform one scalar field; press Save; record whether the request is rejected locally with field guidance or reaches the generic error alert.
- **Why (from the code):** `src/renderer/src/flows/settings-workspace-profile-draft.ts:342-369` trims scalar fields and validates only the list helpers; `:372-379` contains the explicit blank-entry error. A request rejection is caught generically at `src/renderer/src/flows/settings-workspace-profile-draft.ts:170-175`, while `src/renderer/src/flows/settings-workspace-section.tsx:298-302` renders the generic Profile update failed alert. The main-process JSON boundary accepts unknown field values before domain parsing at `src/services/dashboard-controller.ts:76-84,198-224`.
- **Severity:** `medium`. The user can recover by correcting the field, but the error does not identify the invalid input and may require trial and error.
- **Decision needed:** `fix`. Validate scalar fields in the editor or map typed invalid-input failures to the affected field before sending the request.
- **Affected documents/checklists:** [`Workspace profile editor`](settings/workspace-profile-editor.md#open-questions-and-verification), [`SETUP-03`](verification/foundations-and-settings.md#settingsworkspace-profile-editormd).
- **Status:** `suspected - static evidence, live unverified`.
- **Issue:** —

## Medium

### B-03: Open Review recommendation preempts ready-to-merge action

- **Where the user meets it:** A Pull requests row with a Fresh matching saved Review, passing required checks, and GitHub mergeability `mergeable`.
- **What happens / what was expected:** The row receives the `ready_to_merge` category, but the primary recommendation returns Open Review first because a matching saved Review is checked before ready-to-merge. The expected action ordering is a deliberate product choice that should not hide merge readiness when all readiness evidence is present.
- **Reproduce:** Use a disposable repository with one open pull request, a saved Review matching its current head, Fresh listing data, passing checks, and mergeable state; inspect the row's single recommended action.
- **Why (from the code):** `src/domain/maintainer-inbox.ts:177-183` emits `ready_to_merge` for the stated conditions. `src/domain/maintainer-inbox.ts:295-309` returns Open Review for any matching Review before `:310-319` can return Open merge readiness. The pinned domain coverage confirms the category conditions in `tests/domain/maintainer-inbox.test.ts:76-110`, but does not assert recommendation priority for the combined case.
- **Severity:** `medium`. The row remains usable, but the primary action can conceal a consequential readiness path.
- **Decision needed:** `fix`. Decide and encode whether merge readiness, Review reopening, or a combined action should win when both are true.
- **Affected documents/checklists:** [`Repository listing`](pull-requests/repository-listing.md#edge-cases), [`LIST-02`](verification/pull-requests.md#pull-requestsrepository-listingmd).
- **Status:** `suspected - static evidence, live unverified`.
- **Issue:** —

### B-04: Stale Review-opening error remains on the first-run screen

- **Where the user meets it:** The Pull requests screen after opening a Review fails, then the active profile clears or reloads into first-run state.
- **What happens / what was expected:** The local `openError` remains mounted and is passed into the BootstrapOutcome first-run branch, so an old Could not open review alert can appear above the new setup state. The expected behavior is to clear or re-scope an opening error when the active profile and screen identity change.
- **Reproduce:** Use a disposable row whose Review opening fails; switch or clear the active profile so the screen enters first-run; inspect whether the old alert remains above the setup card.
- **Why (from the code):** `src/renderer/src/flows/inbox-flow.tsx:274-288` stores the opening error as a flow prop and renders it in the normal inbox branch. The bootstrap branch receives `openError` at `:161-170` and renders the same alert at `:345-396`. The component comment explicitly notes that local state can survive a cleared profile at `src/renderer/src/flows/inbox-flow.tsx:363-368`. The pinned regression test observes the behavior in `tests/renderer/inbox-flow.ui.test.tsx:536-603`.
- **Severity:** `medium`. It is recoverable, but the first-run screen can show an error for a different profile and mislead the next action.
- **Decision needed:** `fix`. Clear opening errors on profile/screen identity changes or key the flow state to the active profile.
- **Affected documents/checklists:** [`First-run setup`](first-run/setup-checklist.md#open-questions-and-verification), [`Opening a Review`](pull-requests/opening-a-review.md#open-questions-and-verification), [`OPEN-03`](verification/pull-requests.md#pull-requestsopening-a-reviewmd).
- **Status:** `suspected - static evidence, live unverified`.
- **Issue:** —

### B-05: Repository grouping treats a path prefix as containment

- **Where the user meets it:** Settings > Workspace discovery when saved roots include `/workspace/app` and a watched repository is located at `/workspace/app-two`.
- **What happens / what was expected:** The grouping helper uses raw string `startsWith`, so `/workspace/app-two` can be grouped under `/workspace/app`. Containment should require a directory boundary (`/workspace/app/`) or an exact root match.
- **Reproduce:** In a disposable profile, save `/workspace/app` as a root and add a watched repository whose local path is `/workspace/app-two/repo`; inspect the root group and the outside-roots group.
- **Why (from the code):** `src/renderer/src/flows/settings-workspace-repositories.tsx:53-58` documents grouping “by path prefix,” and `:61-80` assigns an entry when `entry.localPath.startsWith(root)`. The pinned test only covers a true descendant path at `tests/renderer/settings-workspace-repositories.test.ts:9-32`; it has no sibling-prefix boundary case.
- **Severity:** `medium`. The repository remains in the watchlist but appears under the wrong workspace scope, which can mislead discovery and profile editing.
- **Decision needed:** `fix`. Use path-aware containment with a directory boundary and add a sibling-prefix regression case.
- **Affected documents/checklists:** [`Repository discovery`](first-run/repository-discovery.md#edge-cases), [`DISC-01`](verification/pull-requests.md#first-runrepository-discoverymd).
- **Status:** `suspected - static evidence, live unverified`.
- **Issue:** —

### B-06: A failed root scan is omitted from an otherwise successful discovery result

- **Where the user meets it:** Settings > Workspace discovery with multiple saved workspace roots when one `find` command fails and another succeeds.
- **What happens / what was expected:** The failing root contributes no directories, while successful roots still produce a successful aggregate response. The UI can therefore show zero candidates for the failed root without explaining that its scan failed. The expected behavior is a per-root failure or an aggregate result that preserves the failed root's status.
- **Reproduce:** Use two disposable saved roots; make the scan command fail for one root and succeed with no repositories for the other; inspect each root's status and whether the failure is distinguishable from zero found.
- **Why (from the code):** `src/adapters/github/workspace-origin-finder.ts:18-37` runs root scans concurrently and `flatMap`s only successful results, turning a command error into no directories. `src/adapters/github/workspace-origin-finder.ts:39-60` then returns only the collected origins. `src/services/dashboard-service.ts:30-46` receives only that array and returns `ok(discovered)`, leaving no error channel for a failed root. The renderer can display a scan error only when the whole suggestions request is in an error state at `src/renderer/src/flows/settings-workspace-root-discovery.tsx:66-80,103-110`.
- **Severity:** `medium`. A maintainer can believe a root is empty and miss repositories without a clear recovery action.
- **Decision needed:** `fix`. Preserve per-root scan outcomes or expose an aggregate partial/error status that cannot be rendered as zero candidates.
- **Affected documents/checklists:** [`Repository discovery`](first-run/repository-discovery.md#while-the-action-runs), [`DISC-01`](verification/pull-requests.md#first-runrepository-discoverymd).
- **Status:** `suspected - static evidence, live unverified`.
- **Issue:** —

## Not filed

No candidates were rejected or merged: all six requested candidates map to distinct user-visible symptoms and distinct source paths. No GitHub issue or external tracker entry has been created.

Verified against Patchdesk application source commit `3100615`.

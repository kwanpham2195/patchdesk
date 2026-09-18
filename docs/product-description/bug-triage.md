# Bug triage

A consolidated record of defects raised by the product documents, the verification checklists, and the live passes. B-01 to B-08 describe the `3100615` source snapshot; all eight were fixed in later commits, and post-fix evidence is kept apart from the original live observations so the historical report remains auditable. B-09 to B-24 come from the 2026-09-14 UX pass: each cause is read from application source at `dd613996`, and the entries the live passes or the independent review confirmed on `5fe7df3b` carry a **Status** line. Every entry was rechecked against `737c515c`; the ones fixed since name their fix commit and keep the original observation. Friction that is not a defect lives in [ux-friction.md](ux-friction.md).

## Summary

Twenty-four entries. The eight from the first pass are fixed: one former high-severity work-loss risk and seven former medium-severity correctness, focus, or feedback risks, clustered in workspace setup, switching, and discovery. B-01, B-02, and B-07 have post-fix desktop evidence, and B-08's exact Reply-textarea live rerun remains outstanding.

The UX pass added sixteen entries after deduplication: seven medium and nine low, none high. Five medium entries were confirmed live and by the independent review: the Workspace authentication banner, the Reviewers control on merged or closed Reviews, the unexplained disabled Generate on those Reviews, the Checks control, and the missing Review worktree. The review marked B-09 to B-12 fix now and B-13 and B-14 as named follow-ups; the rest wait for a decision.

B-09 to B-12 were filed as [#185](https://github.com/kwanpham2195/patchdesk/issues/185) to [#188](https://github.com/kwanpham2195/patchdesk/issues/188) and are fixed at `737c515c`, as is the raw start-time slip inside B-22; each entry records its fix commit. Twelve remain open: B-13 to B-21 and B-23 to B-24, plus B-22's three other slips. The largest remaining cluster is the Visited pull requests column's recovery from removed Review records (B-15, B-16); merged or closed Reviews keep only B-19, whose run controls stay enabled. The open entries are not filed as issues. Every fix here is read from source at `737c515c`; none has post-fix live evidence.

| ID   | Title                                                                                      | Severity | Area                               | Resolution or decision          | Issue                                                        |
| ---- | ------------------------------------------------------------------------------------------ | -------- | ---------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| B-01 | New profile replaces a Dirty draft without a choice                                        | high     | Settings / Workspace               | fixed (`31284f3`)               | —                                                            |
| B-09 | Workspace settings reports GitHub authentication required while the active account works | medium   | Settings / Workspace               | fixed (`419138a3`)              | [#185](https://github.com/kwanpham2195/patchdesk/issues/185) |
| B-10 | The Reviewers control never loads on a merged or closed Review                            | medium   | Review workbench / Conversation    | fixed (`0bb9054a`)              | [#186](https://github.com/kwanpham2195/patchdesk/issues/186) |
| B-11 | Generate and Regenerate are disabled on a merged or closed Review with no reason          | medium   | Review workbench / Insights        | fixed (`e161a483`)              | [#187](https://github.com/kwanpham2195/patchdesk/issues/187) |
| B-12 | The Checks control opens PR overview on Merge readiness                                   | medium   | Review workbench / Merge           | fixed (`50ab4b12`)              | [#188](https://github.com/kwanpham2195/patchdesk/issues/188) |
| B-13 | Context and Preview stay unavailable when the Review worktree is missing                  | medium   | Review workbench / Diff            | fix (named follow-up)           | —                                                            |
| B-15 | A failed load from a Visited row leaves the destination on the missing Review             | medium   | Visited pull requests column       | fix                             | —                                                            |
| B-17 | The inline composer shortcut starts a review while its hint says comment                  | medium   | Review workbench / Inline comments | fix                             | —                                                            |
| B-02 | Scalar profile validation falls through to a generic request error                        | medium   | Settings / Workspace               | fixed (`8dce9e7`)               | —                                                            |
| B-03 | Open Review recommendation preempts ready-to-merge action                                 | medium   | Pull requests                      | fixed (`b66a0a9`), superseded   | —                                                            |
| B-04 | Stale Review-opening error remains on the first-run screen                                | medium   | First run / Pull requests          | fixed (`8d372ab`)               | —                                                            |
| B-05 | Repository grouping treats a path prefix as containment                                   | medium   | Settings / Workspace discovery     | fixed (`c59d249`)               | —                                                            |
| B-06 | A failed root scan is omitted from an otherwise successful discovery result               | medium   | Workspace discovery                | fixed (`c49045d`)               | —                                                            |
| B-07 | Profile switch can leave the Repository picker unset after rows reload                    | medium   | Pull requests / Workspace          | fixed (`c1ce7a2`)               | —                                                            |
| B-08 | Navigate shortcut opens from a focused Review reply editor                                | medium   | Review workbench / Keyboard        | fixed (`75fadec`)               | —                                                            |
| B-14 | A re-render can cancel heading focus after a destination change                           | low      | Navigation / Focus                 | fix (named follow-up)           | —                                                            |
| B-16 | The Visited pull requests column keeps rows for removed Reviews                           | low      | Visited pull requests column       | fix                             | —                                                            |
| B-18 | A Markdown-syntax image never opens the full-size view                                    | low      | Review workbench / Conversation    | fix                             | —                                                            |
| B-19 | Try again and related run controls stay enabled on a merged or closed Review              | low      | Review workbench / Insights        | fix                             | —                                                            |
| B-20 | Some Pull requests filters are not measured against the search length limit              | low      | Pull requests / Filters            | fix                             | —                                                            |
| B-21 | Dismissed Findings still add to Finding badges                                            | low      | Review workbench / Diff            | fix                             | —                                                            |
| B-22 | Small copy and rendering slips                                                             | low      | Insights / Settings                | fix                             | —                                                            |
| B-23 | Walkthrough section keys ignore modifier keys                                              | low      | Review workbench / Walkthrough     | fix                             | —                                                            |
| B-24 | Repository-marked generated files do not reach the Scope gauge                            | low      | Review workbench / Insights        | product call                    | —                                                            |

## High

### B-01: New profile replaces a Dirty draft without a choice

- **Where the user meets it:** Settings > Workspace, after editing an existing profile and clicking New profile.
- **What happens / what was expected:** The New profile action replaces the mounted draft immediately. A Dirty draft should first offer Save, Discard changes, or Cancel, as close and profile switching do.
- **Reproduce:** On a mouse-driven macOS app, open a saved profile; change its label or another field without saving; click New profile; inspect whether the old draft and any guard remain.
- **Why (from the code):** `src/renderer/src/flows/settings-workspace-section.tsx:247-250` wires New profile directly to `startNewProfile`. `src/renderer/src/flows/settings-workspace-profile-draft.ts:261-267` immediately creates a blank draft, replaces the baseline, and marks it dirty; it has no Save/Discard/Cancel branch. The existing profile-switch guard is separate at `src/renderer/src/flows/settings-workspace-profile-draft.ts:213-218`.
- **Severity:** `high`. The action can discard maintainer work with no recovery choice.
- **Decision needed:** `fix`. Route New profile through the same Dirty-draft guard used by close and profile switching, or make the replacement behavior an explicit product decision with a recoverable confirmation.
- **Affected documents/checklists:** [`Workspace profile editor`](settings/workspace-profile-editor.md#cancel-and-interrupt), [`SETUP-04`](verification/foundations-and-settings.md#settingsworkspace-profile-editormd).
- **Status:** fixed by `31284f3`; canonical regression: `tests/renderer/profile-settings.test.tsx`. Post-fix live pass: `SETUP-04` guard offers Cancel and Discard changes, with evidence in `/private/tmp/patchdesk-followup-verification-evidence/followup-b01-guard.png` and `/private/tmp/patchdesk-followup-verification-evidence/followup-b01-discard-new.png`. Superseded 2026-09-03: Workspace settings has no draft to replace. Every control saves itself, creating a workspace moved into the New workspace dialog, and the guard this defect asked for no longer exists.
- **Issue:** —

## Medium

### B-02: Scalar profile validation falls through to a generic request error

- **Where the user meets it:** Settings > Workspace, after entering an empty or malformed value such as GitHub host, GitHub account, or the workspace Name and committing it.
- **What happens / what was expected:** List fields have inline blank-entry validation, but scalar values are trimmed and sent to the main process. A malformed or empty scalar can return the generic Profile update failed request error rather than field-specific guidance. The expected product behavior is an actionable field-level validation message before the request.
- **Reproduce:** In a disposable profile, clear or malform one scalar field; press Save; record whether the request is rejected locally with field guidance or reaches the generic error alert.
- **Why (from the code):** `src/renderer/src/flows/settings-workspace-profile-draft.ts:342-369` trims scalar fields and validates only the list helpers; `:372-379` contains the explicit blank-entry error. A request rejection is caught generically at `src/renderer/src/flows/settings-workspace-profile-draft.ts:170-175`, while `src/renderer/src/flows/settings-workspace-section.tsx:298-302` renders the generic Profile update failed alert. The main-process JSON boundary accepts unknown field values before domain parsing at `src/services/dashboard-controller.ts:76-84,198-224`.
- **Severity:** `medium`. The user can recover by correcting the field, but the error does not identify the invalid input and may require trial and error.
- **Decision needed:** `fix`. Validate scalar fields in the editor or map typed invalid-input failures to the affected field before sending the request.
- **Affected documents/checklists:** [`Workspace profile editor`](settings/workspace-profile-editor.md#open-questions-and-verification), [`SETUP-03`](verification/foundations-and-settings.md#settingsworkspace-profile-editormd).
- **Status:** fixed by `8dce9e7`; canonical regression: `tests/renderer/profile-settings.test.tsx`. Post-fix live pass: `SETUP-03` reports field-associated validation before a request; evidence: `/private/tmp/patchdesk-followup-verification-evidence/followup-b02-invalid.png` and `/private/tmp/patchdesk-followup-verification-evidence/followup-b02-one-field-corrected.png`. Superseded 2026-09-03: there is no Save button. A value is checked when its own control commits, and a rejection is reported beside that control while the previously saved value is kept.
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

### B-09: Workspace settings reports GitHub authentication required while the active account works

- **Where the user meets it:** Settings → Workspace, the Reviewing as card, on a machine where the GitHub CLI holds several accounts and one of them has an invalid token. Workspace setup on Pull requests renders the same card.
- **What happens / what was expected:** The card shows a red `GitHub authentication required` alert with "Not authenticated. Run `gh auth login`, then re-check." while the workspace's active account reads GitHub normally everywhere else. Expected: the card reports the working accounts and flags only the stale one, or nothing.
- **Reproduce:** Sign in to `gh` with two accounts, then invalidate the token of the one that is not active (for example `gh auth logout` on another machine, or revoke it on GitHub). Open Patchdesk, confirm the Pull requests listing loads, then open Settings → Workspace.
- **Why (from the code):** `src/main/routes/dashboard-routes.ts:229-247` derives `githubAuth` from the exit status of plain `gh auth status` (line 230), which is nonzero when any listed account is invalid. `src/renderer/src/flows/settings-workspace-reviewing-as.tsx:117-122` returns the `failed` view for `authentication_required` even when `githubAccounts` is non-empty, and `:213-225` renders the alert. The codebase already records that this exit code is not an authentication signal: `src/adapters/github/github-adapter.ts:775-777` and the comment at the top of `src/adapters/github/github-auth-accounts.ts` (lines 50-56).
- **Severity:** `medium`. Nothing is blocked, but an alarming, actionable-looking error appears on every multi-account machine with one stale account and points the maintainer at the wrong fix.
- **Decision needed:** `fix`, fix now per the independent review. Treat a non-empty account list as ready in the route or the view, and extend `tests/renderer/reviewing-as-panel.test.tsx`.
- **Raised by:** [Workspace settings](settings/workspace-profile-editor.md#open-questions-and-verification), [Workspace profile and identity](foundations/workspace-profile-and-identity.md#interactions-with-other-systems).
- **Status:** confirmed 2026-09-14 on `5fe7df3b`. The settings live pass saw the alert while GitHub data loaded normally; the review read `GET /v1/environment` returning `githubAuth: "authentication_required"` together with the two working accounts, and a third account with an invalid token. Fixed by `419138a3`: the environment route reports `ready` whenever the account list is non-empty, so a stale account no longer decides readiness. The post-fix state is read from source, not observed live.
- **Issue:** [#185](https://github.com/kwanpham2195/patchdesk/issues/185), closed

### B-10: The Reviewers control never loads on a merged or closed Review

- **Where the user meets it:** The Conversation tab of a merged or closed Review, in the Pull request metadata rail.
- **What happens / what was expected:** Reviewers shows a spinner and "Loading reviewers…" indefinitely, with no picker, while Assignees and Labels render their stored values beside it. Expected: a read-only Reviewers state for a terminal Review, such as the stored requested reviewers.
- **Reproduce:** Open any merged Review, choose Conversation, and wait. Compare with an open Review, whose Reviewers control loads in about a second.
- **Why (from the code):** `src/renderer/src/flows/review-workbench-flow.tsx:98-99` sets `canWriteReviewers` only for an open Review, so `:176` passes no reviewer actions. `src/renderer/src/components/pull-request-metadata-rail.tsx:290-298` starts in `loading` and, when `actions` is undefined, sets `loading` again and returns, so `:221` keeps drawing "Loading reviewers…". No test covers the terminal rail.
- **Severity:** `medium`. The control reads as broken on every merged or closed Review, and the maintainer cannot see who was requested.
- **Decision needed:** `fix`, fix now per the independent review. Render a read-only state for terminal Reviews and add a rail test.
- **Raised by:** [Conversation and pull request metadata](review-workbench/conversation-and-metadata.md#open-questions-and-verification).
- **Status:** confirmed 2026-09-14 on `5fe7df3b` on #96, #109, #91, and #86 by the workbench live pass; the review confirmed #96 (merged) and read logs showing the reviewers endpoint answering in about 1.2 seconds for open #113 and #125. Fixed by `0bb9054a`, with the empty-list wording in `c91e9b8d`: with no reviewer actions the rail lists the stored requested reviewers read-only instead of staying on `loading`. The post-fix state is read from source, not observed live.
- **Issue:** [#186](https://github.com/kwanpham2195/patchdesk/issues/186), closed

### B-11: Generate and Regenerate are disabled on a merged or closed Review with no reason

- **Where the user meets it:** Insights → Brief, Walkthrough, or Analysis on a merged or closed Review.
- **What happens / what was expected:** Generate brief, Generate walkthrough, Generate analysis, and Regenerate render disabled with no tooltip, description, or message, while the Review header says the Review remains readable. Expected: the open-only rule stays, and a line beside the disabled control says generation needs an open Review.
- **Reproduce:** Open a merged Review, choose Insights, and inspect each reader's Generate control; hover it. Compare with an open Review, where the same control is enabled.
- **Why (from the code):** `src/renderer/src/components/review-insights-slot.tsx:202-203` sets `runEnabled` only when the catalog loaded, a provider is available, and `workbench.review.status === "open"`. `InsightAvailabilityErrors` at `:90-122` explains only catalog and provider failures, so the terminal case renders nothing.
- **Severity:** `medium`. An unexplained disabled primary action on every terminal Review.
- **Decision needed:** `fix`, fix now per the independent review. Add a terminal branch to the empty-state copy; the page Variants rows already state the rule.
- **Raised by:** [Brief](review-workbench/brief.md#open-questions-and-verification), [Analysis](review-workbench/analysis.md#open-questions-and-verification), [Walkthrough](review-workbench/walkthrough.md#open-questions-and-verification).
- **Status:** confirmed 2026-09-14 on `5fe7df3b` on merged #96 and #91 against open #113 by the Insights live pass, and by the review from source. Fixed by `e161a483`: a merged or closed Review now shows "This Review is merged or closed. Generating an Insight needs an open Review; retained Insights stay readable." above the reader, and that reason replaces provider errors. The post-fix state is read from source, not observed live. [B-19](#b-19-try-again-and-related-run-controls-stay-enabled-on-a-merged-or-closed-review) is unchanged: Try again and Run for latest revision are still ungated.
- **Issue:** [#187](https://github.com/kwanpham2195/patchdesk/issues/187), closed

### B-12: The Checks control opens PR overview on Merge readiness

- **Where the user meets it:** The Review header's Checks control, for example `Checks · Unknown`.
- **What happens / what was expected:** PR overview opens exactly as from the Merge control: Revision, Review status, and Merge readiness expanded, Checks collapsed, and focus on Revision. Expected: the Checks row expanded and focused, as Merge readiness is for the Merge control.
- **Reproduce:** Open an open Review, press the Checks control, and inspect which rows are expanded and where focus is. Close, press the Merge control, and compare.
- **Why (from the code):** `src/renderer/src/components/pr-overview-sheet.tsx:112` defines `OverviewFocusSection` as `"merge_readiness"` only, `:169-171` sets `initialFocus` only for that value, and the Checks row at `:193-198` has no `defaultOpen`. `src/renderer/src/components/review-workbench-header.tsx:85` calls `openOverview()` for Checks and `:98` calls `openOverview("merge_readiness")` for Merge. `tests/renderer/pr-overview-sheet.ui.test.tsx` covers only the Merge branch.
- **Severity:** `medium`. The dedicated control shows the wrong row and needs a second click.
- **Decision needed:** `fix`, fix now per the independent review. Add a `checks` focus section with its own trigger ref and default-open, call it from the header, and mirror the Merge test.
- **Raised by:** [Merge](review-workbench/merge.md#open-questions-and-verification), [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#variants).
- **Status:** confirmed 2026-09-14 on `5fe7df3b` on #113 by the workbench live pass, and by the review's accessibility snapshot of the drawer. Fixed by `50ab4b12`: `OverviewFocusSection` now carries `checks`, and the Checks control opens the drawer with the Checks row expanded and focused. The post-fix state is read from source, not observed live.
- **Issue:** [#188](https://github.com/kwanpham2195/patchdesk/issues/188), closed

### B-13: Context and Preview stay unavailable when the Review worktree is missing

- **Where the user meets it:** The Diff tab of a Review whose represented-review worktree no longer exists on disk.
- **What happens / what was expected:** Every file shows Context unavailable with "Patchdesk could not read the required file contents from the saved review revisions", and no Markdown file offers Preview. Reopening the Review changes nothing. Expected: Patchdesk rebuilds the worktree on demand, since the cache is described as re-creatable, or at least names the missing local checkout instead of a GitHub read.
- **Reproduce:** In a disposable workspace, open a Review, quit Patchdesk, remove that Review's folder under `~/.cache/patchdesk/profiles/<profile>/review-worktrees/`, relaunch, and open the Review's Diff.
- **Why (from the code):** `src/services/review-diff-source-service.ts:210-229` runs `git -C <worktree> merge-base` and `:231-251` reads blobs the same way, mapping any failure, including a missing directory, to the `github_read` reason. Nothing in the Review opening path re-prepares a missing worktree. Clear cache removes exactly those folders (`src/services/storage-management-service.ts:205-218` via `src/adapters/storage/review-artifact-storage.ts:449-470`).
- **Severity:** `medium`. Two reading features disappear for every affected Review with a misleading reason and no recovery short of a new revision.
- **Decision needed:** `fix`, named follow-up per the independent review: rebuild the worktree on demand, or add a distinct reason and copy for a missing local checkout.
- **Raised by:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#open-questions-and-verification), [Persistence and recovery](foundations/persistence-and-recovery.md#open-questions-and-verification), [Data and recovery](settings/data-and-recovery.md#open-questions-and-verification).
- **Status:** confirmed 2026-09-14 on `5fe7df3b`: the workbench pass saw the state on every Review it opened; the review found the Personal profile's `review-worktrees` folder holding only `.quarantine` while every session still recorded a worktree path, with `fatal: cannot change to ...` in the logs. What removed the folders is unknown; the retained logs show no Clear cache call.
- **Issue:** —

### B-15: A failed load from a Visited row leaves the destination on the missing Review

- **Where the user meets it:** Clicking a Visited row whose Review record no longer exists, for example after Clear local review data (see B-16).
- **What happens / what was expected:** The Pull requests screen shows `Could not open review` with "Could not open the saved review." and the reason, but the titlebar still names the Review workbench and shows Back, the stored destination still names that Review, and its row stays highlighted and inert, so the column offers no retry. Expected: the destination returns to Pull requests, as the launch restore does, or the row stays clickable for a retry.
- **Reproduce:** In a disposable workspace, create a Review, remove its record (Clear local review data on a terminal Review), then click its row, which B-16 leaves listed. Inspect the titlebar, the notice, and the row.
- **Why (from the code):** `src/renderer/src/flows/inbox-flow.tsx:180-203` opens the stored Review for a workbench destination and passes `onBootRestoreMissing`; `src/renderer/src/flows/use-inbox-review-opening.ts:225-241` calls it only for a launch restore that meets `not_found` and otherwise stores the error without changing the destination. `src/renderer/src/components/visited-pull-requests.tsx:240-244` makes the row for the destination's Review inert.
- **Severity:** `medium`. The maintainer lands in a mismatched state with no way back from the column except another row or Back.
- **Decision needed:** `fix`. Leave the workbench destination on a failed stored-Review load, or keep the row clickable while the load has failed.
- **Raised by:** [Visited pull requests](foundations/visited-pull-requests.md#open-questions-and-verification), [Opening a Review](pull-requests/opening-a-review.md#open-questions-and-verification), [`VISITED-10`](verification/foundations-and-settings.md#foundationsvisited-pull-requestsmd).
- **Issue:** —

### B-17: The inline composer shortcut starts a review while its hint says comment

- **Where the user meets it:** The inline comment composer on an open Review with no GitHub pending review.
- **What happens / what was expected:** The composer's caption says the comment "publishes to GitHub" and its hint says "Press ⌘/Ctrl+Enter to comment. Escape cancels." Pressing ⌘/Ctrl+Enter runs Start a review, which creates a GitHub pending review holding the comment, so nobody else sees it until the review is finished. Expected: the shortcut matches the hint and caption, or the hint names Start a review.
- **Reproduce:** On a disposable open Review with no pending review, select a changed line, type a comment, and press ⌘+Enter. Check GitHub for a published comment and for a pending review.
- **Why (from the code):** `src/renderer/src/components/review-diff-authoring.tsx:328-333` sets the keyboard action to `start` whenever pending-review support is present and no pending review exists; `:365-371` runs `startOrAdd`, which calls `onStartReview` at `:307-317`. The caption at `:339-346` reads "publishes to GitHub" in that state and the hint at `:449` says "to comment".
- **Severity:** `medium`. A GitHub write of a different kind than the screen promised; the comment stays invisible to others.
- **Decision needed:** `fix`. Map the shortcut to Comment now in that state, or change the hint and caption to say it starts a review.
- **Raised by:** [Inline conversations](review-workbench/inline-conversations.md#open-questions-and-verification).
- **Status:** the hint was confirmed live on 2026-09-14 on `5fe7df3b`; the shortcut was not pressed because it writes to GitHub.
- **Issue:** —

## Low

### B-14: A re-render can cancel heading focus after a destination change

- **Where the user meets it:** Any change between Pull requests and a Review workbench, most plausibly on a heavy workbench first paint.
- **What happens / what was expected:** Patchdesk schedules focus on the new screen's first `h1` for the next animation frame. A re-render that passes a new destination value before that frame cancels it, and focus is never scheduled again, so focus stays on the page body. Expected: the heading receives focus once per destination change.
- **Reproduce:** Not reproduced. In a visible window, open a large Review from Pull requests and read `document.activeElement` after it settles; repeat with Back. A hidden CDP window runs no animation frames and cannot show the result.
- **Why (from the code):** `src/renderer/src/components/app-shell.tsx:119-131` records `focusedDestination.current = nextKey` (line 123) before the frame runs and cancels the frame in the effect cleanup (line 130); the effect depends on the `destination` object, which `src/renderer/src/app.tsx:440` builds inline on each render, so a re-run returns early at line 122. `tests/renderer/app-shell.ui.test.tsx` has no heading-focus case.
- **Severity:** `low`. Latent; when it fires, a keyboard user loses the orientation the documents promise.
- **Decision needed:** `fix`, named follow-up per the independent review. Record the key inside the frame callback or key the effect on the string, add a test that survives a same-key re-render, and verify live only when `document.visibilityState` is `visible`.
- **Raised by:** [Navigation and overlays](foundations/navigation-and-overlays.md#open-questions-and-verification), [Keyboard, focus, and desktop](cross-cutting/keyboard-focus-and-desktop.md#open-questions-and-verification).
- **Status:** 2026-09-14 on `5fe7df3b`: the settings live pass found focus on the body after three destination changes; the review traced one cancelled frame and one frame that never ran in a hidden window, so the live result is inconclusive.
- **Issue:** —

### B-16: The Visited pull requests column keeps rows for removed Reviews

- **Where the user meets it:** The Visited pull requests column after Clear local review data, or after the retention sweep removes a terminal Review's record while Patchdesk runs.
- **What happens / what was expected:** The column does not read again, so removed Reviews stay listed until the next Review open, workspace switch, or expand; clicking one leads to B-15. Expected: cleanup and the sweep refresh the column.
- **Reproduce:** In a disposable workspace with a terminal Review listed, run Clear local review data, close Settings without opening a Review, and inspect the column.
- **Why (from the code):** `src/renderer/src/components/visited-pull-requests.tsx:47-72` reads the list only when `profileId` or `reloadKey` changes; `src/renderer/src/app.tsx:226-232` moves `reloadKey` only in `openWorkbench`.
- **Severity:** `low`. Stale rows until the next open, with a failed click as the visible cost.
- **Decision needed:** `fix`. Move the reload key after cleanup succeeds and after a sweep that removed records.
- **Raised by:** [Visited pull requests](foundations/visited-pull-requests.md#open-questions-and-verification), [Data and recovery](settings/data-and-recovery.md#open-questions-and-verification), [`VISITED-11`](verification/foundations-and-settings.md#foundationsvisited-pull-requestsmd).
- **Issue:** —

### B-18: A Markdown-syntax image never opens the full-size view

- **Where the user meets it:** A pull request description or comment with a screenshot written as `![alt](url)` on its own line.
- **What happens / what was expected:** The image renders but a click does nothing, while a visually identical screenshot written as an HTML `<img>` opens the full-size view. Expected: a block-level Markdown image zooms like the HTML one.
- **Reproduce:** Open a Review whose description holds one Markdown-syntax screenshot and one HTML `<img>` screenshot, each on its own line; click both.
- **Why (from the code):** `src/renderer/src/components/pull-request-description.tsx:135-136` passes the tokenizer's `inline` flag, which is true for a Markdown image even alone in its paragraph, and `:522-524` returns the image without the zoom button whenever `inline` is true. An HTML image is always passed `inline={false}` at `:348`.
- **Severity:** `low`. Inconsistent affordance; the image is still readable.
- **Decision needed:** `fix`. Treat an image that is the only content of its paragraph as block-level.
- **Raised by:** [Conversation and pull request metadata](review-workbench/conversation-and-metadata.md#open-questions-and-verification).
- **Status:** confirmed 2026-09-14 on `5fe7df3b` on #86, a fixture built for image rendering, by the workbench live pass.
- **Issue:** —

### B-19: Try again and related run controls stay enabled on a merged or closed Review

- **Where the user meets it:** A failed or outdated Insight on a merged or closed Review, or a Brief's Start here card there.
- **What happens / what was expected:** Try again, Run for latest revision, and Start here's Generate walkthrough stay enabled and open the Insight run dialog, while the service refuses to start a run for a terminal Review. What the maintainer sees after Start run is unconfirmed. Expected: these controls follow the same open-only rule as Generate and Regenerate, with B-11's explanation.
- **Reproduce:** Use a disposable Review with a failed or outdated Brief, merge or close its pull request, refresh, open Brief, press Try again or Run for latest revision, and press Start run with a low-cost model.
- **Why (from the code):** `src/renderer/src/components/insight-panels.tsx:314-318` (Try again) and `:370-372` (Run for latest revision), and `src/renderer/src/components/brief-reader.tsx:249-258` (Generate walkthrough) are not gated by `runEnabled` from `src/renderer/src/components/review-insights-slot.tsx:202-203`. `src/services/insight-run-coordinator.ts:189` returns `terminal_review` for a terminal Review.
- **Severity:** `low`. A dead end that likely ends in a start failure; no data is at risk.
- **Decision needed:** `fix`. Gate these controls on the same rule and share B-11's explanation.
- **Raised by:** [Brief](review-workbench/brief.md#open-questions-and-verification).
- **Issue:** —

### B-20: Some Pull requests filters are not measured against the search length limit

- **Where the user meets it:** The Pull requests filters, when the composed GitHub search is near its 256-character limit.
- **What happens / what was expected:** Author, Base branch, and labels are refused at their control when they would push the search past the limit. Awaiting review from you, Review state, Check status, a change from Open to Merged, and a change of Selected repository can also lengthen the search but are sent without that check, and the main process refuses the read as an invalid request. What the listing then shows is unconfirmed. Expected: every query change is measured, or refused at its control.
- **Reproduce:** Choose a repository with long label names, select labels and an Author until the search is just under the limit, then turn on Awaiting review from you or choose a Review state.
- **Why (from the code):** `src/renderer/src/hooks/use-workspace-inbox.ts:141-148` defines `requestFitsQueryBudget`, used by labels (`:411`, `:431`), Author (`:492`), and Base branch (`:509`). `changeInboxState` (`:376`), `changeInboxAwaitingMyReview` (`:444`), `changeInboxReviewState` (`:458`), `changeInboxCheckStatus` (`:472`), and `changeInboxRepository` (`:540`) do not call it. `src/main/routes/dashboard-routes.ts:153-164` refuses the composed query with `invalid_input`.
- **Severity:** `low`. Needs unusually long filters; the maintainer can clear a filter.
- **Decision needed:** `fix`. Measure every query change before sending, or disable the control that would breach the limit.
- **Raised by:** [Filters, pagination, and refresh](pull-requests/filters-pagination-and-refresh.md#open-questions-and-verification).
- **Status:** 2026-09-14 on `5fe7df3b`: the live pass could not reach the limit with the repository's short labels.
- **Issue:** —

### B-21: Dismissed Findings still add to Finding badges

- **Where the user meets it:** The Diff tab's Browse rows and file headers, and the Finding cards in the diff, after the maintainer dismisses a mapped Finding.
- **What happens / what was expected:** The Finding badge counts every mapped Finding of the current Analysis, including dismissed ones, so a file keeps its count and tone after its Finding was dismissed, and the Finding may keep its card. Expected: a dismissed Finding no longer counts, matching the needs-attention rule the Analysis uses.
- **Reproduce:** Use a Review with a current Analysis and one mapped Finding on a file; dismiss it in Analysis; open Diff and inspect that file's Finding badge and line.
- **Why (from the code):** `src/renderer/src/components/review-workbench.tsx:492-503` keeps every Finding whose `mappingStatus` is `mapped` and passes them to `countFindingsByPath` at `src/renderer/src/review-finding-counts.ts:24-44`, which never reads `disposition`; dismissals are recorded as `disposition: "dismissed"` by `src/domain/analysis-merge-findings.ts:33-47`.
- **Severity:** `low`. The badge overstates remaining concerns on a reading surface.
- **Decision needed:** `fix`. Exclude dismissed Findings from badges and decide whether their cards stay.
- **Raised by:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#open-questions-and-verification).
- **Issue:** —

### B-22: Small copy and rendering slips

- **Where the user meets it:** Four places, each a copy or formatting slip.
- **What happens / what was expected:**
  - Fixed by `686f8d25`: the running Insight state read "Started 2026-09-14T08:32:10.123Z. Partial results are not shown." with a raw machine timestamp, while every other retained time in Insights was relative. It now draws a relative time and drops the partial-results sentence. Cause was `src/renderer/src/components/insight-panels.tsx:277`.
  - A ready Walkthrough says "Each section maps to one part of the patch. Use Back to files when you're done." The Walkthrough has no Back to files control. Cause: `src/renderer/src/review-copy.ts:37-41`, shown at `src/renderer/src/components/narrative-walkthrough.tsx:622`.
  - Review activity title-cases hyphenated phase names but shows underscore names raw, such as `Retention_sweep`. Cause: `activityLabel` at `src/renderer/src/flows/settings-flow.tsx:860-865` splits on `-` only.
  - The no-eligible-model guidance says to set credentials "in the Electron process, then reload", naming an internal process, while a key added to the login shell after launch needs a relaunch. Cause: `src/renderer/src/components/review-insights-slot.tsx:113` and `src/renderer/src/flows/settings-flow.tsx:750-755`.
- **Reproduce:** Start an Insight run and read the running state; open a retained Walkthrough; open Settings → Data & recovery and Load activity after a retention sweep; open Insights or Settings → Review with no eligible model.
- **Severity:** `low`. Cosmetic or misleading copy with no state at risk.
- **Decision needed:** `fix`, for the three that remain. Remove the Back to files sentence, split phase names on `_` as well, and reword the guidance to say relaunch Patchdesk.
- **Raised by:** [Brief](review-workbench/brief.md#open-questions-and-verification), [Walkthrough](review-workbench/walkthrough.md#open-questions-and-verification), [Logs and diagnostics](settings/logs-and-diagnostics.md#open-questions-and-verification), [Review defaults](settings/review-defaults.md#open-questions-and-verification).
- **Status:** 2026-09-14 on `5fe7df3b`: `Retention_sweep` was seen raw in Review activity by the settings live pass; the other three were read from source.
- **Issue:** —

### B-23: Walkthrough section keys ignore modifier keys

- **Where the user meets it:** A retained Walkthrough with focus inside the reader.
- **What happens / what was expected:** The Left and Right arrows, `j`, and `k` move sections without checking Command, Control, Option, or Shift, so a combination such as ⌘+Left may move sections instead of doing what the system expects. Unconfirmed live. Expected: section movement ignores modified keys, as the Diff's keyboard commands do.
- **Reproduce:** Open a Walkthrough with at least three sections, focus the reader, and press ⌘+Right and Shift+`k`.
- **Why (from the code):** `src/renderer/src/components/narrative-walkthrough.tsx:208-235` checks only the focused element's tag and role before handling `ArrowLeft`, `j`, `ArrowRight`, and `k`.
- **Severity:** `low`. Unconfirmed, and only a modified key reaches it.
- **Decision needed:** `fix`. Return early when a modifier is held.
- **Raised by:** [Walkthrough](review-workbench/walkthrough.md#open-questions-and-verification).
- **Issue:** —

### B-24: Repository-marked generated files do not reach the Scope gauge

- **Where the user meets it:** The Scope gauge in the pull-request list, the workbench header, and the Insights Scope card, for a repository that marks generated files as `linguist-generated` in `.gitattributes`.
- **What happens / what was expected:** Those files land in Core, Docs, or another bucket by path, even though the Scope rule accepts a list of repository-marked generated paths. Either behavior is defensible: wiring the list makes a large generated diff read correctly, and leaving it keeps the gauge purely path-based and cheap to compute from the stored patch.
- **Reproduce:** Open a pull request that changes a file marked `linguist-generated` whose path matches no generated rule, and inspect its bucket.
- **Why (from the code):** `src/domain/change-scope.ts:52` and `:268` accept `generatedPaths`, but `src/services/review-workbench-projection.ts:561` and `src/services/maintainer-inbox-service.ts:806` call `changeScopeFromPatch` with no options.
- **Severity:** `low`. A classification gap on repositories that mark generated files.
- **Decision needed:** `product call`. Wire `.gitattributes` into both call sites, or remove the unused option and keep the page's statement that Patchdesk does not read `.gitattributes`.
- **Raised by:** [Insights overview](review-workbench/insights-overview.md#open-questions-and-verification).
- **Issue:** —

## Not filed

The first pass rejected no candidates: all eight mapped to distinct user-visible symptoms and are fixed. The thread-resolution HTTP 403 and inconclusive reverse diff-navigation attempts remain verification blockers rather than triage entries because their product causes were not established.

From the 2026-09-14 UX pass:

- The current Review's Visited row doing nothing on Enter is intended design: `src/renderer/src/components/visited-pull-requests.tsx:240-244` drops the click handler on purpose and `tests/renderer/visited-pull-requests.ui.test.tsx` asserts it. The Tab walk through the column is friction, recorded in [ux-friction.md](ux-friction.md).
- Keyboard navigation doing nothing in Selected is intended since `14b47d13` and test-asserted; the missing hint is friction in [ux-friction.md](ux-friction.md).
- Insights opening on Brief while `insights-overview.md` said Overview was a documentation error, fixed in the page.
- The stale comment at `src/renderer/src/components/finish-review-dialog.tsx:44`, which says Discard is not offered while the dialog offers Discard review, has no user-visible effect.
- The blank Visited pull requests column on a fresh install, before the first workspace exists, is unobserved and stays an open question in [Visited pull requests](foundations/visited-pull-requests.md#open-questions-and-verification).

B-09 to B-12 were filed as GitHub issues #185 to #188, all four now closed as completed; no issue or external tracker entry has been created for any other entry. The first pass's source snapshot is `3100615`; the UX pass drafted against `dd613996` and rechecked every entry against `737c515c`.

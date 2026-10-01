# Bug triage

Open defects and product decisions are detailed below. Fixed entries retain their IDs for links from feature pages; the [changelog](../../CHANGELOG.md) owns fix history. Friction without a defect belongs in [ux-friction.md](ux-friction.md).

## Summary

The table records each disposition. Open entries need a fix or product decision; resolved entries remain here only to preserve links.

| ID   | Title                                                                                    | Severity | Area                               | Resolution or decision | Issue                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------- | -------- | ---------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B-01 | New profile replaces a Dirty draft without a choice                                      | high     | Settings / Workspace               | fixed                  | —                                                                                                                          |
| B-09 | Workspace settings reports GitHub authentication required while the active account works | medium   | Settings / Workspace               | fixed                  | [#185](https://github.com/kwanpham2195/patchdesk/issues/185)                                                               |
| B-10 | The Reviewers control never loads on a merged or closed Review                           | medium   | Review workbench / Conversation    | fixed                  | [#186](https://github.com/kwanpham2195/patchdesk/issues/186)                                                               |
| B-11 | Generate and Regenerate are disabled on a merged or closed Review with no reason         | medium   | Review workbench / Insights        | fixed                  | [#187](https://github.com/kwanpham2195/patchdesk/issues/187)                                                               |
| B-12 | The Checks control opens PR overview on Merge readiness                                  | medium   | Review workbench / Merge           | fixed                  | [#188](https://github.com/kwanpham2195/patchdesk/issues/188)                                                               |
| B-13 | Context and Preview stay unavailable when the Review worktree is missing                 | medium   | Review workbench / Diff            | fixed                  | [#616](https://github.com/kwanpham2195/patchdesk/issues/616)                                                               |
| B-15 | A failed load from a Visited row leaves the destination on the missing Review            | medium   | Visited pull requests column       | fixed                  | [#615](https://github.com/kwanpham2195/patchdesk/issues/615)                                                               |
| B-17 | The inline composer shortcut starts a review while its hint says comment                 | medium   | Review workbench / Inline comments | fixed                  | [#617](https://github.com/kwanpham2195/patchdesk/issues/617)                                                               |
| B-25 | Local drafts lose their lines after the coding agent commits                             | medium   | Local Review / coding agent        | fixed                  | [#491](https://github.com/kwanpham2195/patchdesk/issues/491)                                                               |
| B-02 | Scalar profile validation falls through to a generic request error                       | medium   | Settings / Workspace               | fixed                  | —                                                                                                                          |
| B-03 | Open Review recommendation preempts ready-to-merge action                                | medium   | Pull requests                      | fixed, superseded      | —                                                                                                                          |
| B-04 | Stale Review-opening error remains on the first-run screen                               | medium   | First run / Pull requests          | fixed                  | —                                                                                                                          |
| B-05 | Repository grouping treats a path prefix as containment                                  | medium   | Settings / Workspace discovery     | fixed                  | —                                                                                                                          |
| B-06 | A failed root scan is omitted from an otherwise successful discovery result              | medium   | Workspace discovery                | fixed                  | —                                                                                                                          |
| B-07 | Profile switch can leave the Repository picker unset after rows reload                   | medium   | Pull requests / Workspace          | fixed                  | —                                                                                                                          |
| B-08 | Navigate shortcut opens from a focused Review reply editor                               | medium   | Review workbench / Keyboard        | fixed                  | —                                                                                                                          |
| B-14 | A re-render can cancel heading focus after a destination change                          | low      | Navigation / Focus                 | fixed                  | [#619](https://github.com/kwanpham2195/patchdesk/issues/619)                                                               |
| B-16 | The Visited pull requests column keeps rows for removed Reviews                          | low      | Visited pull requests column       | fixed                  | [#618](https://github.com/kwanpham2195/patchdesk/issues/618), [#740](https://github.com/kwanpham2195/patchdesk/issues/740) |
| B-18 | A Markdown-syntax image never opens the full-size view                                   | low      | Review workbench / Conversation    | fixed (#348)           | —                                                                                                                          |
| B-19 | Try again and related run controls stay enabled on a merged or closed Review             | low      | Review workbench / Insights        | fixed (#348)           | —                                                                                                                          |
| B-20 | Some Pull requests filters are not measured against the search length limit              | low      | Pull requests / Filters            | fixed                  | [#620](https://github.com/kwanpham2195/patchdesk/issues/620)                                                               |
| B-21 | Dismissed Findings still add to Finding badges                                           | low      | Review workbench / Diff            | fixed                  | [#621](https://github.com/kwanpham2195/patchdesk/issues/621)                                                               |
| B-22 | Small copy and rendering slips                                                           | low      | Insights / Settings                | fixed                  | [#622](https://github.com/kwanpham2195/patchdesk/issues/622)                                                               |
| B-23 | Walkthrough section keys ignore modifier keys                                            | low      | Review workbench / Walkthrough     | fixed                  | [#623](https://github.com/kwanpham2195/patchdesk/issues/623)                                                               |
| B-24 | Repository-marked generated files do not reach the Scope gauge                           | low      | Review workbench / Insights        | product call           | —                                                                                                                          |

## High

### B-01: New profile replaces a Dirty draft without a choice

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-02: Scalar profile validation falls through to a generic request error

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-03: Open Review recommendation preempts ready-to-merge action

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-04: Stale Review-opening error remains on the first-run screen

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-05: Repository grouping treats a path prefix as containment

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-06: A failed root scan is omitted from an otherwise successful discovery result

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-07: Profile switch can leave the Repository picker unset after rows reload

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-08: Navigate shortcut opens from a focused Review reply editor

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-09: Workspace settings reports GitHub authentication required while the active account works

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** [#185](https://github.com/kwanpham2195/patchdesk/issues/185), closed

### B-10: The Reviewers control never loads on a merged or closed Review

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** [#186](https://github.com/kwanpham2195/patchdesk/issues/186), closed

### B-11: Generate and Regenerate are disabled on a merged or closed Review with no reason

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** [#187](https://github.com/kwanpham2195/patchdesk/issues/187), closed

### B-12: The Checks control opens PR overview on Merge readiness

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** [#188](https://github.com/kwanpham2195/patchdesk/issues/188), closed

### B-13: Context and Preview stay unavailable when the Review worktree is missing

- **Where the user meets it:** The Diff tab of a Review whose represented-review worktree no longer exists on disk.
- **What happens / what was expected:** Every file shows Context unavailable with "Patchdesk could not read the required file contents from the saved review revisions", and no Markdown file offers Preview. Reopening the Review changes nothing. Expected: Patchdesk rebuilds the worktree on demand, since the cache is described as re-creatable, or at least names the missing local checkout instead of a GitHub read.
- **Reproduce:** In a disposable workspace, open a Review, quit Patchdesk, remove that Review's folder under `~/.cache/patchdesk/profiles/<profile>/review-worktrees/`, relaunch, and open the Review's Diff.
- **Why (from the code):** `src/services/review-diff-source-service.ts:210-229` runs `git -C <worktree> merge-base` and `:231-251` reads blobs the same way, mapping any failure, including a missing directory, to the `github_read` reason. Nothing in the Review opening path re-prepares a missing worktree. Clear cache removes exactly those folders (`src/services/storage-management-service.ts:205-218` via `src/adapters/storage/review-artifact-storage.ts:449-470`).
- **Severity:** `medium`. Two reading features disappear for every affected Review with a misleading reason and no recovery short of a new revision.
- **Decision needed:** `fix`, named follow-up per the independent review: rebuild the worktree on demand, or add a distinct reason and copy for a missing local checkout.
- **Raised by:** [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md#open-questions-and-verification), [Persistence and recovery](foundations/persistence-and-recovery.md#open-questions-and-verification), [Data and recovery](settings/data-and-recovery.md#open-questions-and-verification).
- **Disposition:** Fixed. Opening a file's source re-creates a missing worktree from the session's pinned refs, pruning the stale registration first; when that fails, the reason is `worktree_missing`, not `github_read`.
- **Issue:** [#616](https://github.com/kwanpham2195/patchdesk/issues/616), closed

### B-15: A failed load from a Visited row leaves the destination on the missing Review

- **Disposition:** Fixed. A failed open of a stored Review that did not come from the launch restore returns the destination to Pull requests, keeps the `Could not open review` message, and leaves the Visited row clickable for a retry.
- **Issue:** [#615](https://github.com/kwanpham2195/patchdesk/issues/615)

### B-17: The inline composer shortcut starts a review while its hint says comment

- **Disposition:** Fixed. The composer's caption and hint name the action ⌘/Ctrl+Enter runs; see [Inline conversations](review-workbench/inline-conversations.md#begin-an-action).
- **Issue:** [#617](https://github.com/kwanpham2195/patchdesk/issues/617)

### B-25: Local drafts lose their lines after the coding agent commits

- **Disposition:** Fixed. Shared Reviews keep committed changes and their notes in the diff.
- **Issue:** [#491](https://github.com/kwanpham2195/patchdesk/issues/491)

### B-14: A re-render can cancel heading focus after a destination change

- **Where the user meets it:** Any change between Pull requests and a Review workbench, most plausibly on a heavy workbench first paint.
- **What happens / what was expected:** Patchdesk schedules focus on the new screen's first `h1` for the next animation frame. A re-render that passes a new destination value before that frame cancels it, and focus is never scheduled again, so focus stays on the page body. Expected: the heading receives focus once per destination change.
- **Reproduce:** Not reproduced. In a visible window, open a large Review from Pull requests and read `document.activeElement` after it settles; repeat with Back. A hidden CDP window runs no animation frames and cannot show the result.
- **Why (from the code):** `src/renderer/src/components/app-shell.tsx:119-131` records `focusedDestination.current = nextKey` (line 123) before the frame runs and cancels the frame in the effect cleanup (line 130); the effect depends on the `destination` object, which `src/renderer/src/app.tsx:440` builds inline on each render, so a re-run returns early at line 122. `tests/renderer/app-shell.ui.test.tsx` has no heading-focus case.
- **Severity:** `low`. Latent; when it fires, a keyboard user loses the orientation the documents promise.
- **Decision needed:** `fix`. Fixed: the focus effect is keyed on the destination key string and records the key only after the heading receives focus; `tests/renderer/app-shell.ui.test.tsx` re-renders between the change and the frame. Verify live only when `document.visibilityState` is `visible`.
- **Raised by:** [Navigation and overlays](foundations/navigation-and-overlays.md#open-questions-and-verification), [Keyboard, focus, and desktop](cross-cutting/keyboard-focus-and-desktop.md#open-questions-and-verification).
- **Issue:** [#619](https://github.com/kwanpham2195/patchdesk/issues/619)

### B-16: The Visited pull requests column keeps rows for removed Reviews

- **Where the user meets it:** The Visited pull requests column after Clear local review data, or after the retention sweep removes a terminal Review's record while Patchdesk runs.
- **What happens / what was expected:** The column does not read again, so removed Reviews stay listed until the next Review open, workspace switch, or expand; clicking one leads to B-15. Expected: cleanup and the sweep refresh the column.
- **Reproduce:** In a disposable workspace with a terminal Review listed, run Clear local review data, close Settings without opening a Review, and inspect the column.
- **Why (from the code):** `src/renderer/src/components/visited-pull-requests.tsx:47-72` reads the list only when `profileId` or `reloadKey` changes; `src/renderer/src/app.tsx:226-232` moves `reloadKey` only in `openWorkbench`.
- **Severity:** `low`. Stale rows until the next open, with a failed click as the visible cost.
- **Disposition:** Fixed. The reload key moves when Clear local review data finishes (#618) and when the main process reports that a retention sweep removed at least one Review record (#740). The report is a main-to-renderer event, not a timer (ADR 0032).
- **Raised by:** [Visited pull requests](foundations/visited-pull-requests.md#open-questions-and-verification), [Data and recovery](settings/data-and-recovery.md#open-questions-and-verification), [`VISITED-11`](verification/foundations-and-settings.md#foundationsvisited-pull-requestsmd).
- **Issue:** [#618](https://github.com/kwanpham2195/patchdesk/issues/618) for Clear local review data, [#740](https://github.com/kwanpham2195/patchdesk/issues/740) for the retention sweep

### B-18: A Markdown-syntax image never opens the full-size view

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-19: Try again and related run controls stay enabled on a merged or closed Review

- **Disposition:** Fixed. See linked feature and verification rows for current behavior.
- **Issue:** —

### B-20: Some Pull requests filters are not measured against the search length limit

- **Disposition:** Fixed. State, Preset, Review state, and Check status run the same length check as labels, Author, and Base branch: an option that would push the search past 256 characters is disabled with `Too long alongside the other filters`, in the filter bar and in the command palette, and a change function called anyway sends nothing. A Selected repository change is never refused: labels are cleared as before, then Author, Base branch, Awaiting review or Your pull requests, Review state, and Check status are dropped in that order until the search fits, and each dropped filter is named beside the filters. Filters restored at launch and a repository removed in Settings during a session go through the same drop, and from a search that is already too long a control that is enabled always applies, so turning a filter off is never ignored ([#786](https://github.com/kwanpham2195/patchdesk/issues/786)). See [Filters, pagination, and refresh](pull-requests/filters-pagination-and-refresh.md#the-search-length-limit).
- **Issue:** [#620](https://github.com/kwanpham2195/patchdesk/issues/620)

### B-21: Dismissed Findings still add to Finding badges

- **Disposition:** Fixed. Finding badges count only Findings that still need attention, by the rule the Analysis headline uses; see [Files, diff, commits, and navigation](review-workbench/files-diff-and-navigation.md). The inline cards stay for every mapped Finding.
- **Issue:** [#621](https://github.com/kwanpham2195/patchdesk/issues/621)

### B-22: Small copy and rendering slips

- **Disposition:** Fixed. Review activity splits phase names on hyphens and underscores (`Retention sweep`), and the Insights panel's no-model message names a shell-profile API key or the Codex or pi CLI on the launch PATH, then a relaunch, with a separate message when the model list fails to load; see [Logs and diagnostics](settings/logs-and-diagnostics.md#open-questions-and-verification) and [Brief](review-workbench/brief.md).
- **Issue:** [#622](https://github.com/kwanpham2195/patchdesk/issues/622)

### B-23: Walkthrough section keys ignore modifier keys

- **Disposition:** Fixed. Section movement skips a key pressed with Command, Control, Option, or Shift held; see [Walkthrough](review-workbench/walkthrough.md#open-questions-and-verification).
- **Issue:** [#623](https://github.com/kwanpham2195/patchdesk/issues/623)

### B-24: Repository-marked generated files do not reach the Scope gauge

- **Where the user meets it:** The Scope gauge in the pull-request list, the workbench header, and the Brief's Scope card, for a repository that marks generated files as `linguist-generated` in `.gitattributes`.
- **What happens / what was expected:** Those files land in Core, Docs, or another bucket by path, even though the Scope rule accepts a list of repository-marked generated paths. Either behavior is defensible: wiring the list makes a large generated diff read correctly, and leaving it keeps the gauge purely path-based and cheap to compute from the stored patch.
- **Reproduce:** Open a pull request that changes a file marked `linguist-generated` whose path matches no generated rule, and inspect its bucket.
- **Why (from the code):** `src/domain/change-scope.ts:52` and `:268` accept `generatedPaths`, but `src/services/review-workbench-projection.ts:561` and `src/services/maintainer-inbox-service.ts:806` call `changeScopeFromPatch` with no options.
- **Severity:** `low`. A classification gap on repositories that mark generated files.
- **Decision needed:** `product call`. Wire `.gitattributes` into both call sites, or remove the unused option and keep the page's statement that Patchdesk does not read `.gitattributes`.
- **Raised by:** Insights overview, a page removed with the Overview tab in #350.
- **Issue:** —

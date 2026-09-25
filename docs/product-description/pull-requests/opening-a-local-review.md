# Opening a local Review

## Summary

Opening a local Review turns a change that has no pull request yet into a readable Review workbench. The maintainer reaches it from the Local review button on the Pull requests screen, beside the Repository picker, and it appears only when the Selected repository has a local checkout in the active workspace profile. The maintainer picks a _Review source_: the working tree against `HEAD`, a local branch against a base branch, or one commit. Patchdesk reads the checkout, prepares a _Review session_ for that exact revision, and opens the workbench on the Diff tab. Opening changes nothing in the maintainer's checkout and performs no GitHub read or write.

## The simple case

The maintainer selects a repository that has a local checkout and presses Local review. The Open a local review dialog names the repository and offers three tabs: Working tree, Branch, and Commit. Working tree is selected, with the note `Staged, unstaged, and untracked changes against HEAD.` The maintainer presses Open review. The button reads Opening… and the shared busy indicator reads Opening Review… while Patchdesk records the working tree and prepares the session.

When preparation succeeds, the dialog closes and the Review workbench opens on the Diff tab. The heading names the source, for example `Working tree on feat/449-local-review-source`. Every staged, unstaged, and untracked file that `.gitignore` does not exclude appears in the file tree and the diff, each untracked file marked NEW.

## The task, event by event

```mermaid
stateDiagram-v2
    [*] --> picking : press Local review
    picking --> opening : press Open review
    opening --> workbench : checkout read and session prepared
    opening --> refused : conflict, missing revision, or read failure
    refused --> opening : press Open review again
    picking --> [*] : Cancel, Close, or Escape
```

### Arrive

The Local review button sits in the Pull requests header between the Repository picker and the freshness badge. It appears only when the workspace profile lists the Selected repository with a local checkout path; a repository without one shows no button. Pressing it opens the dialog with the Working tree tab selected and the Branch fields set to an empty Branch and a Base branch of `main`.

### Leave unchanged

Switching tabs, typing in the fields, pressing Cancel, pressing Close, or pressing Escape reads nothing and writes nothing. The dialog is created fresh each time it opens, so a cancelled draft does not return.

Open review stays disabled until the chosen tab is complete: Branch needs both a branch and a base branch, and Commit needs a SHA of 4 to 64 hexadecimal characters, full or abbreviated, in either case. Spaces around a value are ignored.

### Begin an action

Pressing Open review sends the source to the main process. Patchdesk checks that the repository is in the active profile with a local checkout, then reads the source from that checkout:

- **Working tree.** Patchdesk records the checkout as a _Local snapshot_, a commit object built from every staged, unstaged, and untracked file against `HEAD`. The branch `HEAD` names, or `detached HEAD`, identifies the Review, so switching branches opens a different Review.
- **Branch.** The branch tip is compared with its merge base with the base branch. Commits made on the base branch after the branch point do not appear.
- **Commit.** The commit is compared with its first parent. A root commit is compared with an empty tree, so every file it adds appears as new.

> Technical note: the Local snapshot is built in a temporary copy of the checkout's index and committed with a fixed author, committer, date, and message, so the same content on the same `HEAD` always has the same SHA. The maintainer's index, branches, and working files are never written. The snapshot's objects go into the repository's object store and are reachable only from a ref under `refs/patchdesk/local/` (ADR 0050).

### While the action runs

The dialog stays open. Open review reads Opening…, Cancel is disabled, the Close button is hidden, and Escape and clicks outside the dialog are ignored until the attempt settles. The shared busy indicator reads Opening Review….

Patchdesk prepares the session for the resolved head and base: it pins the head under a managed ref, checks it out as a separate represented-review worktree under the app cache, and writes the patch. The same profile lock and Review lock that serialize pull-request opening serialize this work.

> Technical note: the patch is `git diff --binary` between the base and head, written with `a/` and `b/` paths and no colour whatever the checkout's diff configuration says, and hashed as written. That hash is the session's patch identity.

### Settle

On success the dialog closes and the Review workbench replaces the Pull requests screen, on the Diff tab. The workbench differs from a pull-request Review:

- The heading names the source: `Working tree on <branch>`, `Working tree on detached HEAD`, `Branch <branch> against <base>`, or `Commit <first eight characters>`.
- The tab strip shows Diff and Insights; there is no Conversation tab.
- The header shows the Scope gauge and a line with the repository and the revision it represents: `Local snapshot <first eight characters> · read from the local checkout` for a working tree, `Branch tip <…>` for a branch, and `Commit <…>` for a commit. It makes no claim about GitHub: there is no freshness label or checked time, no Checks or Merge chips, no Open on GitHub or Watch button, no Start a review or Finish review button, and no Refresh button.
- The Diff tab behaves as described in [Files, diff, and navigation](../review-workbench/files-diff-and-navigation.md), including expanding unchanged context around a hunk. Its Commits section lists no commits, its Threads section lists no threads, and selecting lines offers no inline comment.
- The Insights tab runs Brief, Walkthrough, and Analysis as described in [Insights on a local Review](#insights-on-a-local-review).

Opening the same source again with unchanged content lands on the same Review session. An edit to any file, or a new `HEAD`, prepares a new session, and the same Review moves to it.

On failure the dialog stays open with a `Review not opened` alert that gives the reason in one sentence:

| Cause                                                                                  | Sentence                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| The working tree's index holds an unresolved merge conflict                            | `The working tree has unresolved merge conflicts.`          |
| The branch, base branch, merge base, or commit does not exist, or `HEAD` has no commit | `This checkout has no such branch, base branch, or commit.` |
| The repository is no longer in the profile with a local checkout                       | `This repository has no local checkout in the workspace.`   |
| Any other read, storage, or worktree failure                                           | `Patchdesk could not read the local checkout.`              |

The fields keep their values, and pressing Open review again retries.

## Insights on a local Review

Brief, Walkthrough, and Analysis run on a local Review from the same run dialog, with the same provider, model, effort, and language choices, as on a pull request Review. Each run is bound to the local session's head, base, and patch hash, so a run on a working tree analyzes the Local snapshot, including untracked files. A result is retained and read back the same way; a later session makes it Outdated.

What differs is what a local Review has no source for:

- The model's context carries the repository's rule files and the changed-file list, but no pull request comments and no check results. Patchdesk makes no GitHub read to start the run.
- Analysis shows its Findings and their evidence hunks, with Dismiss. There is no Add to review, no Add all, no Finish with the Analysis summary, and no CI badge, because a local Review has no pull request to write to or checks to report. On a working tree, a Finding that carries a suggestion offers an Apply checkbox in place of its status; any other Finding's status reads Unavailable. See [Apply suggestions to the working tree](#apply-suggestions-to-the-working-tree).
- Walkthrough shows no discussion note, because a local Review has no Conversation.
- Brief draws Flow, Shape, Blast radius, and Start here. Blast radius counts names by text search at the session head, which for a working tree is the Local snapshot, so a name the uncommitted change adds is found. Brief has no Description vs diff block for any Review (ADR 0040), and no citation names a commit.
- A settled run posts no desktop notification.

## Apply suggestions to the working tree

On a working-tree Review with a current Analysis, a Finding whose suggestion resolves in the session's patch shows an **Apply** checkbox beside Dismiss, and the Needs attention card shows an Apply bar above the Findings. The maintainer ticks one or more Findings; the button reads `Apply 1 suggestion` or `Apply <n> suggestions` and stays disabled while nothing is ticked. Pressing it opens a confirmation that lists every selected Finding by title and location. **Apply to working tree** writes; Cancel, Escape, or a click outside writes nothing.

Patchdesk first reads the checkout again. When the working tree differs from the session the Analysis ran on, nothing is written, the Review records that its revision changed, and the bar shows `The working tree changed after this Analysis ran. Open the review again to analyze the current files.` beside the button. Otherwise it rebuilds each change from the retained Analysis and the file's current bytes, runs `git apply` on the checkout, and confirms every file reached its expected content. The maintainer's index is not written and nothing is staged.

On success the Review moves to a new session for the changed working tree and the workbench opens on it. The earlier Analysis reads Outdated: its Findings stay readable and offer no Apply, and applying more needs a new run.

| Cause                                                      | Sentence beside the button                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The working tree changed after the run                     | `The working tree changed after this Analysis ran. Open the review again to analyze the current files.` |
| Two selected suggestions change the same line              | `Two selected suggestions change the same lines. Select only one of them.`                              |
| A file no longer holds the replaced lines, or is not UTF-8 | `A file no longer holds the lines a suggestion replaces. Open the review again.`                        |
| `git apply --check` refuses the patch                      | `git apply refused the change. Nothing was written.`                                                    |
| A path leaves the checkout or passes through a symlink     | `A file is outside the checkout or behind a symlink. Nothing was written.`                              |
| Another action on the Review is running                    | `Another action on this review is running. Try again when it finishes.`                                 |

When Patchdesk cannot prove the outcome, for example the app quits while `git apply` runs, the bar replaces Apply with `An Apply may have changed files. Check them before applying more.` and a **Check files** button. Checking, and every app start, compares each file's sha256 with the hashes recorded before the write: every file at its new content confirms the Apply and prepares the next session; every file at its old content clears the lock; anything else keeps the lock and reads `An Apply left the files in an unexpected state.` Patchdesk never runs `git apply` again on its own. Each decision is logged to `patchdesk.jsonl` with topic `local-apply` and message `Local apply recovery decided`.

> Technical note: the operation record in the Review's folder (`local-apply-operation.json`) stores each file's path and pre- and post-image sha256 before `git apply` runs, and is marked outcome-unknown immediately before it (ADR 0050, ADR 0035). Branch and commit Reviews offer no Apply.

## Variants

| Variant                                                | Before the action runs                                                                                                                                    | While the action runs                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workspace profile and GitHub account                   | The button appears only for a Selected repository the active profile lists with a local checkout. The GitHub account is not used.                         | The attempt belongs to the profile that was active when it started; the workbench opens only if that profile is still active. |
| Pull request and Review state                          | No pull request is needed. A source opened before resumes its Review; a new source creates one.                                                           | The resolved head and base fix the session. A different source spec is a different Review.                                    |
| GitHub permissions and merge readiness                 | No effect. A local Review has no GitHub permission or merge readiness.                                                                                    | No effect. Nothing is read from or written to GitHub.                                                                         |
| Network, local tool, and Insight provider availability | `git` must be available. The network and Insight providers are not needed.                                                                                | A failing `git` command or unwritable app storage settles as `Patchdesk could not read the local checkout.`                   |
| Input path: mouse, keyboard, or desktop menu           | The button and dialog take mouse and keyboard input; the tabs move with the arrow keys and select with Enter or Space. There is no menu or palette entry. | Enter in a field submits the form once. Input to the dialog is ignored until the attempt settles.                             |

## Cancel and interrupt

| Event                                                                                                 | Before the action runs                                            | While the action runs                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancel, Stop, or Escape                                                                               | Cancel, Close, and Escape close the dialog with no effect.        | Cancel is disabled and Escape is ignored. The attempt runs to completion or failure.                                                                    |
| Navigate to another Patchdesk screen, Review, Settings section, or workspace profile                  | Closing the dialog and navigating have no effect on the checkout. | A profile switch leaves the prepared session on disk but does not open its workbench.                                                                   |
| Start another action or request a refresh                                                             | Refreshing the Repository listing does not affect the dialog.     | Openings of the same Review wait for each other; each resolves the checkout as it was when it started.                                                  |
| GitHub, the network, a local tool, or an Insight provider fails or times out                          | No effect.                                                        | A `git` failure or timeout settles with a refusal in the dialog; nothing partial is adopted.                                                            |
| Close Settings, reload the renderer, close the window, or quit Patchdesk                              | No effect.                                                        | The preparation journal removes a partly prepared session at the next start. A snapshot commit already written stays in the object store, unreferenced. |
| The pull request, represented revision, pending review, permission, or other target changes elsewhere | No effect until Open review is pressed.                           | An edit after Patchdesk has read the working tree is not in this session; opening again records it as a new session.                                    |
| macOS focus, a file or folder picker, or another input path takes control                             | No effect.                                                        | No effect on the attempt.                                                                                                                               |

## Interactions with other systems

**Workspace profile and identity.** A local Review is keyed by the profile, the repository, and the source spec. The repository must be in the profile with a local checkout path at the time of opening.

**Review revision and freshness.** The session pins a head and base as [Review session and revision](../foundations/review-session-and-revision.md) describes for pull requests. For a working tree the head is the Local snapshot and the base is `HEAD`; for a branch, the tip and the merge base; for a commit, the commit and its first parent. Opening recomputes the source, so a just-opened local Review is Fresh.

**Local persistence and recovery.** The Review, its session, the patch, and the worktree are stored with the pull-request Reviews and recovered by the same journal. A saved destination naming a local Review reopens the stored session at launch without reading the checkout again. A local Review does not appear in the Visited pull requests column or in the Repository listing.

**GitHub permissions and write authority.** No GitHub read or write happens. The checkout is read; the only writes to the repository are the snapshot objects, the managed ref, and the worktree registration.

**Network, local tools, and Insight providers.** Opening needs only local `git`. An Insight run needs its provider, as on a pull request Review, and no GitHub access.

**Concurrent operations and locking.** The Review lock and the profile lock serialize openings of the same Review and preparations in the same profile.

**Feedback, errors, and diagnostics.** Progress shows in the dialog and the shared busy indicator. Failures stay in the dialog; a failed preparation is recorded in the Review diagnostics.

**Preferences, keyboard commands, and desktop integration.** A successful open becomes the saved destination, as for a pull-request Review. The Diff tab's view preferences apply unchanged.

**Supported input and accessibility limits.** Mouse and keyboard only. Touch, pen, and screen-reader behavior are outside the product claim.

## Edge cases

- A detached `HEAD` opens a Review named `Working tree on detached HEAD`, distinct from every branch's working-tree Review.
- A working tree with no changes opens a session whose patch is empty.
- A root commit opens with every file as NEW.
- Two branches whose names differ only in characters that cannot appear in a folder name still open two different Reviews.
- A branch whose history shares nothing with the base branch is refused with the missing-revision sentence.
- Files that `.gitignore` excludes never appear, even when they are open in an editor.
- A patch larger than Patchdesk's 2 MiB command output limit is refused with `Patchdesk could not read the local checkout.`

## Open questions and verification

- Live pass on 2026-09-25 over CDP 9233: a working-tree Review on the Patchdesk checkout showed an untracked probe file as NEW on the Diff tab; `shasum` of the checkout's index and `git status --short` were identical before and after; opening again with unchanged content left one session.
- Live pass on 2026-09-25 over CDP 9233 (#450): on a working-tree Review of the Patchdesk checkout with an untracked probe file, Analysis (Codex CLI account, `gpt-6-luna`, high) returned a P2 Finding anchored to the probe file's line 9 with no Add to review command, and Brief (medium) rendered Flow, Shape, Blast radius counted at the snapshot SHA, and Start here. The header read `Local snapshot 66316662 · read from the local checkout`. Walkthrough was not run live.
- Brief's Blast radius heading reads "what this PR could affect", and Analysis shows `0 of 1 handled` and an Unavailable status beside each Finding; both are pull-request wording on a local Review. Finding actions for local Reviews belong to #451.
- The Analysis prompt still asks the model to review a pull request and check its description; changing prompt text needs its own review.
- That selecting lines offers no inline comment was checked in code, not live.
- Refresh of a local Review, and Commit, Push, and Open PR, are not built (#452). Local drafts, Add to draft, and the copy actions of #451 are not built yet.
- Live pass on 2026-09-25 over CDP 9233 (#451): a working-tree Review of the Patchdesk checkout with an untracked probe file; Analysis (Codex CLI account, `gpt-6-luna`, high) returned a P1 Finding at `tmp-local-review-probe.ts:3` with a suggestion. Apply was refused with the changed-tree sentence after the probe was edited, and after the edit was undone and the Review reopened, Apply changed exactly line 3; `git status --short` and the index `shasum` were identical before and after.
- The outcome-unknown lock and Check files were checked in service and component tests, not live: interrupting the app between the two marks cannot be timed by hand.
- The empty-patch workbench, the conflict refusal, the branch and commit sources, and the failure sentences were checked in service and component tests, not live.
- Managed refs and worktrees of local sessions are not removed after a successful open; cleanup is not described here because it does not exist yet.

Drafted from Patchdesk application source commit `502acfd8`; the Insights section from `7d9a660a`. The live pass ran on `88434b1b`, which lacks two later fixes: the patch command's config-proof flags (`eaa6f3e0`) and the index copy that keeps its mtime (`502acfd8`).

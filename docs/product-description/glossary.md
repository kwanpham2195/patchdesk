# Glossary

The vocabulary for Patchdesk product and engineering documents. Use these terms consistently; feature pages and ADRs own detailed behavior and decisions. The words-to-avoid notes below guard against misleading synonyms.

## The desktop surface

**Patchdesk.** The local macOS desktop app that helps a maintainer find and review GitHub pull requests. It runs beside local checkouts and has no Patchdesk server between the app and GitHub.

**Pull requests screen.** The screen where a maintainer chooses a _Selected repository_ and finds the pull request to review. It is read-only: it opens _Reviews_ but performs no GitHub write.

**Review workbench.** The persistent screen where a maintainer conducts a _Review_. It shows the represented diff, review controls, and optional _Insights_. A pull request Review also shows GitHub state and Conversation; a local Review shows feedback for the coding agent.

**Visited pull requests column.** The persistent column left of the main content on the Pull requests screen, on every Review workbench, and beside workspace setup. It lists up to 20 pull requests and local Reviews the maintainer has opened in the active workspace, most recently opened first, read from local Review records with no GitHub request. Each entry is a Visited row: a click, Enter, or Space opens that Review workbench with no select step, and the row of the Review already on screen is highlighted and does nothing. The titlebar's first control collapses and expands the column; that choice is one setting on this machine, shared by every workspace.

**Settings.** A global overlay above the current screen. It has General, Workspace, and Data & recovery sections and returns focus to the control that opened it when it closes normally.

**Diagnostics.** A global overlay opened from Help → Diagnostics… or the ⌘K palette. It has Logs and Review activity sections and returns focus to the control that held it when it closes.

**Local API.** The authenticated loopback boundary between Patchdesk's sandboxed window and its main process. The maintainer does not call it directly; visible actions in the window use it to read local state, run tools, and request GitHub operations.

## Workspace and identity

**Workspace profile.** The saved local configuration that selects a GitHub host and account, rule paths, and watched repositories with their checkouts. Switching profiles returns the app to the Pull requests screen and reloads that profile's state. This is the internal name; the app calls it a _Workspace_.

**Workspace.** What the app calls a _workspace profile_ everywhere the maintainer can see it: the Settings section, its Name and Active workspace controls, and the New workspace dialog. A workspace's stored identifier is derived from its name and is never shown.

**Active profile.** The workspace profile currently applied to the app. A workspace created in Settings is not active until its creation and selection both succeed.

**GitHub account.** The authenticated `gh` identity Patchdesk resolves for a workspace profile. Patchdesk obtains a token when needed and does not store it.

**Workspace root.** Retired in #641. A folder Patchdesk v0.0.12 and earlier scanned for checkouts. A profile that still lists roots loads normally; Patchdesk ignores them and saves the list back empty.

**Rule path.** An absolute path to an instruction file that Patchdesk includes when it prepares represented Review context. A profile can have no rule paths.

**Reviewing as.** The Settings status that compares the workspace profile's configured GitHub account with the account the GitHub CLI currently resolves. Re-checking probes the local CLI again; it does not perform a GitHub write.

**Watched repository.** A repository saved in a workspace profile for use on the Pull requests screen. The maintainer adds one by `owner/repo`. It can have no checkout.

**Configured checkout.** The local git checkout the maintainer chose for a watched repository with Choose checkout, saved as its top-level folder. Patchdesk accepts only a checkout whose `origin` names the repository and never searches the disk for one. A local Review needs it.

**Selected repository.** The one watched repository whose GitHub pull requests the Pull requests screen currently represents. Filters, counts, pages, and refreshes apply only to this repository.

## Pull requests and Reviews

**Repository listing.** The Pull requests screen's list of GitHub pull requests in the Selected repository. GitHub decides membership, order, count, and pagination; Patchdesk adds local Review indicators but does not re-sort or re-count the returned rows.

**Pull request filter.** The maintainer's constraints on the Repository listing, sent as GitHub search terms. The built surface includes state, labels, Review state, Check status, author, base branch, and the mutually exclusive Awaiting review from you and Your pull requests presets. See [filters and pagination](pull-requests/filters-pagination-and-refresh.md).

**Review state filter.** The More filters choice that limits pull requests by GitHub review state. Its choices are Any, Not reviewed, Review required, Approved, and Changes requested; Any removes this qualifier.

**Check status filter.** The More filters choice that limits pull requests by GitHub check status. Its choices are Any, Pending, Passing, and Failing; Any removes this qualifier.

**Author filter.** The More filters text field that limits pull requests to one GitHub login, or to `@me` for the authenticated account; an empty field removes this qualifier.

**Base branch filter.** The More filters text field that limits pull requests to one base branch name, such as `main`; an empty field removes this qualifier.

**More filters popover.** The Pull requests control that contains the Review state, Check status, Author, and Base branch filters. It shows how many of those fields are active and exposes their active values as individually clearable chips.

**Review indicator.** A signal on a Repository listing row that Patchdesk derives from local Review sessions. The current indicators are Updated since review and Ready to merge.

**Updated since review.** A Review indicator when a pull request's current head moved beyond the session's pinned revision.

**Ready to merge.** A Review indicator shown only when a session matches the current head, checks pass, and fresh GitHub evidence reports the pull request mergeable.

**Recommended action.** The single primary command shown on a Repository listing row. Patchdesk chooses it from the row's Review indicators and Review session state.

**Review.** A maintainer's evaluation of a pull request or local source. A pull request Review continues across revisions and ends when GitHub reports it merged or closed. A local Review collects feedback for the coding agent and does not hand off to a pull request Review. See [the local Review decision](../adr/0051-review-local-changes-for-the-coding-agent.md).

**Review session.** The local work for a Review, anchored to one pinned revision of its source: a pull request head and base, or a local head and base. A later revision moves the Review to another session without changing the earlier one. See [review session and revision](foundations/review-session-and-revision.md).

**Review source.** What a Review's patch is computed from: a pull request, a _shared Review_'s branch against its base branch, or one commit against its parent. Every source but a pull request makes a _local Review_. Working-tree and branch sources from before the shared Review remain only in stored Reviews.

**Checkout.** A working copy of a watched repository used by a local Review: its Configured checkout or a linked Git worktree. Each checkout keys its own Review. See [opening a local Review](pull-requests/opening-a-local-review.md).

**Shared Review.** The one local Review of a checkout's current branch against a base branch: the branch's commits and the checkout's staged, unstaged, and untracked changes in one diff, from the merge base to the Local snapshot. Its notes stay on their lines after the coding agent commits. Patchdesk preselects the nearest other local branch as the base, and the maintainer may pick another; another branch or base is another shared Review.

**Patch view.** One of a _shared Review_'s three diffs of the same session: Combined, from the merge base to the Local snapshot; Committed, from the merge base to the checkout's `HEAD`; and Uncommitted, from `HEAD` to the Local snapshot. Switching views moves neither the Review nor its session. Notes keep their state across views, Viewed marks belong to one view, and Insights run on Combined.

**Local Review.** A Review of a branch or commit in a local checkout the workspace profile lists, opened before any pull request exists. It has no Conversation, checks, merge, or pending review.

**Local snapshot.** The commit object Patchdesk writes to record a working tree: every staged, unstaged, and untracked file not ignored, committed with a fixed identity so the same content always has the same SHA. The maintainer's index and branches never see it.

**Change intent.** The spec a local Review's change is checked against: Markdown the maintainer entered, or a repository-relative spec file read at the reviewed revision. Only Analysis reads it, as the change's stated goal, and an Analysis result names the intent it was checked against.

**Local draft.** A Finding the maintainer added to a local Review's draft list, or a note the maintainer wrote on a diff line. It is feedback for the coding agent, listed in the Diff navigator's Notes section, copied as one prompt or read over MCP, and never becomes a GitHub comment.

**Coding agent.** A terminal agent, such as Claude Code or Codex, that edits a checkout and reaches Patchdesk through the `patchdesk mcp` command. It can open and refresh a local Review, ask for Insights, and read results and Local drafts; its tools cannot run an Insight, Apply, or change the maintainer's notes.

**Agent reply.** The coding agent's latest plain-text answer to a Local draft, stored beside the draft. It can say addressed, skipped with a reason, or ask a question. It never enters an Insight or agent prompt.

**Resolved draft.** A Local draft the maintainer marked done. It stays listed but leaves the agent prompt and open feedback until the maintainer reopens it.

**Agent explanation.** The coding agent's explanation on lines of a local Review's Combined diff. It is shown inline, separate from Local drafts, and does not enter feedback, prompts, hand-off, or Insights.

**Feedback hand-off.** The maintainer's mark that Local drafts are ready for the coding agent, made with Ready for agent or Copy as agent prompt. A newer mark replaces it; moving to a new session clears it. See [coding agent over MCP](pull-requests/coding-agent-over-mcp.md).

**Agent run request.** A coding agent's request for one Insight on a local Review's current or Prepared session. It waits on the Agent requests bar for the maintainer to Run or Decline it and spends nothing by itself. A request for the Prepared session appears after the maintainer refreshes to it. See [coding agent over MCP](pull-requests/coding-agent-over-mcp.md).

**Prepared session.** A session a coding agent's refresh prepared for newer content in the checkout while the local Review stays on the session the maintainer reads. The header shows Updates available, and the maintainer's Refresh moves the Review to it.

**Represented revision.** The exact head, base, and canonical patch identity a Review session presents. User-visible evidence and Insights remain bound to it.

**Represented-review worktree.** Patchdesk's immutable checkout for a Review session's represented revision. It is separate from the maintainer's checkout and is available only to bounded, read-only review inspection.

**Fresh.** A Review freshness state in which the represented revision matches current GitHub evidence. Review-content writes require it; pull-request metadata writes have a separate current-session gate. The workbench shows Up to date with GitHub. See [review session and revision](foundations/review-session-and-revision.md).

**Revision changed.** A Review state in which current GitHub evidence proves that the pull request moved beyond the represented revision. Existing content stays readable, but revision-bound writes and actions stop until the Review refreshes to a new session. The workbench shows it as Newer revision on GitHub.

**Remote state unavailable.** A Review freshness state in which Patchdesk cannot prove the represented revision still matches GitHub. It can show last-known content but cannot authorize a revision-bound review-content write. The workbench shows Could not reach GitHub. See [review session and revision](foundations/review-session-and-revision.md).

**Terminal remote state.** A Review state in which GitHub reports the pull request merged or closed. Patchdesk keeps the Review readable and stops further Review and merge writes.

## Reading the Review workbench

**Workbench theme inheritance.** Embedded Review surfaces use Patchdesk's active light or dark theme; they have no separate theme setting.

**PR overview.** The drawer on the right of the Review workbench, titled "PR overview", that both the Checks and Merge status controls in the Review header open. Its collapsible rows are Revision, Checks, Review status, and Merge readiness, and Merge readiness holds the merge command. Closing it returns focus to the control that opened it.

**Browse.** The Diff navigator's first tab, listing the displayed patch's changed files as a tree. A Scope filter narrows it; the Commits tab and the Threads or Notes tab beside it stay complete.

**File display mode.** The choice in the diff toolbar's View options menu between All files, which draws every file of the displayed patch in one scrolling pane, and Selected, which draws only the selected file. The default is All files, and the choice is saved once for the whole app with the View options. File, hunk, and unresolved-comment keyboard commands work only in All files.

**Scope bucket.** One of the five groups a changed file falls into by its path alone: Core, Tests, Generated, Docs, or Config. Every changed file lands in exactly one bucket.

**Scope filter.** The narrowing of Browse and the diff pane to one Scope bucket, chosen from the diff toolbar's Scope picker or a row of the Brief's Scope card. Choosing Clear scope in the picker, or the Commits tab, clears it. It is not saved with the workbench position.

**Finding badge.** The count on a Browse row and in a diff file header of how many mapped Findings in the current Analysis cite that file. Its tone follows the most severe of them: destructive for P0 and P1, warning for P2, muted for P3.

**Finding card.** A mapped Finding drawn at its line in the diff, with its severity, title, explanation, and Open in Analysis. It appears only while the Analysis is current.

## Review content and GitHub writes

**Analysis review summary.** The high-level part of a current Analysis that may prefill Finish review after a Finding command established the viewer's pending review. The maintainer edits and submits it.

**Conversation.** The chronological PR description, issue comments, review summaries, and general conversation threads that GitHub shows for the pull request. It is GitHub-owned and separate from the viewer's pending review.

**Conversation thread.** A group of GitHub review comments with open, resolved, or outdated state. Inline threads belong to a diff location; general threads appear in the Conversation screen.

**Mapped conversation thread.** An open or resolved inline thread whose anchor Patchdesk can place unambiguously on the represented diff. Only mapped threads appear as diff annotations and in the Threads section.

**Conversation entry.** A PR description, issue comment, review summary, or general thread in the Conversation timeline.

**Partial conversation thread.** A thread shown with only a bounded subset of its GitHub replies and identified as incomplete.

**Revision-bound review verdict.** A reviewer's latest submitted verdict reported against its commit; it is outdated when that commit differs from the represented head.

**Reviewer request.** A pending ask for someone to review a pull request, distinct from a submitted verdict.

**Thread state change.** An explicit Resolve or Unresolve action on a mapped Conversation thread.

**Direct conversation comment.** An inline GitHub comment or reply submitted directly from the diff; Comment now publishes immediately when no viewer pending review is confirmed.

**Threads section.** The pull request Diff navigator section for threads the represented diff can place. Thread actions remain on each thread.

**Notes section.** The local Review Diff navigator section for Local drafts. A row that cannot appear inline explains why.

**Pull request metadata rail.** The Conversation screen's controls for Reviewers, Assignees, and Labels. These values reflect the latest successful GitHub observation and are edited through explicit GitHub writes. See [conversation and metadata](review-workbench/conversation-and-metadata.md).

**GitHub write.** An explicit maintainer action that changes GitHub, such as adding a comment, changing metadata, resolving a thread, submitting a review, or merging. Patchdesk never performs one merely because an Insight completed.

**GitHub pending review.** The authenticated viewer's remote `PENDING` review for the represented pull request. It is the one authoritative editable Review draft; Patchdesk does not keep a second editable local copy.

**GitHub review.** An approval, comment, or request for changes the maintainer explicitly submits to GitHub.

**Pending-review reconciliation.** The same-revision read that adopts GitHub's authoritative pending review after its state differs from Patchdesk's record. It does not merge drafts.

**Merge command.** The maintainer's explicit choice of a GitHub merge method, gated by current state and any required warning acknowledgement.

**Review body.** The shared Markdown message submitted with a GitHub review. The maintainer supplies or edits it in the Finish review dialog.

**Post-write reconciliation.** The single read-only GitHub check after a confirmed write. It updates represented state and never repeats the write.

**Uncertain write outcome.** A result in which Patchdesk cannot prove whether GitHub applied a requested write. Patchdesk locks related writes until explicit reconciliation rather than retrying and risking a duplicate.

## Insights

**Insight.** A revision-bound aid that helps a maintainer understand or evaluate a represented change. Brief, Analysis, and Walkthrough are Insight types on both pull request and local Reviews; none can publish to GitHub on completion.

**Insight provider.** The execution source selected for an Insight run: API key (`pi` internally), Codex CLI account, or pi CLI account. See [Brief](review-workbench/brief.md#begin-an-action) for the run controls.

**Codex CLI account provider.** The Insight provider that uses the maintainer's local Codex CLI account without Patchdesk storing its credentials. It inspects only the represented-review worktree with bounded read-only tools.

**pi CLI account provider.** The Insight provider that runs the maintainer's installed `pi` agent with its own login, read-only built-in tools, and project trust and extensions disabled. Its internal id is `pi-cli-account`.

**Insight run.** One queued, running, completed, failed, cancelled, or superseded attempt to produce an Insight for a represented revision.

**Insight run dialog.** The dialog that Generate, Regenerate, Try again, and Run for latest revision open before any Insight run starts. It has Provider, Model, and Reasoning controls, a confirmation line naming what will receive the prepared pull-request artifacts, and Start run.

**Run Insights dialog.** The dialog that Run Insights… beside the Insight tab strip opens. It has one row per Insight, each with a checkbox and its own Provider, Model, Reasoning, and Language, and Start runs starts every checked row as its own run.

**Brief.** The latest successful view of a represented change's structure. It presents Signals, optional Moves, Flow, Shape, and Blast radius, with Scope and Provenance beside them. It gives no review verdict or Findings. See [Brief](review-workbench/brief.md).

**Signals.** Deterministic Brief rows computed from the patch to orient the reviewer before the structural views.

**Moves.** The Brief's deterministic grouping of files renamed across directories, including reference-only edits that follow the move. It appears when at least two renamed files change directory.

**Brief citation.** An alias from a Brief's evidence manifest. New runs provide diff-hunk aliases (`h*`) for changed Flow steps; older retained Briefs can also contain description and commit citations. Patchdesk checks whether a cited hunk exists in the represented patch, which does not verify the step's claim. See [the citation decision](../adr/0040-make-brief-structure-first.md#citation-status).

**Flow.** Up to five diff-styled Brief views, one per behavior, using call tree, control flow, component, state, or contract form. A changed step may cite a diff hunk; a changed step without a surviving citation stays visible but muted.

**Shape.** The Brief tree of changed files grouped by directory, with short model notes about ownership. A directory past twelve files has a counted remainder.

**Blast radius.** The Brief view of mentions of changed names outside changed files, grouped by name and site. These are text matches to inspect, not proof of a runtime call. It also identifies changed source files with no matching changed test. See [Brief](review-workbench/brief.md#settle).

**Provenance card.** The Brief side-column card naming the Revision, when the Brief was Generated, the Provider and model, and whether all Citations were verified. It ends with a Regenerate button.

**Verdict card.** The first card of an Analysis: a verdict badge, a count of Findings needing attention, the CI state, a heading that follows the verdict, the generated summary, and Finish review when finishing with an Analysis summary is allowed.

**Verification checklist.** The Analysis card titled Verification, with one checkbox per generated verification step. Its ticks are held only by the reader on screen and are never saved.

**Lower severity.** The collapsed Analysis disclosure that holds P2 and P3 Findings when the Analysis also has P0 or P1 Findings.

**Docked layout.** The Walkthrough layout it always opens in, with the Insight tab strip, the shared Insight header, and the chapter rail beside the reading surface.

**Focused layout.** The Walkthrough layout that Focus section switches to, hiding the tab strip, header, and chapter rail for one reading column. Exit focus or Escape returns to the Docked layout.

**Support.** The Walkthrough's retained set of changed hunks that no section cites. The reader counts these hunks as not explained in the reading path and links to the full Diff; it does not list or mark them reviewed in the Walkthrough.

**Analysis run.** One optional model execution that can produce an Analysis for a represented Review session.

**Analysis.** The latest successful review body and evidence-backed Findings produced for a represented revision. The maintainer can dismiss Findings or use current mapped Findings to create GitHub pending-review comments.

**Mapped finding.** A current Finding whose evidence identifies one unambiguous location in the represented diff.

**Finding evidence hunk.** The containing diff hunk for a mapped Finding, with its anchored lines highlighted in Analysis.

**Finding review command.** The maintainer's explicit action that publishes one current mapped Finding into the viewer's GitHub pending review. A failed or uncertain write follows the ordinary GitHub write rules.

**Finding suggestion.** An exact replacement for a mapped Finding's new-side lines, verified against the represented patch before it can be published as a GitHub suggestion.

**Finding review receipt.** The record connecting one Analysis Finding on one represented revision to a GitHub thread. It can be Pending, Published, or Historical.

**Pending-review Finding.** A current mapped Finding already identified by a pending receipt in the viewer's GitHub pending review.

**Finding-backed pending review.** The viewer's GitHub pending review when it contains a current Finding review receipt.

**Dismissed finding.** A Finding the maintainer excluded with a recorded reason.

**Finding.** A concern or observation in an Analysis, supported by evidence from the represented revision. A Mapped Finding identifies one unambiguous location in the current diff.

**Walkthrough.** The latest successful guided explanation of a represented revision. It orders narrative chapters and cited diff hunks without changing GitHub.

**Scope gauge.** The deterministic bar that groups changed files into Scope buckets, with added and removed line counts. It needs no model and is absent when the patch cannot be read. The pull-request list and the workbench header show it; the Brief's side column shows it as the Scope card, whose rows filter the Diff.

## Words to avoid

- Use **Repository listing** instead of inbox, feed, or queue.
- Use **Review** and **Review session** instead of model review or prepared review.
- Use **Local draft** instead of local comment or queued Finding.
- Use **GitHub pending review** instead of local review batch or Review draft.
- Use **Blast radius** instead of call graph or impact analysis; its matches do not prove calls.
- Use **Brief citation** for a manifest hunk alias, not a generic reference, source, or link.
- Use **Agent reply** for an answer to a Local draft and **Agent explanation** for an explanation on diff lines. Avoid agent note or agent comment for either.
- Use **Resolved draft** for feedback the maintainer marked done. Avoid dismissed draft, which confuses it with a Dismissed finding.
- Use **Change intent** for the local change's stated goal. Avoid prompt or PR description for this field.
- Use **Agent run request** for an Insight awaiting the maintainer's approval. Avoid auto-run or queued run.

Historical names in ADRs remain historical.

## Task state

**Task.** One maintainer interaction with a beginning, an optional waiting period, and a settled outcome. A task can be a form edit, a refresh, a preparation run, an Insight run, or a GitHub write.

**Arrived.** The state after the maintainer reaches a screen, dialog, or form and Patchdesk has shown the initial content available for that task.

**Dirty.** A local form draft differs from its last saved baseline. Workspace settings has no dirty state: every control saves itself and reports its own result, so closing Settings or switching workspace asks nothing.

**Saved.** A local edit has completed its required write and reload, and the displayed value reflects the accepted result. In Workspace settings each control says so beside itself for about two seconds.

**Pending.** Patchdesk has accepted an action and has not yet reached a confirmed success or failure. Controls that could duplicate or conflict with the action can be disabled or blocked during this state.

**Settled.** A task has reached a confirmed success, confirmed failure, cancellation, or explicit uncertain-outcome state. A settled task can still require recovery or a product decision.

## Events that end or interrupt a task

**Cancel.** The maintainer explicitly stops a task before it settles, using Cancel, Stop, or Escape when that control is available. Cancellation can discard a local draft, retain a prior result, or request that an Insight child stop; each feature document states which.

**Complete.** A task reaches its intended settled state and commits the corresponding local or remote result. A clean completion can also mean leaving an untouched surface with nothing recorded.

**Interrupt.** Something other than the task's normal completion changes its path: navigation, another action, failure, app closure, a remote change, or an operating-system handoff. An interrupt is not automatically a cancellation; Patchdesk can block it, wait for a final result, retain progress, or recover later.

**Navigation block.** Patchdesk refuses or delays a requested destination because a dirty draft or GitHub write is in progress. A dirty draft offers Save, Discard, or Stay; an active GitHub write requires the maintainer to wait.

## Local state and recovery

**Config.** Workspace-profile and application configuration under `~/.config/patchdesk`. It is distinct from Review data and disposable cache.

**Local data.** Review sessions, retained Insights, write intents and receipts, recovery journals, and diagnostics under `~/.local/share/patchdesk`. The Data & recovery settings describe which subsets can be removed.

**Cache.** Re-creatable Patchdesk state under `~/.cache/patchdesk`, including represented-review worktrees. Clearing cache keeps stored Review history.

**Diagnostic.** A redacted local record of a Review or Insight lifecycle event. Diagnostics omit prompts, tokens, credentials, provider output, and sensitive paths.

**Recovery.** Patchdesk's process of reading durable state after interruption and bringing a Review or operation to a safe explicit status. Recovery never assumes that an uncertain GitHub write failed.

## Interface state

**Selected.** An item is selected when it is the current target of a list, tree, tab set, or picker. Selection does not by itself perform a GitHub write.

**Focused.** A control is focused when it receives the next keyboard input. Closing Settings normally returns focus to the control that opened it.

**Active.** A profile, screen, tab, or operation is active when Patchdesk currently applies or displays it. Active does not mean pending, selected, or saved unless the relevant document says so.

**Readonly.** A surface is readonly when the maintainer can inspect represented or last-known content but Patchdesk will not authorize a write. Revision changed, remote state unavailable, terminal state, missing permission, and uncertain outcomes can each make a specific action readonly.

# Glossary

The vocabulary used across these documents. When a document uses one of these words, it means exactly this.

## The desktop surface

**Patchdesk.** The local macOS desktop app that helps a maintainer find and review GitHub pull requests. It runs beside local checkouts and has no Patchdesk server between the app and GitHub.

**Pull requests screen.** The screen where a maintainer chooses a *Selected repository* and finds the pull request to review. It is read-only: it opens *Reviews* but performs no GitHub write.

**Review workbench.** The persistent screen where a maintainer conducts a *Review*. It shows represented GitHub state, the pull-request diff and conversation, review controls, and optional *Insights*.

**Settings.** A global overlay above the current screen. It has General, Workspace, Review, Data & recovery, and Logs sections and returns focus to the control that opened it when it closes normally.

**Local API.** The authenticated loopback boundary between Patchdesk's sandboxed window and its main process. The maintainer does not call it directly; visible actions in the window use it to read local state, run tools, and request GitHub operations.

## Workspace and identity

**Workspace profile.** The saved local configuration that selects a GitHub host and account, workspace roots, owner filters, rule paths, and watched repositories. Switching profiles returns the app to the Pull requests screen and reloads that profile's state.

**Active profile.** The workspace profile currently applied to the app. A profile draft shown in Settings is not active until its save and any required selection succeed.

**Profile draft.** The editable copy of one workspace profile in Settings. Patchdesk compares it with the last saved baseline to decide whether it is *Dirty*.

**GitHub account.** The authenticated `gh` identity Patchdesk resolves for a workspace profile. Patchdesk obtains a token when needed and does not store it.

**Workspace root.** An absolute local folder Patchdesk scans for Git repositories with GitHub remotes. A root must be saved before repository discovery treats it as part of the active profile.

**Owner filter.** A GitHub owner name that limits which discovered repositories belong to a workspace profile. A profile can have no owner filters.

**Rule path.** An absolute path to an instruction file that Patchdesk includes when it prepares represented Review context. A profile can have no rule paths.

**Reviewing as.** The Settings status that compares the workspace profile's configured GitHub account with the account the GitHub CLI currently resolves. Re-checking probes the local CLI again; it does not perform a GitHub write.

**Watched repository.** A repository saved in a workspace profile for use on the Pull requests screen. A watched repository can remain listed even when its recorded local path is outside every current workspace root.

**Selected repository.** The one watched repository whose GitHub pull requests the Pull requests screen currently represents. Filters, counts, pages, and refreshes apply only to this repository.

## Pull requests and Reviews

**Repository listing.** The Pull requests screen's list of GitHub pull requests in the Selected repository. GitHub decides membership, order, count, and pagination; Patchdesk adds local Review indicators but does not re-sort or re-count the returned rows.

**Pull request filter.** The maintainer's constraints on the Repository listing, expressed in GitHub search terms. The built surface includes state, labels, the Awaiting review from you preset, Review state, and Check status.

**Review state filter.** The More filters choice that limits pull requests by GitHub review state. Its choices are Any, Not reviewed, Review required, Approved, and Changes requested; Any removes this qualifier.

**Check status filter.** The More filters choice that limits pull requests by GitHub check status. Its choices are Any, Pending, Passing, and Failing; Any removes this qualifier.

**More filters popover.** The Pull requests control that contains the Review state and Check status filters. It shows how many of those fields are active and exposes their active values as individually clearable chips.

**Review indicator.** A signal on a Repository listing row that Patchdesk derives from local Review sessions. The current indicators are Updated since review and Ready to merge.

**Recommended action.** The single primary command shown on a Repository listing row. Patchdesk chooses it from the row's Review indicators and Review session state.

**Review.** A maintainer's end-to-end evaluation of one open pull request. It continues across new pull-request revisions and ends when GitHub reports the pull request merged or closed.

**Review session.** The local work for a Review, anchored to one pinned pull-request revision. A later revision creates or moves the Review to a different session rather than changing what the earlier session represented.

**Represented revision.** The exact head, base, and canonical patch identity a Review session presents. User-visible evidence and Insights remain bound to it.

**Represented-review worktree.** Patchdesk's immutable checkout for a Review session's represented revision. It is separate from the maintainer's checkout and is available only to bounded, read-only review inspection.

**Fresh.** A Review state in which the represented revision still matches GitHub's current revision. GitHub writes require Fresh evidence.

**Revision changed.** A Review state in which current GitHub evidence proves that the pull request moved beyond the represented revision. Existing content stays readable, but revision-bound writes and actions stop until the Review refreshes to a new session.

**Remote state unavailable.** A Review state in which Patchdesk cannot prove current GitHub state. It can show last-known read-only content but cannot authorize a GitHub write.

**Terminal remote state.** A Review state in which GitHub reports the pull request merged or closed. Patchdesk keeps the Review readable and stops further Review and merge writes.

## Review content and GitHub writes

**Conversation.** The chronological PR description, issue comments, review summaries, and general conversation threads that GitHub shows for the pull request. It is GitHub-owned and separate from the viewer's pending review.

**Conversation thread.** A group of GitHub review comments with open, resolved, or outdated state. Inline threads belong to a diff location; general threads appear in the Conversation screen.

**Mapped conversation thread.** An open or resolved inline thread whose anchor Patchdesk can place unambiguously on the represented diff. Only mapped threads appear as diff annotations and in the Threads section.

**Pull request metadata rail.** The Conversation screen's controls for Reviewers, Assignees, and Labels. These values reflect the latest successful refresh and are edited through explicit GitHub writes.

**GitHub write.** An explicit maintainer action that changes GitHub, such as adding a comment, changing metadata, resolving a thread, submitting a review, or merging. Patchdesk never performs one merely because an Insight completed.

**GitHub pending review.** The authenticated viewer's remote `PENDING` review for the represented pull request. It is the one authoritative editable Review draft; Patchdesk does not keep a second editable local copy.

**Review body.** The shared Markdown message submitted with a GitHub review. The maintainer supplies or edits it in the Finish review dialog.

**Post-write reconciliation.** The single read-only GitHub check after a confirmed write. It updates represented state and never repeats the write.

**Uncertain write outcome.** A result in which Patchdesk cannot prove whether GitHub applied a requested write. Patchdesk locks related writes until explicit reconciliation rather than retrying and risking a duplicate.

## Insights

**Insight.** A revision-bound aid that helps a maintainer understand or evaluate a pull-request change. Brief, Analysis, and Walkthrough are Insight types; none can publish to GitHub on completion.

**Insight provider.** The configured execution source for an Insight run. Patchdesk offers the API key provider — the `pi` id internally — and the Codex CLI account provider when their required local credentials or executable are available.

**Insight run.** One queued, running, completed, failed, cancelled, or superseded attempt to produce an Insight for a represented revision.

**Brief.** The latest successful answer to the structure of a change — its flow, ownership, and where to start reading. Its blocks are Flow, Shape, Start here, and Reach.

**Analysis.** The latest successful review body and evidence-backed Findings produced for a represented revision. The maintainer can dismiss Findings or use current mapped Findings to create GitHub pending-review comments.

**Finding.** A concern or observation in an Analysis, supported by evidence from the represented revision. A Mapped Finding identifies one unambiguous location in the current diff.

**Walkthrough.** The latest successful guided explanation of a represented revision. It orders narrative chapters and cited diff hunks without changing GitHub.

**Scope gauge.** The deterministic bar that groups changed files into core, tests, generated, docs, and config, with added and removed line counts. It needs no model and is absent when the patch cannot be read.

## Task state

**Task.** One maintainer interaction with a beginning, an optional waiting period, and a settled outcome. A task can be a form edit, a refresh, a preparation run, an Insight run, or a GitHub write.

**Arrived.** The state after the maintainer reaches a screen, dialog, or form and Patchdesk has shown the initial content available for that task.

**Dirty.** A local form draft differs from its last saved baseline. A dirty workspace-profile draft survives switching Settings sections and requires an explicit Save or Discard choice before Settings closes or the active profile changes.

**Saved.** A local edit has completed its required write and reload, and the displayed baseline reflects the accepted value. Text typed after a save request began remains dirty even if the earlier request succeeds.

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

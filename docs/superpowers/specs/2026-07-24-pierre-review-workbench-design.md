# Pierre review workbench design

## Purpose

Replace Patchdesk's separate prepared-review screen and crowded review sidebars with one direct review workbench. The workbench uses Pierre Tree and Pierre CodeView to review a saved pull-request diff, create local inline drafts, read GitHub review threads, and submit an explicitly confirmed review batch.

This is one release. It includes Pierre Tree, infinite diff streaming, inline findings, local comments, GitHub review threads, replies, and separate PR details.

## User outcomes

- Opening a pull request goes directly to its saved diff. There is no prepared-review screen.
- Files load as the user scrolls through the diff. There is no Load more files button.
- The left rail is a Pierre file tree. It does not contain findings, filters, or a Fix queue.
- Findings appear at their source line or range. A mapped finding is an included local draft that the reviewer can edit or remove.
- Reviewers can write a comment on one changed line or a selected range.
- Existing GitHub review threads appear inline and support replies.
- PR description, general discussion, checks, commits, and merge readiness are separate from the review workbench.
- Saved local review work appears as an inbox queue, not separate Drafts or History screens.
- Each pull request shows only its latest review result for the current head.
- No GitHub write occurs without an explicit confirmation.

## Navigation and layout

### Direct review workbench

Opening a pull request shows a read-only diff workbench immediately. Before analysis has run, the header offers Run review. Failed or pending checks remain visible but never block a read-only review or a walkthrough generated from its prepared snapshot. Checks still block merge readiness. The header includes only the pull-request identity and compact check status. It does not repeat author, branch, commits, full SHA, or local-review state.

At desktop widths, the workbench has:

- the existing application rail;
- a 208px Pierre file tree rail;
- the Pierre diff as the primary surface;
- a contextual inspector.

The old prepared-review screen, review-details sidebar, findings list, filters, and Fix queue are removed. The compact sheet remains available at narrower widths.

### Saved reviews queue

Saved reviews is an action queue in the inbox. It shows pull requests with resumable local work: local drafts, a pending review, or a review that failed and needs attention. Selecting it filters the normal inbox list. Opening a row goes directly to the workbench.

Queues overlap. My PRs means the current user authored the pull request. Saved reviews means Patchdesk has local review work. A pull request can match both queues. The inbox has one active queue at a time; a later saved view may combine queue rules.

Completed and submitted reviews are not in Saved reviews. Patchdesk does not provide separate Review drafts or Review history screens. It keeps only the latest result for the pull request's current head.

### File tree and diff navigation

The file tree and CodeView use one canonical mapping from a displayed path to a stable CodeView item ID. They keep independent native scroll containers.

Selecting a tree row, Review result finding, inline thread, or inline draft updates one selected-file state. The workbench ensures the matching diff item is hydrated or streamed, then scrolls CodeView to the file, line, or range.

CodeView scroll events only drive progressive file streaming. The tree does not continuously select or follow the file currently visible in the diff. This avoids feedback loops and preserves normal wheel, trackpad, keyboard, and virtualized scrolling behavior.

### Infinite diff streaming

CodeView initially renders a bounded set of diff files. Near the bottom of the rendered diff, Patchdesk appends the next batch. The viewport must not jump while this occurs. Selecting a file that has not yet streamed materializes it before scrolling to it.

There is no manual load-more control.

## Inline review model

### Findings

Mapped findings appear at their exact source line or range. They are automatically created as included local drafts. A reviewer can edit the draft inline or choose Remove from review. Removing a draft returns it to an inline finding. Add to draft restores it.

Repository-level findings that have no trustworthy source anchor stay in Review result. They are labeled repository-level, not unmapped. Selecting one opens its explanation in the inspector and does not pretend it belongs to a source line.

Review result lists each finding as a navigation link. It is the only finding summary list.

### Comments and threads

A comment action appears when a reviewer hovers a changed line. The same action is available after selecting a changed range. The editor opens directly below the line or range.

GitHub review threads are fetched only when the reviewer refreshes. Open threads appear at their anchors with messages in chronological order. Resolved threads are hidden by default.

GitHub replies attach to a top-level review comment. Patchdesk presents the conversation as one thread and queues a new local reply before any remote write.

The inspector displays the selected finding or thread's full evidence, suggested change, author, draft state, and pending action. With no selection, it displays the review summary and the local draft batch.

## Separate PR details

PR details is a separate view opened from the workbench header. It contains:

- pull-request description;
- author, branch, commits, and full head information;
- checks and merge readiness;
- read-only general PR discussion;
- a link to open the pull request on GitHub;
- the existing merge-confirmation entry point.

Inspect failing checks opens this view on Checks. It remains available alongside Run review; it is not a primary workbench action. General PR discussion is read-only in this release. Writing is limited to inline review threads where the code context is clear.

## Drafts, refresh, and GitHub writes

Local drafts, reply drafts, and queued resolve or reopen actions are stored separately from GitHub data. Refresh updates PR details and inline review threads without replacing local work.

Running review again replaces the current analysis result. When local drafts exist, Patchdesk requires the reviewer to confirm their discard before it starts the new analysis. It does not keep a user-visible history of replaced results.

Before GitHub writes, Patchdesk confirms the current pull-request head. If it changed, Patchdesk retains local work, explains that the diff is stale, and requires refresh and review before a write.

One confirmation shows the exact saved batch:

- new inline comments;
- replies to existing GitHub review threads;
- resolve actions;
- reopen actions.

After confirmation, Patchdesk creates one pending GitHub review when the batch has new inline comments, then performs the approved replies and thread-state actions. A batch with only replies or thread-state actions skips pending-review creation. Submitting a created pending review is a separate confirmation.

GitHub does not make this mixed batch atomic. If an action fails after another succeeds, Patchdesk records completed writes, retains unfinished local work, and does not retry automatically. It reports the exact outcome to the reviewer.

Patchdesk retains only the minimal remote-write receipts needed to prevent duplicate writes and explain a partial failure. These receipts are not shown as review history.

## Boundaries

This release does not include:

- automatic refresh;
- unconfirmed GitHub writes;
- writing general PR comments;
- continuous tree-following while the diff scrolls;
- a second findings rail, filters, Fix queue, prepared-review screen, review-details sidebar, Review drafts screen, Review history screen, or archive of replaced review results.

## Verification

Renderer tests cover:

- Pierre Tree path-to-item mapping and tree-to-diff navigation;
- automatic inline drafts from mapped findings;
- repository-level finding behavior;
- one-line and range comment drafting;
- thread display, replies, and resolved-thread visibility;
- local-draft preservation across refresh;
- mixed-batch confirmation, stale-head protection, partial-write reporting;
- rerun confirmation before local drafts are discarded and replacement of the prior result;
- Saved reviews queue membership, overlapping queue labels, and direct workbench opening;
- removal of old screens and controls.

Browser tests cover:

- 1280px and 1440px desktop layout;
- the 960px compact sheet;
- keyboard navigation and selected-line navigation;
- automatic diff streaming without viewport jumps;
- Review result navigation to inline drafts;
- no page-level horizontal overflow;
- dark and forced-color modes.

Package validation runs the renderer and browser suites, then validates the packaged Electron app through CDP. Packaged QA must confirm the saved customer-management pull request, restored rails, command palette, console and page errors, normal native scrolling, and no GitHub confirmation action entered.

The existing 1,000-file selection ceiling remains below 200ms.

## Approved decisions

- Deliver all Pierre Tree, inline comment, thread, and scroll work in one release.
- Keep comments and replies as local drafts until explicit confirmation.
- Support single-line and range comments.
- Use manual refresh for upstream review threads.
- Hide resolved threads by default.
- Include resolve and reopen actions in the confirmed batch.
- Keep general PR discussion read-only.
- Automatically include mapped findings as local drafts, with remove and restore actions.
- Remove the prepared-review screen and review-details sidebar.
- Replace Review drafts and Review history with the overlapping Saved reviews inbox queue.
- Keep only the latest review result for the current pull-request head and confirm before a rerun discards local drafts.
- Skip pending-review creation when a confirmed batch contains only replies or thread-state actions.

---
created_at: 2026-08-08
repos:
  - patchdesk
status: ready-for-agent
---

# Inline diff conversations

Status: ready-for-agent

## Problem Statement

A maintainer can read the pull request-wide Conversation in Patchdesk, but cannot read or act on GitHub conversations at the relevant lines of the Diff. Existing inline-thread data is loaded for the Review, while the Diff currently shows Findings and a local-comment preview instead of GitHub-owned thread cards.

This separates code from the discussion that explains it. Maintainers must leave Patchdesk to see current inline feedback, resolve an addressed thread, add a single comment, reply, or correct their own published comment. The existing local Review draft makes this more confusing: inline discussion should follow GitHub’s immediate comment workflow, not be mistaken for an unpublished batch.

## Solution

Make mapped Conversation threads first-class content in the Diff. A maintainer sees each eligible GitHub thread at its current old- or new-side code location, reads its Markdown discussion, expands replies, and acts on it without leaving Patchdesk.

Eligible threads are open or resolved threads whose complete anchor maps unambiguously to the represented Diff. The maintainer can directly Resolve or Unresolve any eligible thread permitted by GitHub, add a single inline comment, reply, and edit or delete their own published comments. Direct actions publish to GitHub immediately; they never become part of the local Review draft.

## User Stories

1. As a maintainer, I want to see mapped Conversation threads beside the relevant code, so that discussion context stays with the change it concerns.
2. As a maintainer, I want open and resolved mapped threads visible, so that I can inspect addressed feedback and Unresolve it when needed.
3. As a maintainer, I want outdated threads excluded for now, so that the Diff does not imply that stale discussion is still current.
4. As a maintainer, I want threads mapped to either added or deleted code, so that feedback about removals is not lost.
5. As a maintainer, I want a thread shown only when its complete line range maps to the current Diff, so that discussion is never attached to ambiguous code.
6. As a maintainer, I want Patchdesk to reveal the minimal collapsed context that contains a mapped thread, so that eligible discussion is not silently hidden.
7. As a maintainer, I want each Conversation thread to remain a separate card, so that independent GitHub state and ownership are not merged into one discussion.
8. As a maintainer, I want cards that share a location ordered by their opening-comment time, so that the local discussion order is predictable.
9. As a maintainer, I want a multi-line thread card to appear after its final anchored line with an indication of the full range, so that code remains readable while the anchor stays clear.
10. As a maintainer, I want the opening comment and latest reply visible initially, so that I can understand the thread without expanding every reply.
11. As a maintainer, I want to expand the remaining replies in a thread, so that complete available context is accessible on demand.
12. As a maintainer, I want a partial Conversation thread marked as incomplete, so that bounded GitHub results are not mistaken for the full history.
13. As a maintainer, I want inline comments to render the same safe rich Markdown as the Conversation screen, so that code blocks, tables, images, and Mermaid diagrams stay readable.
14. As a maintainer, I want to Resolve or Unresolve any eligible mapped thread with a direct command, so that Patchdesk follows the normal GitHub review habit.
15. As a maintainer, I want only the thread being changed to show a pending state, so that one GitHub write does not block the rest of my review.
16. As a maintainer, I want Patchdesk to refresh GitHub state after a successful thread-state change while keeping my current Diff position, so that GitHub remains authoritative without interrupting review.
17. As a maintainer, I want a failed thread-state change to restore the previous state and offer Retry in a toast, so that an uncertain write never appears successful.
18. As a maintainer, I want to select one contiguous range on an added or deleted side and add a single comment, so that a new GitHub thread has an unambiguous code anchor.
19. As a maintainer, I want clicking Comment to publish the new inline comment immediately to GitHub, so that it does not enter a Patchdesk-local or GitHub-pending review queue.
20. As a maintainer, I want Reply at the bottom of a thread to publish immediately to GitHub, so that replies follow GitHub’s thread model rather than an invented reply hierarchy.
21. As a maintainer, I want an unsubmitted composer to warn before its text is discarded, but not persist it, so that temporary text is protected without becoming a local Review draft.
22. As a maintainer, I want Patchdesk to block a comment or reply if the represented pull-request revision is stale and offer Refresh, so that I do not publish feedback against shifted code.
23. As a maintainer, I want a successfully submitted comment to replace its composer with an updating published card, so that the direct GitHub action feels immediate while final thread data is reconciled.
24. As a maintainer, I want to edit my own published inline comment and save directly to GitHub, so that I can correct feedback without leaving the Diff.
25. As a maintainer, I want to delete my own published inline comment after explicit confirmation, so that destructive GitHub feedback changes are intentional.
26. As a keyboard user, I want thread cards, expansion controls, composers, state actions, edit controls, and deletion confirmation to have clear names and predictable focus behavior, so that inline conversations are fully usable without a pointer.
27. As a screen-reader user, I want thread state, incomplete-history status, pending writes, and failures communicated in text, so that thread meaning never depends on color or position alone.

## Implementation Decisions

- This is phase two of the Conversation work. The Conversation screen remains read-only and continues to own general Conversation threads; mapped Conversation threads are rendered only in the Diff.
- The existing GitHub thread snapshot is the source for mapped inline Conversation threads. The renderer derives eligible cards from that data and does not create a competing conversation owner or duplicate GitHub state.
- A **mapped Conversation thread** must be open or resolved, must have a complete anchor on either the old or new side, and must map every line in its range unambiguously to the represented Diff. Outdated, unanchored, and partially mapped threads are excluded.
- The Diff annotation seam becomes the single renderer seam for Findings, temporary composers, and mapped Conversation-thread cards. Thread cards are placed after the final line in their anchored range. The Diff reveals the smallest necessary hidden context before rendering an eligible card.
- Separate mapped threads remain separate cards, including threads that share the same location. Their order is determined by opening-comment time.
- A card initially renders its opening comment and latest reply; remaining replies expand on demand. A partial Conversation thread remains visible with explicit incomplete-history text. No card includes a per-thread external link because the workbench already provides the pull request’s Open on GitHub action.
- Thread comments use the established safe Markdown pipeline and its existing image and Mermaid lightbox behavior. Markdown capability must remain consistent with the Conversation screen.
- The Review draft remains for its existing batch-published content. A **Direct conversation comment**—a new single comment or a reply from the Diff—does not enter that draft and is not persisted locally before submission.
- New comments use one contiguous selected range on either side of the Diff. The explicit Comment control creates a single published GitHub comment immediately. Starting a GitHub pending review is out of scope.
- Reply appears once at the bottom of a thread. Its explicit submit control publishes immediately to GitHub.
- Direct Comment, Reply, and Save controls are explicit confirmation of their non-destructive GitHub writes. Delete requires a separate confirmation dialog before the published comment is removed.
- Resolve and Unresolve are direct, explicit thread-state commands. Patchdesk updates the targeted card optimistically, marks only that card pending, and then refreshes represented GitHub state in the background without moving the maintainer’s Diff position. A rejected action restores the last confirmed state and shows a Retry toast.
- Direct Comment, Reply, and thread-state writes require an open Review with fresh represented GitHub state. If the pull request revision is stale, the operation does not write; Patchdesk offers Refresh and requires the maintainer to re-anchor the comment or reply after refresh.
- After a direct comment or reply succeeds, its composer closes and the Diff shows an updating published representation until the background refresh confirms the authoritative thread data.
- Edit and Delete appear only for comments owned by the authenticated GitHub account, with GitHub as the final permission authority. Edit saves directly. Delete is confirmed, then refreshes the affected thread data.
- Existing GitHub adapter capabilities for reply, thread-state changes, comment updates, and comment deletion are reused. The direct single-comment capability and direct-workbench write boundary are added at the same application service and local API seam rather than routing through Review-batch publication.
- The existing Review write boundary remains responsible for review lifecycle, freshness, serialization, capability, and error handling. Direct conversation operations must not weaken merge or batch-publication protections.
- Existing glossary terms govern this work: Conversation thread, Mapped conversation thread, Thread state change, Direct conversation comment, and Partial conversation thread. ADR-0006 remains true: GitHub-accepted content is never represented as an editable local Review draft.

## Testing Decisions

- Tests prove observable behavior at the highest existing seam: the deterministic Review workbench flow and its validated renderer projection. They assert visible thread cards, accessible controls, direct action outcomes, and refresh behavior rather than component internals or CSS implementation details.
- Projection and mapping tests cover open and resolved threads on both old and new sides; exclusion of outdated, unanchored, and partial-range mappings; range-end placement; shared-location ordering; and automatic reveal of necessary collapsed context.
- Renderer-flow tests cover opening/latest-reply summaries, reply expansion, separate cards, incomplete-thread disclosure, rich Markdown rendering, keyboard navigation, and screen-reader names and status text.
- Direct-write service and protected local-API tests cover Comment, Reply, Resolve, Unresolve, Edit, and Delete. They prove fresh-review enforcement, authenticated-owner edit/delete eligibility, explicit delete confirmation, per-thread pending state, optimistic success, background refresh, stale-write rejection with Refresh, failure rollback, and Retry toast behavior.
- Adapter tests cover GitHub request construction and response parsing for the new single-comment operation while retaining existing coverage for replies, state changes, edits, and deletes.
- Existing Diff annotation tests are prior art for range placement and virtualized versus accessible Diff rendering. Existing Conversation Markdown and lightbox tests are prior art for comment rendering. Existing published-feedback and Review-submission tests are prior art for direct GitHub write failure handling and ownership-aware mutation behavior.
- Browser and live Electron verification use a non-writing fixture path first to prove mapped-card placement, context reveal, keyboard flow, responsive layout, and Markdown rendering. A controlled real-data session may verify the read-only thread view; no GitHub write is made during QA unless explicitly authorized for that test.

## Out of Scope

- Outdated, unanchored, partially mapped, or cross-side thread anchors.
- General Conversation-thread writes from the Conversation screen.
- GitHub pending reviews, multi-comment review submission, and changes to the existing Review-batch publication workflow.
- Persisting unsent direct-comment or reply text as a local draft.
- Hiding or filtering resolved threads in the first release.
- Per-thread Open on GitHub links, duplicate GitHub navigation, polling, webhooks, or real-time synchronization.
- Editing or deleting comments not owned by the authenticated GitHub account.
- Editing or deleting GitHub review summaries, merge behavior, review decisions, or other Published feedback management beyond the stated inline-comment actions.
- Redesigning the Conversation screen, PR Overview, Diff navigator, Insights, or Markdown pipeline beyond the integrations required for inline thread cards.

## Further Notes

- The existing local-comment UI is a visual starting point only. Its ownership labels, preview-only actions, and Review-draft behavior must not be reused for GitHub-owned Conversation threads.
- The current workbench-level Open on GitHub control remains the deliberate escape hatch to GitHub for history, permissions, and unsupported actions.
- The specification intentionally matches GitHub’s immediate single-comment habit while preserving Patchdesk’s Review lifecycle and GitHub-write safety boundaries.
- The spec changes no GitHub state. Implementation and any live GitHub-write QA require separate explicit authorization.

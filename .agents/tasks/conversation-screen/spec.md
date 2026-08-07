---
created_at: 2026-07-19
repos: patchdesk
status: ready-for-agent
---

# Conversation screen

## Problem Statement

A maintainer opening a review in Patchdesk has no way to read the pull request's discussion context — the PR description, issue comments, review summaries, and general review-comment threads. The existing published feedback panel is a flat, non-chronological list of reviews and comments that does not represent GitHub's actual conversation view. Review threads were previously shown in the PR overview sidebar but were hidden because the UX was too cramped to be usable. Maintainers must leave Patchdesk and open GitHub in a browser to understand the discussion context of a pull request.

## Solution

A new **Conversation screen** — a first-class, read-only, chronological timeline that serves as the landing view when opening a review. It replaces the scattered published feedback panel and the hidden sidebar review threads with a single unified surface. The Conversation screen sits alongside the Diff and Insights views as a top-level tab, visible only when a review is open.

The Conversation shows: the PR description, issue comments, review summaries (approvals, change requests, comments), and general conversation threads (review-comment threads with no diff anchor, including their nested replies). Inline conversation threads (tied to specific code locations) remain in the diff view.

## User Stories

1. As a maintainer, I want to see the PR description when I open a review, so that I understand what the author intended before diving into code changes.
2. As a maintainer, I want the Conversation screen to be the first thing I see when opening a review, so that I can catch up on the discussion before examining the diff.
3. As a maintainer, I want to see issue comments in chronological order, so that I can follow the discussion thread as it unfolded on GitHub.
4. As a maintainer, I want to see review summaries (approvals, change requests, general comments) in the timeline, so that I know what verdicts other reviewers have already given.
5. As a maintainer, I want to see general review-comment threads with their full nested replies, so that I can follow architectural or approach discussions that aren't anchored to specific code lines.
6. As a maintainer, I want to navigate between Conversation, Diff, and Insights via top-level tabs, so that I can move fluidly between understanding the discussion and examining the code.
7. As a maintainer, I want the Conversation to reload when I refresh GitHub state, so that I'm always seeing the latest discussion without stale data.
8. As a maintainer, I want the Conversation to load automatically when I open a review, so that I don't have to explicitly request it and wait.
9. As a maintainer, I want the Conversation screen to be clean and readable, so that I'm not overwhelmed by a cramped sidebar-style layout like the old hidden threads view.
10. As a maintainer, I want the published feedback panel to be gone, so that I have one canonical place to see GitHub-owned discussion content instead of two partial views.
11. As a maintainer, I want to click on an image or Mermaid diagram in the PR description to open it in a zoomable lightbox, so that I can inspect large diagrams and screenshots that are too big for the inline view.
12. As a maintainer, I want zoom controls (zoom in, zoom out, fit to screen) in the image lightbox, so that I can read fine details in diagrams without losing context.

## Implementation Decisions

- **New top-level navigation.** Conversation, Diff, and Insights become peer tabs at the top level of the workbench, alongside the logo. The tabs are only visible when a review is open.

- **Conversation is the landing view.** When a maintainer opens a review (from the inbox or elsewhere), the workbench opens with the Conversation tab selected. The diff and insights are one click away.

- **Read-only.** The Conversation screen displays GitHub-owned content without any write actions. No replies, no edits, no deletes, no dismissals. All writes go through the Review draft batch or GitHub directly. This keeps the first iteration focused and avoids the complexity of inline reply composition on a read-oriented surface.

- **Unified data type.** The existing `GitHubPublishedFeedback` and `GitHubComments` types are retired and replaced by a single `Conversation` type with a discriminated union of entry types. The GitHub adapter gains a `loadConversation()` method that fetches all conversation data in one logical operation.

- **Conversation entry types.** The discriminated union includes:
  - **PR description** — the pull request body, rendered at the top of the timeline.
  - **Issue comment** — a top-level comment on the pull request, not tied to code.
  - **Review summary** — a review verdict event (approved, changes requested, commented) with the review body.
  - **General conversation thread** — a review-comment thread with no diff anchor, with its nested replies and open/resolved/outdated state.

- **Eager loading.** The Conversation payload loads when a review opens, not lazily on first tab click. This supports the landing-view behavior — the maintainer shouldn't see a spinner when landing on the default tab.

- **Refresh behavior.** When the maintainer triggers a GitHub state refresh, the Conversation reloads alongside the diff and checks. Stale conversation on a refreshed review would feel broken.

- **Published feedback panel removal.** The existing published feedback panel (the collapsible strip at the bottom of the workbench) is removed entirely — its component, the adapter methods that feed it, and the `publishedFeedback` field from the workbench projection. The Conversation screen is the canonical replacement.

- **Existing sidebar review threads.** The `ReviewThreads` component in the PR overview sidebar is already hidden. Its code remains in place for now and will be addressed separately during the inline thread interaction work (phase 2).

- **Inline threads stay in the diff view.** Inline conversation threads (tied to specific diff locations) are not part of the Conversation screen. They remain in the diff view. Improving their UX is phase 2, tracked separately.

- **Workbench contract change.** The `WorkbenchResponse` schema replaces the `publishedFeedback` and `comments` fields with a single `conversation` field whose type shape reflects the discriminated entry union. This is the single seam: adapter fetches into the new shape, renderer consumes the new shape, everything in between follows.

- **Image and diagram zoom.** Images and Mermaid diagrams rendered in the PR description (and other Markdown bodies) are clickable. Clicking opens a lightbox dialog with zoom controls: zoom in, zoom out, fit-to-screen toggle, and click-to-close. The lightbox starts at "fit to screen" so large diagrams are never initially cut off. Mermaid SVGs are rendered at native size inside the lightbox with CSS `transform: scale()` driven by zoom state.

- **Reuse existing Markdown pipeline.** The `PullRequestDescriptionPreview` component already handles GFM Markdown and Mermaid rendering (via `marked` and `mermaid`). The Conversation screen reuses this pipeline for the PR description entry. Issue comments and review summary bodies also use the same Markdown renderer. The zoom lightbox is a new component that wraps the existing image and Mermaid rendering paths — it is not specific to the Conversation screen and benefits the PR overview sheet as well.

- **Glossary updates.** Three new terms added to `CONTEXT.md`: `Conversation`, `Conversation thread`, and `Conversation entry`. `Published feedback` is now an avoided term.

- **ADR-0006 (separate draft and published feedback) remains respected.** The Conversation screen displays GitHub-owned content; it does not blur the boundary with the local Review draft.

## Testing Decisions

- **What makes a good test.** Tests verify the external contract, not implementation details. For the renderer contract: valid `Conversation` payloads parse successfully, malformed ones are rejected. For UI: the Conversation tab renders the timeline entries correctly given a known projection, navigation between tabs works, and the screen handles empty and error states.

- **Primary seam: `WorkbenchResponse` contract.** The Valibot schema change in `renderer-contracts.ts` is the highest seam. Tests follow the existing pattern in `tests/renderer/renderer-contracts.test.ts`: fixture-driven parse success and failure for the new `conversation` field.

- **UI integration: workbench flow.** Tests follow the existing pattern in `tests/renderer/review-workbench-flow.ui.test.tsx`: render the full workbench with a fixture projection, assert that the Conversation tab is visible and selected by default, verify that conversation entries render correctly, and confirm that tab switching (Conversation ↔ Diff ↔ Insights) works.

- **Adapter tests.** The GitHub adapter's `loadConversation()` method should have a test verifying correct payload shape, following the existing adapter test patterns.

- **No new test infrastructure.** Existing tools (Vitest, Testing Library, Valibot schemas) and existing fixture patterns are sufficient.

## Out of Scope

- **Inline comment thread interactions in the diff view.** The "Conversation actions are a UI preview only" placeholder in the diff view is not addressed here. Improving inline thread display and interaction (replying, resolving threads from the diff) is a separate phase.
- **Write actions from the Conversation screen.** No replying to issue comments, no editing or deleting published comments, no dismissing reviews. All writes go through the Review draft or GitHub.
- **`open_discussion` inbox action behavior.** The `open_discussion` recommended action in the maintainer inbox is preserved as-is. Whether it needs different treatment (e.g., scrolling to a specific thread) is deferred.
- **Real-time updates.** The Conversation refreshes on explicit GitHub refresh only. No polling, no webhooks, no live sync.
- **Threaded reply composition.** The `ThreadReply` and `ThreadState` review batch items are unchanged. The existing reply flow through the draft batch works for general threads the same way it already works for inline threads.
- **PR overview sidebar redesign.** The PR overview sheet keeps its metadata, checks, and merge readiness. Only the review threads section is already hidden; no further sidebar changes are in scope.

## Further Notes

- The Conversation screen is the first of two related changes. Phase 2 will address inline conversation thread interactions in the diff view, where the "Conversation actions are a UI preview only" placeholder currently sits.
- The `publishedFeedback` removal touches the adapter, the workbench projection, the renderer contract, and the published feedback panel component. All four should be addressed in the same change to avoid a broken intermediate state.
- The existing `GitHubComments` type (separate from `GitHubPublishedFeedback`) is also retired and folded into the unified `Conversation` type.

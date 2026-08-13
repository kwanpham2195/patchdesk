---
created_at: 2026-08-07
repos: patchdesk
status: ready-for-agent
linear: CFW-XX
---

# Conversation Screen — Tech Spec

## Summary

Add a first-class, read-only Conversation tab to the review workbench. Unify the two existing GitHub-owned-content data types (`GitHubComments` + `GitHubPublishedFeedback`) into a single discriminated-union `Conversation` payload. Remove the published feedback panel. Add a zoomable lightbox for images and Mermaid diagrams in rendered Markdown. The Conversation tab becomes the landing view when opening a review.

## Context / Current State

**Two overlapping GitHub-content data paths:**

- `GitHubReader.getPullRequestComments()` → `GitHubComments` (threads of review comments, displayed in the hidden `ReviewThreads` sidebar component)
- `GitHubReader.getPullRequestPublishedFeedback()` → `GitHubPublishedFeedback` (flat arrays of reviews + comments, displayed in `PublishedFeedbackPanel` at the bottom of the workbench)

**Current navigation:** `primarySurface` is a `"files" | "insights"` toggle. The Insights button lives inside `DiffWorkbench` as a `surfaceAction` prop.

**Published feedback:** rendered via the `publishedFeedback` slot on `ReviewWorkbench`, passed through from `ReviewWorkbenchFlow` → `PublishedFeedbackSlot` → `PublishedFeedbackPanel`.

**Markdown rendering:** `PullRequestDescriptionPreview` in `pull-request-description.tsx` handles GFM Markdown (`marked`) and Mermaid diagrams (lazy `mermaid` import). Images render as plain `<img>` with no click-to-zoom. Mermaid SVGs render inline.

**PR description:** displayed in the `PR overview` sidebar sheet via `PullRequestDescription`. Not visible from the main workbench surface.

## Goals

1. Single `Conversation` tab (alongside Diff and Insights) in the workbench header area
2. Conversation tab is the default when opening a review
3. Unified `Conversation` data type replaces `GitHubComments` + `GitHubPublishedFeedback`
4. Remove the published feedback panel entirely
5. Click-to-zoom lightbox for images and Mermaid diagrams in rendered Markdown
6. Zoom controls: zoom in, zoom out, fit-to-screen, click-to-close

## Non-Goals

- No write actions on the Conversation screen (read-only)
- No inline thread interaction improvements in the diff view (phase 2)
- No changes to the PR overview sidebar (it retains checks, merge readiness, metadata)
- No real-time sync or polling
- No `open_discussion` inbox action changes

## Invariants

- The Conversation payload is GitHub-owned content, separate from the local Review draft (ADR-0006 preserved)
- No conversation data is editable from the Conversation screen
- The `WorkbenchResponse` contract remains Valibot-validated; malformed payloads are rejected before reaching the renderer
- Tab state resets when the reviewed revision changes
- The lightbox never exposes raw HTML injection; Mermaid SVGs are sandboxed via `dangerouslySetInnerHTML` only on pre-rendered output

## Design Constraints

- The app shell titlebar (`app-shell.tsx`) owns the top-level navigation (brand, back button, profile, settings). Workbench tabs must integrate into the workbench header, not replace the app shell.
- The existing `marked` + `mermaid` Markdown rendering pipeline is reused — the Conversation screen calls `PullRequestDescriptionPreview` and equivalent rendering for comment/review bodies.
- The `GitHubReader` interface already has method stubs; the new `loadConversation()` can be a new method or a composition of existing calls. The adapter implementation shape (GraphQL + REST) is unchanged.
- The zoom lightbox is a shared component, not Conversation-specific. It wraps the existing image and Mermaid rendering paths.

## Alternatives Considered

### Option 1: Tabs in app shell titlebar

Conversation · Diff · Insights live in the app shell header, between the brand separator and the profile/settings area. Only rendered when destination is workbench.

- **Pros:** Matches the user's stated design intent ("same level with logo"). High visibility, always accessible.
- **Cons:** Requires the app shell to know about workbench-specific state (active tab). Couples app shell to workbench routing. App shell currently doesn't manage workbench tab state.
- **Verdict:** Rejected. The app shell is a navigation chrome, not a workbench controller. Tab state ownership belongs to the workbench flow.

### Option 2: Tabs in workbench header

Conversation · Diff · Insights live in the workbench's own header bar (`data-review-workbench-toolbar`), above the PR title row. `primarySurface` becomes a 3-way union `"conversation" | "files" | "insights"`.

- **Pros:** All workbench state stays in the workbench flow. No app shell coupling. The toolbar already has PR title, pills, and action buttons — adding tabs here is a natural grouping.
- **Cons:** Tabs are slightly lower in the visual hierarchy than the app shell. Less prominent than Option 1.
- **Verdict:** Chosen (recommendation). Matches the wireframe. Keeps workbench state local to the workbench flow.

### Option 3: Conversation as a slot

Continue using the existing slot pattern — Conversation becomes another slot like Insights and PublishedFeedback. The workbench doesn't own the tab model; the flow does.

- **Pros:** Minimal change to `ReviewWorkbench`. Follows existing pattern.
- **Cons:** The slot pattern is for injecting content into a fixed shell. It doesn't provide tab navigation. We'd need to build custom tab wiring on top of it, defeating the purpose.
- **Verdict:** Rejected. The slot pattern doesn't map cleanly to peer-tab navigation.

## Recommendation

**Option 2** — tabs in the workbench header, `primarySurface` extended to a 3-way union. The workbench owns the tab state. The Conversation content renders directly in the workbench body (not via a slot). Published feedback panel is removed. The Insights slot is promoted to a first-class rendering path alongside Conversation and Diff.

## Domain Model and Types

### New domain types (in `github-context.ts`)

```ts
/** One entry in the Conversation timeline, in chronological order. */
export type ConversationEntry =
  | { readonly _tag: "PrDescription"; readonly body: string }
  | { readonly _tag: "IssueComment"; readonly comment: GitHubComment }
  | { readonly _tag: "ReviewSummary"; readonly review: PublishedReview }
  | {
      readonly _tag: "GeneralThread";
      readonly thread: GitHubConversationThread;
    };

/** Unified Conversation payload replacing GitHubComments and GitHubPublishedFeedback. */
export type Conversation = {
  readonly prDescription: string;
  readonly entries: ReadonlyArray<ConversationEntry>;
  readonly complete?: boolean;
  readonly incompleteReason?:
    "thread_cap" | "comment_cap" | "pagination" | "unavailable";
};
```

**Key decisions:**

- `prDescription` is a separate field, not an entry — it always renders at the top with distinct visual treatment.
- Entries are pre-sorted chronologically by the adapter. The renderer does not sort.
- `GitHubComment` and `PublishedReview` are reused as-is — no new comment or review types.
- `GitHubConversationThread` is reused for general threads (those with `location === undefined`). Inline threads (with `location`) are excluded from the timeline by the adapter before assembly.
- `complete` and `incompleteReason` cover pagination caps from all underlying API calls.
- **All Markdown bodies use the same pipeline.** Issue comment bodies, review summary bodies, and thread comment bodies are rendered through `lexSafely()` → `renderBlocks()`, the same pipeline used by `PullRequestDescriptionPreview`. This means images, Mermaid diagrams, tables, code blocks, and all other GFM features are consistently supported across every entry type — not just the PR description.

### Type changes (deletions)

```ts
// REMOVED from github-context.ts:
// - GitHubPublishedFeedback
// - GitHubComments
// - PublishedReviewComment
```

`PublishedReviewComment` is folded into `GitHubComment` — the `canEdit`/`canDelete` flags were only used by the published feedback panel's edit/delete actions, which are now removed.

### Lightbox types (new, in a new file)

```ts
export type ZoomState = {
  readonly scale: number; // 0.25 .. 4.0
  readonly fitToScreen: boolean;
};

export type ZoomAction =
  | { readonly _tag: "ZoomIn" }
  | { readonly _tag: "ZoomOut" }
  | { readonly _tag: "ToggleFit" }
  | { readonly _tag: "Reset" };
```

## Types, Interfaces, and APIs

### GitHubReader interface change

```ts
// NEW method on GitHubReader:
loadConversation(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly pr: PullRequestRef;
}): Promise<Result<Conversation, GitHubReadFailure>>;
```

Composes existing GraphQL thread query + REST reviews/comments endpoints. Returns entries pre-sorted chronologically. Inline threads (those with `location !== undefined`) are excluded.

### WorkbenchResponse contract change (renderer-contracts.ts)

```ts
// BEFORE:
const workbenchProjectionSchema = v.strictObject({
  // ...
  publishedFeedback: publishedFeedbackSchema,
  comments: githubCommentsSchema,
  // ...
});

// AFTER:
const conversationEntrySchema = v.variant("_tag", [
  v.strictObject({ _tag: v.literal("PrDescription"), body: v.string() }),
  v.strictObject({
    _tag: v.literal("IssueComment"),
    comment: githubCommentSchema,
  }),
  v.strictObject({
    _tag: v.literal("ReviewSummary"),
    review: publishedReviewSchema,
  }),
  v.strictObject({
    _tag: v.literal("GeneralThread"),
    thread: githubThreadSchema,
  }),
]);
const conversationSchema = v.strictObject({
  prDescription: v.string(),
  entries: v.array(conversationEntrySchema),
  complete: v.optional(v.boolean()),
  incompleteReason: v.optional(
    v.picklist(["thread_cap", "comment_cap", "pagination", "unavailable"]),
  ),
});

const workbenchProjectionSchema = v.strictObject({
  // ... (all existing fields unchanged)
  conversation: conversationSchema,
  // REMOVED: publishedFeedback, comments
});
```

### Workbench tab state

```ts
// BEFORE:
const [primarySurface, setPrimarySurface] = useState<"files" | "insights">(...);

// AFTER:
type WorkbenchTab = "conversation" | "diff" | "insights";
const [activeTab, setActiveTab] = useState<WorkbenchTab>("conversation");
```

### Lightbox component contract

```ts
export function MarkdownLightbox({
  open,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element;
```

The lightbox wraps the content (image or Mermaid SVG) in a `Dialog` with a dark backdrop. It owns its own zoom state internally, persisted per-open (reset on close). Zoom controls: `+` / `-` buttons, fit-to-screen toggle, keyboard `+`/`-`/`0`/`Escape`.

### Image and Mermaid click handlers

```ts
// In renderMarkdownImage: wrap <img> in a clickable container that opens MarkdownLightbox
// In MermaidDiagram: wrap rendered SVG in a clickable container that opens MarkdownLightbox
```

## Seams, Boundaries, Adapters, and Implementations

| Seam                               | What crosses it                       | Owner                          |
| ---------------------------------- | ------------------------------------- | ------------------------------ |
| `GitHubReader.loadConversation()`  | `Conversation` DTO                    | Adapter (GitHub API → domain)  |
| `WorkbenchResponse` Valibot schema | `conversation` field                  | Main process → Renderer bridge |
| `ReviewWorkbench` props            | `activeTab` state, tab bar UI         | Renderer                       |
| `Conversation` component           | `Conversation` payload → React tree   | Renderer                       |
| `PullRequestDescriptionPreview`    | Markdown string → rendered nodes      | Renderer (reused, no change)   |
| `MarkdownLightbox`                 | Open/close, zoom state, children      | Renderer (new)                 |
| Loopback API `/v1/reviews/load`    | WorkbenchResponse with `conversation` | Main process service           |

## Call Stacks and Data Flow

### Current Flow: Loading a review

```txt
Renderer: requestJson("/v1/reviews/load", { profileId, reviewId })
  → Main process: review-load-service.loadReview()
    → GitHubReader.getPullRequestComments() → GitHubComments
    → GitHubReader.getPullRequestPublishedFeedback() → GitHubPublishedFeedback
    → (other adapter calls for diff, checks, etc.)
    → Assemble WorkbenchResponse with publishedFeedback + comments fields
  → Renderer: parseWorkbenchResponse() validates
  → ReviewWorkbenchFlow receives workbench
  → PublishedFeedbackSlot wraps PublishedFeedbackPanel
  → ReviewWorkbench renders: header -> diff or insights (via primarySurface toggle) -> published feedback slot
```

### Proposed Flow: Loading a review

```txt
Renderer: requestJson("/v1/reviews/load", { profileId, reviewId })
  → Main process: review-load-service.loadReview()
    → GitHubReader.loadConversation() → Conversation (unified, sorted, inline threads excluded)
    → (other adapter calls for diff, checks, etc. — unchanged)
    → Assemble WorkbenchResponse with conversation field (publishedFeedback and comments removed)
  → Renderer: parseWorkbenchResponse() validates new schema
  → ReviewWorkbenchFlow receives workbench
  → PublishedFeedbackSlot REMOVED
  → ReviewWorkbench renders: header (with tabs) -> conversation | diff | insights (via activeTab)
```

### Proposed Flow: Conversation tab rendering

```txt
activeTab === "conversation"
  → Conversation component receives workbench.conversation
  → Render PR description at top: PullRequestDescriptionPreview(conversation.prDescription)
  → Map entries chronologically:
    - PrDescription: already rendered at top, skip
    - IssueComment: render comment card (author, timestamp, body via renderBlocks)
    - ReviewSummary: render review card (author, event badge, body via renderBlocks)
    - GeneralThread: render thread card (state badge, comments, nested replies)
  → Each Markdown body: lexSafely() → renderBlocks() (existing pipeline)
  → Images in rendered output: clickable → opens MarkdownLightbox with zoom
  → Mermaid diagrams: clickable → opens MarkdownLightbox with zoom
```

### Proposed Flow: Image/diagram zoom

```txt
User clicks image or Mermaid SVG in rendered Markdown
  → MarkdownLightbox opens (Dialog with dark backdrop)
  → Content rendered at native size, initial scale = fit-to-screen
  → User clicks "+" → scale increases by step (0.25x)
  → User clicks "-" → scale decreases by step (min 0.25x)
  → User clicks "Fit" → toggles fitToScreen mode
  → User presses Escape or clicks backdrop/X → lightbox closes, zoom state discarded
```

### Failure Flow

```txt
loadConversation() fails
  → Result.err with GitHubReadFailure
  → Main process returns WorkbenchResponse with conversation === undefined
  → Or: main process returns partial conversation with incompleteReason set
  → Renderer: Conversation component shows "Conversation unavailable" state
  → Refresh button remains available
```

### Refresh Flow

```txt
User triggers refresh
  → /v1/reviews/refresh called (unchanged path)
  → loadConversation() called again as part of refresh pipeline
  → New WorkbenchResponse replaces old one
  → If activeTab was "conversation", content re-renders with fresh data
  → Active tab preserved across refresh
```

## Files to Add / Change / Delete

### Files to ADD

| File                                                | Responsibility                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/renderer/src/components/conversation.tsx`      | Conversation tab content — renders `Conversation` payload as chronological timeline |
| `src/renderer/src/components/markdown-lightbox.tsx` | Zoomable lightbox for images and Mermaid diagrams                                   |
| `tests/renderer/conversation.ui.test.tsx`           | Conversation tab UI tests                                                           |
| `tests/renderer/markdown-lightbox.ui.test.tsx`      | Lightbox zoom behavior tests                                                        |

### Files to CHANGE

| File                                                       | Change                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/github-context.ts`                             | Add `Conversation`, `ConversationEntry` types. Remove `GitHubPublishedFeedback`, `GitHubComments`.                                                                                                                              |
| `src/adapters/github/github-adapter.ts`                    | Add `loadConversation()` to `GitHubReader`. Implement composing GraphQL threads + REST feedback.                                                                                                                                |
| `src/renderer/src/renderer-contracts.ts`                   | Replace `publishedFeedback` + `comments` with `conversation` field in `workbenchProjectionSchema`.                                                                                                                              |
| `src/renderer/src/flows/review-workbench-flow.tsx`         | Remove `PublishedFeedbackSlot` and its props wiring. Route `conversation` to new `Conversation` component.                                                                                                                      |
| `src/renderer/src/components/review-workbench.tsx`         | Extend `primarySurface` → `activeTab` (3-way). Add tab bar to workbench header. Render Conversation/Diff/Insights by tab. Remove published feedback slot rendering. Remove `surfaceAction` prop passthrough to `DiffWorkbench`. |
| `src/renderer/src/components/pull-request-description.tsx` | Wrap `renderMarkdownImage` images and `MermaidDiagram` SVGs in click-to-zoom handlers that open `MarkdownLightbox`.                                                                                                             |
| `tests/renderer/renderer-contracts.test.ts`                | Update `WorkbenchResponse` fixtures — add `conversation`, remove `publishedFeedback`/`comments`.                                                                                                                                |
| `tests/renderer/review-workbench-flow.ui.test.tsx`         | Update fixtures. Add tab navigation assertions. Remove published feedback assertions.                                                                                                                                           |
| `CONTEXT.md`                                               | Already updated with new glossary terms.                                                                                                                                                                                        |

### Files to DELETE

| File                                                        | Reason                          |
| ----------------------------------------------------------- | ------------------------------- |
| `src/renderer/src/components/published-feedback.tsx`        | Replaced by Conversation screen |
| `tests/renderer/published-feedback.ui.test.tsx` (if exists) | Component deleted               |

## RGR TDD Test Plan

Each slice: write one red test → implement minimum → refactor → commit. Tests use the existing Vitest + Testing Library patterns from `review-workbench-flow.ui.test.tsx`.

### Slice 1: Contract — WorkbenchResponse with conversation

**Red:** Add a test in `renderer-contracts.test.ts` that a valid `conversation` field parses successfully and a malformed one (missing `_tag` on an entry) returns `undefined`.

**Green:** Add `conversationSchema` + `conversationEntrySchema`. Update `workbenchProjectionSchema`. Update fixture in test.

### Slice 2: Contract — publishedFeedback removal

**Red:** Existing test fixtures still reference `publishedFeedback`. Update them to use `conversation` instead, verify all contract tests pass.

**Green:** Remove `publishedFeedbackSchema` and `githubCommentsSchema` from the schema. Remove from existing fixtures. Update `parseWorkbenchResponse` callers.

### Slice 3: Domain types — Conversation

**Red:** Unit test that `ConversationEntry` discriminated union accepts all four variants and rejects unknown `_tag` values (via Valibot parse).

**Green:** Add `Conversation`, `ConversationEntry` types to `github-context.ts`. Remove `GitHubPublishedFeedback`, `GitHubComments`, `PublishedReviewComment`.

### Slice 4: Adapter — loadConversation()

**Red:** Test that `loadConversation()` returns a `Conversation` with entries sorted chronologically and inline threads excluded. Test empty PR (no comments, no reviews) returns `{ prDescription: "", entries: [] }`. Test pagination cap sets `complete: false`.

**Green:** Implement `loadConversation()` composing existing GraphQL thread query + REST endpoints. Wire into the review load service.

### Slice 5: Renderer — Conversation tab component

**Red:** Render `Conversation` component with a fixture payload. Assert PR description renders. Assert issue comment renders with author and body. Assert review summary renders with verdict badge. Assert general thread renders with nested replies.

**Green:** Implement `Conversation` component. Render `PullRequestDescriptionPreview` for description. Render each entry type with appropriate markup. Reuse `renderBlocks()` for Markdown bodies.

### Slice 6: Renderer — Tab bar in workbench header

**Red:** Render `ReviewWorkbench` with `activeTab = "conversation"`. Assert three tabs visible. Assert Conversation tab is active. Click Diff tab → assert Diff content visible and Conversation hidden. Assert tab state preserved across prop updates that don't change revision.

**Green:** Add tab bar to `ReviewWorkbench`. Wire `activeTab` state. Conditionally render Conversation/Diff/Insights.

### Slice 7: Integration — Landing on Conversation

**Red:** Default `activeTab` is `"conversation"`. When a fresh `WorkbenchResponse` arrives, Conversation tab is selected.

**Green:** Initialize `activeTab` to `"conversation"`. Reset only on `reviewedHeadSha` change.

### Slice 8: Renderer — Remove published feedback slot

**Red:** `ReviewWorkbenchFlow` no longer renders `PublishedFeedbackSlot`. `PublishedFeedbackPanel` is no longer imported.

**Green:** Delete `PublishedFeedbackSlot` instantiation code. Delete `published-feedback.tsx`. Clean up `usePublishedFeedbackNavigation` context if unused (or defer to phase 2 when inline thread actions need it).

### Slice 9: Lightbox — zoomable overlay

**Red:** Render `MarkdownLightbox` open with a large image. Assert zoom in button increases scale. Assert zoom out decreases scale. Assert fit-to-screen toggle. Assert Escape closes. Assert backdrop click closes.

**Green:** Implement `MarkdownLightbox` with `Dialog`, zoom state reducer, CSS `transform: scale()`, keyboard handlers.

### Slice 10: Lightbox — integration with Markdown rendering

**Red:** Render `PullRequestDescriptionPreview` with an image token. Click image → assert `MarkdownLightbox` opens with that image. Click Mermaid SVG → assert lightbox opens with SVG.

**Green:** Add click handlers to `renderMarkdownImage` and `MermaidDiagram`. Wire to `MarkdownLightbox`.

### Slice 11: Conversation — empty, error, and partial states

**Red:** Render Conversation with `complete: false` — assert partial notice. Render with no entries — assert empty state. Render with `conversation === undefined` — assert unavailable state.

**Green:** Handle all three states in `Conversation` component.

## Risks and Open Questions

- **Pagination depth risk:** `loadConversation()` composes multiple API calls (GraphQL threads + REST reviews + REST comments). Each has its own pagination cap. If one exhausts its cap before others, the timeline may have gaps. Mitigation: set `complete: false` with distinct `incompleteReason` per source. This matches existing behavior.
- **Chronological ordering:** GitHub reviews and comments have different timestamp fields (`submitted_at` vs `created_at`). Interleaving them into a single chronological timeline requires both to be present. The adapter is responsible for correct ordering.
- **Open question — `GitHubComment` shape:** `PublishedReviewComment` had `canEdit`/`canDelete` flags that were only used by the published feedback panel's edit/delete actions. Since those actions are removed, do we keep the flags on the base `GitHubComment` type? Recommendation: remove them — they were never used outside the published feedback panel.
- **Open question — `PublishedFeedbackNavigationContext`:** This context was used to scroll to the published feedback panel from publication confirmation. Without the panel, should the context focus the Conversation tab instead? Recommendation: remove the context hook. The Conversation tab is always visible and doesn't need a scroll-to action.

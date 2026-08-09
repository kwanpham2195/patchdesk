---
created_at: 2026-08-09
repos:
  - patchdesk
status: ready-for-review
spec: .agents/tasks/inline-diff-conversations/spec.md
---

# GitHub Start a review, inline conversations, and the hidden local draft

## Research question

How do inline GitHub conversations work in Patchdesk today, how does GitHub's Start a review lifecycle work, and where should that lifecycle connect to Patchdesk's local Review draft?

This research reflects the uncommitted working tree on `fix/inline-conversation-freshness-repair` on 2026-08-09. It does not include a live GitHub write.

## Summary

Patchdesk currently has two separate feedback paths:

1. Diff conversation actions publish immediately to GitHub.
2. The local Review draft collects unpublished feedback and publishes it through a GitHub pending review.

The local Review draft machinery is active, but the production workbench hides its dock unconditionally. Analysis can seed the draft, Findings can add items to it, draft annotations can appear in the Diff, and publication can still run. The user cannot normally open the draft editor after those actions.

Patchdesk already implements the core GitHub Start a review protocol for publication: create a `PENDING` review, persist its ID, then submit it as `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`. The main integration problem is therefore not missing API support. The product has no coherent visible boundary between local draft feedback, GitHub pending reviews, and immediate inline comments.

The recommended direction is:

- Restore a visible entry point for the local Review draft.
- Keep local draft content authoritative until explicit publication.
- Let manual inline authoring offer **Add to review** as the primary action and **Comment now** as an explicit immediate alternative.
- Detect viewer-owned GitHub pending reviews and block or explain conflicting immediate writes.
- Do not silently mirror every local draft edit into GitHub.

## Current inline conversation behavior

### Read path

The GitHub adapter loads review threads with GraphQL:

- `src/adapters/github/github-adapter.ts:48-63`
- `src/adapters/github/github-adapter.ts:785-917`

The query returns thread identity, resolution and outdated state, path, old/new-side coordinates, and comments. It does not retrieve the owning review's `PENDING` or submitted state.

The renderer maps a thread only when its complete anchor belongs to the represented Diff:

- `src/renderer/src/inline-conversation-mapping.ts:3-55`
- `src/renderer/src/components/review-workbench.tsx:276-295`

The mapper excludes outdated, unanchored, invalid, omitted, binary, and partially mapped ranges. Old-side and new-side ranges remain separate. A mapped card appears after the final anchored line.

Thread cards and their actions live in:

- `src/renderer/src/components/review-diff-view.tsx:107-213`
- `src/renderer/src/components/review-diff-view.tsx:966-980`
- `src/renderer/src/components/review-diff-view.tsx:1386-1538`

A canonical thread can expose Reply, Resolve or Unresolve, and owned-comment Edit and Delete controls.

### Direct write path

The renderer sends direct commands through one protected route:

```text
ReviewDiffView
  -> ReviewWorkbenchFlow
  -> POST /v1/reviews/inline-conversations/command
  -> InlineConversationService
  -> ReviewWriteGate
  -> exact GitHub head check
  -> GitHubAdapter
  -> typed receipt
  -> recent-write journal
```

Relevant code:

- Renderer commands: `src/renderer/src/flows/review-workbench-flow.tsx:351-512`
- Route registration and parsing: `src/main/local-api.ts:651,1034-1090`
- Service boundary: `src/services/inline-conversation-service.ts:6-156`
- Freshness and ownership gate: `src/services/review-write-gate.ts:37-131`
- Adapter mutations: `src/adapters/github/github-adapter.ts:1280-1330`

Each command carries the represented session, head SHA, and patch hash. The service requires an open, fresh Review, then reads the current pull request head immediately before the GitHub write. Reply and thread-state commands prove that the target belongs to the active pull request. Edit and Delete also require viewer authorship. Delete requires explicit confirmation.

New inline comments use REST `POST /pulls/{number}/comments`. Replies, thread-state changes, edits, and deletes use GraphQL.

The REST create receipt includes a comment ID and sometimes a review ID, but no thread ID. A newly created card therefore permits Edit and Delete after confirmation, but Reply and Resolve remain disabled until explicit refresh loads the canonical thread.

### Reconciliation and freshness

Direct writes append typed journal entries. Update detection removes only the app's known comment or review records from both fingerprints and normalizes the requested state of one touched thread:

- `src/services/review-refresh-service.ts:68-118`
- `src/services/review-refresh-service.ts:343-405`

This prevents Patchdesk's own write from producing a false Updates available marker while preserving external replies and state changes in the same thread. Explicit refresh remains the only operation that replaces represented GitHub state under `docs/adr/0001-manual-github-refresh.md`.

## GitHub Start a review behavior

GitHub's web flow is:

1. Select one line, a line range, or a file.
2. Write the first comment and choose **Start a review**.
3. Add more comments with **Add review comment**.
4. Edit pending comments while the review remains private to the reviewer.
5. Submit the review as Comment, Approve, or Request changes, or abandon it.

GitHub documents that pending line comments are visible only to their author. Abandoning a review removes the pending review and its pending comments.

### REST API

`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` creates a pull request review. Omitting `event` creates it in `PENDING` state. The request can include:

- `commit_id`
- review body
- an array of inline comments

`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events` submits the pending review with one of:

- `COMMENT`
- `APPROVE`
- `REQUEST_CHANGES`

Pending reviews omit `submitted_at`. REST can delete an unsubmitted pending review. Submitted reviews cannot be deleted.

### GraphQL API

The GraphQL pull-request schema provides:

- `addPullRequestReview`
- `addPullRequestReviewThread`
- `addPullRequestReviewThreadReply`
- `submitPullRequestReview`
- `deletePullRequestReview`

`addPullRequestReviewThread` explicitly adds a new thread to a pending review. Its input supports path, line, side, and optional multi-line start coordinates.

GraphQL's `clientMutationId` is a correlation value. GitHub does not document it as an idempotency key.

### Constraints and gaps

GitHub content-creation endpoints can return validation errors and secondary rate limits. A timeout after a write may leave the server-side review or comment created even when the client received no result. Patchdesk must reconcile before retrying an uncertain operation.

GitHub's public documentation does not clearly state:

- the one-pending-review-per-user-per-pull-request rule;
- complete cross-user API visibility of pending reviews and comments;
- idempotent retry behavior for review creation;
- whether thread replies join an existing pending review in every relevant API path.

Patchdesk has operational evidence for the one-pending-review constraint. The command runner classifies GitHub's 422 response:

- `src/adapters/github/command-runner.ts:215-218`
- `tests/adapters/github-adapter.test.ts:128-135`

Treat this as a real integration constraint, but verify it against a disposable pull request before expanding the lifecycle.

## Existing Patchdesk review publication

Patchdesk already models a durable local Review draft:

- `src/domain/review-batch.ts:26-204`

The draft can contain:

- inline comments;
- general comments;
- replies to existing threads;
- resolve or reopen actions.

Its lifecycle includes Local, Applying, PartialFailure, PendingReview, Submitted, and Completed states. Remote receipts record pending-review creation, replies, and thread-state changes.

Publication planning and execution live in:

- `src/services/review-submission-service.ts:41-169`
- `src/services/review-submission-service.ts:172-401`
- `src/services/review-write-controller.ts:22-145`

The GitHub adapter already provides:

- `createPendingReview`: `src/adapters/github/github-adapter.ts:1236-1259`
- `submitPendingReview`: `src/adapters/github/github-adapter.ts:1261-1278`

The confirmed publication flow creates a pending review with the Review body and included inline comments, persists the returned review ID, applies separately modeled thread actions, rechecks the head, and submits the pending review. After successful publication, Patchdesk archives the receipts and installs an empty successor draft under `docs/adr/0006-separate-draft-and-published-feedback.md`.

The two-step create-and-submit sequence should remain. One research angle proposed a single directly submitted REST review, but the current two-step implementation has a stronger recovery boundary: Patchdesk can persist the pending review ID before the final submit call. A single request reduces calls but increases duplicate-publication ambiguity when its response is lost.

## The local Review draft is hidden

`ReviewWorkbenchFlow` constructs and supplies a `DraftSlot` for every workbench:

- `src/renderer/src/flows/review-workbench-flow.tsx:770-793`
- `src/renderer/src/flows/review-workbench-flow.tsx:1885-2137`

If the workbench projection has no draft, `DraftSlot` creates an empty renderer fallback:

- `src/renderer/src/flows/review-workbench-flow.tsx:1908-1911`
- `src/renderer/src/flows/review-workbench-flow.tsx:2140-2153`

The production workbench then wraps that slot in an unconditional `hidden` container:

- `src/renderer/src/components/review-workbench.tsx:546-550`

```tsx
<div className="hidden min-h-0 shrink-0" data-review-workbench-draft-dock>
  {slots.draftDock}
</div>
```

No state removes the `hidden` class. The dock stays invisible when it contains items, needs attention, is initially expanded, or requires publication recovery.

The browser test records this as expected behavior:

- `tests/browser/local-api-workbench.spec.ts:119-133`

The renderer test also asserts that the wrapper remains hidden:

- `tests/renderer/review-workbench-flow.ui.test.tsx:997-1006`

Isolated design and component tests render `ReviewDraftDock` directly and expect it to be visible. Those tests bypass the production wrapper:

- `tests/renderer/review-draft-dock.ui.test.tsx:52-63`
- `tests/browser/design.spec.ts:111-160`

### What can populate the hidden draft

Analysis offers these completion actions:

- Save as Review draft
- Open preview when complete
- Publish as Comment
- Publish as Approve
- Publish as Request changes

See `src/renderer/src/flows/review-workbench-flow.tsx:1437-1457`.

The default is Open preview when complete:

- `src/renderer/src/flows/review-workbench-flow.tsx:855-856`

That path can open the publication dialog through a portal even though its trigger lives in the hidden dock. After the dialog closes, the user has no visible way to reopen the draft.

A current Finding also exposes **Add to review**:

- `src/renderer/src/components/review-workbench.tsx:591-603`
- `src/renderer/src/flows/review-workbench-flow.tsx:601-685`

Inline draft items can appear as Diff annotations through `draftInlineAnnotations`:

- `src/renderer/src/components/review-workbench.tsx:50-76`

The Review body, general comments, inclusion controls, item editing, removal, and Needs attention queue remain inside the hidden dock.

The canonical PR Overview is read-only and does not receive the local draft. An older `PullRequestOverviewSheet` contains a Your local review section, but the production workbench uses `CanonicalReviewOverviewSheet` instead:

- `src/renderer/src/components/review-workbench.tsx:330-360,552`
- `src/renderer/src/components/pr-overview-sheet.tsx:98-190`

The hidden dock contradicts `docs/adr/0004-use-one-progressive-review-workbench.md`, which defines the Review draft as a persistent collapsible bottom dock shared by Files and Insights.

## Product implications

The user can currently create local draft content without having a normal place to inspect or edit it. This produces several confusing cases:

- Save as Review draft succeeds, but no draft editor appears.
- Add to review changes the draft and may add a Diff annotation, but the full item list remains hidden.
- General feedback has no Diff annotation and effectively disappears from the visible surface.
- Needs attention can block publication without exposing its repair queue.
- Publication recovery can exist without a reachable recovery trigger.
- Direct inline comments bypass the draft entirely, so the most visible authoring control reinforces immediate publication rather than Review drafting.

## Integration options

### Keep the current immediate-only Diff composer

This preserves the inline-conversation specification as written. It also leaves the hidden Review draft disconnected from the main authoring flow and retains conflicts with viewer-owned GitHub pending reviews.

This option does not solve the observed product problem.

### Mirror the local draft to GitHub while editing

Patchdesk could create a GitHub pending review on the first local item and append remote pending threads through GraphQL.

This adds dual ownership, orphan cleanup, per-item remote identity, stale-head migration, and uncertain-outcome reconciliation. An external edit on github.com could diverge from Patchdesk's local content. Immediate comments would also conflict with the active pending review.

Do not use this as the default lifecycle.

### Keep the draft local and expose two explicit authoring choices

The Diff composer can offer:

- **Add to review**: save a local `InlineComment` item.
- **Comment now**: use the current direct conversation command.

This makes ownership explicit. Patchdesk remains authoritative before publication, while users retain an immediate escape hatch for conversational feedback.

This is the recommended option. It requires a product decision because `.agents/tasks/inline-diff-conversations/spec.md` currently states that new comments publish immediately and GitHub pending reviews are out of scope.

## Recommended direction

### Restore the draft surface

Make the Review draft reachable from the production workbench. At minimum:

- show the collapsed Review draft row;
- allow it to expand;
- surface the number of included items and Needs attention count;
- keep recovery reachable after reload;
- open or focus it after Add to review;
- preserve access after the publication preview closes.

Decide whether Insights should keep the dock visible. ADR-0004 says the dock is shared by Files and Insights, while current renderer tests expect it hidden in the Insights reader.

### Route draft authoring through the existing batch boundary

The existing `DraftSlot` already constructs `ReviewBatchPanelActions`, including `AddInlineComment`:

- `src/renderer/src/flows/review-workbench-flow.tsx:1912-1960`

Reuse that command for **Add to review**. Do not route local draft items through `InlineConversationService`.

Keep **Comment now** on the direct command path. Label it as an immediate GitHub write.

### Add viewer-pending-review awareness

Add a dedicated read result instead of treating a pending review as Published feedback:

```ts
type ViewerPendingReview =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Pending";
      readonly restId: string;
      readonly nodeId: string;
      readonly author: string;
      readonly headSha: GitSha;
      readonly ownership: "patchdesk" | "external";
    };
```

Use both the REST review ID and GraphQL node ID. Bind the result to the authenticated account and represented head.

Behavior:

- Recover a Patchdesk-owned pending review only through its durable receipts.
- Block conflicting immediate comments when an unmatched pending review exists.
- Explain the conflict and offer Open on GitHub.
- Never adopt, submit, or abandon an unmatched pending review automatically.

### Keep remote incremental drafting out of the first integration

If cross-client remote drafting becomes a confirmed requirement, add a separate adapter method around `addPullRequestReviewThread`. That work also needs explicit abandon, remote-comment identity mapping, divergence handling, and reconciliation after uncertain outcomes.

## Validation spike

Before implementation, use a disposable pull request and a dedicated test account:

1. Create a pending review with one inline comment.
2. Read the review through REST and the threads through the current GraphQL query.
3. Record whether the pending thread appears and whether its pending state can be identified.
4. Add another thread with `addPullRequestReviewThread`.
5. Attempt the current immediate REST inline-comment write and capture the exact response.
6. Move the pull request head and inspect anchor and outdated behavior.
7. Delete the pending review without submitting it.
8. Repeat the read with a second account to confirm visibility boundaries.

No production GitHub content should be used for this spike.

## Open questions

- Should the Review draft dock remain visible in Insights, as ADR-0004 requires, or only in Files?
- Should manual Diff authoring default to Add to review, Comment now, or present a split action?
- Should replies and Resolve or Unresolve remain immediate even when new comments default to the local draft?
- Should Patchdesk offer a confirmed Abandon action for its own pending review, or require GitHub for the first version?
- How should the UI distinguish a pending thread returned by GitHub from a submitted Conversation thread?
- Does the current GraphQL reply mutation join the viewer's pending review or publish a separate review comment when a pending review exists?

## Sources

Primary GitHub sources:

- [Reviewing proposed changes in a pull request](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request)
- [REST API endpoints for pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [REST API endpoints for pull request review comments](https://docs.github.com/en/rest/pulls/comments)
- [GraphQL pull request schema](https://docs.github.com/en/graphql/reference/pulls)
- [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

Local specifications and decisions:

- `.agents/tasks/inline-diff-conversations/spec.md`
- `.agents/tasks/inline-diff-conversations/tech-spec.md`
- `.agents/tasks/unified-review-workbench/plans/2026-08-08-inline-conversation-freshness-and-performance-repair.md`
- `.agents/tasks/unified-review-workbench/plans/2026-08-09-inline-conversation-review-follow-up.md`
- `docs/adr/0001-manual-github-refresh.md`
- `docs/adr/0002-preserve-review-drafts-across-revisions.md`
- `docs/adr/0004-use-one-progressive-review-workbench.md`
- `docs/adr/0005-follow-the-pull-request-lifecycle.md`
- `docs/adr/0006-separate-draft-and-published-feedback.md`

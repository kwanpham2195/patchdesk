---
created_at: 2026-08-08
repos:
  - patchdesk
status: ready-for-agent
spec: .agents/tasks/inline-diff-conversations/spec.md
---

# Inline Diff Conversations — Tech Spec

## Summary

Render mapped GitHub Conversation threads inline in the Diff and support direct GitHub actions: single comments, replies, Resolve/Unresolve, edit, and confirmed delete.

New inline actions bypass the local Review draft. The existing Review write boundary remains authoritative for freshness, lifecycle, and safe failure handling.

## Context / Current State

- `Conversation` deliberately excludes inline threads from timeline entries.
- `GitHubComments` already loads GitHub review threads, including anchor, state, and replies.
- The Diff annotation seam currently renders Findings and local-comment draft previews.
- Reply, thread-state, edit, and delete adapter methods exist; direct single-comment creation does not.
- `ReviewWriteGate.requireFresh()` already validates Review ownership, terminal state, represented snapshot, session/head identity, and optional patch hash.
- `PublishedFeedbackService` is unsuitable as the primary owner: it is panel-oriented and cannot create a mapped single comment or render thread state.

## Goals

- Show open and resolved threads whose full anchor maps to the current Diff.
- Support old-side and new-side anchors.
- Publish new comments and replies directly to GitHub.
- Make Resolve/Unresolve immediate explicit actions.
- Permit only the signed-in author to edit or delete their comments.
- Keep GitHub authoritative through post-write refresh.
- Preserve one clear local API and service seam for all direct inline actions.

## Non-Goals

- Outdated, unanchored, partial-range, or cross-side thread mapping.
- GitHub pending reviews.
- Local persistence of unsent comment text.
- Conversation-screen write actions.
- Resolved-thread filtering.
- Per-thread GitHub links.
- Changes to merge or Review-batch publication behavior.

## Invariants

- A mapped Conversation thread is open or resolved and maps every line of one same-side range.
- Direct comments never enter the local Review draft.
- Every direct write requires a fresh, open Review and a final GitHub head check.
- Delete requires confirmation; Comment, Reply, Save, Resolve, and Unresolve are explicit write controls.
- Failed state changes restore the last confirmed UI state.
- Comment bodies never enter logs, diagnostics, or toast messages.

## Design Constraints

- The renderer remains sandboxed and may never invoke GitHub directly.
- Unknown local-API input is strictly parsed before entering service logic.
- Expected failures use typed result channels; no normal write failure is thrown across application layers.
- GitHub-accepted content remains distinct from the local Review draft under ADR-0006.
- Existing safe Markdown rendering and image/Mermaid lightbox behavior are reused.
- The direct path must not weaken merge or batch-publication protections.

## Alternatives Considered

### Option 1: Extend the local Review draft

Add thread actions and comments to `ReviewBatch`, then publish through batch submission.

Rejected: violates the agreed immediate GitHub behavior and makes inline discussion look unpublished.

### Option 2: Renderer calls GitHub directly

Let the React renderer invoke `gh` or GitHub APIs.

Rejected: breaks Electron sandboxing, bypasses the loopback capability boundary, and prevents Review lifecycle validation.

### Option 3: One direct-inline command service

Add one protected local API command endpoint backed by an `InlineConversationService`. It owns freshness checks, final head validation, authorization, GitHub writes, and typed results.

Recommended: one command seam, no draft coupling, and one testable owner for all direct actions.

## Recommendation

Use Option 3.

Expose inline-thread data through the existing workbench projection, derive mapped card annotations in the renderer, and send all mutations through:

```txt
renderer
  -> POST /v1/reviews/inline-conversations/command
  -> InlineConversationService
  -> ReviewWriteGate + current GitHub head check
  -> GitHubReviewWriter
  -> typed response
  -> renderer optimistic update + awaited refresh
```

## Proposed Design

### Domain Model and Types

Keep timeline entries separate from inline threads, but carry inline data in the same GitHub-owned Conversation payload:

```ts
type InlineConversation = {
  readonly threads: ReadonlyArray<GitHubConversationThread>;
  readonly complete?: boolean;
  readonly incompleteReason?:
    | "thread_cap"
    | "comment_cap"
    | "pagination"
    | "unavailable";
};

type Conversation = {
  readonly prDescription: string;
  readonly entries: ReadonlyArray<ConversationEntry>;
  readonly inline: InlineConversation;
  readonly complete?: boolean;
  readonly incompleteReason?:
    | "thread_cap"
    | "comment_cap"
    | "pagination"
    | "unavailable";
};
```

`Conversation.entries` remains general/timeline-only. `Conversation.inline` is consumed only by the Diff.

Add viewer authorship from the GitHub thread query:

```ts
type GitHubComment = {
  readonly id: string; // GitHub GraphQL node ID
  readonly author: string;
  readonly body: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly url?: string;
  readonly location?: DiffLocation;
  readonly viewerDidAuthor: boolean;
};
```

Use a strict annotation union instead of optional combinations:

```ts
type DiffAnnotationAnchor = {
  readonly id: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly side: "new" | "old";
};

type ReviewInlineAnnotation =
  | (DiffAnnotationAnchor & {
      readonly _tag: "Finding";
      readonly severity: string;
      readonly title: string;
      readonly explanation: string;
    })
  | (DiffAnnotationAnchor & {
      readonly _tag: "DraftInlineComment";
      readonly body: string;
    })
  | (DiffAnnotationAnchor & {
      readonly _tag: "ConversationThread";
      readonly thread: GitHubConversationThread;
    })
  | (DiffAnnotationAnchor & {
      readonly _tag: "DirectCommentComposer";
      readonly composerId: string;
    });
```

Add a pure mapper that requires every line in a range to exist in the parsed patch:

```ts
type MapConversationThreadResult =
  | {
      readonly _tag: "Mapped";
      readonly annotation: Extract<
        ReviewInlineAnnotation,
        { readonly _tag: "ConversationThread" }
      >;
    }
  | {
      readonly _tag: "Excluded";
      readonly reason:
        | "outdated"
        | "unanchored"
        | "invalid_range"
        | "unmapped";
    };

function mapConversationThread(
  patch: ReadonlyArray<ParsedPatchFile>,
  thread: GitHubConversationThread,
): MapConversationThreadResult;
```

This must not reuse `mapFindingLocation()` unchanged: that helper currently verifies range endpoints, while mapped Conversation threads require every line in the range.

### Direct Command Contract

Use one strict command DTO:

```ts
type DirectConversationExpectation = {
  readonly sessionId: string;
  readonly headSha: string;
  readonly patchHash: string;
};

type DirectConversationCommand =
  | {
      readonly _tag: "CreateComment";
      readonly expected: DirectConversationExpectation;
      readonly anchor: {
        readonly path: string;
        readonly startLine: number;
        readonly line: number;
        readonly side: "new" | "old";
      };
      readonly body: string;
    }
  | {
      readonly _tag: "Reply";
      readonly expected: DirectConversationExpectation;
      readonly threadId: string;
      readonly body: string;
    }
  | {
      readonly _tag: "SetThreadState";
      readonly expected: DirectConversationExpectation;
      readonly threadId: string;
      readonly state: "open" | "resolved";
    }
  | {
      readonly _tag: "EditComment";
      readonly expected: DirectConversationExpectation;
      readonly commentId: string;
      readonly body: string;
    }
  | {
      readonly _tag: "DeleteComment";
      readonly expected: DirectConversationExpectation;
      readonly commentId: string;
      readonly confirmation: true;
    };
```

All command objects are Valibot strict objects. Parse IDs into existing branded IDs before service entry.

Return semantic results:

```ts
type DirectConversationReceipt =
  | { readonly _tag: "CommentCreated"; readonly commentId: string }
  | { readonly _tag: "ReplyCreated"; readonly commentId: string }
  | {
      readonly _tag: "ThreadStateChanged";
      readonly threadId: string;
      readonly state: "open" | "resolved";
    }
  | { readonly _tag: "CommentEdited"; readonly commentId: string }
  | { readonly _tag: "CommentDeleted"; readonly commentId: string };

type DirectConversationFailure =
  | { readonly _tag: "InvalidInput" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "NotFresh" }
  | { readonly _tag: "TerminalReview" }
  | { readonly _tag: "PermissionDenied" }
  | { readonly _tag: "GitHubRejected" }
  | { readonly _tag: "GitHubUnavailable" }
  | { readonly _tag: "OutcomeUnknown" };
```

### Service and Adapter Interfaces

```ts
interface InlineConversationService {
  execute(
    input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly command: DirectConversationCommand;
    },
  ): Promise<Result<DirectConversationReceipt, DirectConversationFailure>>;
}
```

The service depends on:

```ts
type InlineConversationGateway =
  Pick<
    GitHubReader,
    "getPullRequest" | "getPullRequestComments" | "getRepositoryPermission"
  > &
  Pick<
    GitHubReviewWriter,
    | "createInlineComment"
    | "createThreadReply"
    | "setReviewThreadState"
    | "updateThreadComment"
    | "deleteThreadComment"
  >;
```

Add direct-comment support to `GitHubReviewWriter`:

```ts
createInlineComment(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly pr: PullRequestRef;
  readonly headSha: GitSha;
  readonly coordinates: GitHubReviewCoordinates;
  readonly body: string;
}): Promise<Result<{ readonly commentId: string }, GitHubWriteFailure>>;
```

Use the existing REST pull-request-comment endpoint for direct comment creation, with the already established coordinate projection.

Use GraphQL node-ID mutations for thread-comment edit/delete, because inline thread data currently carries GraphQL node IDs:

```ts
updateThreadComment(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly commentId: string;
  readonly body: string;
}): Promise<Result<void, GitHubWriteFailure>>;

deleteThreadComment(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly commentId: string;
}): Promise<Result<void, GitHubWriteFailure>>;
```

GitHub documents `updatePullRequestReviewComment` and `deletePullRequestReviewComment` GraphQL mutations for this node-ID path.

## Seams, Boundaries, Adapters, and Implementations

- **GitHub adapter**: fetches inline threads, includes `viewerDidAuthor`, and translates REST/GraphQL failures to `GitHubWriteFailure`.
- **Review workbench projection**: projects `Conversation.inline`; never exposes storage paths or credentials.
- **Renderer contract**: strictly parses the enriched Conversation DTO before UI state uses it.
- **Inline mapper**: pure renderer-side mapping from validated thread locations to Diff annotations.
- **Direct command API**: parses unknown JSON and maps typed service outcomes to sanitized HTTP responses.
- **InlineConversationService**: owns fresh-review validation, exact-head validation, command authorization, and mutation choice.
- **Renderer flow**: owns ephemeral composer text, pending-card overlays, toast presentation, and awaited refresh.

The renderer may never invoke GitHub directly. The service may never accept unparsed JSON or trust a renderer-provided anchor without validating it against the represented patch.

## Call Stacks and Data Flow

### Current / Old Flow

```txt
GitHub review threads
  -> GitHubReader.getPullRequestComments()
  -> remote snapshot comments
  -> Conversation assembly drops inline threads from entries
  -> WorkbenchResponse
  -> renderer shows Findings/local drafts only
```

### Proposed / New Read Flow

```txt
GitHub review threads
  -> GitHubReader.loadConversation()
  -> Conversation.inline
  -> represented remote snapshot
  -> ReviewWorkbenchProjection
  -> strict WorkbenchResponse parser
  -> mapConversationThread(parsedPatch, thread)
  -> ReviewInlineAnnotation { _tag: "ConversationThread" }
  -> Diff card after final mapped line
```

### Create Comment Flow

```txt
selected same-side range + body
  -> renderer validates non-empty body
  -> strict CreateComment DTO
  -> local API parser
  -> InlineConversationService.execute()
  -> ReviewWriteGate.requireFresh(expected)
  -> load represented patch + require full mapped range
  -> GitHubReader.getPullRequest() exact-head recheck
  -> GitHubReviewWriter.createInlineComment()
  -> CommentCreated receipt
  -> renderer replaces composer with ephemeral updating card
  -> await existing refresh flow
  -> canonical projection replaces ephemeral card
```

### Reply, State, Edit, and Delete Flow

```txt
explicit action
  -> strict command DTO
  -> ReviewWriteGate.requireFresh(expected)
  -> current GitHub thread/comment lookup where authorization is needed
  -> exact-head recheck
  -> GitHub mutation
  -> semantic receipt
  -> optimistic UI update
  -> await refresh
```

Delete additionally rejects `confirmation !== true` before any GitHub read or write.

### Failure Flow

- `NotFresh`: leave the existing card unchanged; offer Refresh; require the maintainer to re-anchor before retrying a new comment.
- `GitHubRejected` or `PermissionDenied`: restore prior card state; show a safe toast.
- `GitHubUnavailable`: restore state; show Retry only for state changes and idempotent edit/delete actions.
- `OutcomeUnknown` for new comments or replies: do not auto-retry, because GitHub has no supplied idempotency key. Refresh first; only the maintainer may explicitly resubmit.
- A post-success refresh failure does not turn a confirmed GitHub write into a failure. Keep the ephemeral updating card and offer Refresh.

### Retry, Cancellation, and Idempotency Flow

- Disable only the affected card/composer while its command is in flight.
- Serialize direct writes per Review with the existing keyed-review serialization pattern used by refresh and workbench control.
- Thread-state transitions are idempotent by target state.
- New comments and replies are not automatically retried.
- The renderer owns each request promise and awaits refresh; no fire-and-forget write or refresh is introduced.

### Observability Flow

Record only:

```ts
{
  reviewId,
  action: "create_comment" | "reply" | "set_thread_state" | "edit" | "delete",
  outcome: "ok" | "not_fresh" | "rejected" | "unavailable" | "unknown",
}
```

Never record comment body, repository checkout paths, tokens, or raw GitHub errors.

## Files to Add / Change / Delete

Add:

- `src/services/inline-conversation-service.ts`: direct-command owner and typed failures.
- `tests/services/inline-conversation-service.test.ts`: real-seam service behavior.
- `src/renderer/src/inline-conversation-mapping.ts`: pure full-range mapping and annotation derivation.
- `tests/renderer/inline-conversation-mapping.test.ts`: mapping invariants.

Change:

- `src/domain/github-context.ts`: enrich Conversation with inline threads and comment authorship.
- `src/adapters/github/github-adapter.ts`: query authorship; create direct comments; GraphQL edit/delete by node ID.
- `src/adapters/storage/review-remote-store.ts`: persist and parse enriched Conversation.
- `src/services/review-workbench-projection.ts`: project inline Conversation data from live and represented snapshots.
- `src/renderer/src/renderer-contracts.ts`: strict DTO schemas for inline threads and direct-command responses.
- `src/renderer/src/components/review-diff-view.tsx`: discriminated annotations, card rendering, composer, range reveal.
- `src/renderer/src/components/review-workbench.tsx`: derive mapped Conversation annotations.
- `src/renderer/src/flows/review-workbench-flow.tsx`: direct-command callbacks, optimistic UI state, refresh, toasts.
- `src/main/local-api.ts`: direct command route and protocol parsing.
- `src/main/desktop-bridge.ts`: allowlist the one direct command route.
- relevant service, adapter, projection, and renderer tests.

Delete or replace:

- The normal-Diff manual local-comment composer path. Newly authored Diff comments use direct commands instead.
- Preview-only thread action markup once real thread cards replace it.

## RGR TDD Test Plan

1. **Mapped-card projection**
   - Red: open/resolved current threads do not render.
   - Green: map full old/new ranges into separate cards after the final line.
   - Refactor: move mapping to the pure mapper.

2. **Exclusion and reveal**
   - Red: outdated, unanchored, endpoint-only, and partial-range mappings render incorrectly.
   - Green: exclude them; reveal required collapsed context.
   - Refactor: share range validation between selection and thread mapping.

3. **Thread presentation**
   - Red: cards cannot expose opening/latest reply, expand remaining replies, or disclose partial history.
   - Green: render accessible cards through the workbench flow.
   - Refactor: extract shared Markdown comment body rendering.

4. **Direct state transitions**
   - Red: Resolve/Unresolve does not require fresh state or restore on failure.
   - Green: service gate, final head check, typed receipt/failure, optimistic per-card UI.
   - Refactor: unify action state handling.

5. **Direct authoring**
   - Red: Comment/Reply enters a local batch or accepts stale anchors.
   - Green: direct command parser, exact mapping validation, immediate GitHub adapter call, updating card, refresh.
   - Refactor: share body parsing and command dispatch.

6. **Ownership and destructive actions**
   - Red: non-owner edit/delete controls appear or delete writes without confirmation.
   - Green: `viewerDidAuthor` UI guard, server-side final check, explicit delete dialog.
   - Refactor: centralize comment capability rendering.

7. **Adapter and protocol**
   - Test accepted/rejected GraphQL and REST payloads through the adapter interface.
   - Test malformed local command DTOs are rejected before service entry.
   - Test safe protocol failures and no body leakage.

8. **Live proof**
   - Fixture/browser proof for mapped rendering, keyboard navigation, context reveal, and Markdown.
   - Real-data read-only QA.
   - GitHub-write QA only with separate explicit authorization.

## Risks and Open Questions

- Existing persisted local inline draft items need an explicit treatment decision if they are still present when this ships; this design does not migrate or republish them.
- GitHub may accept a mutation but the subsequent refresh may fail. The confirmed action must remain visually distinct from an unconfirmed thread projection.
- Direct-comment and reply requests have no caller-provided GitHub idempotency key; unknown outcomes must refresh before any manual retry.

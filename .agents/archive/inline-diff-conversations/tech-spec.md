---
created_at: "2026-08-09"
repos:
  - patchdesk
status: needs-validation
spec: .agents/tasks/inline-diff-conversations/spec.md
research: .agents/tasks/inline-diff-conversations/01-research-github-start-review-and-local-draft.md
plan: .agents/tasks/inline-diff-conversations/plans/2026-08-09-github-pending-review-workbench.md
---

# GitHub pending reviews in the Review workbench — Tech Spec

## Summary

Replace Patchdesk’s local `ReviewBatch` draft and hidden Review draft dock with a GitHub-native pending-review lifecycle.

A maintainer starts a review from the Diff, creating a remote `PENDING` review with the first inline thread. Patchdesk reads the signed-in maintainer’s pending review, renders its pending comments in the Diff, lets the maintainer add more review comments, and finishes it from a GitHub-style modal. The final summary and Comment/Approve/Request changes decision are supplied only at submit time. Discard is implemented from the normal-response DELETE/read-back contract and uses conservative `OutcomeUnknown` recovery for its explicitly accepted unvalidated timeout/lost-response case.

This design is conditional on the validation spike in the linked plan. Redacted evidence at `fbb91b4` proves the bounded reader, Start with first thread, append, Submit, Comment-now rejection while pending, and create/add/submit lost-response reconciliation for the tested account/PR. `dbacd62` proves normal-response Discard DELETE and bounded absence read-back. The evidence records an environment deviation: the owner used a real open-repository PR and their own account rather than the planned sandbox/disposable PR and dedicated test account. The product owner explicitly accepts the unvalidated Discard timeout/lost-response path only when it persists `OutcomeUnknown`, forbids automatic retry, locks conflicting controls, and requires explicit reconciliation. Isolation with repository access, empty review, Reply/Resolve/Unresolve, and head-change behavior remain open gates, not implied features.

## Context / Current State

- `src/domain/review-batch.ts` makes a local `ReviewBatch` authoritative until `ReviewSubmissionService` creates a pending review at publication time.
- `src/services/review-submission-service.ts` already performs a safe create-pending → persist receipt → submit sequence, but cannot import or incrementally update remote pending reviews.
- `src/adapters/github/github-adapter.ts` can create and submit a pending review, but `getPullRequestPublishedFeedback` intentionally omits unsubmitted reviews and the writer has no pending-review read/add-thread/discard operations.
- `ReviewWorkbenchFlow` creates a `DraftSlot`, but `ReviewWorkbench` permanently hides `data-review-workbench-draft-dock`.
- The current direct composer uses `InlineConversationService` to publish immediately. It is protected by the loopback capability, `ReviewWriteGate.requireFresh()`, exact-head validation, and typed results.
- Current ADRs require a local draft, persistent dock, and local carry-forward across revisions. ADR-0014 must supersede those decisions only for Review drafting.

## Goals

- Make one viewer-owned GitHub pending review the remote source of truth for active review comments.
- Use a GitHub-style header and Finish review modal instead of the hidden bottom dock; expose Discard only after its separate validation gate passes.
- Import a pending review started on GitHub by the authenticated account.
- Offer **Comment now** or **Start a review** before a review exists; use **Add review comment** afterward.
- Keep explicit refresh, capability protection, sandboxing, freshness, exact-head validation, confirmation, and unknown-outcome recovery.
- Let mapped Findings and explicit Analysis completion actions use the same pending-review owner.

## Non-Goals

- A local mirror, offline queue, or two-way sync for a remote pending review.
- Automatic adoption, submission, discard, or mutation of another reviewer’s pending review.
- Polling, webhooks, or implicit refresh.
- A compatibility layer that maintains both `ReviewBatch` and a remote pending review.
- Handling unmapped/general Analysis feedback until the validation spike proves an empty pending review can exist without the final summary, or a separate product decision supplies a source of truth.
- Reply/Resolve/Unresolve pending-review behavior unless the spike confirms it.

## Invariants

1. The renderer never invokes GitHub; it calls only capability-protected loopback routes.
2. A remote pending review is importable only when its PR and author match the represented PR and `resolveAuthenticatedAccount()` result.
3. An incomplete pending-review read is `Unavailable`, never `None`.
4. Starting or adding a pending inline comment requires an open, fresh Review, represented patch/hash, valid full same-side anchor, and final GitHub head match.
5. Submit and discard require an explicit user action. Discard additionally requires destructive confirmation.
6. Before any create, add, submit, or discard remote write, persist a typed operation intent. A timeout, lost response, or failed post-write persistence moves the state to `OutcomeUnknown`; no automatic retry is allowed.
7. Only initial Review open and explicit Refresh replace the represented GitHub snapshot. A user-initiated recovery read (`Check GitHub again`) may reconcile the narrow pending-review owner but must not silently replace that broader snapshot. After Refresh, new coordinate writes require the new head.
8. Whether an existing remote pending review can be submitted or discarded after a head change is a validation-spike result. Until it is proved, the UI must preserve recovery evidence and block the unsupported action rather than claiming GitHub permits it.
9. The product owner approved **discard** for every persisted legacy `batchContent` class, including ordinary, pending, in-flight, and unknown records. The migration may remove local evidence only through its tested path, without a remote write, automatic retry, local fallback, or assumption that a GitHub outcome was absent.
10. The final summary is modal-local and enters a remote command only at Submit. `ViewerPendingReview` has no editable local summary field; the behavior of an imported remote review that already has a body is an open product/spike question.
11. Comment bodies, raw GitHub output, credentials, repository paths, and stack traces do not enter logs, diagnostics, toasts, or protocol failures.

## Design Constraints

- Use existing Valibot strict object parsing in `src/main/local-api.ts` and existing ID parsers in `src/domain/ids.ts`.
- Reuse the existing GitHub adapter and `CommandRunner`; GraphQL/REST response shape stays in `src/adapters/github/github-adapter.ts`.
- Model legal lifecycle states with tagged unions. Persist only parsed values and durable recovery evidence.
- Keep one keyed pending-review operation owner per Review/session. Do not overlap mutations against the same remote pending review.
- Use existing Base UI/shadcn `Dialog`, `AlertDialog`, `Button`, `Badge`, `Textarea`, and `Select`; do not add a UI dependency or a second dialog inside another dialog.

## Alternatives Considered

### Option 1: Restore the local Review draft dock

Keep `ReviewBatch` local, reveal the dock, and retain current two-step publication.

- **State:** local batch is authoritative; GitHub pending review exists only during final publish.
- **Seams:** current `ReviewBatchController` and `ReviewSubmissionService` continue unchanged.
- **Tradeoff:** lowest implementation risk, but conflicts with the selected GitHub-first interaction and cannot carry a pending review started on GitHub into Patchdesk.

Rejected by product decision.

### Option 2: Mirror local draft edits to GitHub pending comments

Keep `ReviewBatch`, create a remote pending review on the first local item, and synchronize each local edit.

- **State:** local and remote copies, remote identity per local item, synchronization and divergence states.
- **Seams:** a synchronizer must own duplicate prevention, external edits, orphan cleanup, stale-anchor migration, and retry recovery.
- **Tradeoff:** supports local editing but adds two authorities and makes uncertain writes materially harder to recover.

Rejected. It recreates the hidden-draft split the change removes.

### Option 3: Remote pending review is the authoritative draft

Read, create, append, submit, and discard the viewer’s pending review through one service. The UI projects that remote state; it does not maintain an editable local copy.

- **State:** `None`, `Pending`, and persisted in-flight/unknown operation states.
- **Seams:** pending-review domain/service, GitHub adapter, protected loopback command route, renderer projection/modal.
- **Tradeoff:** requires the validation spike and deliberate recovery logic, but matches GitHub and gives one authority.

## Recommendation

Use Option 3. The app has one remote pending-review owner, one authoritative reader/writer adapter, and one workbench projection. Existing immediate-comment support remains only as the explicitly selected **Comment now** branch. Existing reply and thread-state mutations remain separate until the validation spike proves that GitHub attaches them to the pending review as expected.

## Proposed Design

### Domain Model and Types

Add parsed GitHub review IDs rather than passing arbitrary strings through services:

```ts
export type GitHubReviewRestId = Brand<string, "GitHubReviewRestId">;
export type GitHubReviewNodeId = Brand<string, "GitHubReviewNodeId">;

export type PendingReviewAnchor = {
  readonly path: RepoRelativePath;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
};

export type PendingReviewComment = {
  readonly reviewCommentId: GitHubReviewCommentId;
  readonly threadId: GitHubThreadId;
  readonly body: string;
  readonly anchor: PendingReviewAnchor;
  readonly createdAt: IsoTimestamp;
};

export type ViewerPendingReview = {
  readonly restId: GitHubReviewRestId;
  readonly nodeId: GitHubReviewNodeId;
  readonly author: GitHubLogin;
  readonly pr: PullRequestRef;
  readonly headSha: GitSha;
  readonly comments: ReadonlyArray<PendingReviewComment>;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};
```

The `GitHubReviewCommentId` and `GitHubLogin` parsers are added to `src/domain/ids.ts` only if the spike proves their respective wire values. A pending read cannot omit its review identity, PR identity, author, head SHA, or complete comment list.

```ts
export type PendingReviewOperation =
  | { readonly _tag: "Start"; readonly requestId: PendingReviewRequestId }
  | {
      readonly _tag: "AddThread";
      readonly requestId: PendingReviewRequestId;
      readonly reviewId: GitHubReviewNodeId;
      readonly anchor: PendingReviewAnchor;
    }
  | {
      readonly _tag: "Submit";
      readonly requestId: PendingReviewRequestId;
      readonly reviewId: GitHubReviewRestId;
      readonly event: GitHubReviewEvent;
    }
  | {
      readonly _tag: "Discard";
      readonly requestId: PendingReviewRequestId;
      readonly reviewId: GitHubReviewRestId;
    };

export type PendingReviewState =
  | { readonly _tag: "None" }
  | { readonly _tag: "Pending"; readonly review: ViewerPendingReview }
  | {
      readonly _tag: "WriteInFlight";
      readonly review: ViewerPendingReview | undefined;
      readonly operation: PendingReviewOperation;
      readonly startedAt: IsoTimestamp;
    }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly review: ViewerPendingReview | undefined;
      readonly operation: PendingReviewOperation;
      readonly startedAt: IsoTimestamp;
    };
```

`WriteInFlight` and `OutcomeUnknown` are durable state, not merely button state. A renderer-only optimistic row may identify a pending command by `PendingReviewRequestId`, but it is never treated as a thread/comment ID.

### Types, Interfaces, and APIs

The adapter is the only GitHub API boundary. `fbb91b4` proves the reader, Start, append, and Submit request/response shapes below; `dbacd62` proves normal-response Discard DELETE and bounded absence read-back. The product owner accepts an unvalidated timeout/lost-response Discard path only as `OutcomeUnknown` with no automatic retry, locked conflicting controls, and explicit Check GitHub again reconciliation.

```ts
export type PendingReviewRead =
  | { readonly _tag: "None" }
  | { readonly _tag: "Pending"; readonly review: ViewerPendingReview }
  | { readonly _tag: "Unavailable" };

export type PendingReviewWriteFailure =
  | { readonly _tag: "NotFresh" }
  | { readonly _tag: "HeadChanged"; readonly currentHeadSha: GitSha }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "PermissionDenied" }
  | { readonly _tag: "Rejected" }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "OutcomeUnknown" };

export interface GitHubPendingReviewGateway {
  getViewerPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: GitHubLogin;
  }): Promise<Result<PendingReviewRead, GitHubReadFailure>>;

  startPendingReviewWithThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<ViewerPendingReview, GitHubWriteFailure>>;

  addPendingReviewThread(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly reviewId: GitHubReviewNodeId;
    readonly anchor: PendingReviewAnchor;
    readonly body: string;
  }): Promise<Result<PendingReviewComment, GitHubWriteFailure>>;

  submitPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
    readonly event: GitHubReviewEvent;
    readonly summaryBody: string;
  }): Promise<Result<{ readonly reviewId: GitHubReviewRestId }, GitHubWriteFailure>>;

  discardPendingReview(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly reviewId: GitHubReviewRestId;
  }): Promise<Result<void, GitHubWriteFailure>>;
}
```

The pending-review service resolves the authenticated account through the existing main-process reader, then passes that typed identity to `getViewerPendingReview()`. The adapter validates the remote PR and author against that input. It returns `Unavailable` for pagination, incomplete comments, missing identity proof, malformed data, or a filtered foreign result rather than granting a false absence. It may return `None` only when the spike-proven bounded query establishes that no viewer-owned pending review exists.

The service owns lifecycle, persistence, and gates:

```ts
export type StartPendingReviewInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expected: ReviewWriteExpectation;
  readonly anchor: PendingReviewAnchor;
  readonly body: string;
};

export type AddPendingReviewThreadInput = StartPendingReviewInput & {
  readonly pendingReviewId: GitHubReviewNodeId;
};

export type SubmitPendingReviewInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expected: ReviewWriteExpectation;
  readonly event: GitHubReviewEvent;
  readonly summaryBody: string;
};

export type DiscardPendingReviewInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expected: ReviewWriteExpectation;
  readonly confirmation: true;
};

export interface PendingReviewService {
  reconcile(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<PendingReviewState, PendingReviewWriteFailure>>;
  start(input: StartPendingReviewInput): Promise<Result<PendingReviewState, PendingReviewWriteFailure>>;
  addThread(input: AddPendingReviewThreadInput): Promise<Result<PendingReviewState, PendingReviewWriteFailure>>;
  submit(input: SubmitPendingReviewInput): Promise<Result<PendingReviewState, PendingReviewWriteFailure>>;
  discard(input: DiscardPendingReviewInput): Promise<Result<PendingReviewState, PendingReviewWriteFailure>>;
}
```

The loopback protocol receives strict Valibot variants. `expected` is the existing session/head/patch-hash expectation, parsed into branded values before service entry.

```ts
type PendingReviewCommandDto =
  | {
      readonly _tag: "Start";
      readonly expected: ReviewWriteExpectationDto;
      readonly anchor: PendingReviewAnchorDto;
      readonly body: string;
    }
  | {
      readonly _tag: "AddThread";
      readonly expected: ReviewWriteExpectationDto;
      readonly pendingReviewId: string;
      readonly anchor: PendingReviewAnchorDto;
      readonly body: string;
    }
  | {
      readonly _tag: "Submit";
      readonly expected: ReviewWriteExpectationDto;
      readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
      readonly summaryBody: string;
    }
  | {
      readonly _tag: "Discard";
      readonly expected: ReviewWriteExpectationDto;
      readonly confirmation: true;
    };
```

The workbench response replaces `draft?: ReviewBatch` with a read projection. It may contain comment bodies because that data already crosses the existing validated Conversation/read projection; it never includes capability values, raw adapter errors, or persistence paths. `unavailable` is not `none`: it retains the last confirmed pending projection when present and otherwise disables Start/Comment now until an explicit retry can establish a safe result.

```ts
type PendingReviewProjection =
  | { readonly state: "none" }
  | {
      readonly state: "unavailable";
      readonly action: "refresh" | "check_github_again";
    }
  | {
      readonly state: "pending";
      readonly count: number;
      readonly review: {
        readonly nodeId: string;
        readonly headSha: string;
        readonly comments: ReadonlyArray<PendingReviewCommentProjection>;
      };
    }
  | {
      readonly state: "recovery_required";
      readonly action: "start" | "add_thread" | "submit" | "discard";
    };
```

### Seams, Boundaries, Adapters, and Implementations

- **`src/domain/pending-review.ts`:** parsed values, legal state transitions, operation/receipt coherence, persistence codec.
- **`src/adapters/github/github-adapter.ts`:** GraphQL/REST request construction, raw response parsing, author/PR matching, and `GitHubWriteFailure` classification.
- **`src/services/pending-review-service.ts`:** serializes one pending-review owner, calls `ReviewWriteGate`, persists intent/receipt, and invokes the adapter.
- **`src/services/review-refresh-service.ts`:** retains ownership of explicit represented-snapshot replacement, asks the pending-review service to reconcile only as part of open/refresh/recovery.
- **`src/main/local-api.ts`:** parses unknown request JSON, enforces loopback capability, and maps typed outcomes to safe HTTP responses.
- **`src/renderer/src/renderer-contracts.ts`:** parses `PendingReviewProjection` and command responses before React state uses them.
- **`ReviewWorkbenchFlow`:** owns each request promise, canonical projection replacement, ephemeral command UI, and refresh calls.
- **`ReviewWorkbench` / `FinishReviewDialog`:** render the header action, modal, explicit submit/discard confirmation, focus behavior, and no write logic.

The service never receives raw JSON. The renderer never receives the GitHub account token or a raw command failure. The GitHub adapter never decides UI labels or modal state.

## Call Stacks and Data Flow

### Current / Old Flow

```txt
Diff composer
  -> InlineConversationService.createInlineComment
  -> ReviewWriteGate + exact-head read
  -> REST POST /pulls/{number}/comments
  -> direct published comment receipt
  -> recent-write journal
  -> explicit refresh later

Analysis/Finding/local draft
  -> ReviewBatchController
  -> persisted ReviewBatch
  -> hidden ReviewDraftDock
  -> ReviewSubmissionService.createPendingReview
  -> submitPendingReview
```

The first flow publishes immediately; the second flow remains local until final publication. They are separate authorities.

### Proposed / New Flow: start or add an inline review comment

```txt
selected Diff range + body + user click
  -> renderer chooses Start or AddThread DTO
  -> POST /v1/reviews/pending-review/command (unknown JSON)
  -> parsePendingReviewCommand(strict Valibot)
  -> PendingReviewService.start | addThread(typed input)
  -> keyed Review/session serialization
  -> ReviewWriteGate.requireFresh(expected)
  -> getPullRequest() exact-head check
  -> persist WriteInFlight(operation)
  -> GitHubPendingReviewGateway.startPendingReviewWithThread | addPendingReviewThread
  -> parse remote receipt/review
  -> persist Pending(review) receipt
  -> PendingReviewProjection
  -> renderer validates projection, clears composer, shows Finish review · N
```

The header's `Start a review` action leads the maintainer to select a valid Diff range and open the inline composer. It must not create an empty remote review unless the empty-review spike gate is accepted. `Comment now` stays on the existing `InlineConversationService` route only while no viewer pending review is confirmed. It remains an explicit immediate GitHub write and cannot run through the pending-review service. Once a pending review is confirmed, the composer exposes only `Add review comment`; it must not offer an unproven fallback that publishes immediately or creates a local draft. When the pending-review read is unavailable, both new-comment branches remain disabled rather than treating unavailable as `None`.

### Proposed / New Flow: import, refresh, and finish

```txt
Initial Review open | explicit Refresh | explicit Check GitHub again
  -> resolveAuthenticatedAccount()
  -> getViewerPendingReview(profile, PR, account)
  -> adapter parses a spike-proven complete bounded result and proves author + PR
  -> PendingReviewService.reconcile()
  -> persist None | Pending | resolved recovery state
  -> ReviewWorkbenchProjection
  -> header Start a review | Finish review · N

Only initial open and explicit Refresh replace the represented GitHub snapshot. `Check GitHub again` is available only to recover a persisted uncertain pending-review operation; it reconciles that operation without implicitly refreshing conversation, checks, or the Diff.

Finish review modal + Submit
  -> strict Submit DTO
  -> PendingReviewService.submit()
  -> require represented pending review + persist WriteInFlight(Submit)
  -> final exact-head check only when required by the selected refresh policy
  -> GitHubPendingReviewGateway.submitPendingReview(summaryBody, event)
  -> persist None + submitted-feedback receipt
  -> explicit refresh replaces GitHub snapshot
```

The optional summary textarea is modal-local until Submit. Closing the modal does not claim it persisted remotely.

### Proposed / New Flow: discard

```txt
Finish review -> Discard review -> AlertDialog confirmation
  -> strict Discard DTO { confirmation: true }
  -> PendingReviewService.discard()
  -> persist WriteInFlight(Discard)
  -> discardPendingReview()
  -> persist confirmed None or OutcomeUnknown
  -> header Start a review only after a confirmed outcome

A discard receipt may update the narrow pending-review projection. It does not trigger an implicit broader GitHub refresh; an uncertain discard stays locked until explicit `Check GitHub again` reconciliation.
```

### Failure Flow

- Invalid DTO/ID/anchor: local API returns safe `invalid_input`; the service and adapter do not run.
- Stale session/head/patch: retain the displayed remote pending review, reject new coordinate writes, and offer explicit Refresh.
- Non-matching account/PR: the adapter never exposes another reviewer’s content. A foreign or unprovable result is `Unavailable`, not proof that the viewer has no pending review; a targeted mutation may return `NotFound` only after its target-specific proof fails.
- Incomplete pending read: return `Unavailable`; keep the current projection and do not render Start a review as proof that none exists.
- Rejected remote write: persist a safe rejected outcome, leave confirmed remote state unchanged, and show bounded copy.
- Timeout/lost response/persist failure: persist `OutcomeUnknown`, lock conflicting controls, show Check GitHub again/Open on GitHub, and prohibit retry until reconciliation.

### Retry, Cancellation, and Idempotency Flow

- Start, AddThread, Submit, and Discard are serialized per Review/session. Each intent has a persisted `PendingReviewRequestId` before its remote write.
- No create/add/submit/discard is retried automatically. GitHub does not document `clientMutationId` as an idempotency key.
- Reconciliation is read-only and runs only at initial open, explicit Refresh, or the maintainer's explicit `Check GitHub again` recovery action. It maps a known remote result to the stored request intent or leaves `OutcomeUnknown` locked; it does not replace the broader represented snapshot outside initial open or Refresh.
- Renderer requests are awaited/owned by `ReviewWorkbenchFlow`; no detached mutation or background refresh is introduced.
- Pass an optional caller-owned `AbortSignal` through any new service/adapter operation only if the existing local API request lifecycle exposes one. Do not add an unowned controller.

### Observability Flow

```ts
type PendingReviewLogFields = {
  readonly reviewId: ReviewId;
  readonly action: "reconcile" | "start" | "add_thread" | "submit" | "discard";
  readonly outcome: "ok" | "not_fresh" | "rejected" | "unavailable" | "unknown";
};
```

Log only this bounded metadata through the existing application log seam. Do not include remote IDs, body content, author names, URLs, command arguments, or raw API responses.

## Files to Add / Change / Delete

### Add

- `src/domain/pending-review.ts` — pending-review values, state machine, parsers, transition helpers.
- `src/services/pending-review-service.ts` — gated/persisted remote lifecycle owner.
- `src/renderer/src/components/finish-review-dialog.tsx` — controlled GitHub-style finishing UI.
- `tests/domain/pending-review.test.ts` — parser/transition behavior.
- `tests/services/pending-review-service.test.ts` — real gateway seam, recovery, serialization, and failure behavior.
- `tests/renderer/finish-review-dialog.ui.test.tsx` — dialog/focus/confirmation states.
- `docs/adr/0014-use-github-pending-reviews-for-review-drafting.md` — superseding Review-draft decision.

### Change

- `src/domain/ids.ts` — only the parsed GitHub review/comment/login IDs proven by the spike.
- `src/domain/review-session.ts` and storage adapters — add pending-review durable state only after the approved discard migration and its tests. Remove legacy batch persistence without a remote write, automatic retry, local fallback, or assertion that a GitHub-side outcome did not occur.
- `src/adapters/github/github-adapter.ts` — authenticated pending read, start, add-thread, Submit, strict response parsers, and fake-adapter support for the `fbb91b4`-proven contracts. Do not add Discard until its separate validation gate passes.
- `src/services/review-refresh-service.ts` and workbench projection — reconcile/project pending review on open/refresh/recovery.
- `src/main/local-api.ts` and `src/main/desktop-bridge.ts` — strict protected pending-review command route and safe projection.
- `src/renderer/src/renderer-contracts.ts` — pending-review response codecs.
- `src/renderer/src/flows/review-workbench-flow.tsx` — request ownership, split composer actions, pending projection, Analysis/Finding commands.
- `src/renderer/src/components/review-workbench.tsx` and `review-diff-view.tsx` — header action, modal mount, Diff action labels and pending annotation behavior.
- `src/renderer/src/flows/app-fixtures.tsx`, renderer/browser/local-API tests — fixture and observable contract migration.
- `CONTEXT.md`, task `spec.md`, and ADR references — vocabulary and supersession links. The new ADR must explicitly scope supersession to Review drafting; historical ADRs remain current until that change lands.

### Delete after the approved legacy-data discard migration

- `src/domain/review-batch.ts`
- `src/services/review-batch-controller.ts`
- `src/services/review-submission-service.ts`
- `src/services/review-write-controller.ts`
- `src/renderer/src/components/review-draft-dock.tsx`
- `src/renderer/src/components/review-batch-panel.tsx`
- `src/renderer/src/components/publication-preview-dialog.tsx`
- old `/v1/reviews/batch` and publication preview/confirm/recover routes and their test-only fixtures.

## RGR TDD Test Plan

### Slice 1: Parse and reconcile a viewer pending review

- **Red:** adapter/service behavior test supplies a complete same-PR/same-account pending review and expects `Pending`; supplies other-account, other-PR, malformed, and incomplete results and expects `Unavailable`, preserved prior state when present, and no Start/Comment-now action.
- **Green:** add the parsed domain types, fake gateway read, strict adapter parser, and `reconcile()` projection.
- **Refactor:** isolate ID/author/PR checks in the adapter; keep no GraphQL JSON outside it.

### Slice 2: Start a review with its first inline thread

- **Red:** service test proves a fresh represented range persists `WriteInFlight` before exactly one start mutation and returns `Pending`; stale/foreign/invalid input performs zero mutations.
- **Green:** add strict command parser, gate/exact-head path, intent persistence, receipt persistence, and renderer Start action.
- **Refactor:** share exact-anchor parsing with existing direct-comment validation without merging the two command services.

### Slice 3: Add a pending review comment and import GitHub-started work

- **Red:** workbench-flow test opens a viewer-owned imported review, shows Finish count, and adds one new comment; adapter test proves bounded complete thread identity.
- **Green:** add `AddThread` command, header count projection, and composer action switch.
- **Refactor:** keep transient optimistic rows separate from canonical thread IDs.

### Slice 4: Finish, submit, and discard

- **Red:** renderer/service tests prove the summary is sent only by Submit, the selected event reaches the gateway, and Discard cannot invoke a write without confirmation.
- **Green:** add `FinishReviewDialog`, submit/discard commands, in-flight modal lock, and safe final projection/feedback refresh.
- **Refactor:** extract typed finish action rendering; do not nest dialogs.

### Slice 5: Unknown outcomes and explicit refresh

- **Red:** controlled fake gateway timeout after persisted Start/Add/Submit/Discard intent locks controls; a later reconcile proves completed/absent state without a second mutation. Head-change test proves Refresh marks outdated anchors and blocks new coordinate writes.
- **Green:** add `OutcomeUnknown` transition, Check GitHub again route, explicit-refresh reconciliation, and bounded recovery UI.
- **Refactor:** centralize operation-to-recovery status mapping in the domain module.

### Slice 6: Apply approved legacy-data discard, remove local draft UI, and prove the real surface

- **Red:** migration tests cover the approved discard of Local, PendingReview, Applying, and unknown/partial-failure `batchContent`. They prove migration issues no remote write or retry and never treats local deletion as proof that the GitHub outcome was absent. Browser/renderer tests assert no hidden draft dock remains, the header action works in Files and Insights by directing a no-review maintainer to valid inline authoring without creating an empty remote review, dialog focus returns to its trigger, and 960px/1280px/1440px have no viewport overflow.
- **Green:** implement the approved discard migration; then remove dock/batch/publication components and legacy routes after all production callers migrate. The new bounded pending-review reader remains responsible for any remote-side reconciliation.
- **Refactor:** remove stale fixture paths and obsolete tests rather than retaining aliases; do not retain compatibility aliases or an undocumented local-draft fallback.

Run focused adapter/service/renderer tests after each slice, then `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run`, `pnpm build`, `pnpm run test:a11y`, and `pnpm exec playwright test`. Live Electron verification remains read-only unless the user separately authorizes the disposable-PR spike.

## Risks and Open Questions

1. **Required validation:** Can GitHub create an empty pending review without using the final summary, then append a thread? This governs unmapped/general Analysis/Finding content.
2. **Required validation:** Which bounded API selection joins a pending review to complete actionable thread/comment IDs and its author? A partial result must not look like no pending review.
3. **Required validation:** Does a reply or thread-state mutation join the active pending review, publish separately, or fail? Only proven operations join this feature.
4. **Approved data treatment:** The product owner selected discard for all legacy `batchContent` classes. The migration must be tested to remove local data without a remote write or automatic retry; a later bounded pending-review read, not local deletion, determines any GitHub-side outcome.
5. **GitHub behavior:** `dbacd62` proves pending-review DELETE semantics and normal absence read-back. The product owner accepted the unvalidated timeout/lost-response path: preserve `OutcomeUnknown`, never retry automatically, and require explicit reconciliation rather than claiming success.
6. **Refresh policy:** After a head change and explicit Refresh, new coordinate writes are blocked until they use the refreshed revision. Whether the pre-existing pending review may be submitted or discarded is unproven; preserve it for recovery and enable either action only if the spike proves the exact result.
7. **Imported summary behavior:** Confirm how a pending review started on GitHub with a pre-existing review body behaves when Patchdesk submits the modal-only final summary. This requires a product decision after the spike; do not create a second local summary field.

# Unified Review Foundation Implementation Plan (Archived)

> Completed and archived on 2026-08-03. Do not execute this plan. Use the
> current [combined repair ExecPlan](../2026-08-03-unified-review-spec-and-design-repair.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the stable Review aggregate, one renderer-safe workbench projection, conservative draft carry-forward, explicit refresh, update detection, and revision-safe commit data.

**Architecture:** A Review is stable for one profile and GitHub pull request. Immutable Review sessions remain the code-revision boundary. The stable Review record points to the current session and stores only represented remote metadata; exact patches, attempts, drafts, and remote-write evidence remain session-owned.

**Tech Stack:** TypeScript, Valibot, JSON-file storage, Hono loopback API, existing GitHub adapter and argv-array Git executor, Vitest.

## Required context

Read these files before editing:

- [Product specification](../../spec.md)
- [No-regression contract](../../research/02-research-core-no-regression-contract.md)
- [Review lifecycle ADR](../../../../../docs/adr/0005-follow-the-pull-request-lifecycle.md)
- [Explicit refresh ADR](../../../../../docs/adr/0001-manual-github-refresh.md)
- [Draft carry-forward ADR](../../../../../docs/adr/0002-preserve-review-drafts-across-revisions.md)
- `src/domain/ids.ts`
- `src/domain/review-session.ts`
- `src/domain/review-batch.ts`
- `src/domain/review-anchor.ts`
- `src/adapters/storage/review-session-store.ts`
- `src/services/review-session-preparation.ts`
- `src/services/review-workbench-projection.ts`
- `src/services/review-workbench-controller.ts`
- `src/main/local-api.ts`

## Authority and reuse constraints

- The product specification and ADRs are authoritative. No design document or screenshot may add a Foundation requirement.
- Extend the listed domain, storage, service, GitHub adapter, controller, and loopback seams before creating another owner for the same state or operation.
- Preserve current parsers, branded IDs, argv-array GitHub execution, snapshot storage, and write gates. If an existing seam cannot satisfy the specification, record the exact missing contract and update this plan before adding a parallel abstraction or dependency.

## Current architecture map

- `ReviewSession` is schema version 4. Its deterministic ID contains profile, pull request identity, head SHA, and a collision suffix.
- `ReviewSessionPreparation.prepare()` fetches the pull request, prepares immutable refs and patch artifacts, and commits one session.
- `ReviewWorkbenchProjectionService.load()` branches on `session.visibleResult` and returns `review_started` or `completed`.
- `ReviewWorkbenchController.open/load/refresh()` parses unknown API input. `refresh()` currently returns remote context without a stable Review aggregate.
- `carryForwardReviewBatch()` exact-matches fingerprints but currently returns unsafe items in `droppedItemIds`.
- `ReviewDiffSourceService` hydrates omitted context only from immutable session refs.
- `GitHubReader` can read pull-request state, comments, checks, full diff, file contents, and revision comparisons. It does not list PR commits.
- `renderer-contracts.ts` rejects local paths but still parses a `review_started | completed` variant.

## Target storage layout

```text
data/profiles/<profile-id>/
  workbenches/<review-id>/
    review.json
    remote/
      <snapshot-hash>.json
  reviews/<review-session-id>/
    session.json
    patch.diff
    prepared/
    attempts/
```

`review.json` is mutable through serialized compare-and-set operations. Each remote snapshot is immutable and content-addressed; `Review.representedRemote.snapshotHash` atomically selects the complete GitHub state shown on screen. An unreferenced candidate is safe to remove during recovery. Session directories retain the existing immutable revision evidence and recovery protocol.

## Exact domain contracts

```ts
export type ReviewId = Brand<string, "ReviewId">;

export type ReviewIdentity = {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly prNumber: PullRequestNumber;
};

export type RepresentedRemoteState = {
  readonly headSha: GitSha;
  readonly pullRequestUpdatedAt: IsoTimestamp;
  readonly snapshotHash: ContentHash;
  readonly refreshedAt: IsoTimestamp;
};

export type DetectedRemoteUpdate = {
  readonly detectedAt: IsoTimestamp;
  readonly reason: "head" | "pull_request" | "checks";
};

export type ReviewRemoteSnapshot = {
  readonly schemaVersion: 1;
  readonly reviewId: ReviewId;
  readonly headSha: GitSha;
  readonly pullRequest: PullRequestSummary;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly publishedFeedback: GitHubPublishedFeedback;
  readonly mergePolicy: MergePolicySnapshot;
  readonly refreshedAt: IsoTimestamp;
};

export type Review = {
  readonly schemaVersion: 1;
  readonly id: ReviewId;
  readonly identity: ReviewIdentity;
  readonly currentSessionId: ReviewSessionId;
  readonly currentHeadSha: GitSha;
  readonly representedRemote?: RepresentedRemoteState;
  readonly detectedUpdate?: DetectedRemoteUpdate;
  readonly status:
    | { readonly _tag: "Open" }
    | {
        readonly _tag: "Terminal";
        readonly state: "merged" | "closed";
        readonly observedAt: IsoTimestamp;
      };
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};
```

`createReviewId()` hashes the five identity fields and excludes head SHA. `parseReviewId()` accepts only the exact path-safe generated syntax.

## Exact API contracts

```ts
type OpenReviewRequest = {
  readonly profileId: string;
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

type ReviewIdentityRequest = {
  readonly profileId: string;
  readonly reviewId: string;
};

type DetectUpdatesResponse = {
  readonly updatesAvailable: boolean;
  readonly detectedAt: string;
};

type CommitDiffRequest = {
  readonly profileId: string;
  readonly reviewId: string;
  readonly commitSha: string;
};
```

- `POST /v1/reviews/open`: prepare or resume one stable Review and return the full projection.
- `POST /v1/reviews/load`: load by `ReviewIdentityRequest` without GitHub reads.
- `POST /v1/reviews/detect-updates`: perform a lightweight GitHub read and return only `DetectUpdatesResponse`.
- `POST /v1/reviews/refresh`: fetch authoritative remote state, atomically advance the Review when needed, and return the full projection.
- `POST /v1/reviews/commit-diff`: return one bounded commit-specific patch for a commit verified as belonging to the current immutable session.

Every route remains behind the existing origin and capability middleware. No response contains a local path, token, command argv, provider event, or raw diagnostic.

## Task 1: Add Review identity and strict storage

**Files:**

- Create: `src/domain/review.ts`
- Create: `src/adapters/storage/review-store.ts`
- Modify: `src/domain/ids.ts`
- Modify: `src/adapters/storage/patchdesk-paths.ts`
- Create: `tests/domain/review.test.ts`
- Create: `tests/storage/review-store.test.ts`

**Produces:** `ReviewId`, `Review`, pure transitions, and `ReviewStore`.

- [ ] Write failing tests using these concrete fixtures:

```ts
const identity = {
  profileId: must(parseWorkspaceProfileId("cfw")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
const firstSha = must(parseGitSha("1".repeat(40)));
const secondSha = must(parseGitSha("2".repeat(40)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const later = must(parseIsoTimestamp("2026-08-01T00:01:00.000Z"));
```

Prove stable ID across heads, identity mismatch rejection, terminal immutability, malformed stored data rejection, cross-profile path rejection, list ordering by `updatedAt`, and atomic round-trip.

- [ ] Run: `pnpm test -- --run tests/domain/review.test.ts tests/storage/review-store.test.ts`

Expected: FAIL because the domain and store do not exist.

- [ ] Implement these pure functions:

```ts
createReview(input: {
  readonly identity: ReviewIdentity;
  readonly currentSessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly createdAt: IsoTimestamp;
}): Review;

moveReviewToSession(
  review: Review,
  input: {
    readonly sessionId: ReviewSessionId;
    readonly headSha: GitSha;
    readonly representedRemote: RepresentedRemoteState;
    readonly updatedAt: IsoTimestamp;
  },
): Result<Review, { readonly _tag: "ReviewTerminal" }>;

markReviewTerminal(
  review: Review,
  state: "merged" | "closed",
  observedAt: IsoTimestamp,
): Review;

markDetectedUpdate(
  review: Review,
  update: DetectedRemoteUpdate,
  updatedAt: IsoTimestamp,
): Review;
```

- [ ] Implement `ReviewStore.load/save/list()` using `readJsonFile()` and `writeJsonFileAtomically()`. Acquire a per-Review promise lock before compare-and-set mutations.

- [ ] Run the focused tests again.

Expected: PASS.

- [ ] Commit:

```bash
git add src/domain/ids.ts src/domain/review.ts src/adapters/storage/patchdesk-paths.ts src/adapters/storage/review-store.ts tests/domain/review.test.ts tests/storage/review-store.test.ts
git commit -m "feat: add stable review aggregate"
```

## Task 2: Make draft carry-forward total

**Files:**

- Modify: `src/domain/review-batch.ts`
- Modify: `src/domain/review-anchor.ts`
- Modify: `src/adapters/storage/review-session-store.ts`
- Modify: `src/services/review-submission-service.ts`
- Modify: `tests/domain/review-anchor.test.ts`
- Modify: `tests/services/review-submission-service.test.ts`

**Produces:** no-drop draft carry-forward and a persisted Needs attention state consumed by the feedback plan.

- [ ] Add the exact attention contract:

```ts
export type ReviewAnchorAttention = {
  readonly reason: "missing" | "ambiguous" | "fingerprint_missing";
  readonly originalAnchor: ReviewAnchor;
  readonly originalFingerprint?: ReviewAnchorFingerprint;
};
```

For `InlineComment`, require `attention` exactly when `postability === "needs_attention"`.

- [ ] Replace `droppedItemIds` tests with cases for exact remap, ambiguous remap, missing match, missing fingerprint, thread actions, body preservation, inclusion preservation, and provenance preservation.

```ts
expect(carryForwardReviewBatch(input)).toMatchObject({
  attentionItemIds: [unsafeItem.id],
  batch: {
    summaryBody: input.source.summaryBody,
    suggestedEvent: input.source.suggestedEvent,
    items: expect.arrayContaining([
      expect.objectContaining({
        id: unsafeItem.id,
        postability: "needs_attention",
      }),
    ]),
  },
});
```

- [ ] Run: `pnpm test -- --run tests/domain/review-anchor.test.ts tests/services/review-submission-service.test.ts`

Expected: FAIL because unsafe comments are currently dropped.

- [ ] Change `carryForwardReviewBatch()` to return:

```ts
type CarryForwardReviewBatchResult = {
  readonly batch: ReviewBatch;
  readonly attentionItemIds: ReadonlyArray<LocalReviewItemId>;
};
```

Keep every source item. Only an exact unique match receives a new anchor/fingerprint and `postable`.

- [ ] Reject included Needs attention items in `planBatchOperations()` before any GitHub writer is invoked.

- [ ] Run focused tests again.

Expected: PASS.

- [ ] Commit:

```bash
git add src/domain/review-batch.ts src/domain/review-anchor.ts src/adapters/storage/review-session-store.ts src/services/review-submission-service.ts tests/domain/review-anchor.test.ts tests/services/review-submission-service.test.ts
git commit -m "feat: preserve every review draft item"
```

## Task 3: Emit one Review projection

**Files:**

- Create: `src/domain/insight.ts`
- Modify: `src/domain/github-context.ts`
- Modify: `src/services/review-workbench-projection.ts`
- Modify: `src/services/review-workbench-controller.ts`
- Modify: `src/renderer/src/renderer-contracts.ts`
- Modify: `src/renderer/src/renderer-models.ts`
- Modify: `tests/services/review-workbench-projection.test.ts`
- Create: `tests/renderer/renderer-contracts.test.ts`

**Produces:** the cross-plan `ReviewWorkbenchProjection` contract.

- [ ] Define the shared Insight envelope:

```ts
export type InsightStatus =
  "not_generated" | "running" | "current" | "outdated" | "failed";

export type InsightProjection<T> = {
  readonly status: InsightStatus;
  readonly retained?: {
    readonly sessionId: ReviewSessionId;
    readonly headSha: GitSha;
    readonly generatedAt: IsoTimestamp;
    readonly value: T;
  };
  readonly activeRun?: {
    readonly sessionId: ReviewSessionId;
    readonly startedAt: IsoTimestamp;
  };
  readonly replacementFailure?: {
    readonly incidentId?: string;
    readonly retryable: boolean;
  };
};
```

- [ ] Define `PullRequestCommit` and `GitHubPublishedFeedback` in `github-context.ts`. Published feedback contains review records and review comments with explicit `canEdit`, `canDelete`, and `canDismiss` fields; the foundation projects empty arrays until the feedback plan adds GitHub reads.

- [ ] Replace both projection types with this single envelope:

```ts
export type ReviewWorkbenchProjection = {
  readonly state: "review";
  readonly review: {
    readonly id: ReviewId;
    readonly status: "open" | "merged" | "closed";
  };
  readonly session: WorkbenchSessionProjection;
  readonly revision: {
    readonly reviewedHeadSha: GitSha;
    readonly currentHeadSha?: GitSha;
    readonly freshness:
      "fresh" | "updates_available" | "unavailable" | "not_refreshed";
    readonly refreshedAt: IsoTimestamp;
  };
  readonly fullPatch?: string;
  readonly pullRequest?: PullRequestSummary;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly insights: {
    readonly analysis: InsightProjection<ReviewResult>;
    readonly walkthrough: InsightProjection<NarrativeWalkthrough>;
  };
  readonly draft?: ReviewBatch;
  readonly publishedFeedback: GitHubPublishedFeedback;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly mergeReadiness: MergeReadiness;
  readonly recoveryView?: ReviewRecoveryView;
};
```

- [ ] Add a projection matrix for no Analysis, running, current, outdated, failed replacement with retained result, terminal Review, local-only load, and unavailable GitHub context.

- [ ] Replace `workbenchProjectionSchema` with one strict object and rejection tests for `patchPath`, `worktree`, `contextPath`, provider events, prompt text, and raw error detail.

- [ ] Run: `pnpm test -- --run tests/services/review-workbench-projection.test.ts tests/renderer/renderer-contracts.test.ts`

Expected: PASS with no `review_started | completed` response.

- [ ] Commit:

```bash
git add src/domain/insight.ts src/domain/github-context.ts src/services/review-workbench-projection.ts src/services/review-workbench-controller.ts src/renderer/src/renderer-contracts.ts src/renderer/src/renderer-models.ts tests/services/review-workbench-projection.test.ts tests/renderer/renderer-contracts.test.ts
git commit -m "refactor: expose one review projection"
```

## Task 4: Separate detection from explicit refresh

**Files:**

- Create: `src/services/review-refresh-service.ts`
- Create: `src/services/review-write-gate.ts`
- Create: `src/adapters/storage/review-remote-store.ts`
- Modify: `src/services/review-workbench-controller.ts`
- Modify: `src/main/local-api.ts`
- Create: `tests/services/review-refresh-service.test.ts`
- Create: `tests/services/review-write-gate.test.ts`
- Create: `tests/storage/review-remote-store.test.ts`
- Modify: `tests/local-api-auth.test.ts`

**Produces:** detection that changes only a durable freshness marker, a complete represented remote snapshot changed only by explicit refresh, a shared write gate, and serialized atomic Review advancement.

- [ ] Use `FakeGitHubAdapter` fixtures with represented head `1`. Return remote head `2`, newer PR `updatedAt`, and changed checks for detection tests.

- [ ] Prove `detect()` does not change the current session, referenced remote snapshot, or `representedRemote`. It may save only `Review.detectedUpdate`, and returns:

```ts
{ updatesAvailable: true, detectedAt: "2026-08-01T00:02:00.000Z" }
```

- [ ] Detect a changed head, newer pull-request `updatedAt`, or changed canonical checks hash. Elapsed time alone never sets `detectedUpdate`. Do not claim that this bounded detector observes every remote change.

- [ ] Implement `ReviewRemoteStore.load/saveCandidate()` with strict parsing and content-addressed atomic JSON writes. Compute `snapshotHash` from canonical JSON; exclude URLs from the checks portion of the hash. Loading always starts from the hash stored in `Review.representedRemote`.

- [ ] Implement `ReviewWriteGate.requireFresh(profileId, reviewId)`. It requires a represented snapshot, no `detectedUpdate`, matching Review/session/head identity, and no terminal state. Publication, Published feedback mutation, thread mutation, and merge services in later plans must call this gate before their own exact-head recheck.

- [ ] Implement `refresh()` under a per-Review lock:

1. Load Review, profile, and current session.
2. Fetch PR, comments, checks, merge policy, and every remote field needed by the projection.
3. Save the complete snapshot candidate under its content hash; if the head matches, atomically update `Review.representedRemote` to that hash, clear `detectedUpdate`, and return the selected projection.
4. If the head differs, call `ReviewSessionPreparation.prepare()` with `previousSessionId`.
5. Carry the entire draft into the new session.
6. Save the new session before moving `Review.currentSessionId`.
7. If any step before the Review save fails, leave the old Review pointer authoritative. Recovery may remove an unreferenced content-addressed candidate only after proving no Review points to it.
8. Mark merged/closed only from the authoritative refreshed PR.

- [ ] Add strict route schemas for `open`, `load`, `detect-updates`, and `refresh`. Map invalid input to 400, missing Review/profile to 404, head races to 409, and GitHub/storage unavailability to 503.

- [ ] Run: `pnpm test -- --run tests/services/review-refresh-service.test.ts tests/services/review-write-gate.test.ts tests/storage/review-remote-store.test.ts tests/local-api-auth.test.ts`

Expected: PASS for marker-only detection, elapsed-time non-detection, write gating, same-head refresh, new-head refresh, ambiguous anchors, atomic failure, terminal state, origin rejection, and capability rejection.

- [ ] Commit:

```bash
git add src/services/review-refresh-service.ts src/services/review-write-gate.ts src/adapters/storage/review-remote-store.ts src/services/review-workbench-controller.ts src/main/local-api.ts tests/services/review-refresh-service.test.ts tests/services/review-write-gate.test.ts tests/storage/review-remote-store.test.ts tests/local-api-auth.test.ts
git commit -m "feat: add explicit review refresh"
```

### Task 4 repair ledger (2026-08-01)

- [x] Validate the current Review session before candidate writes; fail closed on missing, identity-mismatched, or head-mismatched sessions.
- [x] Keep `MergeOutcome.open` Reviews open; terminalize only merged or closed-unmerged outcomes.
- [x] Apply the represented snapshot/current Review head guard to stable open projection.
- [x] Migrate the seven reviewer-listed tests to canonical `state: "review"`, `revision`, stable `reviewId`, and atomic refresh responses.
- [x] Focused Task 4, affected renderer, full suite, lint, typecheck, build, diff, and alias grep gates passed; no unhandled rejection and no staged files.
- [x] Replace the renderer's prepared/completed response-shape adapter with direct `WorkbenchResponse` rendering and stable Review refresh coverage.
- Remaining blocker: none for Task 4 review blockers; publication, feedback/thread mutation, merge lifecycle, and the later unified-workbench slots remain assigned to later plans.

## Task 5: Add revision-safe commit data

**Files:**

- Modify: `src/adapters/github/github-adapter.ts`
- Create: `src/services/review-commit-service.ts`
- Modify: `src/services/review-refresh-service.ts`
- Modify: `src/main/local-api.ts`
- Modify: `src/renderer/src/renderer-contracts.ts`
- Modify: `tests/adapters/github-adapter.test.ts`
- Create: `tests/services/review-commit-service.test.ts`

**Produces:** complete PR commit list and bounded current-session commit patch.

- [ ] Extend `GitHubReader`:

```ts
getPullRequestCommits(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly pr: PullRequestRef;
}): Promise<Result<ReadonlyArray<PullRequestCommit>, GitHubReadFailure>>;
```

- [ ] Use `gh api --paginate --slurp repos/{owner}/{repo}/pulls/{number}/commits?per_page=100`. Flatten and strictly parse at most 250 entries. Reject a response that reaches 250 while GitHub indicates more data; never present a partial list as complete. GitHub documents the PR-commit endpoint as capped at 250: [List commits on a pull request](https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request).

- [ ] Sort newest first in Patchdesk and mark exactly the session head SHA as `isHead: true`.

- [ ] Add the complete parsed commit list to every explicit-refresh `ReviewRemoteSnapshot`. A local Review load reads that stored list without GitHub access; detection never changes it.

- [ ] In `ReviewCommitService.diff()`, load the current session from the stable Review, verify membership, and use immutable managed refs to produce one patch. Return:

```ts
type CommitDiffProjection = {
  readonly commit: PullRequestCommit;
  readonly position: number;
  readonly total: number;
  readonly patch: string;
};
```

- [ ] Reject foreign SHA, stale Review/session mismatch, binary-only unavailable diff, and output beyond the prepared patch byte cap.

- [ ] Add the strict `commit-diff` route and renderer parser.

- [ ] Run: `pnpm test -- --run tests/adapters/github-adapter.test.ts tests/services/review-commit-service.test.ts tests/local-api-auth.test.ts`

Expected: PASS.

- [ ] Commit:

```bash
git add src/adapters/github/github-adapter.ts src/services/review-commit-service.ts src/services/review-refresh-service.ts src/main/local-api.ts src/renderer/src/renderer-contracts.ts tests/adapters/github-adapter.test.ts tests/services/review-commit-service.test.ts tests/local-api-auth.test.ts
git commit -m "feat: expose review commit diffs"
```

## Task 6: Foundation verification

- [ ] Run: `pnpm lint`
- [ ] Run: `pnpm typecheck`
- [ ] Run: `pnpm test -- --run tests/domain/review.test.ts tests/storage/review-store.test.ts tests/storage/review-remote-store.test.ts tests/domain/review-anchor.test.ts tests/services/review-workbench-projection.test.ts tests/services/review-refresh-service.test.ts tests/services/review-write-gate.test.ts tests/services/review-commit-service.test.ts tests/adapters/github-adapter.test.ts tests/local-api-auth.test.ts`
- [ ] Run: `pnpm build`
- [ ] Run: `git diff --check`
- [ ] Confirm `rg -n 'review_started|CompletedWorkbenchProjection|PreparedWorkbenchProjection' src/services src/renderer/src/renderer-contracts.ts` returns no projection branch.

## Handoff to later plans

- UI plan consumes `ReviewWorkbenchProjection` and the five Review routes.
- Insights plan owns durable `InsightProjection` population and model-run APIs.
- Feedback plan consumes Needs attention draft items, adds repair commands, publication, Published feedback, merge policy, and final migration.

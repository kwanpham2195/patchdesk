import {
  createReviewSessionId,
  type AbsolutePath,
  type ContentHash,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type GitSha,
  type IsoTimestamp,
  type PullRequestNumber,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import type { PullRequestSnapshot } from "./github-context";
import type { DirectSummaryReviewState } from "./direct-summary-review";
import type {
  FindingReviewReceipt,
  PendingReviewState,
} from "./pending-review";

/** Immutable local artifacts and current durable GitHub-write evidence for one pinned revision. */
export type ReviewSession = {
  readonly schemaVersion: 5;
  readonly id: ReviewSessionId;
  readonly key: ReviewSessionKey;
  readonly pr: PullRequestSnapshot;
  readonly prContext?: {
    readonly title: string;
    readonly description?: string;
    readonly author: string;
    readonly headBranch: string;
    readonly baseBranch: string;
  };
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash?: ContentHash;
  readonly worktree: ReviewWorktreeRef;
  readonly pendingReview?: PendingReviewState;
  readonly findingReviewReceipts?: ReadonlyArray<FindingReviewReceipt>;
  readonly directSummaryReview?: DirectSummaryReviewState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type ReviewSessionKey = {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly prNumber: PullRequestNumber;
  readonly headSha: GitSha;
};

export type ReviewWorktreeRef = {
  readonly path: AbsolutePath;
  readonly headSha: GitSha;
};

/** Mutable draft of `ReviewSession`, built in statements so each optional
 * field is added only when it has a value. */
type MutableReviewSession = {
  -readonly [K in keyof ReviewSession]: ReviewSession[K];
};

/** Constructs a deterministic session without filesystem or GitHub effects. */
export function createReviewSession(input: {
  readonly key: ReviewSessionKey;
  readonly pr: PullRequestSnapshot;
  readonly prContext?: ReviewSession["prContext"];
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash?: ContentHash;
  readonly worktree: ReviewWorktreeRef;
  readonly createdAt: IsoTimestamp;
}): ReviewSession {
  const session: MutableReviewSession = {
    schemaVersion: 5,
    id: createReviewSessionId(input.key),
    key: input.key,
    pr: input.pr,
    patchPath: input.patchPath,
    worktree: input.worktree,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  if (input.prContext !== undefined) session.prContext = input.prContext;
  if (input.canonicalPatchHash !== undefined)
    session.canonicalPatchHash = input.canonicalPatchHash;
  return session;
}

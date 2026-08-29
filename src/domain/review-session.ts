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
import { definedProps } from "./defined-props";
import type { PullRequestSnapshot } from "./github-context";
import type { DirectSummaryReviewState } from "./direct-summary-review";
import type {
  FindingReviewReceipt,
  PendingReviewState,
} from "./pending-review";

export type ReviewLocalCheckoutWarning =
  | "missing_local_path"
  | "local_checkout_unavailable";

/** Immutable local artifacts and current durable GitHub-write evidence for one pinned revision. */
export type ReviewSession = {
  readonly schemaVersion: 6;
  readonly id: ReviewSessionId;
  readonly key: ReviewSessionKey;
  readonly pr: PullRequestSnapshot & { readonly baseSha: GitSha };
  readonly prContext?: {
    readonly title: string;
    readonly description?: string;
    readonly author: string;
    readonly headBranch: string;
    readonly baseBranch: string;
  };
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash?: ContentHash;
  readonly localCheckoutWarning?: ReviewLocalCheckoutWarning;
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
  readonly baseSha: GitSha;
};

export type ReviewRevision = Pick<ReviewSessionKey, "headSha" | "baseSha">;

export function sameReviewRevision(
  left: ReviewRevision,
  right: ReviewRevision,
): boolean {
  return left.headSha === right.headSha && left.baseSha === right.baseSha;
}

export type ReviewWorktreeRef = {
  readonly path: AbsolutePath;
  readonly headSha: GitSha;
};

/** Constructs a deterministic session without filesystem or GitHub effects. */
export function createReviewSession(input: {
  readonly key: ReviewSessionKey;
  readonly pr: PullRequestSnapshot & { readonly baseSha: GitSha };
  readonly prContext?: ReviewSession["prContext"];
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash?: ContentHash;
  readonly localCheckoutWarning?: ReviewLocalCheckoutWarning;
  readonly worktree: ReviewWorktreeRef;
  readonly createdAt: IsoTimestamp;
}): ReviewSession {
  return {
    schemaVersion: 6,
    id: createReviewSessionId(input.key),
    key: input.key,
    pr: input.pr,
    patchPath: input.patchPath,
    worktree: input.worktree,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    ...definedProps({
      prContext: input.prContext,
      canonicalPatchHash: input.canonicalPatchHash,
      localCheckoutWarning: input.localCheckoutWarning,
    }),
  };
}

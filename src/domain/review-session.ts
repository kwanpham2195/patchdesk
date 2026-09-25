import {
  createReviewSessionId,
  type AbsolutePath,
  type ContentHash,
  type GitSha,
  type IsoTimestamp,
  type ReviewSessionId,
} from "./ids";
import { definedProps } from "./defined-props";
import type { ReviewIdentity } from "./review";
import type {
  LocalReviewSource,
  PullRequestReviewSource,
  ReviewSource,
} from "./review-source";
import type { PullRequestSnapshot } from "./github-context";
import type { DirectSummaryReviewState } from "./direct-summary-review";
import type {
  FindingReviewReceipt,
  PendingReviewState,
} from "./pending-review";

export type ReviewLocalCheckoutWarning =
  | "missing_local_path"
  | "local_checkout_unavailable";

/** The fields every session kind shares; the kind lives in `key.source`. */
export type ReviewSessionFields = {
  readonly schemaVersion: 6;
  readonly id: ReviewSessionId;
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash?: ContentHash;
  readonly localCheckoutWarning?: ReviewLocalCheckoutWarning;
  readonly worktree: ReviewWorktreeRef;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

/**
 * Immutable local artifacts and current durable GitHub-write evidence for one
 * pinned pull request revision. `pr`, `prContext`, and the GitHub pending
 * review state exist only on this kind (ADR 0050).
 */
export type PullRequestReviewSession = ReviewSessionFields & {
  readonly key: ReviewSessionKey<PullRequestReviewSource>;
  readonly pr: PullRequestSnapshot & { readonly baseSha: GitSha };
  readonly prContext?: {
    readonly title: string;
    readonly description?: string;
    readonly author: string;
    readonly headBranch: string;
    readonly baseBranch: string;
  };
  readonly pendingReview?: PendingReviewState;
  readonly findingReviewReceipts?: ReadonlyArray<FindingReviewReceipt>;
  readonly directSummaryReview?: DirectSummaryReviewState;
};

/** Immutable local artifacts for one pinned revision of a local Review source. */
export type LocalReviewSession = ReviewSessionFields & {
  readonly key: ReviewSessionKey<LocalReviewSource>;
};

/** The local work for one pinned revision of a Review source. */
export type ReviewSession = PullRequestReviewSession | LocalReviewSession;

/** Narrow a session to the pull request kind before any GitHub read or write. */
export function isPullRequestReviewSession(
  session: ReviewSession,
): session is PullRequestReviewSession {
  return session.key.source.kind === "pull_request";
}

/** A Review identity plus the pinned revision; the session id is derived from it. */
export type ReviewSessionKey<Source extends ReviewSource = ReviewSource> =
  ReviewIdentity<Source> & ReviewRevision;

export type ReviewRevision = {
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
};

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
  readonly key: ReviewSessionKey<PullRequestReviewSource>;
  readonly pr: PullRequestSnapshot & { readonly baseSha: GitSha };
  readonly prContext?: PullRequestReviewSession["prContext"];
  readonly patchPath: AbsolutePath;
  readonly canonicalPatchHash?: ContentHash;
  readonly localCheckoutWarning?: ReviewLocalCheckoutWarning;
  readonly worktree: ReviewWorktreeRef;
  readonly createdAt: IsoTimestamp;
}): PullRequestReviewSession {
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

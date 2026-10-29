import { definedProps } from "#src/domain/defined-props";
import {
  parseAbsolutePath,
  parsePullRequestNumber,
  type IsoTimestamp,
  type ReviewSessionId,
} from "#src/domain/ids";
import type { PendingReviewState } from "#src/domain/pending-review";
import type {
  PullRequestReviewSession,
  ReviewSessionKey,
} from "#src/domain/review-session";
import type { PullRequestReviewSource } from "#src/domain/review-source";
import { githubRepositoryKeyFixture } from "#tests/domain/repository-fixtures";

/** A storage seam can pin an opaque session ID independently of ID-derivation tests. */
export function pendingReviewSessionFixture(
  input: Pick<
    ReviewSessionKey<PullRequestReviewSource>,
    "profileId" | "headSha" | "baseSha"
  > & { readonly id: ReviewSessionId; readonly at: IsoTimestamp },
  state?: PendingReviewState,
  receipts?: PullRequestReviewSession["findingReviewReceipts"],
): PullRequestReviewSession {
  const number = parsePullRequestNumber(42);
  if (number._tag === "err") throw new Error("Invalid pull request fixture");
  const patchPath = parseAbsolutePath("/tmp/patch"),
    worktreePath = parseAbsolutePath("/tmp/worktree");
  if (patchPath._tag === "err" || worktreePath._tag === "err")
    throw new Error("Invalid session fixture path");
  const base: PullRequestReviewSession = {
    schemaVersion: 6,
    id: input.id,
    key: {
      profileId: input.profileId,
      identityKey: githubRepositoryKeyFixture(),
      source: { kind: "pull_request", prNumber: number.value },
      headSha: input.headSha,
      baseSha: input.baseSha,
    },
    pr: {
      headSha: input.headSha,
      baseSha: input.baseSha,
      isDraft: false,
      isOpen: true,
    },
    patchPath: patchPath.value,
    worktree: { path: worktreePath.value, headSha: input.headSha },
    createdAt: input.at,
    updatedAt: input.at,
  };
  return {
    ...base,
    ...definedProps({ pendingReview: state, findingReviewReceipts: receipts }),
  };
}

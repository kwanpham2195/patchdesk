import { requestJson } from "../api-client";
import {
  parseCommitDiffResponse,
  parseSinceReviewDiffResponse,
  type CommitDiffResponse,
  type SinceReviewDiffResponse,
} from "../review-diff-contracts";

export async function loadReviewCommitDiff(
  profileId: string,
  reviewId: string,
  commitSha: string,
): Promise<CommitDiffResponse> {
  const value = await requestJson("/v1/reviews/commit-diff", {
    method: "POST",
    body: { profileId, reviewId, commitSha },
  });
  const parsed = parseCommitDiffResponse(value);
  if (parsed === undefined) throw new Error("Invalid commit diff response");
  return parsed;
}

export async function loadReviewSinceReviewDiff(
  profileId: string,
  reviewId: string,
): Promise<SinceReviewDiffResponse> {
  const value = await requestJson("/v1/reviews/since-review-diff", {
    method: "POST",
    body: { profileId, reviewId },
  });
  const parsed = parseSinceReviewDiffResponse(value);
  if (parsed === undefined)
    throw new Error("Invalid since-review diff response");
  return parsed;
}

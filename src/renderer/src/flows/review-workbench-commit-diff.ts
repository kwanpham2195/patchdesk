import { requestJson } from "../api-client";
import {
  parseCommitDiffResponse,
  parseSinceLastRefreshDiffResponse,
  parseSinceReviewDiffResponse,
  type CommitDiffResponse,
  type SinceLastRefreshDiffResponse,
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

export async function loadLocalSinceLastRefreshDiff(
  profileId: string,
  reviewId: string,
  sessionId: string,
): Promise<SinceLastRefreshDiffResponse> {
  const value = await requestJson("/v1/reviews/local-since-last-refresh", {
    method: "POST",
    body: { profileId, reviewId, sessionId },
  });
  const parsed = parseSinceLastRefreshDiffResponse(value);
  if (parsed === undefined)
    throw new Error("Invalid since-last-Refresh diff response");
  return parsed;
}

import { requestJson } from "../api-client";
import {
  parseCommitDiffResponse,
  type CommitDiffResponse,
} from "../renderer-contracts";

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

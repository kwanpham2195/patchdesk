import type {
  GitHubDirectSummaryGateway,
  GitHubMergeWriter,
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";

export function isGitHubDirectSummaryGateway(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- structural capability detection on the already-constructed internal `github` adapter, not external/untrusted input; there is no earlier I/O boundary to parse at.
  value: unknown,
): value is GitHubDirectSummaryGateway {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows an internal adapter object for optional-capability `in` checks below; not external input to decode.
    typeof value === "object" &&
    value !== null &&
    "getViewerDirectSummaryReviews" in value &&
    "createDirectSummaryReview" in value
  );
}
export function isGitHubPendingReviewGateway(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- structural capability detection on the already-constructed internal `github` adapter, not external/untrusted input; there is no earlier I/O boundary to parse at.
  value: unknown,
): value is GitHubPendingReviewGateway & GitHubReader & GitHubReviewWriter {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows an internal adapter object for optional-capability `in` checks below; not external input to decode.
    typeof value === "object" &&
    value !== null &&
    "getViewerPendingReview" in value &&
    "startPendingReviewWithThread" in value &&
    "addPendingReviewThread" in value &&
    "submitPendingReview" in value &&
    "resolveAuthenticatedAccount" in value
  );
}
export function isGitHubMergeWriter(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- structural capability detection on the already-constructed internal `merger` adapter, not external/untrusted input; there is no earlier I/O boundary to parse at.
  value: unknown,
): value is GitHubMergeWriter {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows an internal adapter object for an optional-capability `in` check below; not external input to decode.
    typeof value === "object" && value !== null && "mergePullRequest" in value
  );
}

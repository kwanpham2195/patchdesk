import type { Context } from "hono";

import type { GitHubReadFailure } from "../../adapters/github/github-adapter";
import type { RepositoryLabelListing } from "../../domain/github-context";
import type { Result } from "../../domain/result";
import type {
  AssigneeListFailure,
  AssigneeListOutcome,
} from "../../services/assignee-service";
import type {
  LabelListFailure,
  LabelListOutcome,
} from "../../services/label-service";
import type {
  ReviewerListFailure,
  ReviewerListOutcome,
} from "../../services/reviewer-service";

/**
 * Shapes a repository-wide label read directly from `GitHubReadFailure` for
 * `GET /v1/inbox/labels` — this route reads through
 * `github.listRepositoryLabels` directly rather than a service, so there is
 * no review-resolution half to fail outright, unlike `labelListResponse`
 * below. `permission` is omitted: the inbox's label filter is read-only and
 * never resolves it.
 */
export function repositoryLabelListResponse(
  context: Context,
  result: Result<RepositoryLabelListing, GitHubReadFailure>,
): Response {
  if (result._tag === "ok")
    return context.json({
      state: "ready",
      labels: result.value.labels,
      totalCount: result.value.totalCount,
    });
  const failure = result.error;
  if (failure._tag === "GitHubRateLimited") {
    const resumeAtField =
      failure.resumeAt === undefined ? {} : { resumeAt: failure.resumeAt };
    return context.json({ state: "github_rate_limited", ...resumeAtField });
  }
  if (failure._tag === "GitHubForbidden")
    return context.json({
      state: "github_forbidden",
      forbiddenReason: failure.reason,
    });
  if (failure._tag === "GitHubAuthenticationFailed")
    return context.json({ state: "github_auth" });
  return context.json({ state: "github_read" });
}

/**
 * Shapes a repository label listing the same way `GET /v1/inbox` shapes
 * per-repo failure state: a GitHub read failure (auth/rate-limit/forbidden)
 * is data in a 200 response, not an HTTP error, so its specific reason
 * survives to the renderer. Only the review-resolution half — the review
 * itself missing or refused — becomes an HTTP error, mirroring
 * `labelResponse`'s write-path status mapping.
 */
export function labelListResponse(
  context: Context,
  result: Result<LabelListOutcome, LabelListFailure>,
): Response {
  if (result._tag === "err")
    return context.json(
      { error: result.error },
      result.error === "not_found" ? 404 : 409,
    );
  const outcome = result.value;
  if (outcome._tag === "ready")
    return context.json({
      state: "ready",
      labels: outcome.labels,
      totalCount: outcome.totalCount,
      permission: outcome.permission,
    });
  if (outcome._tag === "github_rate_limited") {
    const resumeAtField =
      outcome.resumeAt === undefined ? {} : { resumeAt: outcome.resumeAt };
    return context.json({ state: "github_rate_limited", ...resumeAtField });
  }
  if (outcome._tag === "github_forbidden")
    return context.json({
      state: "github_forbidden",
      forbiddenReason: outcome.reason,
    });
  return context.json({ state: outcome._tag });
}

/**
 * Shapes an assignable-user listing the same way `labelListResponse` shapes
 * a repository label listing: a GitHub read failure (auth/rate-limit/forbidden)
 * is data in a 200 response, not an HTTP error, so its specific reason
 * survives to the renderer. Only the review-resolution half — the review
 * itself missing or refused — becomes an HTTP error, mirroring
 * `assigneeResponse`'s write-path status mapping.
 */
export function assigneeListResponse(
  context: Context,
  result: Result<AssigneeListOutcome, AssigneeListFailure>,
): Response {
  if (result._tag === "err")
    return context.json(
      { error: result.error },
      result.error === "not_found" ? 404 : 409,
    );
  const outcome = result.value;
  if (outcome._tag === "ready")
    return context.json({
      state: "ready",
      users: outcome.users,
      totalCount: outcome.totalCount,
      permission: outcome.permission,
    });
  if (outcome._tag === "github_rate_limited") {
    const resumeAtField =
      outcome.resumeAt === undefined ? {} : { resumeAt: outcome.resumeAt };
    return context.json({ state: "github_rate_limited", ...resumeAtField });
  }
  if (outcome._tag === "github_forbidden")
    return context.json({
      state: "github_forbidden",
      forbiddenReason: outcome.reason,
    });
  return context.json({ state: outcome._tag });
}

/**
 * Shapes a reviewer listing the same way `assigneeListResponse` shapes an
 * assignable-user listing: a GitHub read failure (auth/rate-limit/forbidden)
 * is data in a 200 response, not an HTTP error, so its specific reason
 * survives to the renderer. Only the review-resolution half — the review
 * itself missing or refused — becomes an HTTP error, mirroring
 * `reviewerResponse`'s write-path status mapping.
 */
export function reviewerListResponse(
  context: Context,
  result: Result<ReviewerListOutcome, ReviewerListFailure>,
): Response {
  if (result._tag === "err")
    return context.json(
      { error: result.error },
      result.error === "not_found" ? 404 : 409,
    );
  const outcome = result.value;
  if (outcome._tag === "ready")
    return context.json({
      state: "ready",
      reviewers: outcome.reviewers,
      suggested: outcome.suggested,
      candidates: outcome.candidates,
      candidatesTotalCount: outcome.candidatesTotalCount,
      permission: outcome.permission,
    });
  if (outcome._tag === "github_rate_limited") {
    const resumeAtField =
      outcome.resumeAt === undefined ? {} : { resumeAt: outcome.resumeAt };
    return context.json({ state: "github_rate_limited", ...resumeAtField });
  }
  if (outcome._tag === "github_forbidden")
    return context.json({
      state: "github_forbidden",
      forbiddenReason: outcome.reason,
    });
  return context.json({ state: outcome._tag });
}

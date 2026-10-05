import type { Context } from "hono";

import type { GitHubReadFailure } from "../../adapters/github/github-adapter";
import type { RepositoryLabelListing } from "../../domain/github-context";
import type { Result } from "../../domain/result";
import type {
  BaseBranchListFailure,
  BaseBranchListOutcome,
} from "../../services/base-branch-service";
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
 * Shapes `GET /v1/inbox/labels` from `GitHubReadFailure`, returned directly by
 * `github.listRepositoryLabels`. Unlike `labelListResponse`, this read has no
 * review-resolution failure. The read-only inbox filter never resolves
 * `permission`, so the response omits it.
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
 * Shapes repository label listings like `GET /v1/inbox`: GitHub read failures
 * (auth/rate-limit/forbidden) stay in HTTP 200 data so their reasons reach the
 * renderer. Only missing or refused review resolution becomes an HTTP error,
 * matching `labelResponse`'s write-path status mapping.
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
 * Shapes assignable-user listings like `labelListResponse`: GitHub read
 * failures (auth/rate-limit/forbidden) stay in HTTP 200 data so their reasons
 * reach the renderer. Only missing or refused review resolution becomes an
 * HTTP error, matching `assigneeResponse`'s write-path status mapping.
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
 * Shapes reviewer listings like `assigneeListResponse`: GitHub read failures
 * (auth/rate-limit/forbidden) stay in HTTP 200 data so their reasons reach the
 * renderer. Only missing or refused review resolution becomes an HTTP error,
 * matching `reviewerResponse`'s write-path status mapping.
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

/** Shapes the base-branch picker read the way `reviewerListResponse` shapes its listing. */
export function baseBranchListResponse(
  context: Context,
  result: Result<BaseBranchListOutcome, BaseBranchListFailure>,
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
      current: outcome.current,
      branches: outcome.branches,
      branchesTotalCount: outcome.branchesTotalCount,
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

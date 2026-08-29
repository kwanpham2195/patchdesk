import { definedProps } from "../../../domain/defined-props";
import type { CheckSummary } from "../../../domain/github-context";
import type { PullRequestRef } from "../../../domain/pull-request";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { CanonicalReviewOverview } from "./pr-overview-sheet";
import type { PullRequestMetadataRail } from "./pull-request-metadata-rail";
import type { ReviewWorkbenchActions } from "./review-workbench";

/** The retained Analysis snapshot the overview reads its summary from. */
export type RetainedAnalysis =
  WorkbenchResponse["insights"]["analysis"]["retained"];

/** The revision block of the PR overview sheet. */
export function buildOverviewRevision(
  model: Pick<WorkbenchResponse, "commits" | "pullRequest" | "revision">,
): NonNullable<CanonicalReviewOverview["revision"]> {
  return {
    reviewedHeadSha: model.revision.reviewedHeadSha,
    freshness: model.revision.freshness,
    refreshedAt: model.revision.refreshedAt,
    commitCount: model.commits.length,
    ...definedProps({
      baseBranch: model.pullRequest?.baseBranch,
      headBranch: model.pullRequest?.headBranch,
      currentHeadSha: model.revision.currentHeadSha,
      fileCount: model.pullRequest?.changedFileCount,
    }),
  };
}

/** The canonical Review overview the PR overview sheet renders. */
export function buildOverview({
  model,
  repository,
  title,
  retainedAnalysis,
  overviewRevision,
  externalPullRequest,
}: {
  readonly model: WorkbenchResponse;
  readonly repository: string;
  readonly title: string;
  readonly retainedAnalysis: RetainedAnalysis;
  readonly overviewRevision: NonNullable<CanonicalReviewOverview["revision"]>;
  readonly externalPullRequest: PullRequestRef | undefined;
}): CanonicalReviewOverview {
  return {
    repository,
    prNumber: model.session.key.prNumber,
    title,
    summary:
      retainedAnalysis?.value.summary ??
      "No retained Analysis is available for this snapshot.",
    // SAFETY: the validated projection is structurally identical to the
    // domain shapes; valibot's optional fields carry an explicit undefined
    // that the strict domain types reject, so the overview adopts them at
    // this renderer seam. Runtime validation already ran on `model.checks`.
    checks: model.checks as CheckSummary,
    mergeReadiness: model.mergeReadiness,
    mergeReasons: model.mergeReasons ?? [],
    revision: overviewRevision,
    insights: {
      analysis: { status: model.insights.analysis.status },
      walkthrough: { status: model.insights.walkthrough.status },
    },
    ...definedProps({
      description: model.pullRequest?.description,
      pullRequest: externalPullRequest,
      terminalState:
        model.review.status === "open" ? undefined : model.review.status,
    }),
  };
}

/** Built here (not inside `Conversation`) because it's the model that owns
 * `model.pullRequest`/`model.revision`/`terminal` -- `Conversation` only
 * ever renders what it's handed, which keeps the rail off the Diff and
 * Insights tabs by construction rather than by a conditional inside them. */
export function buildRailProps({
  model,
  actions,
  terminal,
}: {
  readonly model: Pick<
    WorkbenchResponse,
    "pendingReview" | "pullRequest" | "revision"
  >;
  readonly actions: Pick<
    ReviewWorkbenchActions,
    "assignees" | "labels" | "reviewers"
  >;
  readonly terminal: boolean;
}): React.ComponentProps<typeof PullRequestMetadataRail> {
  return {
    labels: model.pullRequest?.labels ?? [],
    assignees: model.pullRequest?.assignees ?? [],
    requestedReviewers: model.pullRequest?.requestedReviewers ?? [],
    freshness: model.revision.freshness,
    refreshedAt: model.revision.refreshedAt,
    terminal,
    ...definedProps({
      pendingReview: model.pendingReview,
      labelActions: actions.labels,
      assigneeActions: actions.assignees,
      reviewerActions: actions.reviewers,
    }),
  };
}

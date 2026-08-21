import type { ReviewWorkbenchInitialState } from "../../components/review-workbench";
import type { WorkbenchResponse } from "../../renderer-contracts";
import {
  canonicalWorkbenchModel,
  fixtureWalkthroughRetention,
  workbenchFixtureData,
} from "./workbench-fixture-data";

export type UnifiedReviewFixtureState =
  | "files-default"
  | "files-commit-selected"
  | "updates-draft"
  | "draft-expanded"
  | "needs-attention"
  | "pr-overview"
  | "merged"
  | "closed"
  | "insights-overview"
  | "analysis-running"
  | "analysis-current"
  | "analysis-outdated"
  | "analysis-failed"
  | "analysis-replacement-running"
  | "analysis-replacement-failed"
  | "walkthrough-current"
  | "walkthrough-outdated"
  | "publication-ready"
  | "publication-publishing"
  | "publication-confirmed"
  | "publication-needs-confirmation"
  | "published-feedback-collapsed"
  | "published-feedback-expanded";

/** Build every design state from one production-shaped Review projection. */
export function unifiedReviewInitialState(
  state: UnifiedReviewFixtureState,
): ReviewWorkbenchInitialState {
  switch (state) {
    case "files-commit-selected":
      return { section: "commits", selectedCommitSha: "b".repeat(40) };
    case "insights-overview":
    case "analysis-running":
    case "analysis-failed":
      return { section: "insights" };
    case "analysis-current":
    case "analysis-outdated":
    case "analysis-replacement-running":
    case "analysis-replacement-failed":
      return { section: "insights", insightDetail: "analysis" };
    case "walkthrough-current":
      return { section: "insights", insightDetail: "walkthrough" };
    case "walkthrough-outdated":
      return { section: "insights", insightDetail: "walkthrough" };
    case "draft-expanded":
      return {
        section: "files",
        selectedPath: "src/a.ts",
        draftExpanded: true,
      };
    case "pr-overview":
      return { section: "files", selectedPath: "src/a.ts", overviewOpen: true };
    default:
      return { section: "files", selectedPath: "src/a.ts" };
  }
}

export function createUnifiedReviewFixture(
  state: UnifiedReviewFixtureState = "files-default",
): WorkbenchResponse {
  const base = canonicalWorkbenchModel(workbenchFixtureData);
  const retainedWalkthrough = fixtureWalkthroughRetention(
    base.session.id,
    base.revision.reviewedHeadSha,
  );
  const withFeedback =
    state === "published-feedback-collapsed" ||
    state === "published-feedback-expanded" ||
    state === "pr-overview" ||
    state === "merged" ||
    state === "closed";
  const analysisFailure = {
    runId: "insight-analysis-1-aaaaaaaaaaaa-review",
    category: "unexpected_failure" as const,
    model: "fixture-model",
    reasoning: "medium" as const,
    retryable: true,
  };
  let analysis: WorkbenchResponse["insights"]["analysis"];
  if (state === "analysis-running") {
    analysis = {
      status: "running",
      activeRun: {
        runId: "analysis-first-run",
        sessionId: base.session.id,
        startedAt: base.revision.refreshedAt,
      },
    };
  } else if (state === "analysis-replacement-running") {
    analysis = {
      ...base.insights.analysis,
      status: "running",
      activeRun: {
        runId: "analysis-replacement-run",
        sessionId: base.session.id,
        startedAt: base.revision.refreshedAt,
      },
    };
  } else if (state === "analysis-failed") {
    analysis = { status: "failed", replacementFailure: analysisFailure };
  } else if (
    state === "analysis-outdated" ||
    state === "analysis-replacement-failed"
  ) {
    analysis = {
      ...base.insights.analysis,
      status: state === "analysis-outdated" ? "outdated" : "failed",
    };
    // Built as a separate statement rather than a conditional spread: only
    // the replacement-failed branch of this already-narrowed state carries
    // `replacementFailure`.
    if (state === "analysis-replacement-failed") {
      analysis = {
        ...analysis,
        replacementFailure: { ...analysisFailure },
      };
    }
  } else if (state === "analysis-current") {
    analysis = { ...base.insights.analysis, status: "current" };
  } else {
    analysis = base.insights.analysis;
  }
  const walkthrough =
    state === "walkthrough-current" || state === "walkthrough-outdated"
      ? {
          status:
            state === "walkthrough-outdated"
              ? ("outdated" as const)
              : ("current" as const),
          retained: retainedWalkthrough,
          progress: { reviewedSectionIds: [], supportReviewed: false },
        }
      : base.insights.walkthrough;
  return {
    ...base,
    review:
      state === "merged"
        ? { id: base.review.id, status: "merged" }
        : state === "closed"
          ? { id: base.review.id, status: "closed" }
          : base.review,
    revision:
      state === "updates-draft" ||
      state === "analysis-outdated" ||
      state === "walkthrough-outdated"
        ? {
            ...base.revision,
            freshness:
              state === "updates-draft"
                ? ("updates_available" as const)
                : base.revision.freshness,
            currentHeadSha: "b".repeat(40),
          }
        : base.revision,
    insights: { analysis, walkthrough },
    conversation: withFeedback
      ? {
          prDescription: base.conversation.prDescription ?? "",
          entries: [
            ...base.conversation.entries,
            {
              _tag: "ReviewSummary" as const,
              review: {
                id: "published-1",
                author: "fixture-maintainer",
                body: "Published review body",
                event: "COMMENTED" as const,
                submittedAt: base.revision.refreshedAt,
                canDismiss: true,
              },
            },
            {
              _tag: "IssueComment" as const,
              comment: {
                id: "comment-1",
                author: "fixture-maintainer",
                body: "Published inline feedback",
                createdAt: base.revision.refreshedAt,
                location: {
                  path: "src/b.ts",
                  line: 1,
                  diffSide: "new" as const,
                },
              },
            },
          ],
        }
      : base.conversation,
  };
}

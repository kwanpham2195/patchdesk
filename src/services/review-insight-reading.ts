import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { renderBriefAsPullRequestDescription } from "../domain/brief-pull-request-description";
import { definedProps } from "../domain/defined-props";
import type {
  GitSha,
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import type {
  InsightFailureCategory,
  InsightType,
} from "../domain/insight-record";
import { findingDraftStates } from "../domain/local-draft";
import type { NarrativeWalkthrough } from "../domain/narrative-walkthrough";
import type { ReviewResult } from "../domain/review-result";
import { casesHandled, err, ok, type Result } from "../domain/result";
import type { LocalBranchMismatch } from "./local-review-opening";
import {
  describeProjectedSession,
  type ReviewSessionDescription,
} from "./review-session-description";
import type {
  ReviewWorkbenchController,
  ReviewWorkbenchFailure,
} from "./review-workbench-controller";
import type { ReviewWorkbenchProjection } from "./review-workbench-projection";

type AnalysisFinding = ReviewResult["findings"][number];

/** One Analysis Finding with the maintainer's disposition as the workbench shows it. */
type AnalysisFindingReading = Pick<
  AnalysisFinding,
  | "id"
  | "severity"
  | "title"
  | "explanation"
  | "file"
  | "lineStart"
  | "lineEnd"
  | "diffSide"
> & {
  /** The verified replacement for the cited new-side lines. */
  readonly suggestion?: string;
  readonly dismissed: boolean;
  readonly drafted: boolean;
  readonly applied: boolean;
};

/** The retained result and the revision it describes; `outdated` when it is not about the Review's current session. */
type RetainedInsightReading = {
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly generatedAt: IsoTimestamp;
  readonly outdated?: true;
} & (
  | {
      readonly type: "analysis";
      readonly verdict: ReviewResult["verdict"];
      readonly summary: string;
      readonly findings: ReadonlyArray<AnalysisFindingReading>;
    }
  | { readonly type: "brief"; readonly markdown: string }
  | {
      readonly type: "walkthrough";
      readonly chapters: NarrativeWalkthrough["chapters"];
    }
);

/** One Insight as `get_insight` answers it (ADR 0052 "Tools, v1"). */
export type InsightReading = ReviewSessionDescription & {
  readonly type: InsightType;
  readonly status: "none" | "running" | "completed" | "failed";
  readonly failure?: {
    readonly category?: InsightFailureCategory;
    readonly retryable: boolean;
  };
  /** Present whenever a result is retained, also while a new run is active or after it failed. */
  readonly result?: RetainedInsightReading;
};

export type InsightReadingFailure =
  | ReviewWorkbenchFailure
  | LocalBranchMismatch
  /** A pull request Review, which the agent never reads. */
  | { readonly reason: "not_applicable" };

/**
 * Reads one Insight through the workbench projection the renderer displays
 * (ADR 0052 `get_insight`), so the agent and the UI never disagree on a
 * Finding's dismissed, drafted, or applied state.
 */
export class ReviewInsightReader {
  constructor(
    private readonly workbench: Pick<ReviewWorkbenchController, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
  ) {}

  async read(request: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
  }): Promise<Result<InsightReading, InsightReadingFailure>> {
    const projected = await this.workbench.load({
      profileId: request.profileId,
      reviewId: request.reviewId,
    });
    if (projected._tag === "err") return projected;
    if (projected.value.session.key.source.kind === "pull_request")
      return err({ reason: "not_applicable" });
    const session = await describeProjectedSession(
      this.sessions,
      projected.value,
    );
    if (session._tag === "err") return session;
    const insight = projected.value.insights[request.type];
    const result = readRetained(projected.value, request.type);
    return ok({
      ...session.value,
      type: request.type,
      status:
        insight.status === "not_generated"
          ? "none"
          : insight.status === "current" || insight.status === "outdated"
            ? "completed"
            : insight.status,
      ...definedProps({
        failure:
          insight.replacementFailure === undefined
            ? undefined
            : {
                ...definedProps({
                  category: insight.replacementFailure.category,
                }),
                retryable: insight.replacementFailure.retryable,
              },
        result,
      }),
    });
  }
}

function readRetained(
  projection: ReviewWorkbenchProjection,
  type: InsightType,
): RetainedInsightReading | undefined {
  const insight = projection.insights[type];
  const retained = insight.retained;
  if (retained === undefined) return undefined;
  const revision = {
    sessionId: retained.sessionId,
    headSha: retained.headSha,
    generatedAt: retained.generatedAt,
    ...definedProps({
      outdated:
        insight.status === "outdated" ||
        retained.sessionId !== projection.session.id
          ? (true as const)
          : undefined,
    }),
  };
  switch (type) {
    case "analysis": {
      const analysis = projection.insights.analysis.retained;
      if (analysis === undefined) return undefined;
      const drafts = findingDraftStates(
        projection.localDrafts ?? [],
        analysis.runId,
      );
      return {
        ...revision,
        type,
        verdict: analysis.value.verdict,
        summary: analysis.value.summary,
        findings: analysis.value.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          title: finding.title,
          explanation: finding.explanation,
          ...definedProps({
            file: finding.file,
            lineStart: finding.lineStart,
            lineEnd: finding.lineEnd,
            diffSide: finding.diffSide,
            suggestion: finding.suggestedReplacement?.code,
          }),
          dismissed: finding.disposition === "dismissed",
          drafted: drafts.has(finding.id),
          applied: drafts.get(finding.id) === "applied",
        })),
      };
    }
    case "brief": {
      const brief = projection.insights.brief.retained;
      return brief === undefined
        ? undefined
        : {
            ...revision,
            type,
            markdown: renderBriefAsPullRequestDescription(brief.value),
          };
    }
    case "walkthrough": {
      const walkthrough = projection.insights.walkthrough.retained;
      return walkthrough === undefined
        ? undefined
        : { ...revision, type, chapters: walkthrough.value.chapters };
    }
    default:
      return casesHandled(type);
  }
}

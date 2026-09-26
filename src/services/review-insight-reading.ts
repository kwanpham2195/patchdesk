import { definedProps } from "../domain/defined-props";
import type { ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { InsightType } from "../domain/insight-record";
import { findingDraftStates } from "../domain/local-draft";
import { ok, type Result } from "../domain/result";
import type { LocalBranchMismatch } from "./local-review-opening";
import type {
  ReviewWorkbenchController,
  ReviewWorkbenchFailure,
} from "./review-workbench-controller";
import type { ReviewWorkbenchProjection } from "./review-workbench-projection";

type AnalysisFinding = NonNullable<
  ReviewWorkbenchProjection["insights"]["analysis"]["retained"]
>["value"]["findings"][number];

/** One Analysis Finding with the maintainer's disposition as the workbench shows it. */
type AnalysisFindingReading = AnalysisFinding & {
  readonly dismissed: boolean;
  readonly drafted: boolean;
  readonly applied: boolean;
};

/** One Insight as the workbench projects it; an Analysis adds each Finding's disposition. */
export type InsightReading = {
  readonly session: ReviewWorkbenchProjection["session"];
  readonly revision: ReviewWorkbenchProjection["revision"];
  readonly insight: ReviewWorkbenchProjection["insights"][InsightType];
  readonly findings?: ReadonlyArray<AnalysisFindingReading>;
};

/**
 * Reads one Insight through the workbench projection the renderer displays
 * (ADR 0052 `get_insight`), so the agent and the UI never disagree on a
 * Finding's dismissed, drafted, or applied state.
 */
export class ReviewInsightReader {
  constructor(
    private readonly workbench: Pick<ReviewWorkbenchController, "load">,
  ) {}

  async read(request: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly type: InsightType;
  }): Promise<
    Result<InsightReading, ReviewWorkbenchFailure | LocalBranchMismatch>
  > {
    const projected = await this.workbench.load({
      profileId: request.profileId,
      reviewId: request.reviewId,
    });
    if (projected._tag === "err") return projected;
    const { session, revision, insights, localDrafts } = projected.value;
    const analysis =
      request.type === "analysis" ? insights.analysis.retained : undefined;
    const drafts = findingDraftStates(localDrafts ?? [], analysis?.runId);
    return ok({
      session,
      revision,
      insight: insights[request.type],
      ...definedProps({
        findings: analysis?.value.findings.map((finding) => ({
          ...finding,
          dismissed: finding.disposition === "dismissed",
          drafted: drafts.has(finding.id),
          applied: drafts.get(finding.id) === "applied",
        })),
      }),
    });
  }
}

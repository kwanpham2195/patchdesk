import type { InsightStore } from "../adapters/storage/insight-store";
import { renderBriefAsPullRequestDescription } from "../domain/brief-pull-request-description";
import type { InsightRunId, ReviewId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { parseStoredBrief } from "../domain/stored-brief";

/**
 * The retained Brief of one run as a pull request description. The renderer
 * names the run only; the Markdown is composed here from what storage holds.
 */
export async function readBriefPullRequestDescription(
  insights: Pick<InsightStore, "loadTyped">,
  request: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly runId: InsightRunId;
  },
): Promise<
  Result<
    { readonly markdown: string },
    { readonly reason: "not_found" | "storage" }
  >
> {
  const record = await insights.loadTyped(
    request.profileId,
    request.reviewId,
    "brief",
    parseStoredBrief,
  );
  if (record._tag === "err")
    return err({
      reason: record.error.reason === "not_found" ? "not_found" : "storage",
    });
  const retained = record.value.retained;
  if (retained === undefined || retained.runId !== request.runId)
    return err({ reason: "not_found" });
  return ok({ markdown: renderBriefAsPullRequestDescription(retained.value) });
}

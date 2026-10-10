import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";

/** Retained evidence must match the displayed session before sharing its review actions. */
export function guideReviewDisabledReason(
  workbench: WorkbenchResponse,
): string | undefined {
  const insight = workbench.insights.guide;
  const retained = insight?.retained;
  if (
    retained === undefined ||
    retained.freshness !== "current" ||
    insight?.status === "outdated" ||
    insight?.artifactStatus !== "verified" ||
    retained.sessionId !== workbench.session.id ||
    retained.headSha !== workbench.revision.reviewedHeadSha
  )
    return "This Guide shows an older or unverified revision, so generate Guide for the current revision to review files.";
  if (workbench.fullPatch === undefined)
    return "The current Review patch is still loading.";
  if (retained.value.patchText !== workbench.fullPatch)
    return "This Guide shows a different patch, so generate Guide for the current revision to review files.";
  if (workbench.review.status !== "open")
    return "File review controls are unavailable because this Review is closed.";
  // Local notes keep their existing session-only gate; GitHub content writes require Fresh.
  if (
    workbench.session.key.source.kind === "pull_request" &&
    workbench.revision.freshness !== "fresh"
  )
    return "Refresh this Review before reviewing files in Guide.";
  return undefined;
}

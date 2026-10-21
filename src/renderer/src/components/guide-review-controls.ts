import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { GuideSummary } from "#src/domain/guide-progress";

/** Cancel needs an owned active run and a nonterminal Review, not a current GitHub revision. */
export function guideCancelDisabledReason(
  workbench: WorkbenchResponse,
): string | undefined {
  return workbench.review.status === "open"
    ? undefined
    : "Guide controls are unavailable because this Review is closed.";
}

/** New Guide controls compare published evidence directly with the displayed patch, without legacy retained fields. */
export function publishedGuideRevisionMatches(
  workbench: WorkbenchResponse,
  summary: Extract<GuideSummary, { _tag: "ready" }>,
): boolean {
  return (
    summary.sessionId === workbench.session.id &&
    summary.revision.headSha === workbench.revision.reviewedHeadSha &&
    summary.revision.patchHash === workbench.revision.patchHash
  );
}

/** File actions require the exact published revision and the existing Review authoring gates. */
export function publishedGuideReviewDisabledReason(
  workbench: WorkbenchResponse,
  summary: Extract<GuideSummary, { _tag: "ready" }> | undefined,
): string | undefined {
  if (summary === undefined)
    return "The published Guide is still loading or unavailable.";
  if (
    workbench.fullPatch === undefined ||
    workbench.revision.patchHash === undefined
  )
    return "The current Review patch is still loading.";
  if (!publishedGuideRevisionMatches(workbench, summary))
    return "This Guide was generated for another revision of the Review.";
  return guideRunReviewDisabledReason(workbench);
}

/** Run actions use the current Review, not the optional result that a replacement run preserves. */
export function guideRunReviewDisabledReason(
  workbench: WorkbenchResponse,
): string | undefined {
  if (workbench.review.status !== "open")
    return "Guide controls are unavailable because this Review is closed.";
  if (
    workbench.revision.currentHeadSha !== undefined &&
    workbench.revision.currentHeadSha !== workbench.revision.reviewedHeadSha
  )
    return "Refresh this Review before changing its Guide run.";
  if (
    workbench.session.key.source.kind === "pull_request" &&
    workbench.revision.freshness !== "fresh"
  )
    return "Refresh this Review before using Guide controls.";
  return undefined;
}

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

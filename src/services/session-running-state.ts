import type { InsightStore } from "../adapters/storage/insight-store";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ReviewStore } from "../adapters/storage/review-store";
import { isDirectSummaryReviewLocked } from "../domain/direct-summary-review";
import { createReviewId, type WorkspaceProfileId } from "../domain/ids";
import { isPendingReviewLocked } from "../domain/pending-review";
import { err, ok, type Result } from "../domain/result";
import type { Review } from "../domain/review";
import {
  isPullRequestReviewSession,
  type ReviewSession,
} from "../domain/review-session";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import { ReviewPreparationJournal } from "./review-preparation-journal";

/** The running-state answer, carrying the Review record that decided it when the session is idle. */
export type SessionRunningState =
  | { readonly running: true }
  | {
      readonly running: false;
      readonly review: Result<Review, StorageFailure>;
    };

export type SessionRunningStateDependencies = {
  readonly paths: PatchdeskPaths;
  readonly reviews: Pick<ReviewStore, "load">;
  readonly insights: Pick<InsightStore, "load">;
  readonly mergeOperations: Pick<MergeOperationStore, "load">;
  readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
};

/**
 * ADR 0020's one definition of a session in motion, which no cleanup may
 * remove: an active preparation journal, the current session of an Open
 * Review or the one an agent's refresh prepared for it (ADR 0052), an active Analysis, Walkthrough or Brief run, a locked GitHub write,
 * or an unsettled merge. A session that is not running carries out the Review
 * record this answer was decided from, so a caller does not read it again.
 */
export async function readSessionRunningState(
  dependencies: SessionRunningStateDependencies,
  profileId: WorkspaceProfileId,
  session: ReviewSession,
): Promise<
  Result<SessionRunningState, { readonly _tag: "StorageUnavailable" }>
> {
  const preparation = await ReviewPreparationJournal.activeFor(
    dependencies.paths,
    profileId,
    session.id,
    dependencies.diagnostics,
  );
  if (preparation._tag === "err") return err({ _tag: "StorageUnavailable" });
  if (preparation.value !== undefined) return ok({ running: true });
  const reviewId = createReviewId(session.key);
  const [review, analysis, walkthrough, brief, merge] = await Promise.all([
    dependencies.reviews.load(profileId, reviewId),
    dependencies.insights.load(profileId, reviewId, "analysis"),
    dependencies.insights.load(profileId, reviewId, "walkthrough"),
    dependencies.insights.load(profileId, reviewId, "brief"),
    dependencies.mergeOperations.load(profileId, session.id),
  ]);
  if (
    [review, analysis, walkthrough, brief, merge].some(
      (value) => value._tag === "err" && value.error.reason !== "not_found",
    )
  )
    return err({ _tag: "StorageUnavailable" });
  if (
    review._tag === "ok" &&
    review.value.status._tag === "Open" &&
    (review.value.currentSessionId === session.id ||
      review.value.preparedSessionId === session.id)
  )
    return ok({ running: true });
  // A Brief reads the session's worktree as an Analysis or Walkthrough does.
  if (
    [analysis, walkthrough, brief].some(
      (record) =>
        record._tag === "ok" &&
        record.value.activeRun?.revision.sessionId === session.id,
    )
  )
    return ok({ running: true });
  if (hasLockedGitHubWrite(session)) return ok({ running: true });
  return ok(
    merge._tag === "ok" && merge.value.state._tag !== "Rejected"
      ? { running: true }
      : { running: false, review },
  );
}

/** A pending-review or summary write on the session is in flight or outcome-unknown (ADR 0035). */
export function hasLockedGitHubWrite(session: ReviewSession): boolean {
  return (
    isPullRequestReviewSession(session) &&
    (isPendingReviewLocked(session.pendingReview) ||
      isDirectSummaryReviewLocked(session.directSummaryReview))
  );
}

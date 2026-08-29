import {
  reconcileReviewRemoteState,
  type Review,
  type RevisionUnavailableReason,
} from "../domain/review";
import type { PendingReviewState } from "../domain/pending-review";
import type { ReviewSession } from "../domain/review-session";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type {
  ReviewObservation,
  ReviewObservationDependencies,
  ReviewObservationFailure,
} from "./review-observation-service";

/**
 * Replays an observation the process was interrupted partway through, using
 * the durable journal rather than a new GitHub read, and decides for each
 * journalled intent whether it already landed.
 */
export class ReviewObservationRecovery {
  constructor(
    private readonly dependencies: ReviewObservationDependencies,
    private readonly markUnavailable: (
      input: {
        readonly profileId: WorkspaceProfileId;
        readonly reviewId: ReviewId;
      },
      review: Review,
      detectedAt: IsoTimestamp,
      reason: RevisionUnavailableReason,
    ) => Promise<Result<ReviewObservation, ReviewObservationFailure>>,
  ) {}

  /** Same recovery as `recover`, for a caller already holding `open`'s coordinator lock — retaking it here would deadlock (`withReviewLock` isn't re-entrant). */
  async recoverUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<ReviewObservation, ReviewObservationFailure>> {
    const journal = await this.dependencies.journals.load(
      input.profileId,
      input.reviewId,
    );
    if (journal._tag === "err") {
      const review = await this.dependencies.reviews.load(
        input.profileId,
        input.reviewId,
      );
      return review._tag === "ok"
        ? this.markUnavailable(
            input,
            review.value,
            this.dependencies.now(),
            "reconciliation_incomplete",
          )
        : err({ reason: "storage" });
    }
    if (journal.value === undefined)
      return ok({ _tag: "Unchanged", detectedAt: this.dependencies.now() });
    const [review, session] = await Promise.all([
      this.dependencies.reviews.load(input.profileId, input.reviewId),
      this.dependencies.sessions.load(input.profileId, journal.value.sessionId),
    ]);
    if (
      review._tag === "err" ||
      session._tag === "err" ||
      review.value.currentSessionId !== journal.value.sessionId ||
      (review.value.representedRemote?.snapshotHash !==
        journal.value.previousSnapshotHash &&
        review.value.representedRemote?.snapshotHash !==
          journal.value.nextSnapshotHash) ||
      session.value.key.headSha !== journal.value.sessionHeadSha
    ) {
      return review._tag === "ok"
        ? this.markUnavailable(
            input,
            review.value,
            this.dependencies.now(),
            "reconciliation_incomplete",
          )
        : err({ reason: "storage" });
    }
    const candidate = await this.dependencies.remote.load({
      profileId: input.profileId,
      reviewId: input.reviewId,
      snapshotHash: journal.value.nextSnapshotHash,
    });
    if (candidate._tag === "err")
      return this.markUnavailable(
        input,
        review.value,
        this.dependencies.now(),
        "reconciliation_incomplete",
      );

    const intendedSession = applySessionAdoption(
      session.value,
      journal.value.nextPendingReview,
      journal.value.nextFindingReviewReceipts,
      journal.value.nextSessionUpdatedAt,
    );
    if (session.value.updatedAt === journal.value.expectedSessionUpdatedAt) {
      const saved = await this.dependencies.sessions.save(
        intendedSession,
        journal.value.expectedSessionUpdatedAt,
      );
      if (saved._tag === "err")
        return this.markUnavailable(
          input,
          review.value,
          this.dependencies.now(),
          "reconciliation_incomplete",
        );
    } else if (
      isResolvedPendingDescendant(
        session.value.pendingReview,
        journal.value.nextPendingReview,
      )
    ) {
      // A later explicit pending-review recovery has stronger remote proof
      // than this older observation journal. Preserve that resolved state.
    } else if (!sameSessionAdoption(session.value, intendedSession)) {
      return this.markUnavailable(
        input,
        review.value,
        this.dependencies.now(),
        "reconciliation_incomplete",
      );
    }

    const intendedReview = reconcileReviewRemoteState(review.value, {
      snapshotHash: journal.value.nextSnapshotHash,
      pullRequestUpdatedAt: candidate.value.pullRequest.updatedAt,
      refreshedAt: journal.value.nextReviewUpdatedAt,
    });
    if (intendedReview._tag === "err")
      return this.markUnavailable(
        input,
        review.value,
        this.dependencies.now(),
        "reconciliation_incomplete",
      );
    let adoptedReview = review.value;
    if (review.value.updatedAt === journal.value.expectedReviewUpdatedAt) {
      const saved = await this.dependencies.reviews.save(
        intendedReview.value,
        journal.value.expectedReviewUpdatedAt,
      );
      if (saved._tag === "err")
        return this.markUnavailable(
          input,
          review.value,
          this.dependencies.now(),
          "reconciliation_incomplete",
        );
      adoptedReview = intendedReview.value;
    } else if (
      isFailedClosedObservation(
        review.value,
        journal.value.previousSnapshotHash,
      )
    ) {
      const saved = await this.dependencies.reviews.save(
        intendedReview.value,
        review.value.updatedAt,
      );
      if (saved._tag === "err") return err({ reason: "storage" });
      adoptedReview = intendedReview.value;
    } else if (
      isFailedClosedObservation(review.value, journal.value.nextSnapshotHash)
    ) {
      // Both ordered adoptions completed; only journal cleanup failed. Restore
      // Fresh on the already-adopted snapshot, then remove the journal below.
      const restored = {
        ...intendedReview.value,
        updatedAt: nextTimestamp(
          review.value.updatedAt,
          this.dependencies.now(),
        ),
      };
      const saved = await this.dependencies.reviews.save(
        restored,
        review.value.updatedAt,
      );
      if (saved._tag === "err") return err({ reason: "storage" });
      adoptedReview = restored;
    } else if (
      isCompletedObservation(review.value, journal.value.nextSnapshotHash)
    ) {
      adoptedReview = review.value;
    } else if (!sameReviewAdoption(review.value, intendedReview.value)) {
      return this.markUnavailable(
        input,
        review.value,
        this.dependencies.now(),
        "reconciliation_incomplete",
      );
    }
    const removed = await this.dependencies.journals.remove(
      input.profileId,
      input.reviewId,
    );
    return removed._tag === "ok"
      ? ok({ _tag: "Reconciled", detectedAt: this.dependencies.now() })
      : this.markUnavailable(
          input,
          adoptedReview,
          this.dependencies.now(),
          "reconciliation_incomplete",
        );
  }
}

export function applySessionAdoption(
  session: ReviewSession,
  pendingReview: PendingReviewState | undefined,
  findingReviewReceipts: ReviewSession["findingReviewReceipts"] | undefined,
  updatedAt: IsoTimestamp,
): ReviewSession {
  const {
    pendingReview: _previousPending,
    findingReviewReceipts: _previousReceipts,
    ...rest
  } = session;
  void _previousPending;
  void _previousReceipts;
  const base = { ...rest, updatedAt };
  const withPendingReview =
    pendingReview === undefined ? base : { ...base, pendingReview };
  return findingReviewReceipts === undefined ||
    findingReviewReceipts.length === 0
    ? withPendingReview
    : { ...withPendingReview, findingReviewReceipts };
}

function sameSessionAdoption(
  left: ReviewSession,
  right: ReviewSession,
): boolean {
  return (
    left.updatedAt === right.updatedAt &&
    JSON.stringify(left.pendingReview) ===
      JSON.stringify(right.pendingReview) &&
    JSON.stringify(left.findingReviewReceipts ?? []) ===
      JSON.stringify(right.findingReviewReceipts ?? [])
  );
}

function isResolvedPendingDescendant(
  current: PendingReviewState | undefined,
  intended: PendingReviewState | undefined,
): boolean {
  if (intended === undefined) return false;
  if (intended._tag !== "WriteInFlight" && intended._tag !== "OutcomeUnknown") {
    return false;
  }
  if (current?._tag === "None") {
    return intended.operation._tag === "Start";
  }
  if (current?._tag !== "Pending") return false;
  if (intended.operation._tag === "Start") return true;
  return (
    intended.operation._tag === "AddThread" &&
    current.review.nodeId === intended.operation.reviewId
  );
}

function sameReviewAdoption(left: Review, right: Review): boolean {
  return (
    left.updatedAt === right.updatedAt &&
    left.freshness._tag === "Fresh" &&
    right.freshness._tag === "Fresh" &&
    left.representedRemote?.snapshotHash ===
      right.representedRemote?.snapshotHash
  );
}

function isFailedClosedObservation(
  review: Review,
  previousSnapshotHash: string,
): boolean {
  return (
    review.freshness._tag === "Unavailable" &&
    review.freshness.reason === "reconciliation_incomplete" &&
    review.representedRemote?.snapshotHash === previousSnapshotHash
  );
}
function isCompletedObservation(
  review: Review,
  nextSnapshotHash: string,
): boolean {
  return (
    review.freshness._tag === "Fresh" &&
    review.representedRemote?.snapshotHash === nextSnapshotHash
  );
}

export function nextTimestamp(
  previous: IsoTimestamp,
  requested: IsoTimestamp,
): IsoTimestamp {
  const milliseconds = Math.max(
    Date.parse(previous) + 1,
    Date.parse(requested),
  );
  const next = new Date(milliseconds).toISOString();
  // SAFETY: both inputs are parsed timestamps; this arithmetic always produces ISO.
  return next as IsoTimestamp;
}

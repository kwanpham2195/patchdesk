import type {
  GitHubPendingReviewGateway,
  GitHubReader,
} from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewObservationJournalStore } from "../adapters/storage/review-observation-journal-store";
import type {
  ReviewRemoteSnapshot,
  ReviewRemoteStore,
} from "../adapters/storage/review-remote-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { GitHubMergeEvidence } from "../domain/github-context";
import {
  parseGitHubLogin,
  type IsoTimestamp,
  type ReviewId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type {
  PendingReviewRead,
  PendingReviewState,
} from "../domain/pending-review";
import {
  markReviewRevisionChanged,
  markReviewTerminal,
  markReviewUnavailable,
  reconcileReviewRemoteState,
  type Review,
  type RevisionUnavailableReason,
} from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type {
  ReviewWorkbenchProjection,
  WorkbenchProjectionFailure,
} from "./review-workbench-projection";
import type { RecentReviewWrite } from "./review-refresh-service";
import { GitHubRevisionIdentityReader } from "./github-revision-identity-reader";
import type { PendingReviewService } from "./pending-review-service";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/** Typed outcome of one bounded same-revision observation. */
export type ReviewObservation =
  | { readonly _tag: "Unchanged"; readonly detectedAt: IsoTimestamp }
  | {
      readonly _tag: "Reconciled";
      readonly detectedAt: IsoTimestamp;
      readonly projection?: ReviewWorkbenchProjection;
    }
  | { readonly _tag: "RevisionChanged"; readonly detectedAt: IsoTimestamp }
  | {
      readonly _tag: "Unavailable";
      readonly detectedAt: IsoTimestamp;
      readonly reason: RevisionUnavailableReason;
    }
  | {
      readonly _tag: "Terminal";
      readonly status: "merged" | "closed";
      readonly detectedAt: IsoTimestamp;
    };

/** Storage or ownership failure that prevents observation. */
export type ReviewObservationFailure = {
  readonly reason: "not_found" | "storage";
};

type ObservationGitHub = Pick<
  GitHubReader,
  | "getPullRequest"
  | "getPullRequestDiff"
  | "getPullRequestComments"
  | "getPullRequestChecks"
  | "getMergePolicy"
  | "loadConversation"
  | "resolveAuthenticatedAccount"
> &
  Partial<
    Pick<
      GitHubReader,
      | "getPullRequestPublishedFeedback"
      | "getMergePolicyEvidence"
      | "getMergeOutcome"
    >
  > &
  Pick<GitHubPendingReviewGateway, "getViewerPendingReview">;

/** Explicit durable seams that one observation transaction coordinates. */
export type ReviewObservationDependencies = {
  readonly profiles: Pick<ProfileStore, "load">;
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly sessions: Pick<ReviewSessionStore, "load" | "save">;
  readonly remote: Pick<ReviewRemoteStore, "load" | "saveCandidate">;
  readonly journals: Pick<
    ReviewObservationJournalStore,
    "load" | "save" | "remove"
  >;
  readonly github: ObservationGitHub;
  readonly pendingReview: Pick<PendingReviewService, "adoptObservedState">;
  readonly coordinator: ReviewOperationCoordinator;
  readonly now: () => IsoTimestamp;
  readonly project?: (input: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSession["id"];
    readonly snapshot: ReviewRemoteSnapshot;
    readonly refreshedAt: IsoTimestamp;
    readonly freshness: Review["freshness"];
    readonly pendingReview: {
      readonly state: PendingReviewState;
      readonly unavailable: boolean;
    };
  }) => Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>>;
};

/**
 * Reconciles bounded GitHub state only after canonical same-revision proof.
 * It owns the candidate -> journal -> session -> Review ordering; Refresh is
 * deliberately outside this service because it is the only code-adoption path.
 */
export class ReviewObservationService {
  constructor(private readonly dependencies: ReviewObservationDependencies) {}

  /** Observe one Review and project only after its durable transition completes. */
  async observe(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly recentWrites?: ReadonlyArray<RecentReviewWrite>;
  }): Promise<Result<ReviewObservation, ReviewObservationFailure>> {
    return this.dependencies.coordinator.withReviewLock(
      input.profileId,
      input.reviewId,
      async () => {
        const recovered = await this.recoverUnlocked(input);
        if (recovered._tag === "err") return recovered;
        if (recovered.value._tag === "Unavailable") return recovered;
        return this.observeUnlocked(input);
      },
    );
  }

  /** Replay an interrupted observation without performing a new GitHub read. */
  async recover(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<ReviewObservation, ReviewObservationFailure>> {
    return this.dependencies.coordinator.withReviewLock(
      input.profileId,
      input.reviewId,
      () => this.recoverUnlocked(input),
    );
  }

  private async observeUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly recentWrites?: ReadonlyArray<RecentReviewWrite>;
  }): Promise<Result<ReviewObservation, ReviewObservationFailure>> {
    const loaded = await this.load(input);
    if (loaded._tag === "err") return loaded;
    const { profile, review, session, represented } = loaded.value;
    const detectedAt = this.dependencies.now();
    if (review.status._tag === "Terminal") {
      return ok({
        _tag: "Terminal",
        status: review.status.state,
        detectedAt: review.status.observedAt,
      });
    }

    // Terminal precedence is intentionally narrow: it stops writes but does
    // not install metadata, conversation, or a pending draft from a changed PR.
    const terminalRead = await this.dependencies.github.getPullRequest({
      profile,
      pr: reviewRef(review),
    });
    if (terminalRead._tag === "err")
      return this.markUnavailable(input, review, detectedAt, "github_read");
    if (!terminalRead.value.isOpen) {
      const state = await this.readTerminalState(
        profile,
        review,
        terminalRead.value.isOpen,
      );
      const terminal = markReviewTerminal(review, state, detectedAt);
      const saved = await this.dependencies.reviews.save(
        terminal,
        review.updatedAt,
      );
      return saved._tag === "ok"
        ? ok({ _tag: "Terminal", status: state, detectedAt })
        : err({ reason: "storage" });
    }

    const identity = new GitHubRevisionIdentityReader(this.dependencies.github);
    const first = await identity.read({
      profile,
      pr: reviewRef(review),
      session,
    });
    if (first._tag === "err")
      return this.markUnavailable(input, review, detectedAt, "github_read");
    if (first.value._tag === "Changed") {
      const changed = markReviewRevisionChanged(
        review,
        { detectedAt, identity: first.value.identity },
        detectedAt,
      );
      const saved = await this.dependencies.reviews.save(
        changed,
        review.updatedAt,
      );
      return saved._tag === "ok"
        ? ok({ _tag: "RevisionChanged", detectedAt })
        : err({ reason: "storage" });
    }
    if (first.value._tag === "Unavailable") {
      return this.markUnavailable(
        input,
        review,
        detectedAt,
        first.value.reason,
      );
    }

    const [
      comments,
      checks,
      conversation,
      mergePolicy,
      publishedFeedback,
      mergeEvidence,
      observedPending,
    ] = await Promise.all([
      this.dependencies.github.getPullRequestComments({
        profile,
        pr: reviewRef(review),
      }),
      this.dependencies.github.getPullRequestChecks({
        profile,
        pr: reviewRef(review),
        headSha: session.key.headSha,
      }),
      this.dependencies.github.loadConversation({
        profile,
        pr: reviewRef(review),
      }),
      this.dependencies.github.getMergePolicy({
        profile,
        pr: reviewRef(review),
        expectedHeadSha: session.key.headSha,
      }),
      this.dependencies.github.getPullRequestPublishedFeedback === undefined
        ? Promise.resolve(undefined)
        : this.dependencies.github.getPullRequestPublishedFeedback({
            profile,
            pr: reviewRef(review),
          }),
      this.dependencies.github.getMergePolicyEvidence === undefined
        ? Promise.resolve(undefined)
        : this.dependencies.github.getMergePolicyEvidence({
            profile,
            pr: reviewRef(review),
            branch: terminalRead.value.baseBranch,
          }),
      this.readPending(profile, review),
    ]);
    if (
      comments._tag === "err" ||
      checks._tag === "err" ||
      conversation._tag === "err" ||
      mergePolicy._tag === "err"
    ) {
      return this.markUnavailable(input, review, detectedAt, "github_read");
    }

    const second = await identity.read({
      profile,
      pr: reviewRef(review),
      session,
    });
    if (second._tag === "err")
      return this.markUnavailable(input, review, detectedAt, "github_read");
    if (second.value._tag === "Unavailable")
      return this.markUnavailable(
        input,
        review,
        detectedAt,
        second.value.reason,
      );
    if (second.value._tag === "Changed") {
      const changed = markReviewRevisionChanged(
        review,
        { detectedAt, identity: second.value.identity },
        detectedAt,
      );
      const saved = await this.dependencies.reviews.save(
        changed,
        review.updatedAt,
      );
      return saved._tag === "ok"
        ? ok({ _tag: "RevisionChanged", detectedAt })
        : err({ reason: "storage" });
    }

    const candidate: ReviewRemoteSnapshot = {
      ...represented,
      pullRequest: terminalRead.value,
      comments: comments.value,
      checks: checks.value,
      conversation: conversation.value,
      mergePolicy: mergePolicy.value,
      mergeEvidence:
        mergeEvidence?._tag === "ok"
          ? toMergeEvidence(mergePolicy.value, mergeEvidence.value)
          : toMergeEvidence(mergePolicy.value),
      ...(publishedFeedback?._tag === "ok"
        ? { publishedFeedback: publishedFeedback.value }
        : {}),
    };
    const savedCandidate = await this.dependencies.remote.saveCandidate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      snapshot: candidate,
    });
    if (savedCandidate._tag === "err") return err({ reason: "storage" });

    const pending = this.dependencies.pendingReview.adoptObservedState({
      session,
      observed: observedPending.read,
      evidenceComplete:
        observedPending.available &&
        comments.value.complete === true &&
        conversation.value.complete === true &&
        (publishedFeedback === undefined ||
          (publishedFeedback._tag === "ok" &&
            publishedFeedback.value.complete === true)),
      comments: comments.value,
      ...(publishedFeedback?._tag === "ok"
        ? { publishedFeedback: publishedFeedback.value }
        : {}),
    });
    const nextSessionAt = nextTimestamp(session.updatedAt, detectedAt);
    const nextReviewAt = nextTimestamp(review.updatedAt, detectedAt);
    const previousSnapshotHash = review.representedRemote?.snapshotHash;
    if (previousSnapshotHash === undefined)
      return this.markUnavailable(
        input,
        review,
        detectedAt,
        "reconciliation_incomplete",
      );
    const journal = {
      schemaVersion: 1 as const,
      profileId: input.profileId,
      reviewId: input.reviewId,
      sessionId: session.id,
      sessionHeadSha: session.key.headSha,
      expectedReviewUpdatedAt: review.updatedAt,
      expectedSessionUpdatedAt: session.updatedAt,
      nextSessionUpdatedAt: nextSessionAt,
      nextReviewUpdatedAt: nextReviewAt,
      previousSnapshotHash,
      nextSnapshotHash: savedCandidate.value.snapshotHash,
      ...(pending.pendingReview === undefined
        ? {}
        : { nextPendingReview: pending.pendingReview }),
      ...(pending.findingReviewReceipts === undefined
        ? {}
        : { nextFindingReviewReceipts: pending.findingReviewReceipts }),
      createdAt: detectedAt,
    };
    const storedJournal = await this.dependencies.journals.save(journal);
    if (storedJournal._tag === "err") return err({ reason: "storage" });

    const adoptedSession = applySessionAdoption(
      session,
      journal.nextPendingReview,
      journal.nextFindingReviewReceipts,
      nextSessionAt,
    );
    const savedSession = await this.dependencies.sessions.save(
      adoptedSession,
      session.updatedAt,
    );
    if (savedSession._tag === "err") {
      return this.markUnavailable(
        input,
        review,
        detectedAt,
        "reconciliation_incomplete",
      );
    }
    const adoptedReview = reconcileReviewRemoteState(review, {
      snapshotHash: savedCandidate.value.snapshotHash,
      pullRequestUpdatedAt: terminalRead.value.updatedAt,
      refreshedAt: nextReviewAt,
    });
    if (adoptedReview._tag === "err") {
      return this.markUnavailable(
        input,
        review,
        detectedAt,
        "reconciliation_incomplete",
      );
    }
    const savedReview = await this.dependencies.reviews.save(
      adoptedReview.value,
      review.updatedAt,
    );
    if (savedReview._tag === "err") {
      return this.markUnavailable(
        input,
        review,
        detectedAt,
        "reconciliation_incomplete",
      );
    }
    const removed = await this.dependencies.journals.remove(
      input.profileId,
      input.reviewId,
    );
    if (removed._tag === "err") {
      return this.markUnavailable(
        input,
        adoptedReview.value,
        detectedAt,
        "reconciliation_incomplete",
      );
    }

    // A successful snapshot transition does not itself prove GitHub has made
    // a just-confirmed write visible. Keep the renderer's typed write journal
    // until this exact durable candidate carries every receipt.
    if (
      this.dependencies.project === undefined ||
      !containsRecentWrites(candidate, input.recentWrites ?? [])
    ) {
      return ok({ _tag: "Reconciled", detectedAt });
    }
    const projection = await this.dependencies.project({
      profileId: input.profileId,
      sessionId: session.id,
      snapshot: candidate,
      freshness: adoptedReview.value.freshness,
      refreshedAt:
        adoptedReview.value.representedRemote?.refreshedAt ?? nextReviewAt,
      pendingReview: {
        state: pending.pendingReview ?? { _tag: "None" },
        unavailable: !observedPending.available,
      },
    });
    return projection._tag === "ok"
      ? ok({ _tag: "Reconciled", detectedAt, projection: projection.value })
      : err({ reason: "storage" });
  }

  private async recoverUnlocked(input: {
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
    const review = await this.dependencies.reviews.load(
      input.profileId,
      input.reviewId,
    );
    const session = await this.dependencies.sessions.load(
      input.profileId,
      journal.value.sessionId,
    );
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

  private async load(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<
    Result<
      {
        readonly profile: Awaited<
          ReturnType<ProfileStore["load"]>
        > extends Result<infer T, unknown>
          ? T
          : never;
        readonly review: Review;
        readonly session: ReviewSession;
        readonly represented: ReviewRemoteSnapshot;
      },
      ReviewObservationFailure
    >
  > {
    const [profile, review] = await Promise.all([
      this.dependencies.profiles.load(input.profileId),
      this.dependencies.reviews.load(input.profileId, input.reviewId),
    ]);
    if (profile._tag === "err" || review._tag === "err")
      return err({
        reason:
          (profile._tag === "err" && profile.error.reason === "not_found") ||
          (review._tag === "err" && review.error.reason === "not_found")
            ? "not_found"
            : "storage",
      });
    if (
      review.value.representedRemote === undefined ||
      review.value.currentSessionId === undefined
    )
      return err({ reason: "storage" });
    const [session, represented] = await Promise.all([
      this.dependencies.sessions.load(
        input.profileId,
        review.value.currentSessionId,
      ),
      this.dependencies.remote.load({
        profileId: input.profileId,
        reviewId: input.reviewId,
        snapshotHash: review.value.representedRemote.snapshotHash,
      }),
    ]);
    if (session._tag === "err" || represented._tag === "err")
      return err({
        reason:
          session._tag === "err" && session.error.reason === "not_found"
            ? "not_found"
            : "storage",
      });
    return ok({
      profile: profile.value,
      review: review.value,
      session: session.value,
      represented: represented.value,
    });
  }

  private async readPending(
    profile: Awaited<ReturnType<ProfileStore["load"]>> extends Result<
      infer T,
      unknown
    >
      ? T
      : never,
    review: Review,
  ): Promise<{
    readonly read: PendingReviewRead;
    readonly available: boolean;
  }> {
    const account =
      await this.dependencies.github.resolveAuthenticatedAccount(profile);
    if (account._tag === "err")
      return { read: { _tag: "Unavailable" }, available: false };
    const accountName = parseGitHubLogin(account.value.account);
    if (accountName._tag === "err")
      return { read: { _tag: "Unavailable" }, available: false };
    const pending = await this.dependencies.github.getViewerPendingReview({
      profile,
      pr: reviewRef(review),
      account: accountName.value,
    });
    return pending._tag === "ok"
      ? { read: pending.value, available: pending.value._tag !== "Unavailable" }
      : { read: { _tag: "Unavailable" }, available: false };
  }

  private async readTerminalState(
    profile: Awaited<ReturnType<ProfileStore["load"]>> extends Result<
      infer T,
      unknown
    >
      ? T
      : never,
    review: Review,
    isOpen: boolean,
  ): Promise<"merged" | "closed"> {
    if (isOpen || this.dependencies.github.getMergeOutcome === undefined)
      return "closed";
    const outcome = await this.dependencies.github.getMergeOutcome({
      profile,
      pr: reviewRef(review),
    });
    return outcome._tag === "ok" && outcome.value.state === "merged"
      ? "merged"
      : "closed";
  }

  private async markUnavailable(
    input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
    review: Review,
    detectedAt: IsoTimestamp,
    reason: RevisionUnavailableReason,
  ): Promise<Result<ReviewObservation, ReviewObservationFailure>> {
    void input;
    const unavailable = markReviewUnavailable(
      review,
      { detectedAt, reason },
      nextTimestamp(review.updatedAt, detectedAt),
    );
    const saved = await this.dependencies.reviews.save(
      unavailable,
      review.updatedAt,
    );
    return saved._tag === "ok"
      ? ok({ _tag: "Unavailable", detectedAt, reason })
      : err({ reason: "storage" });
  }
}

function containsRecentWrites(
  snapshot: ReviewRemoteSnapshot,
  writes: ReadonlyArray<RecentReviewWrite>,
): boolean {
  return writes.every((write) => {
    if (write._tag === "PendingThread") {
      return snapshot.comments.threads.some(
        (thread) => thread.id === write.threadId,
      );
    }
    if (write._tag === "ThreadState") {
      return snapshot.comments.threads.some(
        (thread) =>
          thread.id === write.threadId && thread.state === write.state,
      );
    }
    if (write._tag === "DirectSummaryReview") {
      return (
        snapshot.publishedFeedback?.reviews.some(
          (review) =>
            review.id === write.reviewId || review.nodeId === write.reviewId,
        ) === true
      );
    }
    return (
      snapshot.comments.threads.some((thread) =>
        thread.comments.some((comment) => comment.id === write.commentId),
      ) ||
      snapshot.publishedFeedback?.comments.some(
        (comment) =>
          comment.id === write.commentId || comment.nodeId === write.commentId,
      ) === true
    );
  });
}

function applySessionAdoption(
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
  return {
    ...rest,
    ...(pendingReview === undefined ? {} : { pendingReview }),
    ...(findingReviewReceipts === undefined ||
    findingReviewReceipts.length === 0
      ? {}
      : { findingReviewReceipts }),
    updatedAt,
  };
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

function reviewRef(review: Review) {
  return {
    host: review.identity.host,
    owner: review.identity.owner,
    repo: review.identity.repo,
    number: review.identity.prNumber,
  };
}

function nextTimestamp(
  previous: IsoTimestamp,
  requested: IsoTimestamp,
): IsoTimestamp {
  const milliseconds = Math.max(
    Date.parse(previous) + 1,
    Date.parse(requested),
  );
  const next = new Date(milliseconds).toISOString();
  // Both inputs are parsed timestamps; this arithmetic always produces ISO.
  return next as IsoTimestamp;
}

function toMergeEvidence(
  policy: NonNullable<ReviewRemoteSnapshot["mergePolicy"]>,
  evidence?: NonNullable<ReviewRemoteSnapshot["mergeEvidence"]>["policy"],
): GitHubMergeEvidence {
  return {
    mergeable: policy.mergeability,
    mergeStateStatus: policy.mergeStateStatus ?? "unavailable",
    reviewDecision: policy.reviewDecision,
    ...(evidence === undefined ? {} : { policy: evidence }),
  };
}

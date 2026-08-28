import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { ReviewSession } from "../domain/review-session";
import {
  requireCurrentHead,
  type FreshReview,
  type ReviewWriteGate,
} from "./review-write-gate";

export type PublishedFeedbackFailure =
  | "not_fresh"
  | "not_found"
  | "permission_denied"
  | "confirmation_required"
  | "github_read_failed"
  | "github_write_failed"
  | "refresh_required"
  | "review_write_in_progress";

type FeedbackReader = Pick<
  GitHubReader,
  | "getPullRequest"
  | "getPullRequestComments"
  | "getPullRequestPublishedFeedback"
>;
type FeedbackWriter = Pick<
  GitHubReviewWriter,
  "updateReviewComment" | "deleteReviewComment" | "dismissReview"
>;

/** Owns explicit edits to already-published GitHub feedback. */
export class PublishedFeedbackService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireFresh">,
    private readonly github: FeedbackReader & FeedbackWriter,
    private readonly coordinator: ReviewOperationCoordinator,
    private readonly refresh?: (input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    }) => Promise<Result<unknown, unknown>>,
  ) {}

  async editComment(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly commentId: string;
    readonly body: string;
  }): Promise<Result<void, PublishedFeedbackFailure>> {
    if (input.body.trim().length === 0) return err("github_write_failed");
    const written = await this.serialized(input, async () => {
      const fresh = await this.fresh(input.profileId, input.reviewId);
      if (fresh._tag === "err") return fresh;
      const allowed = await this.authorizedComment(
        fresh.value.profile,
        fresh.value.session,
        input.commentId,
        "edit",
      );
      if (allowed._tag === "err") return allowed;
      const latestHead = await this.verifyHead(
        fresh.value.profile,
        fresh.value.session,
      );
      if (latestHead._tag === "err") return latestHead;
      const writer = this.github.updateReviewComment;
      if (writer === undefined) return err("github_write_failed");
      return this.classifyWrite(
        await writer({
          profile: fresh.value.profile,
          pr: sessionPr(fresh.value.session),
          commentId: input.commentId,
          body: input.body.trim(),
        }),
      );
    });
    // `serialized` has already released the Review lock by the time this
    // runs, so the refresh below cannot re-enter it. See `refreshAfterWrite`.
    return written._tag === "err" ? written : this.refreshAfterWrite(input);
  }

  async deleteComment(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly commentId: string;
    readonly confirmation: boolean;
  }): Promise<Result<void, PublishedFeedbackFailure>> {
    if (!input.confirmation) return err("confirmation_required");
    const written = await this.serialized(input, async () => {
      const fresh = await this.fresh(input.profileId, input.reviewId);
      if (fresh._tag === "err") return fresh;
      const allowed = await this.authorizedComment(
        fresh.value.profile,
        fresh.value.session,
        input.commentId,
        "delete",
      );
      if (allowed._tag === "err") return allowed;
      const latestHead = await this.verifyHead(
        fresh.value.profile,
        fresh.value.session,
      );
      if (latestHead._tag === "err") return latestHead;
      const writer = this.github.deleteReviewComment;
      if (writer === undefined) return err("github_write_failed");
      return this.classifyWrite(
        await writer({
          profile: fresh.value.profile,
          pr: sessionPr(fresh.value.session),
          commentId: input.commentId,
        }),
      );
    });
    // `serialized` has already released the Review lock by the time this
    // runs, so the refresh below cannot re-enter it. See `refreshAfterWrite`.
    return written._tag === "err" ? written : this.refreshAfterWrite(input);
  }

  async dismissReview(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly publishedReviewId: string;
    readonly message: string;
    readonly confirmation: boolean;
  }): Promise<Result<void, PublishedFeedbackFailure>> {
    if (!input.confirmation || input.message.trim().length === 0)
      return err(
        input.confirmation ? "github_write_failed" : "confirmation_required",
      );
    const written = await this.serialized(input, async () => {
      const fresh = await this.fresh(input.profileId, input.reviewId);
      if (fresh._tag === "err") return fresh;
      const allowed = await this.authorizedReview(
        fresh.value.profile,
        fresh.value.session,
        input.publishedReviewId,
      );
      if (allowed._tag === "err") return allowed;
      const latestHead = await this.verifyHead(
        fresh.value.profile,
        fresh.value.session,
      );
      if (latestHead._tag === "err") return latestHead;
      const writer = this.github.dismissReview;
      if (writer === undefined) return err("github_write_failed");
      return this.classifyWrite(
        await writer({
          profile: fresh.value.profile,
          pr: sessionPr(fresh.value.session),
          reviewId: input.publishedReviewId,
          message: input.message.trim(),
        }),
      );
    });
    // `serialized` has already released the Review lock by the time this
    // runs, so the refresh below cannot re-enter it. See `refreshAfterWrite`.
    return written._tag === "err" ? written : this.refreshAfterWrite(input);
  }

  private async serialized<
    T extends {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
  >(
    input: T,
    operation: () => Promise<Result<void, PublishedFeedbackFailure>>,
  ): Promise<Result<void, PublishedFeedbackFailure>> {
    const key = `${input.profileId}:${input.reviewId}`;
    if (!this.coordinator.acquire(key)) return err("review_write_in_progress");
    try {
      return await operation();
    } finally {
      this.coordinator.release(key);
    }
  }

  private async fresh(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<FreshReview, PublishedFeedbackFailure>> {
    const fresh = await this.gate.requireFresh(profileId, reviewId);
    if (fresh._tag === "err")
      return err(
        fresh.error.reason === "not_fresh"
          ? "not_fresh"
          : fresh.error.reason === "terminal"
            ? "permission_denied"
            : "not_found",
      );
    return fresh;
  }

  private async verifyHead(
    profile: WorkspaceProfileConfig,
    session: ReviewSession,
  ): Promise<Result<void, PublishedFeedbackFailure>> {
    const current = await requireCurrentHead(this.github, profile, session);
    if (current._tag === "ok") return ok(undefined);
    return err(
      current.error.reason === "github_read"
        ? "github_read_failed"
        : "not_fresh",
    );
  }

  private async authorizedComment(
    profile: WorkspaceProfileConfig,
    session: Parameters<typeof sessionPr>[0],
    commentId: string,
    action: "edit" | "delete",
  ): Promise<Result<void, PublishedFeedbackFailure>> {
    if (this.github.getPullRequestPublishedFeedback === undefined)
      return err("permission_denied");
    const feedback = await this.github.getPullRequestPublishedFeedback({
      profile,
      pr: sessionPr(session),
    });
    if (feedback._tag === "err") return err("github_read_failed");
    const comment = feedback.value.comments.find(
      (candidate) => candidate.id === commentId,
    );
    if (comment === undefined) return err("not_found");
    return (action === "edit" ? comment.canEdit : comment.canDelete)
      ? ok(undefined)
      : err("permission_denied");
  }

  private async authorizedReview(
    profile: WorkspaceProfileConfig,
    session: Parameters<typeof sessionPr>[0],
    reviewId: string,
  ): Promise<Result<void, PublishedFeedbackFailure>> {
    if (this.github.getPullRequestPublishedFeedback === undefined)
      return err("permission_denied");
    const feedback = await this.github.getPullRequestPublishedFeedback({
      profile,
      pr: sessionPr(session),
    });
    if (feedback._tag === "err") return err("github_read_failed");
    const review = feedback.value.reviews.find(
      (candidate) => candidate.id === reviewId,
    );
    return review === undefined
      ? err("not_found")
      : review.canDismiss
        ? ok(undefined)
        : err("permission_denied");
  }

  /**
   * Classifies the GitHub write's own outcome, INSIDE the Review lock.
   * Deliberately does not refresh: `ReviewRefreshService.refresh` takes the
   * same Review lock through `withReviewLock`, and `KeyedMutex` is not
   * reentrant, so refreshing here — before `serialized` releases the lock —
   * would queue behind this call's own lock and never complete. See
   * `refreshAfterWrite`.
   */
  private classifyWrite(
    result: Result<void, unknown>,
  ): Result<void, PublishedFeedbackFailure> {
    return result._tag === "err" ? err("github_write_failed") : ok(undefined);
  }

  /**
   * Runs only after `serialized` has already released the Review lock, so a
   * failure here can never strand it. Reconciles local state with the write
   * that already succeeded against GitHub; not part of the durable write
   * itself, so a caller can safely observe the write as done even if this
   * read reconciliation is still pending or fails.
   */
  private async refreshAfterWrite(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<void, PublishedFeedbackFailure>> {
    if (this.refresh === undefined) return ok(undefined);
    const refreshed = await this.refresh(input);
    return refreshed._tag === "ok" ? ok(undefined) : err("refresh_required");
  }
}

function sessionPr(session: {
  readonly key: {
    readonly host: PullRequestRef["host"];
    readonly owner: PullRequestRef["owner"];
    readonly repo: PullRequestRef["repo"];
    readonly prNumber: PullRequestRef["number"];
    readonly headSha?: string;
  };
}): PullRequestRef {
  return {
    host: session.key.host,
    owner: session.key.owner,
    repo: session.key.repo,
    number: session.key.prNumber,
  };
}

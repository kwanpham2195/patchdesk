import type {
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type { GitHubWriteFailure } from "../domain/github-write";
import type { GitHubPublishedFeedback } from "../domain/github-context";
import {
  parseGitHubReviewCommentId,
  parseGitHubReviewRestId,
  type IsoTimestamp,
  type ReviewId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import {
  confirmReviewWrite,
  markReviewWriteOutcomeUnknown,
  type ReviewWriteIntent,
  type ReviewWriteOperation,
  type ReviewWriteRevision,
} from "../domain/review-write-operation";
import { err, ok, type Result } from "../domain/result";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import {
  requireCurrentHead,
  type FreshReview,
  type ReviewWriteExpectation,
  type ReviewWriteGate,
} from "./review-write-gate";

export type PublishedFeedbackFailure =
  | "invalid_input"
  | "not_fresh"
  | "not_found"
  | "permission_denied"
  | "forbidden"
  | "confirmation_required"
  | "github_read_failed"
  | "github_write_failed"
  | "outcome_unknown"
  | "rate_limited"
  | "review_write_in_progress";

export type PublishedFeedbackReceipt =
  | {
      readonly _tag: "PublishedCommentEdited";
      readonly commentId: string;
      readonly reconciliation: "complete" | "required";
    }
  | {
      readonly _tag: "PublishedCommentDeleted";
      readonly commentId: string;
      readonly reconciliation: "complete" | "required";
    }
  | {
      readonly _tag: "PublishedReviewDismissed";
      readonly publishedReviewId: string;
      readonly reconciliation: "complete" | "required";
    };

type FeedbackReader = Pick<
  GitHubReader,
  "getPullRequest" | "getPullRequestPublishedFeedback"
>;
type FeedbackWriter = Pick<
  GitHubReviewWriter,
  "updateReviewComment" | "deleteReviewComment" | "dismissReview"
>;

type PublishedFeedbackInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expected: ReviewWriteExpectation;
};

type ConfirmedReceipt =
  | { readonly _tag: "PublishedCommentEdited"; readonly commentId: string }
  | { readonly _tag: "PublishedCommentDeleted"; readonly commentId: string }
  | {
      readonly _tag: "PublishedReviewDismissed";
      readonly publishedReviewId: string;
    };

/** Owns explicit edits to already-published GitHub feedback. */
export class PublishedFeedbackService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireFresh">,
    private readonly github: FeedbackReader & FeedbackWriter,
    private readonly coordinator: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp,
    private readonly recentWrites: Pick<RecentWriteJournalStore, "append">,
    private readonly operations: Pick<
      ReviewWriteOperationStore,
      "load" | "begin" | "markOutcomeUnknown" | "confirm" | "reject" | "remove"
    >,
    private readonly refresh?: (input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    }) => Promise<Result<unknown, unknown>>,
  ) {}

  async editComment(
    input: PublishedFeedbackInput & {
      readonly commentId: string;
      readonly body: string;
    },
  ): Promise<Result<PublishedFeedbackReceipt, PublishedFeedbackFailure>> {
    const body = input.body.trim();
    if (
      body.length === 0 ||
      parseGitHubReviewCommentId(input.commentId)._tag === "err"
    )
      return err("invalid_input");
    return this.serialized(input, async () => {
      const prepared = await this.prepare(input);
      if (prepared._tag === "err") return prepared;
      const allowed = this.authorizedComment(
        prepared.value.feedback,
        input.commentId,
        "edit",
      );
      if (allowed._tag === "err") return allowed;
      const canonicalCommentId = parseGitHubReviewCommentId(allowed.value.id);
      if (canonicalCommentId._tag === "err") return err("github_read_failed");
      const writer = this.github.updateReviewComment?.bind(this.github);
      if (writer === undefined) return err("github_write_failed");
      return this.runDurableWrite(
        input,
        {
          _tag: "EditPublishedComment",
          expected: revision(input.expected),
          commentId: canonicalCommentId.value,
          body,
        },
        () =>
          writer({
            profile: prepared.value.fresh.profile,
            pr: sessionPr(prepared.value.fresh.session),
            commentId: allowed.value.id,
            body,
          }),
        {
          _tag: "PublishedCommentEdited",
          commentId: input.commentId,
        },
        { _tag: "Comment", commentId: allowed.value.id },
      );
    });
  }

  async deleteComment(
    input: PublishedFeedbackInput & {
      readonly commentId: string;
      readonly confirmation: boolean;
    },
  ): Promise<Result<PublishedFeedbackReceipt, PublishedFeedbackFailure>> {
    if (!input.confirmation) return err("confirmation_required");
    if (parseGitHubReviewCommentId(input.commentId)._tag === "err")
      return err("invalid_input");
    return this.serialized(input, async () => {
      const prepared = await this.prepare(input);
      if (prepared._tag === "err") return prepared;
      const allowed = this.authorizedComment(
        prepared.value.feedback,
        input.commentId,
        "delete",
      );
      if (allowed._tag === "err") return allowed;
      const canonicalCommentId = parseGitHubReviewCommentId(allowed.value.id);
      if (canonicalCommentId._tag === "err") return err("github_read_failed");
      const writer = this.github.deleteReviewComment?.bind(this.github);
      if (writer === undefined) return err("github_write_failed");
      return this.runDurableWrite(
        input,
        {
          _tag: "DeletePublishedComment",
          expected: revision(input.expected),
          commentId: canonicalCommentId.value,
        },
        () =>
          writer({
            profile: prepared.value.fresh.profile,
            pr: sessionPr(prepared.value.fresh.session),
            commentId: allowed.value.id,
          }),
        { _tag: "PublishedCommentDeleted", commentId: input.commentId },
      );
    });
  }

  async dismissReview(
    input: PublishedFeedbackInput & {
      readonly publishedReviewId: string;
      readonly message: string;
      readonly confirmation: boolean;
    },
  ): Promise<Result<PublishedFeedbackReceipt, PublishedFeedbackFailure>> {
    if (!input.confirmation) return err("confirmation_required");
    const message = input.message.trim();
    const publishedReviewId = parseGitHubReviewRestId(input.publishedReviewId);
    if (message.length === 0 || publishedReviewId._tag === "err")
      return err("invalid_input");
    return this.serialized(input, async () => {
      const prepared = await this.prepare(input);
      if (prepared._tag === "err") return prepared;
      const allowed = this.authorizedReview(
        prepared.value.feedback,
        input.publishedReviewId,
      );
      if (allowed._tag === "err") return allowed;
      const writer = this.github.dismissReview?.bind(this.github);
      if (writer === undefined) return err("github_write_failed");
      return this.runDurableWrite(
        input,
        {
          _tag: "DismissPublishedReview",
          expected: revision(input.expected),
          publishedReviewId: publishedReviewId.value,
          message,
        },
        () =>
          writer({
            profile: prepared.value.fresh.profile,
            pr: sessionPr(prepared.value.fresh.session),
            reviewId: publishedReviewId.value,
            message,
          }),
        {
          _tag: "PublishedReviewDismissed",
          publishedReviewId: input.publishedReviewId,
        },
      );
    });
  }

  private async serialized(
    input: PublishedFeedbackInput,
    operation: () => Promise<
      Result<ConfirmedReceipt, PublishedFeedbackFailure>
    >,
  ): Promise<Result<PublishedFeedbackReceipt, PublishedFeedbackFailure>> {
    const key = `${input.profileId}:${input.reviewId}`;
    if (!this.coordinator.acquire(key)) return err("review_write_in_progress");
    let written: Result<ConfirmedReceipt, PublishedFeedbackFailure>;
    try {
      const active = await this.operations.load(
        input.profileId,
        input.reviewId,
      );
      if (active._tag === "err" || active.value !== undefined)
        return err("outcome_unknown");
      written = await operation();
    } finally {
      this.coordinator.release(key);
    }
    if (written._tag === "err") return written;
    const reconciliation = await this.refreshAfterWrite(input);
    switch (written.value._tag) {
      case "PublishedCommentEdited":
      case "PublishedCommentDeleted":
        return ok({
          _tag: written.value._tag,
          commentId: written.value.commentId,
          reconciliation,
        });
      case "PublishedReviewDismissed":
        return ok({
          _tag: written.value._tag,
          publishedReviewId: written.value.publishedReviewId,
          reconciliation,
        });
    }
  }

  private async prepare(input: PublishedFeedbackInput): Promise<
    Result<
      {
        readonly fresh: FreshReview;
        readonly feedback: GitHubPublishedFeedback;
      },
      PublishedFeedbackFailure
    >
  > {
    const fresh = await this.gate.requireFresh(
      input.profileId,
      input.reviewId,
      input.expected,
    );
    if (fresh._tag === "err")
      return err(
        fresh.error.reason === "not_fresh" || fresh.error.reason === "stale"
          ? "not_fresh"
          : fresh.error.reason === "terminal"
            ? "permission_denied"
            : "not_found",
      );
    const getFeedback = this.github.getPullRequestPublishedFeedback?.bind(
      this.github,
    );
    if (getFeedback === undefined) return err("permission_denied");
    const feedback = await getFeedback({
      profile: fresh.value.profile,
      pr: sessionPr(fresh.value.session),
    });
    if (feedback._tag === "err") return err("github_read_failed");
    const current = await requireCurrentHead(
      this.github,
      fresh.value.profile,
      fresh.value.session,
    );
    if (current._tag === "err")
      return err(
        current.error.reason === "github_read"
          ? "github_read_failed"
          : "not_fresh",
      );
    return ok({ fresh: fresh.value, feedback: feedback.value });
  }

  private authorizedComment(
    feedback: GitHubPublishedFeedback,
    commentId: string,
    action: "edit" | "delete",
  ): Result<
    GitHubPublishedFeedback["comments"][number],
    PublishedFeedbackFailure
  > {
    const comment = feedback.comments.find(
      (candidate) =>
        candidate.id === commentId || candidate.nodeId === commentId,
    );
    if (comment === undefined) return err("not_found");
    return (action === "edit" ? comment.canEdit : comment.canDelete)
      ? ok(comment)
      : err("permission_denied");
  }

  private authorizedReview(
    feedback: GitHubPublishedFeedback,
    reviewId: string,
  ): Result<void, PublishedFeedbackFailure> {
    const review = feedback.reviews.find(
      (candidate) => candidate.id === reviewId,
    );
    return review === undefined
      ? err("not_found")
      : review.canDismiss
        ? ok(undefined)
        : err("permission_denied");
  }

  private async runDurableWrite(
    input: PublishedFeedbackInput,
    intent: Extract<
      ReviewWriteIntent,
      {
        readonly _tag:
          | "EditPublishedComment"
          | "DeletePublishedComment"
          | "DismissPublishedReview";
      }
    >,
    write: () => Promise<Result<void, GitHubWriteFailure>>,
    receipt: ConfirmedReceipt,
    journalEntry?: RecentReviewWrite,
  ): Promise<Result<ConfirmedReceipt, PublishedFeedbackFailure>> {
    const operation: ReviewWriteOperation = {
      schemaVersion: 1,
      profileId: input.profileId,
      reviewId: input.reviewId,
      sessionId: intent.expected.sessionId,
      intent,
      state: { _tag: "Requested" },
      startedAt: this.now(),
    };
    const begun = await this.operations.begin(operation);
    if (begun._tag === "err") return err("outcome_unknown");
    const outcomeUnknown = markReviewWriteOutcomeUnknown(operation);
    if (outcomeUnknown._tag === "err") return err("outcome_unknown");
    const marked = await this.operations.markOutcomeUnknown(
      outcomeUnknown.value,
    );
    if (marked._tag === "err") return err("outcome_unknown");
    let result: Result<void, GitHubWriteFailure>;
    try {
      result = await write();
    } catch {
      return err("outcome_unknown");
    }
    if (result._tag === "err") {
      if (result.error.category === "unavailable")
        return err("outcome_unknown");
      const rejected = await this.operations.reject(operation);
      if (rejected._tag === "err") return err("outcome_unknown");
      return err(mapWriteFailure(result.error));
    }
    const transitioned = confirmReviewWrite(outcomeUnknown.value, journalEntry);
    if (transitioned._tag === "err") return err("outcome_unknown");
    const confirmed = await this.operations.confirm(transitioned.value);
    if (confirmed._tag === "err") return err("outcome_unknown");
    if (journalEntry !== undefined) {
      const appended = await this.recentWrites.append(
        input.profileId,
        input.reviewId,
        journalEntry,
        this.now(),
      );
      if (appended._tag === "err") return err("outcome_unknown");
    }
    const removed = await this.operations.remove(
      input.profileId,
      input.reviewId,
    );
    return removed._tag === "err" ? err("outcome_unknown") : ok(receipt);
  }

  private async refreshAfterWrite(
    input: PublishedFeedbackInput,
  ): Promise<"complete" | "required"> {
    if (this.refresh === undefined) return "complete";
    const refreshed = await this.refresh(input);
    return refreshed._tag === "ok" ? "complete" : "required";
  }
}

function revision(expected: ReviewWriteExpectation): ReviewWriteRevision {
  return expected;
}

function mapWriteFailure(
  failure: GitHubWriteFailure,
): PublishedFeedbackFailure {
  switch (failure.category) {
    case "pending_review":
    case "rejected":
      return "github_write_failed";
    case "rate_limited":
      return "rate_limited";
    case "forbidden":
      return "forbidden";
    case "auth":
      return "permission_denied";
    case "unavailable":
      return "outcome_unknown";
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

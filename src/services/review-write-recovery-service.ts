import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ConfirmedWriteJournal } from "../adapters/storage/recent-write-journal-store";
import type { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import type {
  GitHubComments,
  GitHubComment,
  GitHubPublishedFeedback,
  PullRequestSummary,
} from "../domain/github-context";
import type { ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestReviewSession } from "../domain/review-session";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import {
  confirmReviewWrite,
  markReviewWriteOutcomeUnknown,
  setReviewWriteResolution,
  type ReviewWriteOperation,
} from "../domain/review-write-operation";
import { casesHandled, err, ok, type Result } from "../domain/result";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import { requireCurrentHead, type ReviewWriteGate } from "./review-write-gate";

/** Read-only outcome of checking one durable uncertain Review write. */
export type ReviewWriteRecovery =
  | { readonly _tag: "NoOperation" }
  | { readonly _tag: "Confirmed"; readonly receipt?: RecentReviewWrite }
  | { readonly _tag: "Rejected" }
  | { readonly _tag: "CheckRequired" }
  | { readonly _tag: "ManualResolutionRequired" };

/** Bounded failure from recovery; no raw storage or GitHub details escape. */
export type ReviewWriteRecoveryFailure =
  | "storage"
  | "not_found"
  | "not_fresh"
  | "github_read_failed"
  | "review_write_in_progress";

type RecoveryGateway = Pick<
  GitHubReader,
  | "getPullRequest"
  | "getPullRequestComments"
  | "getPullRequestPublishedFeedback"
>;

/** Reconciles uncertain Review writes only through complete GitHub reads. */
export class ReviewWriteRecoveryService {
  constructor(
    private readonly gate: Pick<
      ReviewWriteGate,
      "requireFresh" | "requireCurrentSession"
    >,
    private readonly github: RecoveryGateway,
    private readonly operations: Pick<
      ReviewWriteOperationStore,
      "load" | "markOutcomeUnknown" | "confirm" | "remove"
    >,
    private readonly recentWrites: ConfirmedWriteJournal,
    private readonly coordinator: ReviewOperationCoordinator,
    private readonly now: () => Parameters<
      ConfirmedWriteJournal["appendConfirmed"]
    >[3],
  ) {}

  /** Check remote evidence for one operation without ever replaying its mutation. */
  async recover(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<ReviewWriteRecovery, ReviewWriteRecoveryFailure>> {
    const key = `${input.profileId}:${input.reviewId}`;
    if (!this.coordinator.acquire(key)) return err("review_write_in_progress");
    try {
      const loaded = await this.operations.load(
        input.profileId,
        input.reviewId,
      );
      if (loaded._tag === "err") return err("storage");
      if (loaded.value === undefined) return ok({ _tag: "NoOperation" });
      return await this.recoverOperation(loaded.value);
    } finally {
      this.coordinator.release(key);
    }
  }

  private async recoverOperation(
    operation: ReviewWriteOperation,
  ): Promise<Result<ReviewWriteRecovery, ReviewWriteRecoveryFailure>> {
    if (operation.state._tag === "Confirmed")
      return this.finishConfirmed(operation, operation.state.receipt);
    if (!("expected" in operation.intent))
      return this.recoverMetadataOperation(operation);
    const fresh = await this.gate.requireFresh(
      operation.profileId,
      operation.reviewId,
      operation.intent.expected,
    );
    if (fresh._tag === "err")
      return err(
        fresh.error.reason === "not_fresh" || fresh.error.reason === "stale"
          ? "not_fresh"
          : "not_found",
      );
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
    switch (operation.intent._tag) {
      case "EditPublishedComment":
      case "DeletePublishedComment":
      case "DismissPublishedReview":
        return this.recoverPublishedFeedbackOperation(
          operation,
          fresh.value.profile,
          fresh.value.session,
        );
      case "CreateComment":
      case "Reply":
      case "SetThreadState":
      case "EditComment":
      case "DeleteComment":
        break;
      default:
        return casesHandled(operation.intent);
    }
    const comments = await this.github.getPullRequestComments({
      profile: fresh.value.profile,
      pr: {
        host: fresh.value.session.key.host,
        owner: fresh.value.session.key.owner,
        repo: fresh.value.session.key.repo,
        number: fresh.value.session.key.source.prNumber,
      },
    });
    if (comments._tag === "err") return err("github_read_failed");
    if (comments.value.complete !== true)
      return this.retain(operation, "check_required");
    const classified = classifyConversationIntent(operation, comments.value);
    if (classified._tag === "CheckRequired")
      return this.retain(operation, "check_required");
    if (classified._tag === "ManualResolutionRequired")
      return this.retain(operation, "manual_resolution_required");
    return this.finishConfirmed(operation, classified.receipt);
  }

  private async recoverPublishedFeedbackOperation(
    operation: ReviewWriteOperation,
    profile: Parameters<
      NonNullable<RecoveryGateway["getPullRequestPublishedFeedback"]>
    >[0]["profile"],
    session: Pick<PullRequestReviewSession, "key">,
  ): Promise<Result<ReviewWriteRecovery, ReviewWriteRecoveryFailure>> {
    const read = this.github.getPullRequestPublishedFeedback?.bind(this.github);
    if (read === undefined) return err("github_read_failed");
    const feedback = await read({
      profile,
      pr: {
        host: session.key.host,
        owner: session.key.owner,
        repo: session.key.repo,
        number: session.key.source.prNumber,
      },
    });
    if (feedback._tag === "err") return err("github_read_failed");
    if (feedback.value.complete !== true)
      return this.retain(operation, "check_required");
    const classified = classifyPublishedFeedbackIntent(
      operation,
      feedback.value,
    );
    return classified._tag === "CheckRequired"
      ? this.retain(operation, "check_required")
      : classified._tag === "ManualResolutionRequired"
        ? this.retain(operation, "manual_resolution_required")
        : this.finishConfirmed(operation, classified.receipt);
  }

  private async recoverMetadataOperation(
    operation: ReviewWriteOperation,
  ): Promise<Result<ReviewWriteRecovery, ReviewWriteRecoveryFailure>> {
    const current = await this.gate.requireCurrentSession(
      operation.profileId,
      operation.reviewId,
    );
    if (current._tag === "err")
      return err(
        current.error.reason === "not_found" ? "not_found" : "not_fresh",
      );
    if (current.value.session.id !== operation.sessionId)
      return err("not_fresh");
    const pullRequest = await this.github.getPullRequest({
      profile: current.value.profile,
      pr: {
        host: current.value.session.key.host,
        owner: current.value.session.key.owner,
        repo: current.value.session.key.repo,
        number: current.value.session.key.source.prNumber,
      },
    });
    if (pullRequest._tag === "err") return err("github_read_failed");
    const receipt = classifyMetadataIntent(operation, pullRequest.value);
    return receipt === undefined
      ? this.retain(operation, "check_required")
      : this.finishConfirmed(operation, receipt);
  }

  private async retain(
    operation: ReviewWriteOperation,
    resolution: "check_required" | "manual_resolution_required",
  ): Promise<Result<ReviewWriteRecovery, ReviewWriteRecoveryFailure>> {
    const transitioned =
      operation.state._tag === "Requested"
        ? markReviewWriteOutcomeUnknown(operation, resolution)
        : setReviewWriteResolution(operation, resolution);
    if (transitioned._tag === "err") return err("storage");
    const saved = await this.operations.markOutcomeUnknown(transitioned.value);
    if (saved._tag === "err") return err("storage");
    return ok({
      _tag:
        resolution === "check_required"
          ? "CheckRequired"
          : "ManualResolutionRequired",
    });
  }

  private async finishConfirmed(
    operation: ReviewWriteOperation,
    receipt: RecentReviewWrite | undefined,
  ): Promise<Result<ReviewWriteRecovery, ReviewWriteRecoveryFailure>> {
    if (operation.state._tag !== "Confirmed") {
      const outcomeUnknown =
        operation.state._tag === "Requested"
          ? markReviewWriteOutcomeUnknown(operation)
          : ok(operation);
      if (outcomeUnknown._tag === "err") return err("storage");
      const transitioned = confirmReviewWrite(outcomeUnknown.value, receipt);
      if (transitioned._tag === "err") return err("storage");
      const confirmed = await this.operations.confirm(transitioned.value);
      if (confirmed._tag === "err") return err("storage");
    }
    if (receipt !== undefined)
      await this.recentWrites.appendConfirmed(
        operation.profileId,
        operation.reviewId,
        receipt,
        this.now(),
      );
    const removed = await this.operations.remove(
      operation.profileId,
      operation.reviewId,
    );
    if (removed._tag === "err") return err("storage");
    return ok(
      receipt === undefined
        ? { _tag: "Confirmed" }
        : { _tag: "Confirmed", receipt },
    );
  }
}

type ClassifiedRecovery =
  | { readonly _tag: "Confirmed"; readonly receipt?: RecentReviewWrite }
  | { readonly _tag: "CheckRequired" }
  | { readonly _tag: "ManualResolutionRequired" };

/** Classify only complete comment evidence; callers enforce completeness first. */
export function classifyConversationIntent(
  operation: ReviewWriteOperation,
  comments: GitHubComments,
): ClassifiedRecovery {
  const intent = operation.intent;
  switch (intent._tag) {
    case "SetThreadState": {
      const thread = comments.threads.find(
        (entry) => entry.id === intent.threadId,
      );
      if (thread?.state !== intent.state) return { _tag: "CheckRequired" };
      return {
        _tag: "Confirmed",
        receipt: {
          _tag: "ThreadState",
          threadId: thread.id,
          state: intent.state,
        },
      };
    }
    case "DeleteComment":
      return allThreadComments(comments).some(
        (entry) => entry.comment.id === intent.commentId,
      )
        ? { _tag: "CheckRequired" }
        : { _tag: "Confirmed" };
    case "EditComment": {
      const match = allThreadComments(comments).find(
        (entry) => entry.comment.id === intent.commentId,
      );
      return match !== undefined && sameBody(match.comment.body, intent.body)
        ? {
            _tag: "Confirmed",
            receipt: { _tag: "Comment", commentId: intent.commentId },
          }
        : { _tag: "CheckRequired" };
    }
    case "CreateComment":
    case "Reply":
      return classifyAuthoredComment(operation, intent, comments);
    // Published-feedback and metadata intents never reach this classifier; stay locked for a manual check.
    case "EditPublishedComment":
    case "DeletePublishedComment":
    case "DismissPublishedReview":
    case "AddLabels":
    case "RemoveLabels":
    case "AddAssignees":
    case "RemoveAssignees":
    case "RequestReviewers":
    case "RemoveReviewers":
    case "SetDraftState":
    case "SetBaseBranch":
      return { _tag: "CheckRequired" };
    default:
      return casesHandled(intent);
  }
}

function allThreadComments(comments: GitHubComments) {
  return comments.threads.flatMap((thread) =>
    thread.comments.map((comment) => ({ thread, comment })),
  );
}

function classifyAuthoredComment(
  operation: ReviewWriteOperation,
  intent: Extract<
    ReviewWriteOperation["intent"],
    { readonly _tag: "CreateComment" | "Reply" }
  >,
  comments: GitHubComments,
): ClassifiedRecovery {
  const candidates = allThreadComments(comments).filter(
    ({ thread, comment }) => {
      if (
        !isMatchingAuthoredComment(
          comment,
          intent.body,
          operation.startedAt,
          intent.actor,
        )
      )
        return false;
      if (intent._tag === "Reply") return thread.id === intent.threadId;
      const location = comment.location ?? thread.location;
      return (
        location?.path === intent.anchor.path &&
        location.line === intent.anchor.startLine &&
        (location.lineEnd ?? location.line) === intent.anchor.line &&
        location.diffSide === intent.anchor.side
      );
    },
  );
  if (candidates.length === 0) return { _tag: "CheckRequired" };
  if (candidates.length > 1) return { _tag: "ManualResolutionRequired" };
  const candidate = candidates[0];
  if (candidate === undefined) return { _tag: "CheckRequired" };
  return {
    _tag: "Confirmed",
    receipt: { _tag: "Comment", commentId: candidate.comment.id },
  };
}

/** Confirm metadata membership only when the relevant pull request evidence is complete. */
export function classifyMetadataIntent(
  operation: ReviewWriteOperation,
  pullRequest: PullRequestSummary,
): RecentReviewWrite | undefined {
  const intent = operation.intent;
  switch (intent._tag) {
    case "AddLabels":
    case "RemoveLabels": {
      const names = new Set(pullRequest.labels.map((label) => label.name));
      const confirmed = intent.names.every((name) =>
        intent._tag === "AddLabels" ? names.has(name) : !names.has(name),
      );
      if (!confirmed) return undefined;
      return intent._tag === "AddLabels"
        ? { _tag: "LabelChange", added: intent.names, removed: [] }
        : { _tag: "LabelChange", added: [], removed: intent.names };
    }
    case "AddAssignees":
    case "RemoveAssignees": {
      if (pullRequest.assignees === undefined) return undefined;
      const logins = new Set(pullRequest.assignees);
      const confirmed = intent.logins.every((login) =>
        intent._tag === "AddAssignees" ? logins.has(login) : !logins.has(login),
      );
      if (!confirmed) return undefined;
      return intent._tag === "AddAssignees"
        ? { _tag: "AssigneeChange", added: intent.logins, removed: [] }
        : { _tag: "AssigneeChange", added: [], removed: intent.logins };
    }
    case "RequestReviewers":
    case "RemoveReviewers": {
      if (pullRequest.requestedReviewers === undefined) return undefined;
      const logins = new Set(pullRequest.requestedReviewers);
      const confirmed = intent.logins.every((login) =>
        intent._tag === "RequestReviewers"
          ? logins.has(login)
          : !logins.has(login),
      );
      if (!confirmed) return undefined;
      return intent._tag === "RequestReviewers"
        ? { _tag: "ReviewerChange", requested: intent.logins, removed: [] }
        : { _tag: "ReviewerChange", requested: [], removed: intent.logins };
    }
    case "SetDraftState":
      // `isDraft` is required on every pull request read, so a mismatch is real evidence the write did not land.
      return pullRequest.isDraft === intent.draft
        ? { _tag: "DraftStateChange", draft: intent.draft }
        : undefined;
    case "SetBaseBranch":
      return pullRequest.baseBranch === intent.branch
        ? { _tag: "BaseBranchChange", branch: intent.branch }
        : undefined;
    // Conversation and published-feedback intents are not confirmed from pull request metadata.
    case "CreateComment":
    case "Reply":
    case "SetThreadState":
    case "EditComment":
    case "DeleteComment":
    case "EditPublishedComment":
    case "DeletePublishedComment":
    case "DismissPublishedReview":
      return undefined;
    default:
      return casesHandled(intent);
  }
}

/** Classify a published-feedback intent only after the caller proves a complete read. */
export function classifyPublishedFeedbackIntent(
  operation: ReviewWriteOperation,
  feedback: GitHubPublishedFeedback,
): ClassifiedRecovery {
  const intent = operation.intent;
  switch (intent._tag) {
    case "EditPublishedComment": {
      const comment = feedback.comments.find(
        (candidate) => candidate.id === intent.commentId,
      );
      return comment !== undefined && sameBody(comment.body, intent.body)
        ? {
            _tag: "Confirmed",
            receipt: { _tag: "Comment", commentId: intent.commentId },
          }
        : { _tag: "CheckRequired" };
    }
    case "DeletePublishedComment":
      return feedback.comments.some(
        (candidate) => candidate.id === intent.commentId,
      )
        ? { _tag: "CheckRequired" }
        : { _tag: "Confirmed" };
    case "DismissPublishedReview": {
      const review = feedback.reviews.find(
        (candidate) => candidate.id === intent.publishedReviewId,
      );
      return review?.event === "DISMISSED"
        ? { _tag: "Confirmed" }
        : { _tag: "CheckRequired" };
    }
    // Conversation and metadata intents are not confirmed from published feedback; stay locked for a manual check.
    case "CreateComment":
    case "Reply":
    case "SetThreadState":
    case "EditComment":
    case "DeleteComment":
    case "AddLabels":
    case "RemoveLabels":
    case "AddAssignees":
    case "RemoveAssignees":
    case "RequestReviewers":
    case "RemoveReviewers":
    case "SetDraftState":
    case "SetBaseBranch":
      return { _tag: "CheckRequired" };
    default:
      return casesHandled(intent);
  }
}

function isMatchingAuthoredComment(
  comment: GitHubComment,
  body: string,
  startedAt: Parameters<DateConstructor["parse"]>[0],
  actor: string,
): boolean {
  return (
    comment.viewerDidAuthor === true &&
    comment.author.toLowerCase() === actor.toLowerCase() &&
    sameBody(comment.body, body) &&
    Date.parse(comment.createdAt) >= Date.parse(startedAt)
  );
}

function sameBody(left: string, right: string): boolean {
  return (
    left.replaceAll("\r\n", "\n").trim() ===
    right.replaceAll("\r\n", "\n").trim()
  );
}

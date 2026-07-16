import type { FindingId, IsoTimestamp, RepoRelativePath, ReviewAttemptId, ReviewSessionId } from "./ids";
import { err, ok, type Result } from "./result";

export type GitHubReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export type GitHubWriteFailure = {
  readonly _tag: "GitHubWriteFailure";
  readonly category: "auth" | "rejected" | "unavailable";
  readonly message: string;
};

export type ReviewDraftState =
  | { readonly _tag: "LocalDraft" }
  | { readonly _tag: "PendingGitHubReview"; readonly pendingReviewId: string; readonly commentCount: number }
  | { readonly _tag: "SubmittedGitHubReview"; readonly reviewId: string; readonly event: GitHubReviewEvent }
  | { readonly _tag: "DraftFailed"; readonly error: GitHubWriteFailure };

export type DraftComment = {
  readonly findingId: FindingId;
  readonly include: boolean;
  readonly originalSuggestedBody: string;
  readonly body: string;
  readonly path: RepoRelativePath;
  readonly line: number;
  readonly lineEnd?: number;
  readonly diffSide: "new" | "old";
  readonly postability: "postable" | "invalid_line" | "stale_sha" | "api_rejected";
};

export type ReviewDraft = {
  readonly sessionId: ReviewSessionId;
  readonly attemptId: ReviewAttemptId;
  readonly state: ReviewDraftState;
  readonly summaryBody: string;
  readonly suggestedEvent: GitHubReviewEvent;
  readonly comments: ReadonlyArray<DraftComment>;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

/** A draft blocks rerun until it has been submitted or explicitly failed. */
export function hasActiveDraft(draft: Pick<ReviewDraft, "state">): boolean {
  return draft.state._tag === "LocalDraft" || draft.state._tag === "PendingGitHubReview";
}

/** Re-arms a rejected draft only after an explicit user edit; Patchdesk never silently splits or retries a batch. */
export function editFailedDraftComment(
  draft: ReviewDraft,
  findingId: FindingId,
  body: string,
  updatedAt: IsoTimestamp,
): Result<ReviewDraft, { readonly _tag: "DraftNotEditable" } | { readonly _tag: "DraftEditRequired" }> {
  if (draft.state._tag !== "DraftFailed") return err({ _tag: "DraftNotEditable" });
  const target = draft.comments.find((comment) => comment.findingId === findingId);
  if (target === undefined || body.trim().length === 0 || body === target.body)
    return err({ _tag: "DraftEditRequired" });
  return ok({
    ...draft,
    state: { _tag: "LocalDraft" },
    comments: draft.comments.map((comment) =>
      comment.findingId === findingId
        ? { ...comment, body, postability: "postable" as const }
        : comment,
    ),
    updatedAt,
  });
}

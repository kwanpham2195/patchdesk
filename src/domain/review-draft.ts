import * as v from "valibot";

import {
  parseFindingId,
  parseIsoTimestamp,
  parseRepoRelativePath,
  parseReviewAttemptId,
  parseReviewSessionId,
  type FindingId,
  type IsoTimestamp,
  type RepoRelativePath,
  type ReviewAttemptId,
  type ReviewSessionId,
} from "./ids";
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
  readonly postability: "postable" | "already_reported" | "invalid_line" | "stale_sha" | "api_rejected";
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

const draftSchema = v.strictObject({
  sessionId: v.string(),
  attemptId: v.string(),
  state: v.variant("_tag", [
    v.strictObject({ _tag: v.literal("LocalDraft") }),
    v.strictObject({ _tag: v.literal("PendingGitHubReview"), pendingReviewId: v.pipe(v.string(), v.minLength(1)), commentCount: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
    v.strictObject({ _tag: v.literal("SubmittedGitHubReview"), reviewId: v.pipe(v.string(), v.minLength(1)), event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]) }),
    v.strictObject({ _tag: v.literal("DraftFailed"), error: v.strictObject({ _tag: v.literal("GitHubWriteFailure"), category: v.picklist(["auth", "rejected", "unavailable"]), message: v.pipe(v.string(), v.minLength(1)) }) }),
  ]),
  summaryBody: v.string(),
  suggestedEvent: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  comments: v.array(v.strictObject({
    findingId: v.string(), include: v.boolean(), originalSuggestedBody: v.string(), body: v.string(), path: v.string(), line: v.pipe(v.number(), v.integer(), v.minValue(1)), lineEnd: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))), diffSide: v.picklist(["new", "old"]), postability: v.picklist(["postable", "already_reported", "invalid_line", "stale_sha", "api_rejected"]),
  })),
  createdAt: v.string(),
  updatedAt: v.string(),
});

/** Parse a renderer-provided draft before it can cross into a GitHub write service. */
export function parseReviewDraft(input: unknown): Result<ReviewDraft, { readonly _tag: "InvalidReviewDraft" }> {
  const raw = v.safeParse(draftSchema, input);
  if (!raw.success) return err({ _tag: "InvalidReviewDraft" });
  const sessionId = parseReviewSessionId(raw.output.sessionId);
  const attemptId = parseReviewAttemptId(raw.output.attemptId);
  const createdAt = parseIsoTimestamp(raw.output.createdAt);
  const updatedAt = parseIsoTimestamp(raw.output.updatedAt);
  if (sessionId._tag === "err" || attemptId._tag === "err" || createdAt._tag === "err" || updatedAt._tag === "err") return err({ _tag: "InvalidReviewDraft" });
  const comments: DraftComment[] = [];
  for (const comment of raw.output.comments) {
    const findingId = parseFindingId(comment.findingId);
    const path = parseRepoRelativePath(comment.path);
    if (findingId._tag === "err" || path._tag === "err" || (comment.lineEnd !== undefined && comment.lineEnd < comment.line)) return err({ _tag: "InvalidReviewDraft" });
    comments.push({
      findingId: findingId.value,
      include: comment.include,
      originalSuggestedBody: comment.originalSuggestedBody,
      body: comment.body,
      path: path.value,
      line: comment.line,
      ...(comment.lineEnd === undefined ? {} : { lineEnd: comment.lineEnd }),
      diffSide: comment.diffSide,
      postability: comment.postability,
    });
  }
  return ok({ ...raw.output, sessionId: sessionId.value, attemptId: attemptId.value, comments, createdAt: createdAt.value, updatedAt: updatedAt.value });
}

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

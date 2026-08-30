import type { Context, Hono } from "hono";
import {
  boolean,
  minLength,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import {
  parseContentHash,
  parseGitSha,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../domain/ids";
import { err, type Result } from "../../domain/result";
import type {
  PublishedFeedbackFailure,
  PublishedFeedbackReceipt,
  PublishedFeedbackService,
} from "../../services/published-feedback-service";
import type { ReviewWriteExpectation } from "../../services/review-write-gate";
import type { LocalApiContainer } from "../local-api-container";
import { jsonBody } from "./json-body";
import { mapReviewWriteFailureStatus } from "./http-status";

/** Edits, deletes and dismissals of feedback GitHub has already published. */
export function registerPublishedFeedbackRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { publishedFeedback } = container;
  app.post("/v1/reviews/published-comments/edit", async (context) =>
    publishedFeedbackResponse(
      context,
      publishedFeedback,
      "edit",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/published-comments/delete", async (context) =>
    publishedFeedbackResponse(
      context,
      publishedFeedback,
      "delete",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/published-reviews/dismiss", async (context) =>
    publishedFeedbackResponse(
      context,
      publishedFeedback,
      "dismiss",
      await jsonBody(context),
    ),
  );
}

const expectedSchema = strictObject({
  sessionId: string(),
  headSha: string(),
  patchHash: string(),
});
const publishedCommentEditSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  expected: expectedSchema,
  commentId: pipe(string(), minLength(1)),
  body: string(),
});
const publishedCommentDeleteSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  expected: expectedSchema,
  commentId: pipe(string(), minLength(1)),
  confirmation: boolean(),
});
const publishedReviewDismissSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  expected: expectedSchema,
  publishedReviewId: pipe(string(), minLength(1)),
  message: string(),
  confirmation: boolean(),
});

async function publishedFeedbackResponse(
  context: Context,
  service: PublishedFeedbackService,
  action: "edit" | "delete" | "dismiss",
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser and immediately runs the owned strict schema.
  body: unknown,
): Promise<Response> {
  const result =
    action === "edit"
      ? await parsePublishedEdit(service, body)
      : action === "delete"
        ? await parsePublishedDelete(service, body)
        : await parsePublishedDismiss(service, body);
  if (result._tag === "err") {
    if (result.error === "invalid_input")
      return context.json({ error: result.error }, 400);
    return context.json(
      { error: result.error },
      mapReviewWriteFailureStatus(result.error, {
        not_fresh: 409,
        confirmation_required: 409,
      }),
    );
  }
  return context.json(result.value);
}

async function parsePublishedEdit(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser and immediately runs the owned strict schema.
  body: unknown,
): Promise<
  Result<PublishedFeedbackReceipt, "invalid_input" | PublishedFeedbackFailure>
> {
  const parsed = safeParse(publishedCommentEditSchema, body);
  if (!parsed.success) return err("invalid_input");
  const common = parseCommon(parsed.output);
  return common._tag === "err"
    ? common
    : service.editComment({
        ...common.value,
        commentId: parsed.output.commentId,
        body: parsed.output.body,
      });
}

async function parsePublishedDelete(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser and immediately runs the owned strict schema.
  body: unknown,
): Promise<
  Result<PublishedFeedbackReceipt, "invalid_input" | PublishedFeedbackFailure>
> {
  const parsed = safeParse(publishedCommentDeleteSchema, body);
  if (!parsed.success) return err("invalid_input");
  const common = parseCommon(parsed.output);
  return common._tag === "err"
    ? common
    : service.deleteComment({
        ...common.value,
        commentId: parsed.output.commentId,
        confirmation: parsed.output.confirmation,
      });
}

async function parsePublishedDismiss(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser and immediately runs the owned strict schema.
  body: unknown,
): Promise<
  Result<PublishedFeedbackReceipt, "invalid_input" | PublishedFeedbackFailure>
> {
  const parsed = safeParse(publishedReviewDismissSchema, body);
  if (!parsed.success) return err("invalid_input");
  const common = parseCommon(parsed.output);
  return common._tag === "err"
    ? common
    : service.dismissReview({
        ...common.value,
        publishedReviewId: parsed.output.publishedReviewId,
        message: parsed.output.message,
        confirmation: parsed.output.confirmation,
      });
}

function parseCommon(input: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly expected: {
    readonly sessionId: string;
    readonly headSha: string;
    readonly patchHash: string;
  };
}): Result<
  {
    readonly profileId: ReturnType<
      typeof parseWorkspaceProfileId
    > extends Result<infer Value, unknown>
      ? Value
      : never;
    readonly reviewId: ReturnType<typeof parseReviewId> extends Result<
      infer Value,
      unknown
    >
      ? Value
      : never;
    readonly expected: ReviewWriteExpectation;
  },
  "invalid_input"
> {
  const profileId = parseWorkspaceProfileId(input.profileId);
  const reviewId = parseReviewId(input.reviewId);
  const sessionId = parseReviewSessionId(input.expected.sessionId);
  const headSha = parseGitSha(input.expected.headSha);
  const patchHash = parseContentHash(input.expected.patchHash);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
  )
    return err("invalid_input");
  return {
    _tag: "ok",
    value: {
      profileId: profileId.value,
      reviewId: reviewId.value,
      expected: {
        sessionId: sessionId.value,
        headSha: headSha.value,
        patchHash: patchHash.value,
      },
    },
  };
}

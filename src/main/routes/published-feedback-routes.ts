import type { Context, Hono } from "hono";
import {
  boolean,
  minLength,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import { parseReviewId, parseWorkspaceProfileId } from "../../domain/ids";
import { err, type Result } from "../../domain/result";
import type {
  PublishedFeedbackFailure,
  PublishedFeedbackService,
} from "../../services/published-feedback-service";
import type { LocalApiContainer } from "../local-api-container";
import { jsonBody } from "./json-body";

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

const publishedCommentEditSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  commentId: pipe(string(), minLength(1)),
  body: string(),
});
const publishedCommentDeleteSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  commentId: pipe(string(), minLength(1)),
  confirmation: boolean(),
});
const publishedReviewDismissSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  publishedReviewId: pipe(string(), minLength(1)),
  message: string(),
  confirmation: boolean(),
});

async function publishedFeedbackResponse(
  context: Context,
  service: PublishedFeedbackService,
  action: "edit" | "delete" | "dismiss",
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
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
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "not_fresh" ||
            result.error === "confirmation_required" ||
            result.error === "permission_denied"
          ? 409
          : result.error === "github_read_failed" ||
              result.error === "refresh_required"
            ? 503
            : 400;
    return context.json({ error: result.error }, status);
  }
  return context.json({ status: "ok" });
}

async function parsePublishedEdit(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedCommentEditSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err"
    ? err("invalid_input")
    : service.editComment({
        profileId: profileId.value,
        reviewId: reviewId.value,
        commentId: parsed.output.commentId,
        body: parsed.output.body,
      });
}

async function parsePublishedDelete(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedCommentDeleteSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err"
    ? err("invalid_input")
    : service.deleteComment({
        profileId: profileId.value,
        reviewId: reviewId.value,
        commentId: parsed.output.commentId,
        confirmation: parsed.output.confirmation,
      });
}

async function parsePublishedDismiss(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedReviewDismissSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err"
    ? err("invalid_input")
    : service.dismissReview({
        profileId: profileId.value,
        reviewId: reviewId.value,
        publishedReviewId: parsed.output.publishedReviewId,
        message: parsed.output.message,
        confirmation: parsed.output.confirmation,
      });
}

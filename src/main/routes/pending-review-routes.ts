import type { Context, Hono } from "hono";

import { parseReviewId, parseWorkspaceProfileId } from "../../domain/ids";
import type { ReviewSessionId, WorkspaceProfileId } from "../../domain/ids";
import { readObjectField } from "../../services/read-object-field";
import type { ReviewSessionStore } from "../../adapters/storage/review-session-store";
import {
  projectPendingReview,
  type PendingReviewProjection,
  type PendingReviewService,
} from "../../services/pending-review-service";
import {
  projectDirectSummaryReview,
  type DirectSummaryReviewService,
} from "../../services/direct-summary-review-service";
import type { LocalApiContainer } from "../local-api-container";
import {
  parseDirectSummaryCommand,
  parsePendingReviewCommand,
} from "./pending-review-command";
import { jsonBody } from "./json-body";

/** The pending-review composer and the direct summary review that bypasses it. */
export function registerPendingReviewRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { directSummaryReviews, pendingReviews, sessions } = container;
  app.post("/v1/reviews/pending-review/command", async (context) =>
    pendingReviewCommandResponse(
      context,
      pendingReviews,
      sessions,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/pending-review/recover", async (context) =>
    pendingReviewRecoverResponse(
      context,
      pendingReviews,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/direct-summary/submit", async (context) =>
    directSummarySubmitResponse(
      context,
      directSummaryReviews,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/direct-summary/recover", async (context) =>
    directSummaryRecoverResponse(
      context,
      directSummaryReviews,
      await jsonBody(context),
    ),
  );
}

async function pendingReviewCommandResponse(
  context: Context,
  service: PendingReviewService | undefined,
  sessions: ReviewSessionStore,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const parsed = parsePendingReviewCommand(body);
  if (parsed === undefined)
    return context.json({ error: "invalid_input" }, 400);
  const result =
    parsed.command._tag === "Start"
      ? await service.start(
          parsed.command.finding === undefined
            ? {
                profileId: parsed.profileId,
                reviewId: parsed.reviewId,
                expected: parsed.command.expected,
                anchor: parsed.command.anchor,
                body: parsed.command.body,
              }
            : {
                profileId: parsed.profileId,
                reviewId: parsed.reviewId,
                expected: parsed.command.expected,
                anchor: parsed.command.anchor,
                body: parsed.command.body,
                finding: parsed.command.finding,
              },
        )
      : parsed.command._tag === "AddThread"
        ? await service.addThread(
            parsed.command.finding === undefined
              ? {
                  profileId: parsed.profileId,
                  reviewId: parsed.reviewId,
                  expected: parsed.command.expected,
                  pendingReviewNodeId: parsed.command.pendingReviewNodeId,
                  anchor: parsed.command.anchor,
                  body: parsed.command.body,
                }
              : {
                  profileId: parsed.profileId,
                  reviewId: parsed.reviewId,
                  expected: parsed.command.expected,
                  pendingReviewNodeId: parsed.command.pendingReviewNodeId,
                  anchor: parsed.command.anchor,
                  body: parsed.command.body,
                  finding: parsed.command.finding,
                },
          )
        : parsed.command._tag === "Submit"
          ? await service.submit({
              profileId: parsed.profileId,
              reviewId: parsed.reviewId,
              expected: parsed.command.expected,
              event: parsed.command.event,
              summaryBody: parsed.command.summaryBody,
            })
          : await service.discard({
              profileId: parsed.profileId,
              reviewId: parsed.reviewId,
              expected: parsed.command.expected,
              confirmation: parsed.command.confirmation,
            });
  if (result._tag === "ok") {
    return context.json({
      pendingReview: projectPendingReview(result.value.state, false),
    });
  }
  const projection = await storedPendingReviewProjection(
    sessions,
    parsed.profileId,
    parsed.command.expected.sessionId,
  );
  return context.json(
    projection === undefined
      ? { error: result.error }
      : { error: result.error, pendingReview: projection },
    pendingReviewFailureStatus(result.error),
  );
}

async function pendingReviewRecoverResponse(
  context: Context,
  service: PendingReviewService | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.reconcile({
    profileId: profileId.value,
    reviewId: reviewId.value,
    recover: true,
  });
  if (result._tag === "ok") {
    return context.json({
      pendingReview: projectPendingReview(
        result.value.state,
        result.value.unavailable,
      ),
    });
  }
  return context.json(
    { error: result.error },
    pendingReviewFailureStatus(result.error),
  );
}

async function storedPendingReviewProjection(
  sessions: ReviewSessionStore,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
): Promise<PendingReviewProjection | undefined> {
  const loaded = await sessions.load(profileId, sessionId);
  if (loaded._tag === "err") return undefined;
  return projectPendingReview(
    loaded.value.pendingReview ?? { _tag: "None" },
    false,
  );
}

function pendingReviewFailureStatus(
  failure: string,
): 400 | 403 | 404 | 409 | 503 {
  if (failure === "invalid_input") return 400;
  if (failure === "not_found") return 404;
  if (failure === "forbidden") return 403;
  if (
    failure === "not_fresh" ||
    failure === "stale_head" ||
    failure === "permission_denied" ||
    failure === "self_approval_not_allowed" ||
    failure === "rejected" ||
    failure === "review_write_in_progress" ||
    failure === "no_pending_review" ||
    failure === "pending_review_locked" ||
    failure === "pending_review_exists"
  )
    return 409;
  if (
    failure === "unavailable" ||
    failure === "outcome_unknown" ||
    failure === "rate_limited"
  )
    return 503;
  return 400;
}

async function directSummarySubmitResponse(
  context: Context,
  service: DirectSummaryReviewService | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const parsed = parseDirectSummaryCommand(body);
  if (parsed === undefined)
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.submit(parsed);
  return result._tag === "ok"
    ? context.json({ directSummary: projectDirectSummaryReview(result.value) })
    : context.json(
        { error: result.error },
        pendingReviewFailureStatus(result.error),
      );
}

async function directSummaryRecoverResponse(
  context: Context,
  service: DirectSummaryReviewService | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.reconcile({
    profileId: profileId.value,
    reviewId: reviewId.value,
  });
  return result._tag === "ok"
    ? context.json({ directSummary: projectDirectSummaryReview(result.value) })
    : context.json(
        { error: result.error },
        pendingReviewFailureStatus(result.error),
      );
}

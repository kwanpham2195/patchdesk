import type { Context, Hono } from "hono";
import { safeParse } from "valibot";

import { definedProps } from "../../domain/defined-props";
import { parseReviewId, parseWorkspaceProfileId } from "../../domain/ids";
import type { ReviewSessionId, WorkspaceProfileId } from "../../domain/ids";
import type { RawJsonValue } from "../../domain/json";
import type { Result } from "../../domain/result";
import type { ReviewSessionStore } from "../../adapters/storage/review-session-store";
import {
  projectPendingReview,
  type PendingReviewCommandResult,
  type PendingReviewProjection,
  type PendingReviewService,
  type PendingReviewServiceFailure,
} from "../../services/pending-review-service";
import {
  projectDirectSummaryReview,
  type DirectSummaryReviewService,
} from "../../services/direct-summary-review-service";
import type { FindingSuggestionCommand } from "../../services/insight-run-coordinator";
import type { InsightCoordinatorSeam } from "../local-api-configuration";
import type { LocalApiContainer } from "../local-api-container";
import {
  parseDirectSummaryCommand,
  parseFindingSuggestionCommand,
  parsePendingReviewCommand,
} from "./pending-review-command";
import { insightFailureStatus } from "./http-status";
import { jsonBody } from "./json-body";
import { reviewRecoverySchema } from "./review-recovery-schema";

/** The pending-review composer and the direct summary review that bypasses it. */
export function registerPendingReviewRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { directSummaryReviews, insights, pendingReviews, sessions } =
    container;
  app.post("/v1/reviews/pending-review/command", async (context) =>
    pendingReviewCommandResponse(
      context,
      pendingReviews,
      sessions,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/pending-review/finding-suggestion", async (context) =>
    findingSuggestionResponse(
      context,
      insights,
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
  return pendingReviewWriteResponse(
    context,
    sessions,
    parsed.profileId,
    parsed.command.expected.sessionId,
    result,
  );
}

/**
 * Publishes a Finding's verified replacement as one GitHub suggestion. The
 * request carries identity and the expected revision only: the anchor and the
 * comment body are rebuilt here, then written through the same pending-review
 * service as every other Review write (issue #316).
 */
async function findingSuggestionResponse(
  context: Context,
  insights: InsightCoordinatorSeam | undefined,
  service: PendingReviewService | undefined,
  sessions: ReviewSessionStore,
  body: unknown,
): Promise<Response> {
  if (insights === undefined || service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const parsed = parseFindingSuggestionCommand(body);
  if (parsed === undefined)
    return context.json({ error: "invalid_input" }, 400);
  const resolved = await insights.resolveFindingSuggestion({
    profileId: parsed.profileId,
    reviewId: parsed.reviewId,
    runId: parsed.runId,
    findingId: parsed.findingId,
  });
  if (resolved._tag === "err")
    return context.json(
      { error: resolved.error },
      insightFailureStatus(resolved.error),
    );
  const write = {
    profileId: parsed.profileId,
    reviewId: parsed.reviewId,
    expected: parsed.expected,
    anchor: resolved.value.anchor,
    body: resolved.value.body,
    finding: resolved.value.finding,
  };
  const result =
    parsed.pendingReviewNodeId === undefined
      ? await service.start(write)
      : await service.addThread({
          ...write,
          pendingReviewNodeId: parsed.pendingReviewNodeId,
        });
  return pendingReviewWriteResponse(
    context,
    sessions,
    parsed.profileId,
    parsed.expected.sessionId,
    result,
    resolved.value,
  );
}

/**
 * The one envelope every pending-review write answers with. A failure carries
 * the stored projection so the caller can tell an untouched pending review
 * from an uncertain outcome, and `composed` names the comment the main process
 * built so a Finding caller confirms that text rather than one it assembled.
 */
async function pendingReviewWriteResponse(
  context: Context,
  sessions: ReviewSessionStore,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
  result: Result<PendingReviewCommandResult, PendingReviewServiceFailure>,
  command?: FindingSuggestionCommand,
): Promise<Response> {
  const composed =
    command === undefined
      ? undefined
      : { anchor: command.anchor, body: command.body };
  if (result._tag === "ok") {
    return context.json({
      pendingReview: projectPendingReview(result.value.state, false),
      ...definedProps({ composed }),
    });
  }
  const projection = await storedPendingReviewProjection(
    sessions,
    profileId,
    sessionId,
  );
  return context.json(
    {
      error: result.error,
      ...definedProps({ pendingReview: projection, composed }),
    },
    pendingReviewFailureStatus(result.error),
  );
}

async function pendingReviewRecoverResponse(
  context: Context,
  service: PendingReviewService | undefined,
  body: RawJsonValue | undefined,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const parsed = safeParse(reviewRecoverySchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
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
    failure === "pending_review_gone" ||
    failure === "pending_review_locked" ||
    failure === "pending_review" ||
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
  body: RawJsonValue | undefined,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const parsed = safeParse(reviewRecoverySchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
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

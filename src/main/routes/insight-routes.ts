import type { Context, Hono } from "hono";
import {
  array,
  boolean,
  maxLength,
  minLength,
  optional,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import {
  parseFindingId,
  parseInsightRunId,
  parseReviewId,
  parseWorkspaceProfileId,
} from "../../domain/ids";
import type { InsightType } from "../../domain/insight-record";
import { err } from "../../domain/result";
import type { InsightRunCoordinator } from "../../services/insight-run-coordinator";
import type { LocalApiConfiguration } from "../local-api-configuration";
import type { LocalApiContainer } from "../local-api-container";
import { response } from "./http-status";
import { jsonBody } from "./json-body";

/** Insight provider activation and the analysis, walkthrough, and brief run lifecycle. */
export function registerInsightRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { configuration } = container;
  app.get("/v1/insight-providers", async (context) => {
    if (configuration.insightProviders === undefined)
      return context.json({ error: "provider_unavailable" }, 503);
    return response(context, await configuration.insightProviders.passive());
  });
  app.post("/v1/insight-providers/codex/models", async (context) => {
    if (configuration.insightProviders === undefined)
      return context.json({ error: "provider_unavailable" }, 503);
    return response(
      context,
      await configuration.insightProviders.activateCodex(),
    );
  });
  app.post("/v1/reviews/insights/analysis/run", async (context) =>
    insightRunResponse(
      context,
      configuration.insights,
      "analysis",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/walkthrough/run", async (context) =>
    insightRunResponse(
      context,
      configuration.insights,
      "walkthrough",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/brief/run", async (context) =>
    insightRunResponse(
      context,
      configuration.insights,
      "brief",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/analysis/cancel", async (context) =>
    insightCancelResponse(
      context,
      configuration.insights,
      "analysis",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/walkthrough/cancel", async (context) =>
    insightCancelResponse(
      context,
      configuration.insights,
      "walkthrough",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/brief/cancel", async (context) =>
    insightCancelResponse(
      context,
      configuration.insights,
      "brief",
      await jsonBody(context),
    ),
  );
  app.post(
    "/v1/reviews/insights/analysis/findings/:findingId/dismiss",
    async (context) =>
      insightFindingResponse(
        context,
        configuration.insights,
        "dismiss",
        context.req.param("findingId"),
        await jsonBody(context),
      ),
  );
  app.post("/v1/reviews/insights/walkthrough/progress", async (context) =>
    insightWalkthroughProgressResponse(
      context,
      configuration.insights,
      await jsonBody(context),
    ),
  );
  app.get("/v1/reviews/insights/runs/:runId", async (context) => {
    if (configuration.insights === undefined)
      return context.json({ error: "workflow_unavailable" }, 503);
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    const runId = parseInsightRunId(context.req.param("runId"));
    const type = parseInsightType(context.req.query("type"));
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      runId._tag === "err" ||
      type === undefined
    )
      return context.json({ error: "invalid_input" }, 400);
    return insightResultResponse(
      context,
      await configuration.insights.observe({
        profileId: profileId.value,
        reviewId: reviewId.value,
        type,
        runId: runId.value,
      }),
    );
  });
}

const insightRunSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  type: picklist(["analysis", "walkthrough", "brief"]),
  provider: picklist(["pi", "codex-cli-account"]),
  model: pipe(string(), minLength(1), maxLength(200)),
  reasoning: picklist(["minimal", "low", "medium", "high", "xhigh"]),
});
const insightCancelSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  type: picklist(["analysis", "walkthrough", "brief"]),
  runId: pipe(string(), minLength(1)),
});
const insightFindingSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  runId: pipe(string(), minLength(1)),
  reason: optional(pipe(string(), minLength(1), maxLength(500))),
});

async function insightRunResponse(
  context: Context,
  coordinator: LocalApiConfiguration["insights"],
  type: InsightType,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (coordinator === undefined)
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightRunSchema, body);
  if (!parsed.success || parsed.output.type !== type)
    return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const result = await coordinator.start({
    profileId: profileId.value,
    reviewId: reviewId.value,
    type,
    provider: parsed.output.provider,
    model: parsed.output.model,
    reasoning: parsed.output.reasoning,
  });
  return insightResultResponse(context, result, 202);
}

async function insightCancelResponse(
  context: Context,
  coordinator: LocalApiConfiguration["insights"],
  type: InsightType,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (coordinator === undefined)
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightCancelSchema, body);
  if (!parsed.success || parsed.output.type !== type)
    return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    runId._tag === "err"
  )
    return context.json({ error: "invalid_input" }, 400);
  const result = await coordinator.cancel({
    profileId: profileId.value,
    reviewId: reviewId.value,
    type,
    runId: runId.value,
  });
  return insightResultResponse(context, result);
}

function insightResultResponse(
  context: Context,
  result:
    | Awaited<
        ReturnType<NonNullable<LocalApiConfiguration["insights"]>["observe"]>
      >
    | Awaited<
        ReturnType<NonNullable<LocalApiConfiguration["insights"]>["start"]>
      >
    | Awaited<
        ReturnType<NonNullable<LocalApiConfiguration["insights"]>["cancel"]>
      >
    | Awaited<
        ReturnType<
          NonNullable<LocalApiConfiguration["insights"]>["dismissFinding"]
        >
      >
    | Awaited<ReturnType<InsightRunCoordinator["updateWalkthroughProgress"]>>,
  successStatus: 200 | 202 = 200,
): Response {
  if (result._tag === "ok") return context.json(result.value, successStatus);
  const status =
    result.error === "invalid_request" || result.error === "model_unavailable"
      ? 400
      : result.error === "ownership_mismatch"
        ? 403
        : result.error === "not_found"
          ? 404
          : result.error === "terminal_review" ||
              result.error === "already_running" ||
              result.error === "not_active" ||
              result.error === "stale_request" ||
              result.error === "not_available"
            ? 409
            : 503;
  return context.json({ error: result.error }, status);
}

async function insightWalkthroughProgressResponse(
  context: Context,
  coordinator: LocalApiConfiguration["insights"],
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (
    coordinator === undefined ||
    coordinator.updateWalkthroughProgress === undefined
  )
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(
    strictObject({
      profileId: string(),
      reviewId: string(),
      runId: string(),
      reviewedSectionIds: array(string()),
      supportReviewed: boolean(),
      currentSectionId: optional(string()),
    }),
    body,
  );
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    runId._tag === "err"
  )
    return context.json({ error: "invalid_input" }, 400);
  const progress =
    parsed.output.currentSectionId === undefined
      ? {
          reviewedSectionIds: parsed.output.reviewedSectionIds,
          supportReviewed: parsed.output.supportReviewed,
        }
      : {
          reviewedSectionIds: parsed.output.reviewedSectionIds,
          supportReviewed: parsed.output.supportReviewed,
          currentSectionId: parsed.output.currentSectionId,
        };
  const result = await coordinator.updateWalkthroughProgress({
    profileId: profileId.value,
    reviewId: reviewId.value,
    runId: runId.value,
    progress,
  });
  return insightResultResponse(context, result);
}

async function insightFindingResponse(
  context: Context,
  coordinator: LocalApiConfiguration["insights"],
  action: "dismiss",
  findingIdInput: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (coordinator === undefined)
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightFindingSchema, body);
  const findingId = parseFindingId(findingIdInput);
  if (
    !parsed.success ||
    findingId._tag === "err" ||
    (action === "dismiss" && parsed.output.reason === undefined)
  )
    return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    runId._tag === "err"
  )
    return context.json({ error: "invalid_input" }, 400);
  const result =
    coordinator.dismissFinding === undefined
      ? err("storage_unavailable" as const)
      : await coordinator.dismissFinding({
          profileId: profileId.value,
          reviewId: reviewId.value,
          runId: runId.value,
          findingId: findingId.value,
          reason: parsed.output.reason ?? "",
        });
  return insightResultResponse(context, result);
}

function parseInsightType(value: string | undefined): InsightType | undefined {
  return value === "analysis" || value === "walkthrough" || value === "brief"
    ? value
    : undefined;
}

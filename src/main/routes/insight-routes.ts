import type { Context, Hono } from "hono";
import {
  array,
  boolean,
  integer,
  maxLength,
  minLength,
  minValue,
  number,
  optional,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import {
  parseAgentRunRequestId,
  parseFindingId,
  parseInsightRunId,
  parseReviewId,
  parseWorkspaceProfileId,
} from "../../domain/ids";
import type { InsightType } from "../../domain/insight-record";
import { err } from "../../domain/result";
import {
  agentRunDeclineRequestSchema,
  agentRunRequestFailureKinds,
  type AgentRunRequestService,
} from "../../services/agent-run-request-service";
import { readBriefPullRequestDescription } from "../../services/brief-pull-request-description";
import {
  insightRunRequestSchema,
  type InsightRunCoordinator,
} from "../../services/insight-run-coordinator";
import type { InsightCoordinatorSeam } from "../local-api-configuration";
import type { LocalApiContainer } from "../local-api-container";
import { insightFailureStatus, response, serviceResponse } from "./http-status";
import { jsonBody } from "./json-body";

/** Insight provider activation and the analysis, walkthrough, and brief run lifecycle. */
export function registerInsightRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { configuration, insights } = container;
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
  const { agentRunRequests } = container;
  app.post("/v1/reviews/insights/analysis/run", async (context) =>
    insightRunResponse(context, insights, agentRunRequests, "analysis"),
  );
  app.post("/v1/reviews/insights/walkthrough/run", async (context) =>
    insightRunResponse(context, insights, agentRunRequests, "walkthrough"),
  );
  app.post("/v1/reviews/insights/brief/run", async (context) =>
    insightRunResponse(context, insights, agentRunRequests, "brief"),
  );
  // Decline on the Agent requests bar; final for the request's session (ADR 0052).
  app.post("/v1/reviews/insights/agent-requests/decline", async (context) => {
    const parsed = safeParse(
      agentRunDeclineRequestSchema,
      await jsonBody(context),
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    const requestId = parseAgentRunRequestId(parsed.output.requestId);
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      requestId._tag === "err"
    )
      return context.json({ error: "invalid_input" }, 400);
    return serviceResponse(
      context,
      await agentRunRequests.decline({
        profileId: profileId.value,
        reviewId: reviewId.value,
        requestId: requestId.value,
      }),
      agentRunRequestFailureKinds,
    );
  });
  app.post("/v1/reviews/insights/analysis/cancel", async (context) =>
    insightCancelResponse(
      context,
      insights,
      "analysis",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/walkthrough/cancel", async (context) =>
    insightCancelResponse(
      context,
      insights,
      "walkthrough",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/brief/cancel", async (context) =>
    insightCancelResponse(context, insights, "brief", await jsonBody(context)),
  );
  app.post(
    "/v1/reviews/insights/analysis/findings/:findingId/dismiss",
    async (context) =>
      insightFindingResponse(
        context,
        insights,
        "dismiss",
        context.req.param("findingId"),
        await jsonBody(context),
      ),
  );
  // Identity only: the Markdown is composed in the main process from the retained Brief.
  app.post(
    "/v1/reviews/insights/brief/pull-request-description",
    async (context) => {
      const parsed = safeParse(briefDescriptionSchema, await jsonBody(context));
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
      return response(
        context,
        await readBriefPullRequestDescription(container.retainedInsights, {
          profileId: profileId.value,
          reviewId: reviewId.value,
          runId: runId.value,
        }),
      );
    },
  );
  app.post("/v1/reviews/insights/walkthrough/progress", async (context) =>
    insightWalkthroughProgressResponse(
      context,
      insights,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/analysis/verification", async (context) =>
    analysisVerificationResponse(context, insights, await jsonBody(context)),
  );
  app.get("/v1/reviews/insights/runs/:runId", async (context) => {
    if (insights === undefined)
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
      await insights.observe({
        profileId: profileId.value,
        reviewId: reviewId.value,
        type,
        runId: runId.value,
      }),
    );
  });
}

const insightCancelSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  type: picklist(["analysis", "walkthrough", "brief"]),
  runId: pipe(string(), minLength(1)),
});
const briefDescriptionSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  runId: pipe(string(), minLength(1)),
});
const insightFindingSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  runId: pipe(string(), minLength(1)),
  reason: optional(pipe(string(), minLength(1), maxLength(500))),
});

/** Starts a run; with `requestId` the start also approves that agent run request. */
async function insightRunResponse(
  context: Context,
  coordinator: InsightCoordinatorSeam | undefined,
  agentRunRequests: Pick<AgentRunRequestService, "approve">,
  type: InsightType,
): Promise<Response> {
  if (coordinator === undefined)
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightRunRequestSchema, await jsonBody(context));
  if (!parsed.success || parsed.output.type !== type)
    return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const requestId =
    parsed.output.requestId === undefined
      ? undefined
      : parseAgentRunRequestId(parsed.output.requestId);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    requestId?._tag === "err"
  )
    return context.json({ error: "invalid_input" }, 400);
  const input = {
    profileId: profileId.value,
    reviewId: reviewId.value,
    type,
    provider: parsed.output.provider,
    model: parsed.output.model,
    reasoning: parsed.output.reasoning,
    language: parsed.output.language,
  };
  const result =
    requestId === undefined
      ? await coordinator.start(input)
      : await agentRunRequests.approve(coordinator, {
          ...input,
          requestId: requestId.value,
        });
  if (result._tag === "ok") return context.json(result.value, 202);
  return context.json(
    { error: result.error },
    result.error === "request_not_awaiting"
      ? 409
      : insightFailureStatus(result.error),
  );
}

async function insightCancelResponse(
  context: Context,
  coordinator: InsightCoordinatorSeam | undefined,
  type: InsightType,
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
    | Awaited<ReturnType<InsightCoordinatorSeam["observe"]>>
    | Awaited<ReturnType<InsightCoordinatorSeam["start"]>>
    | Awaited<ReturnType<InsightCoordinatorSeam["cancel"]>>
    | Awaited<ReturnType<InsightCoordinatorSeam["dismissFinding"]>>
    | Awaited<ReturnType<InsightRunCoordinator["updateWalkthroughProgress"]>>
    | Awaited<ReturnType<InsightRunCoordinator["updateAnalysisVerification"]>>,
  successStatus: 200 | 202 = 200,
): Response {
  if (result._tag === "ok") return context.json(result.value, successStatus);
  return context.json(
    { error: result.error },
    insightFailureStatus(result.error),
  );
}

async function insightWalkthroughProgressResponse(
  context: Context,
  coordinator: InsightCoordinatorSeam | undefined,
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

async function analysisVerificationResponse(
  context: Context,
  coordinator: InsightCoordinatorSeam | undefined,
  body: unknown,
): Promise<Response> {
  if (coordinator?.updateAnalysisVerification === undefined)
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(
    strictObject({
      profileId: string(),
      reviewId: string(),
      runId: string(),
      stepIndex: pipe(number(), integer(), minValue(0)),
      checked: boolean(),
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
  const result = await coordinator.updateAnalysisVerification({
    profileId: profileId.value,
    reviewId: reviewId.value,
    runId: runId.value,
    stepIndex: parsed.output.stepIndex,
    checked: parsed.output.checked,
  });
  return insightResultResponse(context, result);
}

async function insightFindingResponse(
  context: Context,
  coordinator: InsightCoordinatorSeam | undefined,
  action: "dismiss",
  findingIdInput: string,
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

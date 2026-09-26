import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { ReviewStore } from "../../src/adapters/storage/review-store";
import {
  createAgentRunRequestId,
  parseLocalBranchName,
  type AgentRunRequestId,
} from "../../src/domain/ids";
import type { InsightType } from "../../src/domain/insight-record";
import { err, ok } from "../../src/domain/result";
import type { LogEntryInput } from "../../src/domain/log-entry";
import { registerInsightRoutes } from "../../src/main/routes/insight-routes";
import { AgentRunRequestService } from "../../src/services/agent-run-request-service";
import type {
  InsightInvoker,
  InsightRunCoordinator,
} from "../../src/services/insight-run-coordinator";
import {
  cleanupRoots,
  fixture,
  must,
  now,
  profileId,
  settled,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

/** Keeps every run active, so a test reads the request while its run still runs. */
const runsUntilStopped: InsightInvoker = {
  invoke: () => new Promise(() => undefined),
};

const localSource = {
  kind: "working_tree" as const,
  branch: must(parseLocalBranchName("feat/x")),
};

/** A local Review with the real Insight run coordinator, and the request service over the same stores and lock. */
async function approvalFixture(
  invoker: InsightInvoker = runsUntilStopped,
  reviews?: (store: ReviewStore) => Pick<ReviewStore, "load" | "save">,
) {
  const value = await fixture(invoker, { localSource });
  const logs: LogEntryInput[] = [];
  let issued = 0;
  const service = (
    store: Pick<ReviewStore, "load" | "save"> = value.reviews,
  ): AgentRunRequestService =>
    new AgentRunRequestService({
      reviews: store,
      insights: value.insights,
      profiles: { list: async () => ok([]) },
      coordinator: value.operations,
      logs: { write: (entry) => logs.push(entry) },
      now: () => now,
      createRequestId: () =>
        createAgentRunRequestId(`request-${String((issued += 1))}`),
    });
  const ask = async (type: InsightType): Promise<AgentRunRequestId> => {
    const requested = must(
      await service().request({
        profileId,
        reviewId: value.review.id,
        sessionId: value.session.id,
        type,
      }),
    );
    if (requested.requestId === undefined) throw new Error("no request");
    return requested.requestId;
  };
  const stored = async () =>
    must(await value.reviews.load(profileId, value.review.id)).agentRunRequests;
  return {
    ...value,
    logs,
    ask,
    stored,
    requests: service(reviews?.(value.reviews)),
    runInput: (type: InsightType) => ({
      profileId,
      reviewId: value.review.id,
      type,
      model: "model",
      reasoning: "medium" as const,
      language: "en" as const,
    }),
  };
}

describe("AgentRunRequestService.startRun over the Insight run coordinator", () => {
  it("approves the named request with the started run, and run_insight answers it while the run is active", async () => {
    const value = await approvalFixture();
    const requestId = await value.ask("analysis");

    const started = await value.requests.startRun(value.coordinator, {
      ...value.runInput("analysis"),
      requestId,
    });
    const askedAgain = await value.requests.request({
      profileId,
      reviewId: value.review.id,
      sessionId: value.session.id,
      type: "analysis",
    });

    const { runId } = must(started);
    expect(await value.stored()).toEqual([
      expect.objectContaining({ requestId, status: "approved", runId }),
    ]);
    expect(askedAgain).toMatchObject(
      ok({ status: "approved", requestId, runId }),
    );
  });

  it("has a plain Run of a requested type approve the session's awaiting request of that type only", async () => {
    const value = await approvalFixture();
    const analysisRequest = await value.ask("analysis");
    const briefRequest = await value.ask("brief");

    const started = await value.requests.startRun(
      value.coordinator,
      value.runInput("analysis"),
    );

    const { runId } = must(started);
    expect(await value.stored()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: analysisRequest,
          status: "approved",
          runId,
        }),
        expect.objectContaining({
          requestId: briefRequest,
          status: "awaiting_approval",
        }),
      ]),
    );
  });

  it("links the run before a Decline sent the moment the start returns can land, so the request is never declined under a started run", async () => {
    const value = await approvalFixture();
    const requestId = await value.ask("analysis");
    let declined:
      | Awaited<ReturnType<AgentRunRequestService["decline"]>>
      | undefined;
    const declineOnReturn: Pick<InsightRunCoordinator, "start"> = {
      start: async (input, hooks) => {
        const result = await value.coordinator.start(input, hooks);
        declined = await value.requests.decline({
          profileId,
          reviewId: value.review.id,
          requestId,
        });
        return result;
      },
    };

    const started = await value.requests.startRun(declineOnReturn, {
      ...value.runInput("analysis"),
      requestId,
    });

    const { runId } = must(started);
    expect(declined).toEqual(err({ reason: "request_not_awaiting" }));
    expect(await value.stored()).toEqual([
      expect.objectContaining({ requestId, status: "approved", runId }),
    ]);
  });

  it("leaves the request awaiting when the start is refused", async () => {
    const value = await approvalFixture();
    const requestId = await value.ask("analysis");

    const started = await value.requests.startRun(value.coordinator, {
      ...value.runInput("analysis"),
      model: "missing-model",
      requestId,
    });

    expect(started).toEqual(err("model_unavailable"));
    expect(await value.stored()).toEqual([
      expect.objectContaining({ requestId, status: "awaiting_approval" }),
    ]);
  });

  it("records a new request once the approved run has settled, which needs a new approval", async () => {
    const value = await approvalFixture({
      invoke: async () => err({ reason: "execution_failed" }),
    });
    const requestId = await value.ask("analysis");
    const { runId } = must(
      await value.requests.startRun(value.coordinator, {
        ...value.runInput("analysis"),
        requestId,
      }),
    );
    await settled(value.coordinator, value.review.id, runId);
    // The executor persists the failure under the Review lock; request refuses rather than waits.
    await value.operations.withReviewLock(
      profileId,
      value.review.id,
      async () => undefined,
    );

    const askedAgain = await value.requests.request({
      profileId,
      reviewId: value.review.id,
      sessionId: value.session.id,
      type: "analysis",
    });

    expect(askedAgain).toMatchObject(
      ok({ status: "awaiting_approval", requestId: "agent-request-request-2" }),
    );
  });

  it("keeps the started run and logs a warning when linking it to the request fails to save", async () => {
    const value = await approvalFixture(runsUntilStopped, (store) => ({
      load: (...args) => store.load(...args),
      save: async () =>
        err({
          _tag: "ReviewConflict" as const,
          reason: "stale_revision" as const,
        }),
    }));
    const requestId = await value.ask("analysis");

    const started = await value.requests.startRun(value.coordinator, {
      ...value.runInput("analysis"),
      requestId,
    });

    const { runId } = must(started);
    expect(
      must(await value.insights.load(profileId, value.review.id, "analysis"))
        .activeRun?.id,
    ).toBe(runId);
    expect(value.logs).toEqual([
      expect.objectContaining({
        level: "warn",
        topic: "agent-run-request",
        meta: expect.objectContaining({ requestId, runId }),
      }),
    ]);
  });
});

describe("the Insight run route with a requestId", () => {
  it("answers 409 request_not_awaiting for a request declined before Run, and begins no run", async () => {
    const value = await approvalFixture();
    const requestId = await value.ask("analysis");
    const app = new Hono();
    // SAFETY: the routes under test reach only the two services supplied.
    registerInsightRoutes(app, {
      configuration: {},
      insights: value.coordinator,
      agentRunRequests: value.requests,
    } as never);
    const post = (path: string, body: Readonly<Record<string, string>>) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("/v1/reviews/insights/agent-requests/decline", {
      profileId,
      reviewId: value.review.id,
      requestId,
    });

    const answered = await post("/v1/reviews/insights/analysis/run", {
      ...value.runInput("analysis"),
      provider: "pi",
      requestId,
    });

    expect(answered.status).toBe(409);
    expect(await answered.json()).toEqual({ error: "request_not_awaiting" });
    expect(
      (await value.insights.load(profileId, value.review.id, "analysis"))._tag,
    ).toBe("err");
  });
});

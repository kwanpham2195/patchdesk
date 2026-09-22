import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { err, ok, type Result } from "../../src/domain/result";
import { registerPendingReviewRoutes } from "../../src/main/routes/pending-review-routes";
import type { FindingSuggestionCommand } from "../../src/services/insight-run-coordinator";
import type { PendingReviewServiceFailure } from "../../src/services/pending-review-service";

const PATH = "/v1/reviews/pending-review/finding-suggestion";
const reviewId = "acme__octo-org__patchdesk__pr-42__review-abcdef123456";
const runId = `insight-analysis-1-abcdef123456-${reviewId}`;
const expected = {
  sessionId:
    "acme__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__abcdef123456",
  headSha: "a".repeat(40),
  patchHash: "b".repeat(64),
};
const request = {
  profileId: "acme",
  reviewId,
  runId,
  findingId: "finding-1",
  expected,
};
const resolved = {
  anchor: { path: "src/a.ts", startLine: 3, line: 5, side: "new" },
  body: "Reject invalid values here.\n\n```suggestion\nguarded\n```",
  finding: {
    analysisRunId: runId,
    findingId: "finding-1",
    ...expected,
  },
};

/**
 * The route over a coordinator answer and a pending-review write, both
 * scripted. The write service and the session store are the seams this route
 * shares with the ordinary pending-review command, so only the Finding
 * suggestion path is exercised here.
 */
function routeFixture(input: {
  readonly suggestion?: Result<unknown, string>;
  readonly write?: Result<unknown, PendingReviewServiceFailure>;
}) {
  const app = new Hono();
  const writes: Array<{
    readonly kind: "start" | "addThread";
    readonly command: FindingSuggestionCommand;
  }> = [];
  const write = input.write ?? ok({ state: { _tag: "None" } });
  const container = {
    sessions: {
      load: async () => err({ reason: "not_found" }),
    },
    pendingReviews:
      input.suggestion === undefined
        ? undefined
        : {
            start: async (command: FindingSuggestionCommand) => {
              writes.push({ kind: "start", command });
              return write;
            },
            addThread: async (command: FindingSuggestionCommand) => {
              writes.push({ kind: "addThread", command });
              return write;
            },
          },
    insights:
      input.suggestion === undefined
        ? undefined
        : { resolveFindingSuggestion: async () => input.suggestion },
  };
  // SAFETY: this route reaches only the coordinator, write service, and
  // session seams scripted above.
  registerPendingReviewRoutes(app, container as never);
  return {
    writes,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- each test supplies its own request-body fixture, not a decoded value.
    post: (body: unknown) =>
      app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

describe("POST /v1/reviews/pending-review/finding-suggestion", () => {
  it("answers 503 when the Insight lifecycle is unavailable", async () => {
    const fixture = routeFixture({});
    const response = await fixture.post(request);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "review_write_unavailable",
    });
  });

  it("refuses a body that carries no Finding identity", async () => {
    const fixture = routeFixture({ suggestion: ok(resolved) });
    const response = await fixture.post({ profileId: "acme", reviewId });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input" });
    expect(fixture.writes).toEqual([]);
  });

  it("starts the pending review and names the comment it wrote", async () => {
    const fixture = routeFixture({ suggestion: ok(resolved) });
    const response = await fixture.post(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pendingReview: { state: "none" },
      written: { anchor: resolved.anchor, body: resolved.body },
    });
    expect(fixture.writes).toMatchObject([
      {
        kind: "start",
        command: {
          anchor: resolved.anchor,
          body: resolved.body,
          finding: resolved.finding,
        },
      },
    ]);
  });

  it("appends to the named pending review and keeps the written comment on failure", async () => {
    const fixture = routeFixture({
      suggestion: ok(resolved),
      write: err("outcome_unknown"),
    });
    const response = await fixture.post({
      ...request,
      pendingReviewNodeId: "PRR_1",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "outcome_unknown",
      written: { anchor: resolved.anchor, body: resolved.body },
    });
    expect(fixture.writes).toMatchObject([
      { kind: "addThread", command: { pendingReviewNodeId: "PRR_1" } },
    ]);
  });

  it.each([
    ["not_found", 404],
    ["stale_request", 409],
    ["ownership_mismatch", 403],
    ["storage_unavailable", 503],
  ] as const)(
    "maps the %s coordinator failure without writing",
    async (failure, status) => {
      const fixture = routeFixture({ suggestion: err(failure) });
      const response = await fixture.post(request);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: failure });
      expect(fixture.writes).toEqual([]);
    },
  );
});

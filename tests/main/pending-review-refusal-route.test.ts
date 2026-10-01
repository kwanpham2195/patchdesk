import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { err, type Result } from "../../src/domain/result";
import { registerPendingReviewRoutes } from "../../src/main/routes/pending-review-routes";
import { GitHubRefusedDirectSummaryReview } from "../../src/services/direct-summary-review-service";
import { GitHubRefusedPendingReviewWrite } from "../../src/services/pending-review-service";

const reviewId = "acme__octo-org__patchdesk__pr-42__review-abcdef123456";
const expected = {
  sessionId:
    "acme__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__abcdef123456",
  headSha: "a".repeat(40),
  patchHash: "b".repeat(64),
};
const common = { profileId: "acme", reviewId };

/** A refused write answers 409 with its cause, so the renderer can say why (issue #755). */
function routeFixture(
  failure: Result<
    never,
    GitHubRefusedPendingReviewWrite | GitHubRefusedDirectSummaryReview
  >,
) {
  const app = new Hono();
  const refuse = async () => failure;
  const container = {
    sessions: { load: async () => err({ reason: "not_found" }) },
    pendingReviews: {
      start: refuse,
      addThread: refuse,
      submit: refuse,
      discard: refuse,
    },
    directSummaryReviews: { submit: refuse },
    insights: undefined,
  };
  // SAFETY: these routes reach only the scripted services and session store.
  registerPendingReviewRoutes(app, container as never);
  return (path: string, body: RawJsonValue) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
}

const anchor = { path: "src/a.ts", startLine: 3, line: 5, side: "new" };

describe("a refused pending-review or summary write over the local API", () => {
  it.each([
    ["Start", { _tag: "Start", expected, anchor, body: "note" }],
    [
      "AddThread",
      {
        _tag: "AddThread",
        expected,
        pendingReviewNodeId: "PRR_1",
        anchor,
        body: "note",
      },
    ],
    [
      "Submit",
      { _tag: "Submit", expected, event: "COMMENT", summaryBody: "summary" },
    ],
    ["Discard", { _tag: "Discard", expected, confirmation: true }],
  ] as const)(
    "answers a refused %s with 409 and the refusal cause",
    async (_name, command) => {
      const post = routeFixture(
        err(new GitHubRefusedPendingReviewWrite("unprocessable")),
      );
      const response = await post("/v1/reviews/pending-review/command", {
        ...common,
        command,
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "github_refused",
        cause: "unprocessable",
      });
    },
  );

  it("answers a refused direct summary with 409 and the refusal cause", async () => {
    const post = routeFixture(
      err(new GitHubRefusedDirectSummaryReview("unprocessable")),
    );
    const response = await post("/v1/reviews/direct-summary/submit", {
      ...common,
      expected,
      event: "REQUEST_CHANGES",
      body: "summary",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "github_refused",
      cause: "unprocessable",
    });
  });
});

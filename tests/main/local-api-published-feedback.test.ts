import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { err, ok, type Result } from "../../src/domain/result";
import type { RawJsonValue } from "../../src/domain/json";
import { registerPublishedFeedbackRoutes } from "../../src/main/routes/published-feedback-routes";
import type {
  PublishedFeedbackFailure,
  PublishedFeedbackReceipt,
  PublishedFeedbackService,
} from "../../src/services/published-feedback-service";

const expected = {
  sessionId:
    "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
  headSha: "a".repeat(40),
  patchHash: "b".repeat(64),
};
const common = {
  profileId: "cfw",
  reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
  expected,
};

type ServiceResult = Result<PublishedFeedbackReceipt, PublishedFeedbackFailure>;

function routeFixture(
  results: {
    readonly edit?: ServiceResult;
    readonly delete?: ServiceResult;
    readonly dismiss?: ServiceResult;
  } = {},
) {
  const app = new Hono();
  const inputs: Array<
    | Parameters<PublishedFeedbackService["editComment"]>[0]
    | Parameters<PublishedFeedbackService["deleteComment"]>[0]
    | Parameters<PublishedFeedbackService["dismissReview"]>[0]
  > = [];
  const fallback: PublishedFeedbackReceipt = {
    _tag: "PublishedCommentEdited",
    commentId: "201",
    reconciliation: "complete",
  };
  const service = {
    editComment: async (
      input: Parameters<PublishedFeedbackService["editComment"]>[0],
    ) => {
      inputs.push(input);
      return results.edit ?? ok(fallback);
    },
    deleteComment: async (
      input: Parameters<PublishedFeedbackService["deleteComment"]>[0],
    ) => {
      inputs.push(input);
      return (
        results.delete ??
        ok({
          _tag: "PublishedCommentDeleted",
          commentId: "201",
          reconciliation: "complete",
        })
      );
    },
    dismissReview: async (
      input: Parameters<PublishedFeedbackService["dismissReview"]>[0],
    ) => {
      inputs.push(input);
      return (
        results.dismiss ??
        ok({
          _tag: "PublishedReviewDismissed",
          publishedReviewId: "101",
          reconciliation: "complete",
        })
      );
    },
  };
  // SAFETY: this route fixture supplies every container field the registered routes read.
  registerPublishedFeedbackRoutes(app, { publishedFeedback: service } as never);
  return {
    request: (path: string, body: RawJsonValue) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    inputs,
  };
}

describe("published-feedback local API", () => {
  it("strictly rejects unknown fields and malformed represented revision evidence", async () => {
    const fixture = routeFixture();
    for (const body of [
      { ...common, commentId: "201", body: "edited", extra: true },
      {
        ...common,
        expected: { ...expected, headSha: "not-a-sha" },
        commentId: "201",
        body: "edited",
      },
    ]) {
      const response = await fixture.request(
        "/v1/reviews/published-comments/edit",
        body,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_input",
      });
    }
    expect(fixture.inputs).toEqual([]);
  });

  it.each([
    [
      "/v1/reviews/published-comments/edit",
      { ...common, commentId: "201", body: "edited" },
      {
        _tag: "PublishedCommentEdited",
        commentId: "201",
        reconciliation: "complete",
      },
    ],
    [
      "/v1/reviews/published-comments/delete",
      { ...common, commentId: "201", confirmation: true },
      {
        _tag: "PublishedCommentDeleted",
        commentId: "201",
        reconciliation: "complete",
      },
    ],
    [
      "/v1/reviews/published-reviews/dismiss",
      {
        ...common,
        publishedReviewId: "101",
        message: "stale",
        confirmation: true,
      },
      {
        _tag: "PublishedReviewDismissed",
        publishedReviewId: "101",
        reconciliation: "complete",
      },
    ],
  ] as const)(
    "returns the command-specific receipt for %s",
    async (path, body, receipt) => {
      const fixture = routeFixture();
      const response = await fixture.request(path, body);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(receipt);
    },
  );

  it("keeps confirmed refresh-required reconciliation as a bounded 2xx receipt", async () => {
    const receipt: PublishedFeedbackReceipt = {
      _tag: "PublishedCommentDeleted",
      commentId: "201",
      reconciliation: "required",
    };
    const fixture = routeFixture({ delete: ok(receipt) });
    const response = await fixture.request(
      "/v1/reviews/published-comments/delete",
      { ...common, commentId: "201", confirmation: true },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(receipt);
  });

  it("maps outcome_unknown to the shared conflict without raw or internal fields", async () => {
    const fixture = routeFixture({ edit: err("outcome_unknown") });
    const response = await fixture.request(
      "/v1/reviews/published-comments/edit",
      { ...common, commentId: "201", body: "edited" },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ error: "outcome_unknown" });
    expect(JSON.stringify(body)).not.toContain("cause");
    expect(JSON.stringify(body)).not.toContain("operation");
  });
});

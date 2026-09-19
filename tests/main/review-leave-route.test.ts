import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { ok } from "../../src/domain/result";
import { registerReviewLifecycleRoutes } from "../../src/main/routes/review-lifecycle-routes";
import type { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";

type LeaveInput = Parameters<ReviewWorkbenchController["leave"]>[0];
/** A request body as the renderer might send it, well-formed or not. */
type LeaveBody = {
  readonly profileId?: string;
  readonly reviewId?: string;
  readonly headSha?: string;
  readonly seenThrough?: string;
  readonly recordOpen?: boolean;
};

const shown = {
  profileId: "acme",
  reviewId: "acme__octo-org__patchdesk__pr-42__review-abcdef123456",
  headSha: "a".repeat(40),
  seenThrough: "2026-08-09T11:00:00.000Z",
};

function routeFixture() {
  const app = new Hono();
  const leaves: Array<LeaveInput> = [];
  const container = {
    reviewWorkbench: {
      leave: async (input: LeaveInput) => {
        leaves.push(input);
        return ok(null);
      },
    },
  };
  // SAFETY: the route under test reaches only the explicitly supplied service seam.
  registerReviewLifecycleRoutes(app, container as never);
  return {
    request: (body: LeaveBody) =>
      app.request("/v1/reviews/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    leaves,
  };
}

describe("POST /v1/reviews/leave", () => {
  it("forwards the head and newest entry the renderer showed, with or without a dated entry", async () => {
    const fixture = routeFixture();
    const { seenThrough: _seenThrough, ...undated } = shown;
    void _seenThrough;
    expect((await fixture.request(shown)).status).toBe(200);
    expect((await fixture.request(undated)).status).toBe(200);
    expect(fixture.leaves).toEqual([
      shown,
      { ...undated, seenThrough: undefined },
    ]);
  });

  it("refuses a body without a parseable head, timestamp, or with unknown fields", async () => {
    const fixture = routeFixture();
    const refused = [
      { profileId: shown.profileId, reviewId: shown.reviewId },
      { ...shown, headSha: "not-a-sha" },
      { ...shown, seenThrough: "2026-08-09T11:00:00Z" },
      { ...shown, recordOpen: true },
    ];
    for (const body of refused)
      expect((await fixture.request(body)).status).toBe(400);
    expect(fixture.leaves).toEqual([]);
  });
});

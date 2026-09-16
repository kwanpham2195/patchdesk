import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ReviewId, WorkspaceProfileId } from "../../src/domain/ids";
import { ok } from "../../src/domain/result";
import type { RecentReviewWrite } from "../../src/domain/recent-review-write";
import { registerReviewLifecycleRoutes } from "../../src/main/routes/review-lifecycle-routes";

const body = {
  profileId: "cfw",
  reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
};

function routeFixture() {
  const app = new Hono();
  type DetectionInput = {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly recentWrites?: ReadonlyArray<RecentReviewWrite>;
  };
  const detectionInputs: Array<DetectionInput> = [];
  const container = {
    reviewWorkbench: {
      detectUpdates: async (input: DetectionInput) => {
        detectionInputs.push(input);
        return ok({ state: "review" });
      },
    },
  };
  // SAFETY: the route under test reaches only the explicitly supplied service seams.
  registerReviewLifecycleRoutes(app, container as never);
  return {
    request: (recentWrites: ReadonlyArray<RecentReviewWrite>) =>
      app.request("/v1/reviews/detect-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, recentWrites }),
      }),
    detectionInputs,
  };
}

describe("POST /v1/reviews/detect-updates", () => {
  const receipts: ReadonlyArray<readonly [string, RecentReviewWrite]> = [
    [
      "AssigneeChange",
      { _tag: "AssigneeChange", added: ["octocat"], removed: [] },
    ],
    [
      "ReviewerChange",
      { _tag: "ReviewerChange", requested: ["octocat"], removed: ["hubot"] },
    ],
    ["DraftStateChange", { _tag: "DraftStateChange", draft: true }],
  ];

  for (const [tag, receipt] of receipts) {
    it(`accepts a ${tag} receipt and forwards it to detection`, async () => {
      const fixture = routeFixture();
      const response = await fixture.request([receipt]);
      expect(response.status).toBe(200);
      expect(fixture.detectionInputs).toEqual([
        { ...body, recentWrites: [receipt] },
      ]);
    });
  }
});

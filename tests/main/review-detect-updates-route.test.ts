import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  parseGitHubThreadId,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../src/domain/ids";
import { ok } from "../../src/domain/result";
import type { RecentReviewWrite } from "../../src/domain/recent-review-write";
import { registerReviewLifecycleRoutes } from "../../src/main/routes/review-lifecycle-routes";

const body = {
  profileId: "acme",
  reviewId: "acme__octo-org__patchdesk__pr-42__review-abcdef123456",
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
  const threadId = parseGitHubThreadId("PRRT_thread");
  if (threadId._tag === "err") throw new Error("invalid fixture");
  const receipts = {
    Comment: { _tag: "Comment", commentId: "PRRC_1", reviewId: "PRR_1" },
    ThreadState: {
      _tag: "ThreadState",
      threadId: threadId.value,
      state: "resolved",
    },
    PendingThread: { _tag: "PendingThread", threadId: threadId.value },
    DiscardedThread: { _tag: "DiscardedThread", threadId: threadId.value },
    DeletedComment: {
      _tag: "DeletedComment",
      commentId: "2145998877",
      nodeId: "PRRC_deleted",
    },
    DirectSummaryReview: { _tag: "DirectSummaryReview", reviewId: "PRR_1" },
    LabelChange: { _tag: "LabelChange", added: ["bug"], removed: [] },
    AssigneeChange: { _tag: "AssigneeChange", added: ["octocat"], removed: [] },
    ReviewerChange: {
      _tag: "ReviewerChange",
      requested: ["octocat"],
      removed: ["hubot"],
    },
    DraftStateChange: { _tag: "DraftStateChange", draft: true },
    BaseBranchChange: { _tag: "BaseBranchChange", branch: "release/1.2" },
  } satisfies Record<RecentReviewWrite["_tag"], RecentReviewWrite>;

  for (const [tag, receipt] of Object.entries(receipts)) {
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

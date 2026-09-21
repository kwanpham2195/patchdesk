import { describe, expect, it } from "vitest";

import { buildPendingReviewAnnotations } from "../../src/renderer/src/components/review-workbench-annotations";
import { pending } from "./review-workbench-fixtures";

describe("buildPendingReviewAnnotations", () => {
  it("keeps observed pending comments visible while AddThread recovery remains locked", () => {
    const owner = pending("pending");
    if (owner.state !== "pending") throw new Error("fixture");

    const annotations = buildPendingReviewAnnotations({
      pendingReview: {
        state: "recovery_required",
        action: "add_thread",
        review: owner.review,
      },
    });

    expect(annotations).toMatchObject([
      {
        id: "pending-review:PRRT_1",
        pendingReviewThread: {
          body: "Finding",
          nodeId: "PRR_1",
        },
      },
    ]);
  });
});

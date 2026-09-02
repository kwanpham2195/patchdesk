import { describe, expect, it } from "vitest";

import { inspectorReviewStatus } from "../../src/renderer/src/inspector-review-status";
import type { InboxRow } from "../../src/renderer/src/renderer-contracts";

const row: InboxRow = {
  remoteState: "open",
  identity: { host: "github.com", owner: "owner", repo: "repo", number: 1 },
  title: "PR",
  author: "author",
  baseBranch: "main",
  headBranch: "change",
  currentHeadSha: "a".repeat(40),
  isDraft: false,
  updatedAt: "2026-08-13T00:00:00.000Z",
  changeStats: {},
  checks: { overall: "unknown", checks: [] },
  reviewState: "none",
  mergeability: "unknown",
  labels: [],
  categories: [],
  recommendedAction: { kind: "run_review" },
  dataFreshness: "fresh",
};

const reviewOfCurrentHead = {
  reviewId: "review-1",
  reviewedHeadSha: "a".repeat(40),
  updatedAt: "2026-08-13T00:00:00.000Z",
  matchesCurrentHead: true,
};

describe("inspectorReviewStatus", () => {
  it("offers to prepare a session for a head with no saved Review", () => {
    const status = inspectorReviewStatus(row);
    expect(status.kind).toBe("not_reviewed");
    expect(status.label).toBe("Not reviewed");
    expect(status.heads).toEqual(["aaaaaaaa"]);
  });

  it("names the reviewed head when the saved Review still matches it", () => {
    const status = inspectorReviewStatus({
      ...row,
      latestReview: reviewOfCurrentHead,
    });
    expect(status.kind).toBe("current");
    expect(status.label).toBe("Current");
    expect(status.heads).toEqual(["aaaaaaaa"]);
  });

  it("names both heads once the pull request moved past the saved Review", () => {
    const status = inspectorReviewStatus({
      ...row,
      currentHeadSha: "b".repeat(40),
      latestReview: { ...reviewOfCurrentHead, matchesCurrentHead: false },
    });
    expect(status.kind).toBe("updates_available");
    expect(status.label).toBe("Updates available");
    expect(status.heads).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("answers merged first, whatever a saved Review still matches", () => {
    const status = inspectorReviewStatus({
      ...row,
      remoteState: "merged",
      latestReview: reviewOfCurrentHead,
    });
    expect(status.kind).toBe("merged");
    expect(status.label).toBe("Merged");
    expect(status.heads).toEqual(["aaaaaaaa"]);
  });
});

import { describe, expect, it } from "vitest";
import { parseGitSha } from "../../src/domain/ids";
import { projectMaintainerInboxRow } from "../../src/domain/maintainer-inbox";

const sha = parseGitSha("a".repeat(40));
if (sha._tag === "err") throw new Error("fixture SHA invalid");
const reviewId = "review-123" as never;
const input = {
  summary: { ref: { host: "github.com" as never, owner: "owner" as never, repo: "repo" as never, number: 1 as never }, title: "PR", author: "other", baseBranch: "main", headBranch: "change", headSha: sha.value, isDraft: false, isOpen: true, updatedAt: "2026-08-13T00:00:00.000Z" as never, reviewState: "none" as const, mergeability: "unknown" as const, labels: [] },
  checks: { overall: "unknown" as const, checks: [] }, activeAccount: "me", dataFreshness: "fresh" as const,
};
describe("maintainer inbox", () => {
  it("opens an existing changed Review without adopting its new revision", () => {
    const row = projectMaintainerInboxRow({ ...input, latestReview: { reviewId, reviewedHeadSha: "b".repeat(40) as never, updatedAt: "2026-08-12T00:00:00.000Z" as never, matchesCurrentHead: false } });
    expect(row.recommendedAction).toEqual({ kind: "open_saved_review", label: "Open Review", reviewId });
    expect(row.categories).toContain("updated_since_review");
  });
});

import { describe, expect, it } from "vitest";
import { parseGitSha } from "../../src/domain/ids";
import { projectMaintainerInboxRow } from "../../src/domain/maintainer-inbox";

const sha = parseGitSha("a".repeat(40));
if (sha._tag === "err") throw new Error("fixture SHA invalid");
// SAFETY: this opaque fixture id is passed through only to the row projection.
const reviewId = "review-123" as never;
const input = {
  summary: {
    ref: {
      // SAFETY: each literal satisfies its branded GitHub identity parser.
      host: "github.com" as never,
      // SAFETY: each literal satisfies its branded GitHub identity parser.
      owner: "owner" as never,
      // SAFETY: each literal satisfies its branded GitHub identity parser.
      repo: "repo" as never,
      // SAFETY: this positive integer satisfies the branded PR number parser.
      number: 1 as never,
    },
    title: "PR",
    author: "other",
    baseBranch: "main",
    headBranch: "change",
    headSha: sha.value,
    isDraft: false,
    isOpen: true,
    // SAFETY: this fixed ISO timestamp is valid fixture data.
    updatedAt: "2026-08-13T00:00:00.000Z" as never,
    reviewState: "none" as const,
    mergeability: "unknown" as const,
    labels: [],
  },
  checks: { overall: "unknown" as const, checks: [] },
  activeAccount: "me",
  dataFreshness: "fresh" as const,
};
describe("maintainer inbox", () => {
  it("opens an existing changed Review without adopting its new revision", () => {
    const row = projectMaintainerInboxRow({
      ...input,
      latestReview: {
        reviewId,
        // SAFETY: this fixture SHA is exactly 40 lowercase hexadecimal characters.
        reviewedHeadSha: "b".repeat(40) as never,
        // SAFETY: this fixed ISO timestamp is valid fixture data.
        updatedAt: "2026-08-12T00:00:00.000Z" as never,
        matchesCurrentHead: false,
      },
    });
    expect(row.recommendedAction).toEqual({
      kind: "open_saved_review",
      label: "Open Review",
      reviewId,
    });
    expect(row.categories).toContain("updated_since_review");
  });

  it("projects a merged pull request outside active-work queues", () => {
    const row = projectMaintainerInboxRow({
      ...input,
      summary: { ...input.summary, isOpen: false },
    });

    expect(row).toMatchObject({
      remoteState: "merged",
      categories: [],
      recommendedAction: {
        kind: "open_merged_review",
        label: "View merged pull request",
      },
    });
    expect(row.latestReview).toBeUndefined();
  });

  describe("ready_to_merge", () => {
    const matchingReview = {
      reviewId,
      reviewedHeadSha: sha.value,
      // SAFETY: this fixed ISO timestamp is valid fixture data.
      updatedAt: "2026-08-12T00:00:00.000Z" as never,
      matchesCurrentHead: true,
    };
    const readyInput = {
      ...input,
      summary: { ...input.summary, mergeability: "mergeable" as const },
      checks: { overall: "passing" as const, checks: [] },
      latestReview: matchingReview,
      dataFreshness: "fresh" as const,
    };

    it("is emitted when the session matches head, GitHub reports mergeable, checks pass, and data is fresh", () => {
      const row = projectMaintainerInboxRow(readyInput);
      expect(row.categories).toContain("ready_to_merge");
    });

    it("is absent when the data is cached, even though every other condition is satisfied", () => {
      const row = projectMaintainerInboxRow({
        ...readyInput,
        dataFreshness: "cached",
      });
      expect(row.categories).not.toContain("ready_to_merge");
    });

    it("is absent when the saved session no longer matches the current head", () => {
      const row = projectMaintainerInboxRow({
        ...readyInput,
        latestReview: { ...matchingReview, matchesCurrentHead: false },
      });
      expect(row.categories).not.toContain("ready_to_merge");
    });

    it("is absent when GitHub does not report the pull request mergeable", () => {
      const row = projectMaintainerInboxRow({
        ...readyInput,
        summary: {
          ...readyInput.summary,
          mergeability: "conflicting" as const,
        },
      });
      expect(row.categories).not.toContain("ready_to_merge");
    });

    it("is absent when checks are not passing", () => {
      const row = projectMaintainerInboxRow({
        ...readyInput,
        checks: { overall: "failing" as const, checks: [] },
      });
      expect(row.categories).not.toContain("ready_to_merge");
    });
  });
});

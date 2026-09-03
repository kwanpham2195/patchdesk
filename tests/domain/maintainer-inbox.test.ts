import { describe, expect, it } from "vitest";
import { parseGitSha } from "../../src/domain/ids";
import {
  INBOX_CHECK_STATUS_FILTER_VALUES,
  INBOX_REVIEW_STATE_FILTER_VALUES,
  parseInboxAuthorFilter,
  parseInboxBaseBranchFilter,
  projectMaintainerInboxRow,
} from "../../src/domain/maintainer-inbox";
import { err, ok } from "../../src/domain/result";

const sha = parseGitSha("a".repeat(40));
if (sha._tag === "err") throw new Error("fixture SHA invalid");
const previousSha = parseGitSha("b".repeat(40));
if (previousSha._tag === "err") throw new Error("fixture SHA invalid");
// SAFETY: this fixed ISO timestamp is valid fixture data.
const reviewTimestamp = "2026-08-12T00:00:00.000Z" as never;
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
  it("exposes the bounded GitHub review and check filter values", () => {
    expect(INBOX_REVIEW_STATE_FILTER_VALUES).toEqual([
      "none",
      "required",
      "approved",
      "changes_requested",
    ]);
    expect(INBOX_CHECK_STATUS_FILTER_VALUES).toEqual([
      "pending",
      "success",
      "failure",
    ]);
  });

  it("accepts a login, @me, and a slashed branch name as filter text", () => {
    expect(parseInboxAuthorFilter("octocat")).toEqual(ok("octocat"));
    expect(parseInboxAuthorFilter("  @me  ")).toEqual(ok("@me"));
    expect(parseInboxBaseBranchFilter("release/2.0")).toEqual(
      ok("release/2.0"),
    );
  });

  it("names the rule a refused author or base branch broke", () => {
    expect(parseInboxAuthorFilter("John Smith")).toEqual(err("characters"));
    expect(parseInboxAuthorFilter('"x"')).toEqual(err("characters"));
    expect(parseInboxAuthorFilter(`octo${String.fromCharCode(1)}cat`)).toEqual(
      err("characters"),
    );
    expect(parseInboxAuthorFilter("a".repeat(40))).toEqual(err("too_long"));
    expect(parseInboxBaseBranchFilter("b".repeat(101))).toEqual(
      err("too_long"),
    );
    expect(parseInboxAuthorFilter("   ")).toEqual(err("empty"));
    expect(parseInboxBaseBranchFilter("")).toEqual(err("empty"));
  });

  it("opens an existing changed Review without adopting its new revision", () => {
    const row = projectMaintainerInboxRow({
      ...input,
      latestReview: {
        reviewId,
        // SAFETY: this fixture SHA is exactly 40 lowercase hexadecimal characters.
        reviewedHeadSha: previousSha.value,

        // SAFETY: this fixed ISO timestamp is valid fixture data.
        updatedAt: reviewTimestamp,
        matchesCurrentHead: false,
      },
    });
    expect(row.recommendedAction).toEqual({
      kind: "open_saved_review",
      reviewId,
    });
    expect(row.categories).toContain("updated_since_review");
  });

  it("keeps Open Review as the one action for a ready-to-merge matching Review", () => {
    const row = projectMaintainerInboxRow({
      ...input,
      summary: { ...input.summary, mergeability: "mergeable" },
      checks: { overall: "passing", checks: [] },
      latestReview: {
        reviewId,
        reviewedHeadSha: sha.value,
        updatedAt: reviewTimestamp,
        matchesCurrentHead: true,
      },
    });

    expect(row.categories).toContain("ready_to_merge");
    expect(row.recommendedAction).toEqual({
      kind: "open_saved_review",
      reviewId,
    });
  });

  it("carries Insight readiness onto an open row and a merged one alike", () => {
    const insights = {
      brief: "ready" as const,
      analysis: "outdated" as const,
    };
    expect(projectMaintainerInboxRow({ ...input, insights }).insights).toEqual(
      insights,
    );
    expect(
      projectMaintainerInboxRow({
        ...input,
        summary: { ...input.summary, isOpen: false },
        insights,
      }).insights,
    ).toEqual(insights);
  });

  it("leaves Insight readiness off a row the caller reports nothing for", () => {
    expect(projectMaintainerInboxRow(input).insights).toBeUndefined();
    expect("insights" in projectMaintainerInboxRow(input)).toBe(false);
  });

  it("projects a merged pull request outside active-work queues", () => {
    const row = projectMaintainerInboxRow({
      ...input,
      summary: { ...input.summary, isOpen: false },
    });

    expect(row).toMatchObject({
      remoteState: "merged",
      categories: [],
      recommendedAction: { kind: "open_merged_review" },
    });
    expect(row.latestReview).toBeUndefined();
  });

  describe("ready_to_merge", () => {
    const matchingReview = {
      reviewId,
      reviewedHeadSha: sha.value,
      // SAFETY: this fixed ISO timestamp is valid fixture data.
      updatedAt: reviewTimestamp,
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

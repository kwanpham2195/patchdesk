// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MaintainerInbox } from "../../src/renderer/src/components/maintainer-inbox";
import type { InboxRow } from "../../src/renderer/src/renderer-contracts";
const row: InboxRow = {
  identity: { host: "github.com", owner: "owner", repo: "repo", number: 1 },
  title: "PR",
  author: "author",
  baseBranch: "main",
  headBranch: "change",
  currentHeadSha: "a".repeat(40),
  isDraft: false,
  updatedAt: "2026-08-13T00:00:00.000Z",
  changeStats: {},
  checks: { overall: "unknown" as const, checks: [] },
  reviewState: "none" as const,
  mergeability: "unknown" as const,
  latestReview: {
    reviewId: "review-1",
    reviewedHeadSha: "a".repeat(40),
    updatedAt: "2026-08-13T00:00:00.000Z",
    matchesCurrentHead: true,
  },
  categories: ["saved_review"],
  recommendedAction: {
    kind: "open_saved_review" as const,
    label: "Open Review" as const,
    reviewId: "review-1",
  },
  dataFreshness: "fresh" as const,
};
describe("MaintainerInbox", () => {
  it("opens a saved Review by review id", () => {
    const open = vi.fn();
    render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={open}
      />,
    );
    fireEvent.click(screen.getByRole("option"));
    expect(open).toHaveBeenCalledWith("review-1");
  });

  it("carries the repository only while the view spans more than one", () => {
    const sized: InboxRow = {
      ...row,
      changeStats: { changedFiles: 28, additions: 361_006, deletions: 17 },
    };
    const other: InboxRow = {
      ...row,
      identity: { ...row.identity, repo: "other", number: 2 },
    };
    const { container, rerender } = render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[sized]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const [only] = within(container).getAllByRole("option");
    if (only === undefined) throw new Error("expected one inbox row");
    expect(within(only).queryByTitle("owner/repo")).toBeNull();
    // The row renders one change-size cell per breakpoint; only one is visible.
    expect(
      within(only).getAllByTitle("28 files · +361006 · -17").length,
    ).toBeGreaterThan(0);
    expect(within(only).getAllByText("+361k").length).toBeGreaterThan(0);

    rerender(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[sized, other]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const repositories = within(container)
      .getAllByRole("option")
      .map((node) =>
        node.querySelector("[title^='owner/']")?.getAttribute("title"),
      );
    expect(new Set(repositories)).toEqual(
      new Set(["owner/repo", "owner/other"]),
    );
  });

  it("shows a blocking banner naming the elapsed age when the cache is stale", () => {
    const { container } = render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[row]}
        freshness="cached"
        refreshStatus="Stale"
        snapshot={{
          state: "stale_cached",
          refreshedAt: "2020-01-01T00:00:00.000Z",
        }}
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(
      within(container).getByText(/Priority order may be unreliable/),
    ).toBeTruthy();
  });

  it("shows visible elapsed-age copy for a cached-after-failure snapshot", () => {
    const { container } = render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[row]}
        freshness="cached"
        refreshStatus="Cached after refresh failure"
        snapshot={{
          state: "failed_cached",
          refreshedAt: "2020-01-01T00:00:00.000Z",
        }}
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(within(container).getByText(/Updated .* ago/)).toBeTruthy();
  });
});

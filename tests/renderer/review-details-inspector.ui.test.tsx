// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { MaintainerInbox } from "../../src/renderer/src/components/maintainer-inbox";
import type { InboxRow } from "../../src/renderer/src/renderer-contracts";

afterEach(() => {
  cleanup();
});

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
  latestReview: {
    reviewId: "review-1",
    reviewedHeadSha: "a".repeat(40),
    updatedAt: "2026-08-13T00:00:00.000Z",
    matchesCurrentHead: true,
  },
  categories: [],
  recommendedAction: { kind: "open_saved_review", reviewId: "review-1" },
  dataFreshness: "fresh",
};

describe("ReviewDetailsInspector", () => {
  it("leads the inspector with the row's review state and keeps one Open", () => {
    const { rerender } = render(
      <MaintainerInbox
        profileId="inspector-status"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getByRole("status", { name: "Current" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);

    const movedRow: InboxRow = {
      ...row,
      currentHeadSha: "b".repeat(40),
      latestReview: {
        reviewId: "review-1",
        reviewedHeadSha: "a".repeat(40),
        updatedAt: "2026-08-13T00:00:00.000Z",
        matchesCurrentHead: false,
      },
    };
    rerender(
      <MaintainerInbox
        profileId="inspector-status"
        profileLabel="P"
        rows={[movedRow]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("status", { name: "Updates available" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);

    const { latestReview: _dropped, ...unreviewed } = row;
    rerender(
      <MaintainerInbox
        profileId="inspector-status"
        profileLabel="P"
        rows={[unreviewed]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getByRole("status", { name: "Not reviewed" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);
  });

  it("shows the scope legend for a row that carries a retained scope", () => {
    render(
      <MaintainerInbox
        profileId="inspector-scope"
        profileLabel="P"
        rows={[
          {
            ...row,
            scope: {
              buckets: [
                { bucket: "core", files: 11, additions: 120, deletions: 30 },
                { bucket: "config", files: 1, additions: 4, deletions: 0 },
              ],
              total: { files: 12, additions: 124, deletions: 30 },
            },
          },
        ]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const scopeCell = screen.getByText("Scope").parentElement;
    if (!(scopeCell instanceof HTMLElement))
      throw new Error("expected a Scope cell in the inspector's facts grid");
    expect(
      within(scopeCell)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Core11", "Config1"]);
  });
});

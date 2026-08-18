// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MaintainerInbox } from "../../src/renderer/src/components/maintainer-inbox";
import type { InboxRow } from "../../src/renderer/src/renderer-contracts";

afterEach(() => {
  cleanup();
});

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
  labels: [],
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

  it("renders label chips on the row and in the Inspector, showing truncation only in the Inspector", () => {
    const labeled: InboxRow = {
      ...row,
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "enhancement", color: "a2eeef" },
      ],
      labelCount: 5,
    };
    render(
      <MaintainerInbox
        profileId="label-chips"
        profileLabel="P"
        rows={[labeled]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getAllByText("bug").length).toBeGreaterThan(0);
    expect(screen.getAllByText("enhancement").length).toBeGreaterThan(0);
    // The single row is auto-selected, so the Inspector already shows its
    // labels; "+N more" (labelCount truncation) is Inspector-only copy that
    // never appears in the dense row itself.
    expect(screen.getByText("+3 more")).toBeTruthy();
  });

  it("filters rows by the selected label", async () => {
    const user = userEvent.setup();
    const bugRow: InboxRow = {
      ...row,
      identity: { ...row.identity, number: 1 },
      title: "Bug fix",
      labels: [{ name: "bug", color: "d73a4a" }],
    };
    const featureRow: InboxRow = {
      ...row,
      identity: { ...row.identity, number: 2 },
      title: "New feature",
      labels: [{ name: "enhancement", color: "a2eeef" }],
    };
    render(
      <MaintainerInbox
        profileId="label-filter"
        profileLabel="P"
        rows={[bugRow, featureRow]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/Bug fix/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/New feature/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Filter by label" }));
    await user.click(await screen.findByRole("checkbox", { name: "bug" }));

    expect(
      screen.getByRole("button", { name: "Filter by label" }).textContent,
    ).toContain("bug");
    expect(screen.getAllByText(/Bug fix/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/New feature/)).toBeNull();
  });

  it("restores a saved view's selected label", async () => {
    const user = userEvent.setup();
    const bugRow: InboxRow = {
      ...row,
      identity: { ...row.identity, number: 1 },
      title: "Bug fix",
      labels: [{ name: "bug", color: "d73a4a" }],
    };
    const featureRow: InboxRow = {
      ...row,
      identity: { ...row.identity, number: 2 },
      title: "New feature",
      labels: [{ name: "enhancement", color: "a2eeef" }],
    };
    render(
      <MaintainerInbox
        profileId="label-saved-view"
        profileLabel="P"
        rows={[bugRow, featureRow]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter by label" }));
    await user.click(await screen.findByRole("checkbox", { name: "bug" }));
    expect(screen.queryByText(/New feature/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /save current view/i }));
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: "Bugs only" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save view/i }));

    // Clear the label filter directly; "New feature" becomes visible again.
    await user.click(
      await screen.findByRole("button", { name: "Filter by label" }),
    );
    await user.click(await screen.findByRole("button", { name: /clear/i }));
    expect(await screen.findByText(/New feature/)).toBeTruthy();

    // Re-select the saved view; the label filter should be restored.
    fireEvent.click(screen.getByRole("button", { name: "Bugs only" }));
    expect(screen.getAllByText(/Bug fix/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/New feature/)).toBeNull();
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

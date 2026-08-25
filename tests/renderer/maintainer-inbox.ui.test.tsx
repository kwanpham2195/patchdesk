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

  it("delegates page navigation through callbacks without loading an inbox itself", () => {
    const previous = vi.fn();
    const next = vi.fn();
    render(
      <MaintainerInbox
        profileId="pagination"
        profileLabel="P"
        scope="open"
        page={2}
        hasPreviousPage
        hasNextPage
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onPreviousPage={previous}
        onNextPage={next}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getByText("Page 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
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

  it("renders each label in a dedicated column and clamps pull request titles to two lines", () => {
    const labeled: InboxRow = {
      ...row,
      title:
        "A long pull request title that must wrap cleanly before it truncates after the second line",
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
    expect(screen.getAllByText("Labels").length).toBeGreaterThan(1);
    const inboxRow = screen.getByRole("option");
    const labelColumn = inboxRow.querySelector(
      '[data-slot="pull-request-label-column"]',
    );
    if (!(labelColumn instanceof HTMLDivElement))
      throw new Error("expected dedicated pull request label column");
    expect(within(labelColumn).getByTitle("bug")).toBeTruthy();
    expect(within(labelColumn).getByTitle("enhancement")).toBeTruthy();
    expect(labelColumn.className).toContain("flex-col");
    const title = within(inboxRow).getByTitle(`#1 ${labeled.title}`);
    expect(title.className).toContain("line-clamp-2");
    // The single row is auto-selected, so the Inspector still gives the
    // complete label count when GitHub returned only a partial label list.
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

  it("filters rows by selected repositories, multi-select, without narrowing the label list", async () => {
    const user = userEvent.setup();
    const acmeRow: InboxRow = {
      ...row,
      identity: { ...row.identity, owner: "acme", repo: "widgets", number: 1 },
      title: "Acme fix",
      labels: [{ name: "bug", color: "d73a4a" }],
    };
    const otherRow: InboxRow = {
      ...row,
      identity: { ...row.identity, owner: "other", repo: "gizmos", number: 2 },
      title: "Other feature",
      labels: [{ name: "enhancement", color: "a2eeef" }],
    };
    const thirdRow: InboxRow = {
      ...row,
      identity: { ...row.identity, owner: "third", repo: "gadgets", number: 3 },
      title: "Third change",
      labels: [],
    };
    render(
      <MaintainerInbox
        profileId="repo-filter"
        profileLabel="P"
        rows={[acmeRow, otherRow, thirdRow]}
        repos={[
          { host: "github.com", owner: "acme", repo: "widgets" },
          { host: "github.com", owner: "other", repo: "gizmos" },
          { host: "github.com", owner: "third", repo: "gadgets" },
        ]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/Acme fix/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Other feature/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Third change/).length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: "Filter by repository" }),
    );
    await user.click(
      await screen.findByRole("checkbox", { name: "acme/widgets" }),
    );
    expect(
      screen.getByRole("button", { name: "Filter by repository" }).textContent,
    ).toContain("acme/widgets");
    expect(screen.getAllByText(/Acme fix/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Other feature/)).toBeNull();
    expect(screen.queryByText(/Third change/)).toBeNull();

    // Selecting a second repository widens the result rather than narrowing
    // further, proving this is a multi-select rather than a single choice.
    await user.click(
      await screen.findByRole("checkbox", { name: "other/gizmos" }),
    );
    expect(
      screen.getByRole("button", { name: "Filter by repository" }).textContent,
    ).toContain("2 repositories");
    expect(screen.getAllByText(/Acme fix/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Other feature/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Third change/)).toBeNull();

    // Selecting repositories must not narrow the label filter's own options
    // — the two filters compose independently, exactly like labels do today.
    await user.click(screen.getByRole("button", { name: "Filter by label" }));
    expect(await screen.findByRole("checkbox", { name: "bug" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "enhancement" })).toBeTruthy();
  });

  it("clears the repository filter via the popover's Clear affordance", async () => {
    const user = userEvent.setup();
    const acmeRow: InboxRow = {
      ...row,
      identity: { ...row.identity, owner: "acme", repo: "widgets", number: 1 },
      title: "Acme fix",
    };
    const otherRow: InboxRow = {
      ...row,
      identity: { ...row.identity, owner: "other", repo: "gizmos", number: 2 },
      title: "Other feature",
    };
    render(
      <MaintainerInbox
        profileId="repo-clear"
        profileLabel="P"
        rows={[acmeRow, otherRow]}
        repos={[
          { host: "github.com", owner: "acme", repo: "widgets" },
          { host: "github.com", owner: "other", repo: "gizmos" },
        ]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Filter by repository" }),
    );
    await user.click(
      await screen.findByRole("checkbox", { name: "acme/widgets" }),
    );
    expect(screen.queryByText(/Other feature/)).toBeNull();

    // The popover is still open from the selection above — click Clear
    // directly rather than re-toggling the trigger, which would close it.
    await user.click(await screen.findByRole("button", { name: /clear/i }));
    expect(await screen.findByText(/Other feature/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Filter by repository" }).textContent,
    ).toContain("All repositories");
  });

  it("restores a saved view's selected repositories", async () => {
    const user = userEvent.setup();
    const acmeRow: InboxRow = {
      ...row,
      identity: { ...row.identity, owner: "acme", repo: "widgets", number: 1 },
      title: "Acme fix",
    };
    const otherRow: InboxRow = {
      ...row,
      identity: { ...row.identity, owner: "other", repo: "gizmos", number: 2 },
      title: "Other feature",
    };
    render(
      <MaintainerInbox
        profileId="repo-saved-view"
        profileLabel="P"
        rows={[acmeRow, otherRow]}
        repos={[
          { host: "github.com", owner: "acme", repo: "widgets" },
          { host: "github.com", owner: "other", repo: "gizmos" },
        ]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Filter by repository" }),
    );
    await user.click(
      await screen.findByRole("checkbox", { name: "acme/widgets" }),
    );
    expect(screen.queryByText(/Other feature/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /save current view/i }));
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: "Acme only" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save view/i }));

    // Clear the repo filter directly; "Other feature" becomes visible again.
    await user.click(
      await screen.findByRole("button", { name: "Filter by repository" }),
    );
    await user.click(await screen.findByRole("button", { name: /clear/i }));
    expect(await screen.findByText(/Other feature/)).toBeTruthy();

    // Re-select the saved view; the repository filter should be restored.
    fireEvent.click(screen.getByRole("button", { name: "Acme only" }));
    expect(screen.getAllByText(/Acme fix/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Other feature/)).toBeNull();
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

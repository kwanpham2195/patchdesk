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
  categories: ["updated_since_review"],
  recommendedAction: {
    kind: "open_saved_review" as const,
    reviewId: "review-1",
  },
  dataFreshness: "fresh" as const,
};
describe("MaintainerInbox", () => {
  it("offers one Open action for a ready-to-merge row, cached or fresh", () => {
    const openReview = vi.fn();
    const openReviewId = vi.fn();
    const readyRow: InboxRow = {
      ...row,
      categories: ["ready_to_merge"],
      checks: { overall: "passing", checks: [] },
      mergeability: "mergeable",
    };
    const { rerender } = render(
      <MaintainerInbox
        profileId="ready-actions"
        profileLabel="P"
        rows={[readyRow]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={openReview}
        onOpenReviewId={openReviewId}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openReview).not.toHaveBeenCalled();
    expect(openReviewId).toHaveBeenCalledTimes(1);
    expect(openReviewId).toHaveBeenNthCalledWith(1, "review-1");

    rerender(
      <MaintainerInbox
        profileId="ready-actions"
        profileLabel="P"
        rows={[readyRow]}
        freshness="cached"
        refreshStatus="Cached after refresh failure"
        onOpenReview={openReview}
        onOpenReviewId={openReviewId}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Open" }).hasAttribute("disabled"),
    ).toBe(false);

    rerender(
      <MaintainerInbox
        profileId="ready-actions"
        profileLabel="P"
        rows={[readyRow]}
        freshness="fresh"
        refreshStatus="Current"
        openingOperations={
          new Map([["github.com/owner/repo#1", { status: "opening" as const }]])
        }
        onOpenReview={openReview}
        onOpenReviewId={openReviewId}
      />,
    );
    expect(
      screen
        .getAllByRole("button", { name: /Opening…/ })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);

    rerender(
      <MaintainerInbox
        profileId="ordinary-action"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={openReview}
        onOpenReviewId={openReviewId}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);
  });

  it("opens a saved Review by review id", () => {
    const open = vi.fn();
    render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={open}
      />,
    );
    fireEvent.click(screen.getByRole("option"));
    expect(open).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByRole("option"));
    expect(open).toHaveBeenCalledWith("review-1");
  });

  it("opens a Review from the row title", () => {
    const open = vi.fn();
    render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={open}
      />,
    );
    fireEvent.click(rowTitle(screen.getByRole("option")));
    expect(open).toHaveBeenCalledWith("review-1");
  });

  it("opens the selected Review on Enter without leaving the row list", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={open}
      />,
    );
    const option = screen.getByRole("option");
    option.focus();
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledWith("review-1");
  });

  it("scopes pending and failure feedback to the owning row and inspector action", () => {
    const key = "github.com/owner/repo#1";
    const { rerender } = render(
      <MaintainerInbox
        profileId="opening"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        openingOperations={new Map([[key, { status: "opening" }]])}
        onOpenReview={() => undefined}
        onOpenReviewId={() => undefined}
      />,
    );
    expect(screen.getByRole("option").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      screen.getByRole("button", { name: /Opening…/ }).hasAttribute("disabled"),
    ).toBe(true);

    rerender(
      <MaintainerInbox
        profileId="opening"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        openingOperations={
          new Map([[key, { status: "error", error: "Request failed" }]])
        }
        onOpenReview={() => undefined}
        onOpenReviewId={() => undefined}
      />,
    );
    expect(screen.getByRole("option").getAttribute("aria-disabled")).toBe(
      "false",
    );
    expect(within(screen.getByRole("option")).getByRole("alert")).toBeTruthy();
  });

  it("delegates page navigation through callbacks without loading an inbox itself", () => {
    const previous = vi.fn();
    const next = vi.fn();
    render(
      <MaintainerInbox
        profileId="pagination"
        profileLabel="P"
        state="open"
        hasPreviousPage
        hasNextPage
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onPreviousPage={previous}
        onNextPage={next}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Go to previous page"));
    fireEvent.click(screen.getByLabelText("Go to next page"));
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("disables an unavailable pagination direction and ignores clicks on it", () => {
    const previous = vi.fn();
    const next = vi.fn();
    const { rerender } = render(
      <MaintainerInbox
        profileId="pagination-disabled"
        profileLabel="P"
        state="open"
        hasPreviousPage={false}
        hasNextPage
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onPreviousPage={previous}
        onNextPage={next}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    // A real `disabled` button, not `aria-disabled` on a clickable anchor
    // (see maintainer-inbox.tsx's `InboxFooter`) — genuinely inert, not just
    // advisory.
    const previousButton = screen.getByLabelText("Go to previous page");
    if (!(previousButton instanceof HTMLButtonElement))
      throw new Error("expected a button element");
    expect(previousButton.disabled).toBe(true);
    fireEvent.click(previousButton);
    expect(previous).not.toHaveBeenCalled();

    // hasPreviousPage is now true, but a refresh in flight must also disable
    // both directions.
    rerender(
      <MaintainerInbox
        profileId="pagination-disabled"
        profileLabel="P"
        state="open"
        hasPreviousPage
        hasNextPage
        rows={[row]}
        freshness="fresh"
        refreshStatus="Refreshing"
        onPreviousPage={previous}
        onNextPage={next}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const nextButton = screen.getByLabelText("Go to next page");
    if (!(nextButton instanceof HTMLButtonElement))
      throw new Error("expected a button element");
    expect(nextButton.disabled).toBe(true);
    fireEvent.click(nextButton);
    expect(next).not.toHaveBeenCalled();
  });

  it("moves the page controls to a footer below the row list and drops the header's page number", () => {
    render(
      <MaintainerInbox
        profileId="footer-placement"
        profileLabel="P"
        state="open"
        hasPreviousPage
        hasNextPage
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onPreviousPage={vi.fn()}
        onNextPage={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^Page \d+$/)).toBeNull();
    const header = screen.getByRole("banner");
    expect(within(header).queryByLabelText("Go to previous page")).toBeNull();
    expect(within(header).queryByLabelText("Go to next page")).toBeNull();
    expect(within(header).queryByLabelText("Rows per page")).toBeNull();

    const pagination = screen.getByRole("navigation", {
      name: "Pull requests pages",
    });
    const footer = pagination.closest("footer");
    if (footer === null) throw new Error("Expected pagination in a footer");
    expect(within(footer).getByText("Rows per page")).toBeTruthy();
    expect(within(footer).getByLabelText("Go to previous page")).toBeTruthy();
    expect(within(footer).getByLabelText("Go to next page")).toBeTruthy();
  });

  it("renders the rows-per-page selector bound to the confirmed size and calls back on selection", async () => {
    const user = userEvent.setup();
    const onPageSizeChange = vi.fn();
    render(
      <MaintainerInbox
        profileId="rows-per-page"
        profileLabel="P"
        state="open"
        pageSize={25}
        hasPreviousPage
        hasNextPage
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onPageSizeChange={onPageSizeChange}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Rows per page" });
    expect(select.textContent).toContain("25");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "10" }));
    expect(onPageSizeChange).toHaveBeenCalledWith(10);
  });

  const repoA = { host: "github.com", owner: "acme", repo: "widgets" };
  const repoB = { host: "github.com", owner: "acme", repo: "gadgets" };

  it("does not render the repository picker without a watchlist", () => {
    render(
      <MaintainerInbox
        profileId="no-watchlist"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
  });

  it("still shows the labelled repository picker for exactly one watched repository", () => {
    render(
      <MaintainerInbox
        profileId="one-repo"
        profileLabel="P"
        rows={[row]}
        repos={[repoA]}
        selectedRepository={repoA}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const combo = screen.getByRole("combobox", { name: "Repository" });
    // Labelled so the current state is readable without opening it.
    expect(combo.textContent).toContain("acme/widgets");
  });

  it("selects a different watched repository by keyboard alone and calls back", async () => {
    const user = userEvent.setup();
    const onRepositoryChange = vi.fn();
    render(
      <MaintainerInbox
        profileId="repo-picker"
        profileLabel="P"
        rows={[row]}
        repos={[repoA, repoB]}
        selectedRepository={repoA}
        onRepositoryChange={onRepositoryChange}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const combo = screen.getByRole("combobox", { name: "Repository" });
    combo.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onRepositoryChange).toHaveBeenCalledWith(repoB);
  });

  it("shows merged rows and delegates state selection through the filter bar", async () => {
    const user = userEvent.setup();
    const stateChange = vi.fn();
    const mergedRow: InboxRow = {
      ...row,
      remoteState: "merged",
      categories: [],
      recommendedAction: { kind: "open_merged_review" },
    };
    render(
      <MaintainerInbox
        profileId="merged"
        profileLabel="P"
        state="merged"
        rows={[mergedRow]}
        freshness="fresh"
        refreshStatus="Current"
        onStateChange={stateChange}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    // The row's Merged badge, the filter bar's state Select showing its
    // current value, and the inspector's review-state card — the queue rail
    // is gone entirely (slice 8a), so no fourth "Merged" source remains.
    expect(screen.getAllByText("Merged")).toHaveLength(3);
    const stateSelect = screen.getByRole("combobox", {
      name: "Pull request state",
    });
    await user.click(stateSelect);
    await user.click(await screen.findByRole("option", { name: "Open" }));
    expect(stateChange).toHaveBeenCalledWith("open");
  });

  it("reflects the requested state in the filter bar's state Select", () => {
    render(
      <MaintainerInbox
        profileId="state-pressed"
        profileLabel="P"
        state="merged"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onStateChange={vi.fn()}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Pull request state" }).textContent,
    ).toContain("Merged");
  });

  it("offers controlled review and check filters with active chips and clear actions", async () => {
    const user = userEvent.setup();
    const onReviewStateChange = vi.fn();
    const onCheckStatusChange = vi.fn();
    const onClearInboxMoreFilters = vi.fn();
    const { rerender } = render(
      <MaintainerInbox
        profileId="more-filters"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onReviewStateChange={onReviewStateChange}
        onCheckStatusChange={onCheckStatusChange}
        onClearInboxMoreFilters={onClearInboxMoreFilters}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More filters" }));
    expect(screen.getByRole("heading", { name: "More filters" })).toBeTruthy();
    const reviewSelect = screen.getByRole("combobox", {
      name: "Review state",
    });
    const checkSelect = screen.getByRole("combobox", {
      name: "Check status",
    });
    await user.click(reviewSelect);
    expect(
      await screen.findByRole("option", { name: "Not reviewed" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Review required" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Approved" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Changes requested" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("option", { name: "Approved" }));
    expect(onReviewStateChange).toHaveBeenCalledWith("approved");

    await user.click(reviewSelect);
    await user.click(await screen.findByRole("option", { name: "Any" }));
    expect(onReviewStateChange).toHaveBeenLastCalledWith(undefined);

    await user.click(checkSelect);
    expect(await screen.findByRole("option", { name: "Pending" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Passing" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Failing" })).toBeTruthy();

    rerender(
      <MaintainerInbox
        profileId="more-filters"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        reviewState="approved"
        checkStatus="failure"
        onReviewStateChange={onReviewStateChange}
        onCheckStatusChange={onCheckStatusChange}
        onClearInboxMoreFilters={onClearInboxMoreFilters}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("2 active filters")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Clear review filter" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Clear check filter" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(onClearInboxMoreFilters).toHaveBeenCalledTimes(1);
  });

  it("renders large change counts in compact form", () => {
    const sized: InboxRow = {
      ...row,
      changeStats: { changedFiles: 28, additions: 361_006, deletions: 17 },
    };
    const { container } = render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[sized]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const [only] = within(container).getAllByRole("option");
    if (only === undefined) throw new Error("expected one inbox row");
    // The row renders one change-size cell per breakpoint; only one is visible.
    expect(
      within(only).getAllByTitle("28 files · +361006 · -17").length,
    ).toBeGreaterThan(0);
    expect(within(only).getAllByText("+361k").length).toBeGreaterThan(0);
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
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const warning = within(container).getByText(
      /Priority order may be unreliable/,
    );
    const alert = warning.closest('[data-slot="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.className).toContain("status-warning");
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
    const title = rowTitle(inboxRow);
    expect(title.className).toContain("line-clamp-2");
    // The single row is auto-selected, so the Inspector still gives the
    // complete label count when GitHub returned only a partial label list.
    expect(screen.getByText("+3 more")).toBeTruthy();
  });

  it("sends the label filter to GitHub instead of filtering loaded rows locally", async () => {
    const user = userEvent.setup();
    const onLabelsChange = vi.fn();
    const fetchLabels = vi.fn(async () => ({
      state: "ready" as const,
      labels: [
        { id: "LA_bug", name: "bug", color: "d73a4a" },
        { id: "LA_enhancement", name: "enhancement", color: "a2eeef" },
      ],
      totalCount: 2,
    }));
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
        onLabelsChange={onLabelsChange}
        labelActions={{ fetchLabels }}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/Bug fix/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/New feature/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Filter by label" }));
    await user.click(await screen.findByRole("checkbox", { name: "bug" }));

    // The label filter is a GitHub `label:"NAME"` search qualifier now (ADR
    // 0031/0032): selecting it asks the parent for a new request rather
    // than filtering the already-loaded page, so both rows stay on screen
    // until that request's response replaces `rows`.
    expect(onLabelsChange).toHaveBeenCalledWith(["bug"]);
    expect(screen.getAllByText(/Bug fix/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/New feature/).length).toBeGreaterThan(0);
  });

  it("offers a label that appears on no loaded row, fed from the repository-wide read instead of `rows`", async () => {
    const user = userEvent.setup();
    const onLabelsChange = vi.fn();
    // Only "bug" is attached to the one loaded row; "wontfix" exists only in
    // the repository-wide read `fetchLabels` stands in for. Deriving options
    // from `rows` (the pre-slice-10 defect) could never offer it.
    const fetchLabels = vi.fn(async () => ({
      state: "ready" as const,
      labels: [
        { id: "LA_bug", name: "bug", color: "d73a4a" },
        { id: "LA_wontfix", name: "wontfix", color: "ffffff" },
      ],
      totalCount: 2,
    }));
    const bugRow: InboxRow = {
      ...row,
      identity: { ...row.identity, number: 1 },
      title: "Bug fix",
      labels: [{ name: "bug", color: "d73a4a" }],
    };
    render(
      <MaintainerInbox
        profileId="label-filter-offpage"
        profileLabel="P"
        rows={[bugRow]}
        freshness="fresh"
        refreshStatus="Current"
        onLabelsChange={onLabelsChange}
        labelActions={{ fetchLabels }}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter by label" }));
    const wontfixCheckbox = await screen.findByRole("checkbox", {
      name: "wontfix",
    });
    await user.click(wontfixCheckbox);
    expect(onLabelsChange).toHaveBeenCalledWith(["wontfix"]);
  });

  it("shows the read failure instead of an empty list when the label read fails", async () => {
    const user = userEvent.setup();
    const fetchLabels = vi.fn(async () => undefined);
    render(
      <MaintainerInbox
        profileId="label-filter-failed"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        labelActions={{ fetchLabels }}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter by label" }));
    expect(
      await screen.findByText(
        "Patchdesk could not load this repository's labels. Reopen this menu to retry.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("alert").getAttribute("data-slot")).toBe("alert");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("does not render the label filter trigger before a repository is selected", () => {
    render(
      <MaintainerInbox
        profileId="label-filter-none"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Filter by label" }),
    ).toBeNull();
  });

  it("reserves the review-details grid column while the inspector is open", () => {
    // Assert on the rendered className directly (via `container.firstChild`,
    // the component's root grid div)
    // since there is no dedicated seam for the grid template today.
    const { container } = render(
      <MaintainerInbox
        profileId="grid-columns"
        profileLabel="P"
        state="open"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    const grid = container.firstChild;
    if (!(grid instanceof HTMLElement))
      throw new Error("expected root grid element");
    // Inspector open by default (see `inbox-view-preferences.ts`), so the
    // grid reserves the review-details column. The queue rail's own column
    // — reserved only in "open" state — is gone entirely (slice 8a); there
    // is no state-conditional grid template left to assert on.
    expect(grid.className).toMatch(/grid-cols-\[minmax\(0,1fr\)_21rem\]/);
  });

  it("refreshes GitHub from the freshness badge, the screen's one refresh affordance", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={refresh}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Refresh pull requests. GitHub: Current",
      }),
    );

    // Refresh stays explicit under ADR 0032 — one click, one read, and the
    // badge never refreshes itself.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not offer refresh from the badge while a read is already in flight", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    render(
      <MaintainerInbox
        profileId="p"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Refreshing"
        onRefresh={refresh}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    const badge = screen.getByRole("button", {
      name: "Refresh pull requests. GitHub: Refreshing",
    });
    expect(badge.hasAttribute("disabled")).toBe(true);
    await user.click(badge);
    expect(refresh).not.toHaveBeenCalled();
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
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(within(container).getByText(/Updated .* ago/)).toBeTruthy();
  });

  it("renders GitHub's repository-wide matchCount, not the loaded page's row count", () => {
    // Ten loaded rows, GitHub reports 237 matching in total — the exact
    // "10 merged" defect ADR 0031 exists to remove. Rendering `rows.length`
    // here instead of `matchCount` must fail this assertion.
    const rows = Array.from({ length: 10 }, (_, index) => ({
      ...row,
      identity: { ...row.identity, number: index + 1 },
    }));
    render(
      <MaintainerInbox
        profileId="match-count"
        profileLabel="P"
        rows={rows}
        matchCount={237}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getByText("237 open")).toBeTruthy();
    expect(screen.queryByText("10 open")).toBeNull();
  });

  it("renders the count honestly as unknown, never as 0, when matchCount is absent", () => {
    render(
      <MaintainerInbox
        profileId="match-count-absent"
        profileLabel="P"
        rows={[row]}
        freshness="cached"
        refreshStatus="Cached after refresh failure"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );
    expect(screen.getByText("1 on this page")).toBeTruthy();
    expect(screen.queryByText("0 open")).toBeNull();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });
});

/** The row title is styled text with no role, found by the slot it carries. */
function rowTitle(option: HTMLElement): HTMLElement {
  const title = option.querySelector('[data-slot="pull-request-title"]');
  if (!(title instanceof HTMLElement))
    throw new Error("expected a pull request title in the row");
  return title;
}

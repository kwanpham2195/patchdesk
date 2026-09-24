// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { MaintainerInbox } from "../../src/renderer/src/components/maintainer-inbox";
import type { InboxRow } from "../../src/renderer/src/renderer-contracts";
import type { InboxPageSize } from "../../src/domain/maintainer-inbox";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  changeStats: { additions: 4, deletions: 1, changedFiles: 2 },
  checks: { overall: "passing", checks: [] },
  reviewState: "none",
  mergeability: "unknown",
  labels: [],
  categories: [],
  recommendedAction: { kind: "run_review" },
  dataFreshness: "fresh",
};

/** The desktop column header, found by its first column name; the inspector repeats the others. */
function columnHeader(): HTMLElement {
  const header = screen.getByText("Pull request").parentElement;
  if (header === null) throw new Error("expected the column header");
  return header;
}

function rowsNumbered(count: number): ReadonlyArray<InboxRow> {
  return Array.from({ length: count }, (_, index) => ({
    ...row,
    identity: { ...row.identity, number: index + 1 },
  }));
}

describe("MaintainerInbox layout", () => {
  it("drops the Labels column when no row on the page has a label", () => {
    render(
      <MaintainerInbox
        profileId="no-labels"
        profileLabel="P"
        rows={rowsNumbered(3)}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    expect(within(columnHeader()).queryByText("Labels")).toBeNull();
    expect(
      document.querySelector('[data-slot="pull-request-label-column"]'),
    ).toBeNull();
    // Columns with values stay.
    expect(within(columnHeader()).getByText("Author")).toBeTruthy();
    expect(within(columnHeader()).getByText("Changes")).toBeTruthy();
  });

  it("keeps the Labels column when one row on the page has a label", () => {
    const [first, ...rest] = rowsNumbered(3);
    if (first === undefined) throw new Error("expected a row");
    render(
      <MaintainerInbox
        profileId="one-label"
        profileLabel="P"
        rows={[
          { ...first, labels: [{ name: "bug", color: "d73a4a" }] },
          ...rest,
        ]}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    expect(within(columnHeader()).getByText("Labels")).toBeTruthy();
    expect(
      document.querySelectorAll('[data-slot="pull-request-label-column"]'),
    ).toHaveLength(3);
  });

  it.each<{
    readonly name: string;
    readonly rowCount: number;
    readonly pageSize: InboxPageSize;
    readonly pager: boolean;
    readonly pageSizeControl: boolean;
  }>([
    {
      name: "a short single page shows no page controls",
      rowCount: 3,
      pageSize: 25,
      pager: false,
      pageSizeControl: false,
    },
    {
      name: "a single page longer than the smallest size keeps Rows per page",
      rowCount: 11,
      pageSize: 25,
      pager: false,
      pageSizeControl: true,
    },
    {
      name: "a full single page keeps Previous and Next",
      rowCount: 10,
      pageSize: 10,
      pager: true,
      pageSizeControl: false,
    },
  ])("$name", ({ rowCount, pageSize, pager, pageSizeControl }) => {
    render(
      <MaintainerInbox
        profileId="single-page"
        profileLabel="P"
        rows={rowsNumbered(rowCount)}
        pageSize={pageSize}
        hasPreviousPage={false}
        hasNextPage={false}
        freshness="fresh"
        refreshStatus="Current"
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("navigation", { name: "Pull requests pages" }) !==
        null,
    ).toBe(pager);
    expect(
      screen.queryByRole("combobox", { name: "Rows per page" }) !== null,
    ).toBe(pageSizeControl);
  });

  it("shows the read's age in the Refresh chip in place of a separate age line", () => {
    vi.setSystemTime(new Date("2026-08-13T00:26:00.000Z"));
    render(
      <MaintainerInbox
        profileId="chip-age"
        profileLabel="P"
        rows={[row]}
        freshness="fresh"
        refreshStatus="Current"
        snapshot={{ state: "current", refreshedAt: "2026-08-13T00:00:00.000Z" }}
        onOpenReview={vi.fn()}
        onOpenReviewId={vi.fn()}
      />,
    );

    const chip = screen.getByRole("button", {
      name: "Refresh pull requests. GitHub: checked 26m",
    });
    expect(chip.textContent).toContain("checked 26m");
    expect(screen.queryByText(/Updated .* ago/)).toBeNull();
  });
});

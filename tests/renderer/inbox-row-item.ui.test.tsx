// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxRowItem } from "../../src/renderer/src/components/inbox-row-item";
import type { InboxRow } from "../../src/renderer/src/renderer-contracts";

afterEach(() => cleanup());

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
  recommendedAction: { kind: "run_review", label: "Run review" },
  dataFreshness: "fresh",
};

function renderRow(value: InboxRow): void {
  render(
    <InboxRowItem
      row={value}
      selected={false}
      onSelect={vi.fn()}
      onAction={vi.fn()}
      openingState={undefined}
    />,
  );
}

describe("InboxRowItem", () => {
  it("tags a row whose current head already has a Brief", () => {
    renderRow({ ...row, briefReady: true });
    expect(screen.getByText("Brief")).toBeTruthy();
  });

  it("leaves the tag off a row with no Brief for its current head", () => {
    renderRow(row);
    expect(screen.queryByText("Brief")).toBeNull();
  });

  it("selects on a row click without opening the Review", () => {
    const { onSelect, onAction } = renderActionableRow();
    fireEvent.click(screen.getByRole("option"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("selects and opens once from the title, twice from a double click", () => {
    const { onSelect, onAction } = renderActionableRow();
    fireEvent.click(rowTitle());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(screen.getByRole("option"));
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("ignores the title and a double click while the Review is opening", () => {
    const onAction = vi.fn();
    render(
      <InboxRowItem
        row={row}
        selected={false}
        onSelect={vi.fn()}
        onAction={onAction}
        openingState={{ status: "opening" }}
      />,
    );
    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(rowTitle());
    fireEvent.doubleClick(option);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps the row free of nested controls, leaving it the only tab stop", () => {
    renderActionableRow();
    expect(
      within(screen.getByRole("option")).queryAllByRole("button"),
    ).toHaveLength(0);
  });
});

/** The title is styled text inside the row, found by the label it carries. */
function rowTitle(): HTMLElement {
  return within(screen.getByRole("option")).getByTitle("Open #1");
}

function renderActionableRow() {
  const onSelect = vi.fn();
  const onAction = vi.fn();
  render(
    <InboxRowItem
      row={row}
      selected={false}
      onSelect={onSelect}
      onAction={onAction}
      openingState={undefined}
    />,
  );
  return { onSelect, onAction };
}

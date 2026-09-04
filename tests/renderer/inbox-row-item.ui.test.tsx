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
  recommendedAction: { kind: "run_review" },
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
    renderRow({ ...row, insights: { brief: "ready" } });
    expect(screen.getByText("Brief")).toBeTruthy();
  });

  it("leaves the tag off a row with no Brief for its current head", () => {
    renderRow(row);
    expect(screen.queryByText("Brief")).toBeNull();
  });

  it("shows the author's cached avatar as an image once it resolves", () => {
    renderRow({ ...row, authorAvatarDataUri: "data:image/png;base64,AAAA" });
    const avatars = avatarSlots();
    expect(avatars.length).toBeGreaterThan(0);
    for (const avatar of avatars) {
      expect(avatar.tagName).toBe("IMG");
      expect(avatar.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    }
  });

  it("falls back to the author's initials while the avatar cache is cold", () => {
    renderRow(row);
    const avatars = avatarSlots();
    expect(avatars.length).toBeGreaterThan(0);
    for (const avatar of avatars) {
      expect(avatar.tagName).not.toBe("IMG");
      expect(avatar.textContent).toBe("A");
    }
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

/** Both the wide and the narrow author cells render one; each is decorative, so neither has a role. */
function avatarSlots(): ReadonlyArray<HTMLElement> {
  return [
    ...screen.getByRole("option").querySelectorAll('[data-slot="avatar"]'),
  ].filter((node): node is HTMLElement => node instanceof HTMLElement);
}

/** The title is styled text with no role, found by the slot it carries. */
function rowTitle(): HTMLElement {
  const title = screen
    .getByRole("option")
    .querySelector('[data-slot="pull-request-title"]');
  if (!(title instanceof HTMLElement))
    throw new Error("expected a pull request title in the row");
  return title;
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

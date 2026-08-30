// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
});

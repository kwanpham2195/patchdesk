// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { MaintainerInbox } from "../../src/renderer/src/components/maintainer-inbox";
import type { InboxRow } from "../../src/renderer/src/renderer-contracts";

const rows: ReadonlyArray<InboxRow> = [
  {
    identity: { host: "github.com", owner: "centraldigital", repo: "customer-management", number: 118 },
    title: "Review updated VIP snapshot replacement",
    author: "maintainer",
    baseBranch: "sit",
    headBranch: "feat/vip",
    currentHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
    isDraft: false,
    updatedAt: "2026-07-18T10:00:00.000Z",
    changeStats: { additions: 12, deletions: 4, changedFiles: 2 },
    checks: { overall: "passing", checks: [] },
    reviewState: "review_pending",
    mergeability: "mergeable",
    latestReview: {
      sessionId: "review-118",
      reviewedHeadSha: "1234567890abcdef1234567890abcdef12345678",
      state: "completed",
      updatedAt: "2026-07-17T10:00:00.000Z",
      matchesCurrentHead: false,
    },
    categories: ["updated_since_review", "needs_review"],
    recommendedAction: { kind: "review_updates", label: "Review updates", baseSessionId: "review-118" },
    dataFreshness: "fresh",
  },
  {
    identity: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 },
    title: "Open saved local review",
    author: "reviewer",
    baseBranch: "main",
    headBranch: "fix/draft",
    currentHeadSha: "fedcba1234567890abcdef1234567890abcdef12",
    isDraft: false,
    updatedAt: "2026-07-17T10:00:00.000Z",
    changeStats: { additions: 1, deletions: 1, changedFiles: 1 },
    checks: { overall: "failing", checks: [] },
    reviewState: "none",
    mergeability: "blocked",
    latestReview: {
      sessionId: "review-42",
      reviewedHeadSha: "fedcba1234567890abcdef1234567890abcdef12",
      state: "draft",
      updatedAt: "2026-07-17T10:00:00.000Z",
      matchesCurrentHead: true,
    },
    categories: ["saved_review", "checks_failing"],
    recommendedAction: { kind: "open_saved_review", label: "Open saved review", sessionId: "review-42" },
    dataFreshness: "fresh",
  },
];

const draftRow = rows.find((row) => row.identity.number === 42);
if (draftRow === undefined) throw new Error("missing running review fixture");

const runningRow: InboxRow = {
  ...draftRow,
  latestReview: {
    sessionId: "review-running",
    reviewedHeadSha: "fedcba1234567890abcdef1234567890abcdef12",
    state: "starting",
    updatedAt: "2026-07-18T10:00:00.000Z",
    matchesCurrentHead: true,
  },
  categories: ["running"],
  recommendedAction: { kind: "continue_review", label: "View review progress", sessionId: "review-running" },
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("MaintainerInbox", () => {
  it("retains rows while showing an in-flight refresh with an explanatory disabled action", () => {
    render(
      <MaintainerInbox
        profileId="cfw"
        profileLabel="CFW"
        rows={rows}
        freshness="fresh"
        refreshStatus="Refreshing"
        onRefresh={() => undefined}
        onOpenReview={() => undefined}
        onOpenSession={() => undefined}
      />,
    );

    expect(screen.getByText("GitHub: Refreshing")).toBeTruthy();
    expect(screen.getByRole("option", { name: /#42/ })).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh all — refresh already running" });
    expect(refresh).toHaveProperty("disabled", true);
  });

  it("shows a persisted active review as progress instead of a second run action", () => {
    render(
      <MaintainerInbox
        profileId="cfw"
        profileLabel="CFW"
        rows={[runningRow]}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={() => undefined}
        onOpenReview={() => undefined}
        onOpenSession={() => undefined}
      />,
    );

    expect(screen.getAllByText("Review starting").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /View review progress/ })).toBeTruthy();
  });

  it("uses the action kind instead of a persisted label in the inspector", () => {
    const relabeledRows = rows.map((row) => {
      if (row.identity.number !== 42) return row;
      const recommendedAction = { ...row.recommendedAction };
      Object.defineProperty(recommendedAction, "label", { configurable: true, enumerable: true, value: "Untrusted persisted text" });
      return { ...row, recommendedAction };
    });
    render(
      <MaintainerInbox
        profileId="cfw"
        profileLabel="CFW"
        rows={relabeledRows}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={() => undefined}
        onOpenReview={() => undefined}
        onOpenSession={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Open saved review" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Untrusted persisted text" })).toBeNull();
  });
  it("filters queues, moves selection by keyboard, and starts only the selected recommended action", async () => {
    const openedReviews: Array<{ readonly number: number; readonly mode: string }> = [];
    const openedSessions: Array<string> = [];
    const user = userEvent.setup();
    render(
      <MaintainerInbox
        profileId="cfw"
        profileLabel="CFW"
        rows={rows}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={() => undefined}
        onOpenReview={(row, mode) => openedReviews.push({ number: row.identity.number, mode })}
        onOpenSession={(sessionId) => openedSessions.push(sessionId)}
      />,
    );

    expect(screen.getByRole("option", { name: /#42/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /#118/ }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Review updates" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Review updates$/ }));
    expect(openedReviews).toEqual([{ number: 118, mode: "incremental" }]);
    expect(openedSessions).toEqual([]);

    await user.click(screen.getByRole("button", { name: /Updated/ }));
    expect(screen.getByRole("option", { name: /#118/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /#42/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    await user.click(screen.getByRole("button", { name: /^Review updates$/ }));
    expect(openedReviews).toEqual([
      { number: 118, mode: "incremental" },
      { number: 118, mode: "incremental" },
    ]);
  });

  it("persists the selected filter and search locally without affecting review state", async () => {
    const user = userEvent.setup();
    render(
      <MaintainerInbox
        profileId="cfw"
        profileLabel="CFW"
        rows={rows}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={() => undefined}
        onOpenReview={() => undefined}
        onOpenSession={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Checks failing/ }));
    await user.type(screen.getByLabelText("Filter pull requests"), "saved");
    expect(window.localStorage.getItem("patchdesk.inbox-view.v1.cfw")).toContain("checks_failing");
    expect(screen.getByRole("option", { name: /#42/ })).toBeTruthy();
  });

  it("saves and deletes profile-scoped inbox views without mutating review state", async () => {
    const user = userEvent.setup();
    render(
      <MaintainerInbox
        profileId="cfw"
        profileLabel="CFW"
        rows={rows}
        freshness="fresh"
        refreshStatus="Current"
        onRefresh={() => undefined}
        onOpenReview={() => undefined}
        onOpenSession={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Updated/ }));
    await user.click(screen.getByRole("button", { name: "Save current view" }));
    await user.type(screen.getByLabelText("View name"), "VIP updates");
    await user.click(screen.getByRole("button", { name: "Save view" }));
    expect(screen.getByRole("button", { name: "VIP updates" })).toBeTruthy();
    expect(window.localStorage.getItem("patchdesk.inbox-view.v1.cfw")).toContain("VIP updates");

    await user.click(screen.getByRole("button", { name: "Delete VIP updates saved view" }));
    await user.click(screen.getByRole("button", { name: "Delete view" }));
    expect(screen.queryByRole("button", { name: "VIP updates" })).toBeNull();
  });
});

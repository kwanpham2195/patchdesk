// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MaintainerInbox } from "../../src/renderer/src/components/maintainer-inbox";
import type { InspectorInsightRequests } from "../../src/renderer/src/components/review-details-inspector";
import { inboxInsightRequestKey } from "../../src/renderer/src/inbox-insight-request";
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
  insights: { brief: "ready", analysis: "outdated" },
};

const allAvailable = {
  brief: true,
  analysis: true,
  walkthrough: true,
} as const;

function renderInbox(insightRequests?: InspectorInsightRequests) {
  return render(
    <MaintainerInbox
      profileId="inspector-insights"
      profileLabel="P"
      rows={[row]}
      freshness="fresh"
      refreshStatus="Current"
      onOpenReview={vi.fn()}
      onOpenReviewId={vi.fn()}
      {...(insightRequests === undefined ? {} : { insightRequests })}
    />,
  );
}

describe("ReviewDetailsInspector Insights", () => {
  it("names each chip by its kind and readiness, absent kinds included", () => {
    renderInbox();
    expect(screen.getByLabelText("Brief: Ready")).toBeTruthy();
    expect(screen.getByLabelText("Analysis: Outdated")).toBeTruthy();
    expect(screen.getByLabelText("Walkthrough: Not run")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Request/ })).toBeNull();
  });

  it("requests the selected row's kind from its button", () => {
    const onRequest = vi.fn();
    renderInbox({
      requests: new Map(),
      availability: allAvailable,
      onRequest,
    });
    const button = screen.getByRole("button", { name: "Request Walkthrough" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onRequest).toHaveBeenCalledWith(row, "walkthrough");
  });

  it("disables a kind with no saved preference and points at Settings", () => {
    renderInbox({
      requests: new Map(),
      availability: { brief: true, analysis: false, walkthrough: false },
      onRequest: vi.fn(),
    });
    expect(
      screen
        .getByRole("button", { name: "Request Brief" })
        .hasAttribute("disabled"),
    ).toBe(false);
    const analysis = screen.getByRole("button", { name: "Request Analysis" });
    expect(analysis.hasAttribute("disabled")).toBe(true);
    expect(analysis.getAttribute("title")).toContain("Settings > Review");
  });

  it("shows the pending state for the kind in flight and leaves the others live", () => {
    renderInbox({
      requests: new Map([
        [inboxInsightRequestKey(row, "brief"), { status: "preparing" }],
        [inboxInsightRequestKey(row, "analysis"), { status: "running" }],
      ]),
      availability: allAvailable,
      onRequest: vi.fn(),
    });
    expect(
      screen
        .getByRole("button", { name: /Preparing…/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /Running…/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Request Walkthrough" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("surfaces a failed request beside its chip and lets it be retried", () => {
    renderInbox({
      requests: new Map([
        [
          inboxInsightRequestKey(row, "brief"),
          { status: "error", error: "Could not request Brief. Provider down." },
        ],
      ]),
      availability: allAvailable,
      onRequest: vi.fn(),
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not request Brief. Provider down.",
    );
    expect(
      screen
        .getByRole("button", { name: "Request Brief" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});

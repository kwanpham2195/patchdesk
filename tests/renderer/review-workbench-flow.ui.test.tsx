// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";

const projection = (): WorkbenchResponse => ({
  state: "review",
  review: { id: "review-42", status: "open" },
  session: {
    id: "session-a",
    key: {
      profileId: "profile",
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      prNumber: 42,
      headSha: "a".repeat(40),
    },
  },
  revision: {
    reviewedHeadSha: "a".repeat(40),
    currentHeadSha: "a".repeat(40),
    freshness: "fresh",
    refreshedAt: "2026-08-01T00:00:00.000Z",
  },
  fullPatch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  pullRequest: {
    ref: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 },
    title: "Canonical workbench",
    author: "author",
    headBranch: "feature",
    baseBranch: "main",
    headSha: "a".repeat(40),
    isDraft: false,
    isOpen: true,
    reviewState: "none",
    mergeability: "mergeable",
    labels: [],
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  commits: [],
  insights: {
    analysis: { status: "not_generated" },
    walkthrough: { status: "not_generated" },
  },
  publishedFeedback: { reviews: [], comments: [] },
  comments: { threads: [] },
  checks: { overall: "passing", checks: [] },
  mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReviewWorkbenchFlow", () => {
  it("renders the canonical review projection without prepared or completed response states", () => {
    const value = projection();
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Review workbench" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Canonical workbench" })).toBeTruthy();
    expect(screen.getAllByRole("tab", { name: "Files" })).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Insights" })).toBeTruthy();
    expect(screen.queryByText("Review unavailable")).toBeNull();
  });

  it("opens the retained Analysis reader from the Insights card", async () => {
    const value = {
      ...projection(),
      insights: {
        analysis: {
          status: "current" as const,
          retained: {
            runId: "insight-analysis-1-aaaaaaaaaaaa-review-42",
            sessionId: "session-a",
            headSha: "a".repeat(40),
            generatedAt: "2026-08-01T00:00:00.000Z",
            value: {
              changeSummary: "Protect the write boundary",
              verdict: "request_changes" as const,
              summary: "One finding needs attention.",
              findings: [{ id: "finding-1", severity: "P1" as const, title: "Missing guard", explanation: "The guard is missing.", confidence: "high" as const, mappingStatus: "mapped" as const, file: "src/a.ts", lineStart: 1, disposition: "open" as const }],
              validationPlan: ["pnpm test"],
              assumptions: [],
            },
          },
        },
        walkthrough: { status: "not_generated" as const },
      },
    };
    const user = userEvent.setup();
    render(<ReviewWorkbenchFlow workbench={value} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    const insightsTab = screen.getAllByRole("tab", { name: "Insights" })[0];
    if (insightsTab === undefined) throw new Error("Expected Insights tab");
    await user.click(insightsTab);
    await user.click(screen.getByRole("button", { name: "Open Analysis" }));
    expect(screen.getByRole("region", { name: "Analysis reader" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Protect the write boundary" })).toBeTruthy();
    expect(screen.getAllByText("Missing guard").length).toBeGreaterThanOrEqual(1);
  });

  it("opens the PR overview without replacing the workbench", async () => {
    const base = projection();
    if (base.pullRequest === undefined) throw new Error("Expected pull request fixture");
    const value = {
      ...base,
      pullRequest: { ...base.pullRequest, description: "Current PR description" },
      comments: { threads: [{ id: "thread-1", state: "open" as const, comments: [{ id: "comment-1", author: "reviewer", body: "Existing thread", createdAt: "2026-08-01T00:00:00.000Z" }] }] },
    };
    const user = userEvent.setup();
    render(<ReviewWorkbenchFlow workbench={value} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    const overviewTrigger = screen.getByRole("button", { name: "PR overview" });
    await user.click(overviewTrigger);
    expect(screen.getByRole("heading", { name: "PR overview" })).toBeTruthy();
    expect(screen.getByText("Current PR description")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Checks" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Existing threads" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Checks" }));
    expect(screen.getByText("No checks reported.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Review workbench" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "PR overview" })).toBeNull());
    expect(document.activeElement).toBe(overviewTrigger);
    await user.click(overviewTrigger);
    const overlay = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]');
    if (overlay === null) throw new Error("Expected overview backdrop");
    await user.click(overlay);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "PR overview" })).toBeNull());
  });

  it("shows only current mapped Findings and focuses their evidence", async () => {
    const value = {
      ...projection(),
      fullPatch: "diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1,2 @@\\n-old\\n+new\\n+mapped\\n",
      insights: {
        analysis: {
          status: "current" as const,
          retained: {
            sessionId: "session-a",
            headSha: "a".repeat(40),
            generatedAt: "2026-08-01T00:00:00.000Z",
            value: {
              changeSummary: "Findings",
              verdict: "comment" as const,
              summary: "Findings",
              findings: [
                { id: "mapped", severity: "P1" as const, title: "Mapped finding", file: "src/a.ts", lineStart: 2, diffSide: "new" as const, explanation: "Mapped", confidence: "high" as const, mappingStatus: "mapped" as const },
                { id: "unmapped", severity: "P2" as const, title: "Outdated finding", explanation: "Outdated", confidence: "medium" as const, mappingStatus: "unmapped" as const },
              ],
              validationPlan: [],
              assumptions: [],
            },
          },
        },
        walkthrough: { status: "not_generated" as const },
      },
    };
    render(<ReviewWorkbenchFlow workbench={value} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Findings" }));
    expect(screen.getByRole("button", { name: /Mapped finding/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Outdated finding/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: /Mapped finding/ }));
    expect(screen.getByLabelText("Review diff").getAttribute("data-selected-path")).toBe("src/a.ts");
  });

  it("selects the newest commit and suppresses stale commit responses", async () => {
    const value = {
      ...projection(),
      commits: [
        { sha: "b".repeat(40), message: "Add feature\n\nDetails", author: "author", authoredAt: "2026-08-01T00:01:00.000Z", isHead: true },
        { sha: "a".repeat(40), message: "Initial change", author: "author", authoredAt: "2026-08-01T00:00:00.000Z", isHead: false },
      ],
    };
    const request = vi.fn(async (input: { readonly path: string; readonly method?: string; readonly body?: unknown }) => {
      if (input.path === "/v1/reviews/detect-updates") return { ok: true, body: { updatesAvailable: false }, correlationId: "detect" };
      if (input.path === "/v1/reviews/commit-diff") return { ok: true, body: { commit: value.commits[0], position: 1, total: 2, patch: "diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" }, correlationId: "commit" };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request } });
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await userEvent.setup().click(screen.getByRole("tab", { name: "Commits" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: "/v1/reviews/commit-diff", body: { profileId: "profile", reviewId: "review-42", commitSha: "b".repeat(40) } })));
    expect(screen.getByRole("button", { name: /Add feature/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/1 of 2/)).toBeTruthy());
  });

  it("refreshes by stable Review ID and replaces the whole canonical projection", async () => {
    const value = projection();
    const refreshed = { ...value, session: { ...value.session, id: "session-b" } };
    const request = vi.fn(async (input: { readonly path: string; readonly method?: string; readonly body?: unknown }) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { ok: true, body: { updatesAvailable: false }, correlationId: "detect" };
      if (input.path === "/v1/reviews/refresh")
        return { ok: true, body: refreshed, correlationId: "refresh" };
      throw new Error(`unexpected ${input.path}`);
    });
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request } });
    const replace = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={replace}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Refresh GitHub state" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(refreshed));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1/reviews/refresh",
      method: "POST",
      body: { profileId: "profile", reviewId: "review-42" },
    }));
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { createUnifiedReviewFixture, unifiedReviewInitialState } from "../../src/renderer/src/flows/app-fixtures";
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

  it("applies typed fixture initial state to the production navigator and overview", () => {
    const value = createUnifiedReviewFixture("files-finding-selected");
    render(<ReviewWorkbenchFlow workbench={value} initialUiState={unifiedReviewInitialState("files-finding-selected")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Findings", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Keep writes behind the stale-head check/ })).toBeTruthy();

    cleanup();
    const overview = createUnifiedReviewFixture("pr-overview");
    render(<ReviewWorkbenchFlow workbench={overview} initialUiState={unifiedReviewInitialState("pr-overview")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps terminal Reviews readable while hiding refresh and Published feedback mutations", () => {
    for (const state of ["merged", "closed"] as const) {
      const value = createUnifiedReviewFixture(state);
      cleanup();
      render(<ReviewWorkbenchFlow workbench={value} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
      expect(screen.getByText("Published review body")).toBeTruthy();
      expect(screen.getByText("Published inline feedback")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Refresh GitHub state" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Refresh updates" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    }
  });

  it("keeps persisted Applying publication recovery reachable after reload", async () => {
    const user = userEvent.setup();
    render(<ReviewWorkbenchFlow workbench={createUnifiedReviewFixture("publication-publishing")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Review publication recovery" }));
    expect(screen.getByRole("button", { name: "Check GitHub again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open on GitHub" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm publication" })).toBeNull();
  });

  it("refreshes GitHub-owned feedback before the production View feedback path", async () => {
    const user = userEvent.setup();
    const workbench = createUnifiedReviewFixture("publication-ready");
    const calls: string[] = [];
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: vi.fn(async (request: { readonly path: string }) => {
          calls.push(request.path);
          if (request.path === "/v1/reviews/publication/preview") return { ok: true, status: 200, correlationId: "preview", body: { reviewId: workbench.review.id, sessionId: workbench.session.id, headSha: workbench.revision.reviewedHeadSha, draftRevision: workbench.draft?.updatedAt, event: "COMMENT", body: "# Review", inlineComments: [], threadActions: [], warnings: [] } };
          if (request.path === "/v1/reviews/publication/confirm") return { ok: true, status: 200, correlationId: "confirm", body: { batch: workbench.draft } };
          return { ok: true, status: 200, correlationId: request.path, body: workbench };
        }),
      },
    });
    render(<ReviewWorkbenchFlow workbench={workbench} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Preview publication" }));
    await user.click(screen.getByRole("button", { name: "Confirm publication" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "View feedback" })).toBeTruthy());
    const confirmIndex = calls.indexOf("/v1/reviews/publication/confirm");
    const refreshIndex = calls.indexOf("/v1/reviews/refresh");
    const loadIndex = calls.indexOf("/v1/reviews/load");
    expect(confirmIndex).toBeGreaterThanOrEqual(0);
    expect(refreshIndex).toBeGreaterThan(confirmIndex);
    expect(loadIndex).toBeGreaterThan(refreshIndex);
  });

  it("represents confirmed publication as remote feedback plus an empty Local successor draft", () => {
    const value = createUnifiedReviewFixture("publication-confirmed");
    expect(value.draft).toMatchObject({ state: { _tag: "Local" }, summaryBody: "", items: [] });
    expect(value.publishedFeedback.reviews).toHaveLength(1);
    expect(value.publishedFeedback.comments).toHaveLength(1);
    render(<ReviewWorkbenchFlow workbench={value} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText("Published review body")).toBeTruthy();
    expect(screen.getByText("Published inline feedback")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review draft/ })).toBeTruthy();
    expect(screen.getByText("0 included")).toBeTruthy();
  });

  it("defaults Analysis completion to opening its publication preview and exposes every permitted action", async () => {
    const user = userEvent.setup();
    render(<ReviewWorkbenchFlow workbench={projection()} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);

    const insightsTab = screen.getAllByRole("tab", { name: "Insights" })[0];
    if (insightsTab === undefined) throw new Error("Expected Insights tab");
    await user.click(insightsTab);
    expect(screen.getByLabelText("Analysis completion").textContent).toContain("Open preview when complete");
    await user.click(screen.getByLabelText("Analysis completion"));
    expect(screen.getByText("Save as Review draft")).toBeTruthy();
    expect(screen.getAllByText("Open preview when complete").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Publish as Comment")).toBeTruthy();
    expect(screen.getByText("Publish as Approve")).toBeTruthy();
    expect(screen.getByText("Publish as Request changes")).toBeTruthy();
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

  it("hydrates a persisted first-run Analysis and exposes Cancel instead of Regenerate", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/models") return { ok: true, body: { models: [{ id: "fixture-model", label: "Fixture model" }] }, correlationId: "models" };
      if (input.path === "/v1/reviews/detect-updates") return { ok: true, body: { updatesAvailable: false }, correlationId: "detect" };
      if (input.path === "/v1/reviews/insights/runs/analysis-first-run") return { ok: true, body: { runId: "analysis-first-run", type: "analysis", status: "running" }, correlationId: "run" };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", { configurable: true, value: { request } });
    render(<ReviewWorkbenchFlow workbench={createUnifiedReviewFixture("analysis-running")} initialUiState={unifiedReviewInitialState("analysis-running")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Analysis" })).toBeNull();
    expect(screen.queryByLabelText("Insight model")).toBeNull();
    expect(screen.queryByLabelText("Insight reasoning")).toBeNull();
    expect(screen.queryByLabelText("Analysis completion")).toBeNull();
    await waitFor(() => expect(request.mock.calls.some((call) => String(call[0]?.path).startsWith("/v1/reviews/insights/runs/analysis-first-run"))).toBe(true));
  });

  it("keeps retained Analysis readable beneath an outdated treatment and suppresses old actions", () => {
    const value = createUnifiedReviewFixture("analysis-outdated");
    render(<ReviewWorkbenchFlow workbench={value} initialUiState={unifiedReviewInitialState("analysis-outdated")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Analysis is outdated" })).toBeTruthy();
    expect(screen.getByText(/Retained revision abcdef12 · current revision bbbbbbbb/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Analysis reader" })).toBeTruthy();
    expect(screen.getAllByText("Review completed for Patchdesk workbench").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "Run for latest revision" })).toBeTruthy();
    expect(screen.queryByLabelText("Insight model")).toBeNull();
    expect(screen.queryByLabelText("Insight reasoning")).toBeNull();
    expect(screen.queryByLabelText("Analysis completion")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Analysis" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(screen.queryByText("Publish as Comment")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("keeps a first-run Analysis failure as failure without inventing retained content", () => {
    const value = createUnifiedReviewFixture("analysis-failed");
    render(<ReviewWorkbenchFlow workbench={value} initialUiState={unifiedReviewInitialState("analysis-failed")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText("This Insight run failed. No retained result is available.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Analysis reader" })).toBeNull();
  });

  it("keeps retained Analysis readable beneath a failed replacement", () => {
    const value = createUnifiedReviewFixture("analysis-replacement-failed");
    render(<ReviewWorkbenchFlow workbench={value} initialUiState={unifiedReviewInitialState("analysis-replacement-failed")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText("This Insight run failed. The previous retained result remains available below.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Analysis reader" })).toBeTruthy();
    expect(screen.getAllByText("Review completed for Patchdesk workbench").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps retained Analysis readable beneath a replacement-running treatment", () => {
    const value = createUnifiedReviewFixture("analysis-replacement-running");
    render(<ReviewWorkbenchFlow workbench={value} initialUiState={unifiedReviewInitialState("analysis-replacement-running")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Analysis is running" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Analysis reader" })).toBeTruthy();
    expect(screen.getAllByText("Review completed for Patchdesk workbench").length).toBeGreaterThanOrEqual(2);
  });

  it("renders current Walkthrough content and Back to files returns to the Files surface", async () => {
    const value = createUnifiedReviewFixture("walkthrough-current");
    render(<ReviewWorkbenchFlow workbench={value} initialUiState={unifiedReviewInitialState("walkthrough-current")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Walkthrough chapters" })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Back to files" }));
    expect(screen.getAllByRole("tab", { name: "Files" }).some((tab) => tab.getAttribute("aria-selected") === "true")).toBe(true);
    expect(screen.getAllByLabelText("Review diff").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps outdated Walkthrough readable beneath its treatment", () => {
    const value = createUnifiedReviewFixture("walkthrough-outdated");
    render(<ReviewWorkbenchFlow workbench={value} initialUiState={unifiedReviewInitialState("walkthrough-outdated")} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Walkthrough is outdated" })).toBeTruthy();
    expect(screen.getByText(/Retained revision abcdef12 · current revision bbbbbbbb/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Walkthrough chapters" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run for latest revision" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to files" })).toBeNull();
  });

  it("renders the Analysis document in ADR order and omits empty optional callouts", async () => {
    const base = projection();
    const value = { ...base, insights: { ...base.insights, analysis: { status: "current" as const, retained: { sessionId: base.session.id, headSha: base.revision.reviewedHeadSha, generatedAt: base.revision.refreshedAt, value: { changeSummary: "Summary", verdict: "approve" as const, summary: "Overview", findings: [], validationPlan: ["Run tests"], assumptions: [] } } } } };
    render(<ReviewWorkbenchFlow workbench={value} initialUiState={{ section: "insights", insightDetail: "analysis" }} onWorkbenchReplace={vi.fn()} onWorkbenchPatch={vi.fn()} onNavigationStateChange={vi.fn()} onNavigate={vi.fn()} />);
    const reader = screen.getByRole("region", { name: "Analysis reader" });
    const headings = Array.from(reader.querySelectorAll('[data-slot="card-title"]')).map((heading) => heading.textContent);
    expect(headings).toEqual(["Review Scope", "Pull Request Overview", "Reviewed Changes", "Verification", "Findings", "Verdict"]);
    expect(screen.queryByText("Human Reviewer Callouts")).toBeNull();
  });

  it("opens the PR overview without replacing the workbench", async () => {
    const base = projection();
    if (base.pullRequest === undefined) throw new Error("Expected pull request fixture");
    const value = {
      ...base,
      pullRequest: { ...base.pullRequest, description: "Current PR description" },
      comments: { threads: [{ id: "thread-1", state: "open" as const, comments: [{ id: "comment-1", author: "reviewer", body: "Existing thread", createdAt: "2026-08-01T00:00:00.000Z" }] }] },
      publishedFeedback: { reviews: [{ id: "published-1", author: "maintainer", body: "Published review body", event: "COMMENTED" as const, submittedAt: "2026-08-01T00:00:00.000Z", canDismiss: false }], comments: [] },
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
    await user.click(screen.getByRole("button", { name: "Published feedback" }));
    expect(screen.getAllByText("Published review body").length).toBeGreaterThanOrEqual(2);
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
      if (input.path === "/v1/reviews/commit-diff") return { ok: true, body: { commit: value.commits[0], position: 1, total: 2, patch: "diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n", fileCount: 1, additions: 1, deletions: 1 }, correlationId: "commit" };
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

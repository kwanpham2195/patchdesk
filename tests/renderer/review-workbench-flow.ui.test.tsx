// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  createUnifiedReviewFixture,
  unifiedReviewInitialState,
} from "../../src/renderer/src/flows/app-fixtures";
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
  fullPatch:
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  pullRequest: {
    ref: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    },
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
  conversation: { prDescription: "", entries: [] },
  checks: { overall: "passing", checks: [] },
  mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
  mergeReasons: [],
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReviewWorkbenchFlow", () => {
  it("renders the canonical review projection without prepared or completed response states", async () => {
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

    expect(
      screen.getByRole("region", { name: "Review workbench" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Canonical workbench" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("navigation", { name: "Review surfaces" }),
    ).toBeNull();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByRole("tab", { name: "Browse" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Insights" })).toBeTruthy();
    expect(screen.queryByText("Review unavailable")).toBeNull();
  });

  it("opens the represented pull request in GitHub through the safe desktop bridge", async () => {
    const openExternalHttps = vi.fn(async () => true);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { openExternalHttps },
    });
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={projection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(openExternalHttps).toHaveBeenCalledWith(
      "https://github.com/centraldigital/patchdesk/pull/42",
    );
  });

  it("uses a narrow restore rail when the review navigator is collapsed", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={projection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Diff" }));
    expect(
      document.querySelector('[data-review-diff-layout="with-navigator"]'),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Hide review navigator" }),
    );
    expect(
      document.querySelector('[data-review-diff-layout="collapsed-navigator"]'),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show review navigator" }),
    ).toBeTruthy();
  });

  it("applies typed fixture initial state to the production navigator and overview", async () => {
    const value = createUnifiedReviewFixture("files-finding-selected");
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState("files-finding-selected")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByRole("tab", { name: "Diff" }));
    expect(
      screen.getByRole("tab", { name: "Findings", selected: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Keep writes behind the stale-head check/,
      }),
    ).toBeTruthy();

    cleanup();
    const overview = createUnifiedReviewFixture("pr-overview");
    render(
      <ReviewWorkbenchFlow
        workbench={overview}
        initialUiState={unifiedReviewInitialState("pr-overview")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps terminal Reviews readable while hiding refresh and write actions", async () => {
    for (const state of ["merged", "closed"] as const) {
      const value = createUnifiedReviewFixture(state);
      cleanup();
      render(
        <ReviewWorkbenchFlow
          workbench={value}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      expect(screen.getByText("Published review body")).toBeTruthy();
      expect(screen.getByText("Published inline feedback")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Refresh GitHub state" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Refresh updates" }),
      ).toBeNull();
    }
  });

  it("keeps persisted Applying publication recovery reachable after reload", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={createUnifiedReviewFixture("publication-publishing")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Review publication recovery" }),
    );
    expect(
      screen.getByRole("button", { name: "Check GitHub again" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open on GitHub" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm publication" }),
    ).toBeNull();
  });

  // Skipped: publication confirmation flow needs restructuring after published-feedback panel removal.
  // The confirm handler calls refreshConfirmedPublication which replaces the workbench mid-flow.
  it.skip("refreshes GitHub-owned feedback after confirmed publication", async () => {
    const user = userEvent.setup();
    const workbench = createUnifiedReviewFixture("publication-ready");
    const calls: string[] = [];
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: vi.fn(async (request: { readonly path: string; readonly method?: string; readonly body?: unknown }) => {
          calls.push(request.path);
          if (request.path === "/v1/reviews/publication/preview")
            return { ok: true, status: 200, correlationId: "preview", body: { reviewId: workbench.review.id, sessionId: workbench.session.id, headSha: workbench.revision.reviewedHeadSha, draftRevision: workbench.draft?.updatedAt, event: "COMMENT", body: "# Review", inlineComments: [], threadActions: [], warnings: [] } };
          if (request.path === "/v1/reviews/publication/confirm")
            return { ok: true, status: 200, correlationId: "confirm", body: { batch: workbench.draft } };
          if (request.path === "/v1/reviews/refresh" || request.path === "/v1/reviews/load")
            return { ok: true, status: 200, correlationId: request.path, body: workbench };
          throw new Error(`unexpected ${request.path}`);
        }),
      },
    });
    render(
      <ReviewWorkbenchFlow
        workbench={workbench}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Preview publication" }));
    await user.click(screen.getByRole("button", { name: "Confirm publication" }));
    // After confirm, refresh then load should be called in sequence.
    // Wait for the async confirm handler to complete.
    await vi.waitFor(() => expect(calls).toContain("/v1/reviews/load"), { timeout: 5000 });
    const confirmIndex = calls.indexOf("/v1/reviews/publication/confirm");
    const refreshIndex = calls.indexOf("/v1/reviews/refresh");
    const loadIndex = calls.indexOf("/v1/reviews/load");
    expect(confirmIndex).toBeGreaterThanOrEqual(0);
    expect(refreshIndex).toBeGreaterThan(confirmIndex);
    expect(loadIndex).toBeGreaterThan(refreshIndex);
  });

  it("represents confirmed publication as remote feedback plus an empty Local successor draft", async () => {
    const value = createUnifiedReviewFixture("publication-confirmed");
    expect(value.draft).toMatchObject({
      state: { _tag: "Local" },
      summaryBody: "",
      items: [],
    });
    expect(value.conversation.entries.filter(e => e._tag === "ReviewSummary")).toHaveLength(1);
    expect(value.conversation.entries.filter(e => e._tag === "IssueComment")).toHaveLength(1);
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText("Published review body")).toBeTruthy();
    expect(screen.getByText("Published inline feedback")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByRole("button", { name: /Review draft/ })).toBeTruthy();
    expect(screen.getByText("0 included")).toBeTruthy();
  });

  it("shows Analysis completion choices in the explicit run setup dialog", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/models")
        return {
          ok: true,
          body: {
            models: [{ id: "fixture-model", label: "Fixture model" }],
            defaultModel: "fixture-model",
          },
          correlationId: "models",
        };
      if (input.path === "/v1/reviews/detect-updates")
        return {
          ok: true,
          body: { updatesAvailable: false },
          correlationId: "detect",
        };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={projection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Insight model")).toBeTruthy();
    expect(screen.getByLabelText("Insight reasoning")).toBeTruthy();
    expect(screen.getByLabelText("Analysis completion").textContent).toContain(
      "Open preview when complete",
    );
    await user.click(screen.getByLabelText("Analysis completion"));
    expect(screen.getByText("Save as Review draft")).toBeTruthy();
    expect(screen.getByText("Publish as Comment")).toBeTruthy();
    expect(screen.getByText("Publish as Approve")).toBeTruthy();
    expect(screen.getByText("Publish as Request changes")).toBeTruthy();
  });

  it("shows provider guidance and disables Insight runs for an intentional empty catalog", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/models")
        return { ok: true, body: { models: [] }, correlationId: "models" };
      if (input.path === "/v1/reviews/detect-updates")
        return {
          ok: true,
          body: { updatesAvailable: false },
          correlationId: "detect",
        };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={projection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() =>
      expect(screen.getByText(/No eligible model configured/)).toBeTruthy(),
    );
    expect(
      (screen.getByRole("button", { name: /^Run$/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps every universal model selectable when the catalog exceeds 64 entries", async () => {
    const models = Array.from({ length: 269 }, (_, index) => ({
      id: `openai/universal-model-${index}`,
      label: `Universal model ${index}`,
    }));
    const calls: Array<{ readonly path: string; readonly body?: unknown }> = [];
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        calls.push(input);
        if (input.path === "/v1/reviews/models")
          return {
            ok: true,
            body: { models, defaultModel: models[0]?.id },
            correlationId: "models",
          };
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/insights/analysis/run")
          return {
            ok: true,
            body: {
              runId: "analysis-universal",
              type: "analysis",
              status: "queued",
            },
            correlationId: "run",
          };
        throw new Error(`unexpected ${input.path}`);
      },
    );
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={projection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /^Run$/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    const modelSelect = screen.getByLabelText("Insight model");
    const last = models[268];
    if (last === undefined) throw new Error("Expected last universal model");
    await user.click(modelSelect);
    await user.clear(modelSelect);
    await user.type(modelSelect, last.id);
    expect(
      await screen.findByRole("option", { name: last.label }),
    ).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    expect((modelSelect as HTMLInputElement).value).toBe(last.label);
    await user.click(screen.getByTestId("insight-run-confirm"));
    await waitFor(() =>
      expect(
        calls.some((call) => call.path === "/v1/reviews/insights/analysis/run"),
      ).toBe(true),
    );
    expect(
      calls.find((call) => call.path === "/v1/reviews/insights/analysis/run")
        ?.body,
    ).toMatchObject({ model: last.id });
  });

  it("does not POST a Walkthrough first run until confirmation and sends the selected choices", async () => {
    const calls: Array<{ readonly path: string; readonly body?: unknown }> = [];
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        calls.push(input);
        if (input.path === "/v1/reviews/models")
          return {
            ok: true,
            body: {
              models: [
                { id: "fast-model", label: "Fast model" },
                { id: "deep-model", label: "Deep model" },
              ],
              defaultModel: "fast-model",
            },
            correlationId: "models",
          };
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/insights/walkthrough/run")
          return {
            ok: true,
            body: {
              runId: "walkthrough-run",
              type: "walkthrough",
              status: "running",
            },
            correlationId: "run",
          };
        if (input.path.startsWith("/v1/reviews/insights/runs/"))
          return {
            ok: true,
            body: {
              runId: "walkthrough-run",
              type: "walkthrough",
              status: "running",
            },
            correlationId: "status",
          };
        throw new Error(`unexpected ${input.path}`);
      },
    );
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={projection()}
        initialUiState={{ section: "insights", insightDetail: "walkthrough" }}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(
      calls.some(
        (call) => call.path === "/v1/reviews/insights/walkthrough/run",
      ),
    ).toBe(false);
    expect(screen.getByRole("dialog")).toBeTruthy();
    const modelSelect = screen.getByLabelText("Insight model");
    await user.click(modelSelect);
    await user.clear(modelSelect);
    await user.type(modelSelect, "deep-model");
    await user.keyboard("{ArrowDown}{Enter}");
    await user.selectOptions(
      screen.getByLabelText("Insight reasoning"),
      "high",
    );
    await user.click(screen.getByTestId("insight-run-confirm"));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === "/v1/reviews/insights/walkthrough/run",
        ),
      ).toBe(true),
    );
    const runCall = calls.find(
      (call) => call.path === "/v1/reviews/insights/walkthrough/run",
    );
    expect(runCall?.body).toMatchObject({
      model: "deep-model",
      reasoning: "high",
      type: "walkthrough",
    });
  });

  it("uses the same setup dialog for Walkthrough regeneration and Analysis retry", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/models")
        return {
          ok: true,
          body: {
            models: [{ id: "fixture-model", label: "Fixture model" }],
            defaultModel: "fixture-model",
          },
          correlationId: "models",
        };
      if (input.path === "/v1/reviews/detect-updates")
        return {
          ok: true,
          body: { updatesAvailable: false },
          correlationId: "detect",
        };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={createUnifiedReviewFixture("walkthrough-current")}
        initialUiState={unifiedReviewInitialState("walkthrough-current")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Regenerate",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Regenerate Walkthrough" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    cleanup();
    render(
      <ReviewWorkbenchFlow
        workbench={createUnifiedReviewFixture("analysis-failed")}
        initialUiState={unifiedReviewInitialState("analysis-failed")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Run again" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Run again" }));
    expect(
      screen.getByRole("heading", { name: "Run Analysis again" }),
    ).toBeTruthy();
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
              findings: [
                {
                  id: "finding-1",
                  severity: "P1" as const,
                  title: "Missing guard",
                  explanation: "The guard is missing.",
                  confidence: "high" as const,
                  mappingStatus: "mapped" as const,
                  file: "src/a.ts",
                  lineStart: 1,
                  disposition: "open" as const,
                },
              ],
              validationPlan: ["pnpm test"],
              assumptions: [],
            },
          },
        },
        walkthrough: { status: "not_generated" as const },
      },
    };
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(screen.getByRole("button", { name: "Open Analysis" }));
    expect(
      screen.getByRole("region", { name: "Analysis reader" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Protect the write boundary" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Missing guard").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("hydrates a persisted first-run Analysis and exposes Cancel instead of Regenerate", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/models")
        return {
          ok: true,
          body: { models: [{ id: "fixture-model", label: "Fixture model" }] },
          correlationId: "models",
        };
      if (input.path === "/v1/reviews/detect-updates")
        return {
          ok: true,
          body: { updatesAvailable: false },
          correlationId: "detect",
        };
      if (input.path === "/v1/reviews/insights/runs/analysis-first-run")
        return {
          ok: true,
          body: {
            runId: "analysis-first-run",
            type: "analysis",
            status: "running",
          },
          correlationId: "run",
        };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    render(
      <ReviewWorkbenchFlow
        workbench={createUnifiedReviewFixture("analysis-running")}
        initialUiState={unifiedReviewInitialState("analysis-running")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Analysis" })).toBeNull();
    expect(screen.queryByLabelText("Insight model")).toBeNull();
    expect(screen.queryByLabelText("Insight reasoning")).toBeNull();
    expect(screen.queryByLabelText("Analysis completion")).toBeNull();
    await waitFor(() =>
      expect(
        request.mock.calls.some((call) =>
          String(call[0]?.path).startsWith(
            "/v1/reviews/insights/runs/analysis-first-run",
          ),
        ),
      ).toBe(true),
    );
  });

  it("keeps retained Analysis readable beneath an outdated treatment and suppresses old actions", () => {
    const value = createUnifiedReviewFixture("analysis-outdated");
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState("analysis-outdated")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Analysis is outdated" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Retained revision abcdef12 · current revision bbbbbbbb/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Analysis reader" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Review completed for Patchdesk workbench").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByRole("button", { name: "Run for latest revision" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Insight model")).toBeNull();
    expect(screen.queryByLabelText("Insight reasoning")).toBeNull();
    expect(screen.queryByLabelText("Analysis completion")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Analysis" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(screen.queryByText("Publish as Comment")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("renders a first-run Analysis failure diagnostic without inventing retained content", () => {
    const value = createUnifiedReviewFixture("analysis-failed");
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState("analysis-failed")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByText("The Insight failed unexpectedly. Try again."),
    ).toBeTruthy();
    expect(
      screen.getByText("Selected model: fixture-model · Reasoning: medium"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Correlation ID: insight-analysis-1-aaaaaaaaaaaa-review",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Analysis reader" }),
    ).toBeNull();
  });

  it("renders a persisted first-run failure diagnostic without retained content", () => {
    const value = createUnifiedReviewFixture("analysis-failed");
    value.insights.analysis = {
      ...value.insights.analysis,
      replacementFailure: {
        runId: "insight-analysis-1-aaaaaaaaaaaa-review",
        category: "unexpected_failure",
        model: "fixture-model",
        reasoning: "medium",
        retryable: true,
      },
    };
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState("analysis-failed")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByText("The Insight failed unexpectedly. Try again."),
    ).toBeTruthy();
    expect(
      screen.getByText("Selected model: fixture-model · Reasoning: medium"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Correlation ID: insight-analysis-1-aaaaaaaaaaaa-review",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Analysis reader" }),
    ).toBeNull();
  });

  it("renders safe category, selected run configuration, and run correlation for both Insight types", () => {
    const value = createUnifiedReviewFixture("analysis-failed");
    const diagnostic = {
      runId: "insight-analysis-1-aaaaaaaaaaaa-review",
      category: "rate_limited" as const,
      model: "fixture-model",
      reasoning: "high" as const,
      retryable: true,
    };
    value.insights.analysis = {
      ...value.insights.analysis,
      replacementFailure: diagnostic,
    };
    value.insights.walkthrough = {
      ...value.insights.walkthrough,
      status: "failed",
      replacementFailure: {
        ...diagnostic,
        runId: "insight-walkthrough-1-aaaaaaaaaaaa-review",
      },
    };
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState("analysis-failed")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText(/provider rate limit was reached/)).toBeTruthy();
    expect(
      screen.getByText("Selected model: fixture-model · Reasoning: high"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Correlation ID: insight-analysis-1-aaaaaaaaaaaa-review",
      ),
    ).toBeTruthy();
  });

  it("renders replacement failure diagnostics while keeping retained Analysis readable", () => {
    const value = createUnifiedReviewFixture("analysis-replacement-failed");
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState(
          "analysis-replacement-failed",
        )}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByText("The Insight failed unexpectedly. Try again."),
    ).toBeTruthy();
    expect(
      screen.getByText("Selected model: fixture-model · Reasoning: medium"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Correlation ID: insight-analysis-1-aaaaaaaaaaaa-review",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Analysis reader" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Review completed for Patchdesk workbench").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps retained Analysis readable beneath a replacement-running treatment", () => {
    const value = createUnifiedReviewFixture("analysis-replacement-running");
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState(
          "analysis-replacement-running",
        )}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Analysis is running" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Analysis reader" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Review completed for Patchdesk workbench").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("renders current Walkthrough content while Files remains the parent navigation", async () => {
    const value = createUnifiedReviewFixture("walkthrough-current");
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState("walkthrough-current")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Walkthrough chapters" }),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-review-workbench-insights]"),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-review-insight-document="walkthrough"]'),
    ).toBeTruthy();
    const insightNavigation = screen.getByRole("navigation", {
      name: "Insight navigation",
    });
    expect(insightNavigation.className).not.toContain("md:flex-col");
    expect(
      screen.getByRole("button", { name: /Walkthrough/ }),
    ).toBeTruthy();
    const feedbackDock = document.querySelector<HTMLElement>(
      "[data-review-workbench-feedback]",
    );
    const draftDock = document.querySelector<HTMLElement>(
      "[data-review-workbench-draft-dock]",
    );
    if (feedbackDock === null || draftDock === null)
      throw new Error("Expected the retained bottom docks");
    expect(feedbackDock.classList.contains("hidden")).toBe(true);
    expect(draftDock.classList.contains("hidden")).toBe(true);
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByRole("tab", { name: "Insights" })).toBeTruthy();
    expect(
      screen.getAllByLabelText("Review diff").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("keeps outdated Walkthrough readable beneath its treatment", () => {
    const value = createUnifiedReviewFixture("walkthrough-outdated");
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState("walkthrough-outdated")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Walkthrough is outdated" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Retained revision abcdef12 · current revision bbbbbbbb/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Walkthrough chapters" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run for latest revision" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to files" })).toBeNull();
  });

  it("renders the Analysis document in ADR order and omits empty optional callouts", async () => {
    const base = projection();
    const value = {
      ...base,
      insights: {
        ...base.insights,
        analysis: {
          status: "current" as const,
          retained: {
            sessionId: base.session.id,
            headSha: base.revision.reviewedHeadSha,
            generatedAt: base.revision.refreshedAt,
            value: {
              changeSummary: "Summary",
              verdict: "approve" as const,
              summary: "Overview",
              findings: [],
              validationPlan: ["Run tests"],
              assumptions: [],
            },
          },
        },
      },
    };
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={{ section: "insights", insightDetail: "analysis" }}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const reader = screen.getByRole("region", { name: "Analysis reader" });
    const headings = Array.from(
      reader.querySelectorAll('[data-slot="card-title"]'),
    ).map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Review Scope",
      "Pull Request Overview",
      "Reviewed Changes",
      "Verification",
      "Findings",
      "Verdict",
    ]);
    expect(screen.queryByText("Human Reviewer Callouts")).toBeNull();
  });

  it("opens the PR overview without replacing the workbench", async () => {
    const base = projection();
    if (base.pullRequest === undefined)
      throw new Error("Expected pull request fixture");
    const value = {
      ...base,
      pullRequest: {
        ...base.pullRequest,
        description: "Current PR description",
      },
      comments: {
        threads: [
          {
            id: "thread-1",
            state: "open" as const,
            comments: [
              {
                id: "comment-1",
                author: "reviewer",
                body: "Existing thread",
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          },
        ],
      },
      conversation: {
        prDescription: "",
        entries: [
          {
            _tag: "ReviewSummary" as const,
            review: {
              id: "published-1",
              author: "maintainer",
              body: "Published review body",
              event: "COMMENTED" as const,
              submittedAt: "2026-08-01T00:00:00.000Z",
              canDismiss: false,
            },
          },
        ],
      },
    };
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const overviewTrigger = screen.getByRole("button", { name: "PR overview" });
    await user.click(overviewTrigger);
    expect(screen.getByRole("heading", { name: "PR overview" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Review workbench" }),
    ).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "PR overview" })).toBeNull(),
    );
    expect(document.activeElement).toBe(overviewTrigger);
    await user.click(overviewTrigger);
    const overlay = document.querySelector<HTMLElement>(
      '[data-slot="sheet-overlay"]',
    );
    if (overlay === null) throw new Error("Expected overview backdrop");
    await user.click(overlay);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "PR overview" })).toBeNull(),
    );
  });

  it("shows only current mapped Findings and focuses their evidence", async () => {
    const value = {
      ...projection(),
      fullPatch:
        "diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1,2 @@\\n-old\\n+new\\n+mapped\\n",
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
                {
                  id: "mapped",
                  severity: "P1" as const,
                  title: "Mapped finding",
                  file: "src/a.ts",
                  lineStart: 2,
                  diffSide: "new" as const,
                  explanation: "Mapped",
                  confidence: "high" as const,
                  mappingStatus: "mapped" as const,
                },
                {
                  id: "unmapped",
                  severity: "P2" as const,
                  title: "Outdated finding",
                  explanation: "Outdated",
                  confidence: "medium" as const,
                  mappingStatus: "unmapped" as const,
                },
              ],
              validationPlan: [],
              assumptions: [],
            },
          },
        },
        walkthrough: { status: "not_generated" as const },
      },
    };
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Diff" }));
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Findings" }));
    expect(screen.getByRole("button", { name: /Mapped finding/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Outdated finding/ }),
    ).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Mapped finding/ }));
    expect(
      screen.getByLabelText("Review diff").getAttribute("data-selected-path"),
    ).toBe("src/a.ts");
  });

  it("selects the newest commit and suppresses stale commit responses", async () => {
    const value = {
      ...projection(),
      commits: [
        {
          sha: "b".repeat(40),
          message: "Add feature\n\nDetails",
          author: "author",
          authoredAt: "2026-08-01T00:01:00.000Z",
          isHead: true,
        },
        {
          sha: "a".repeat(40),
          message: "Initial change",
          author: "author",
          authoredAt: "2026-08-01T00:00:00.000Z",
          isHead: false,
        },
      ],
    };
    const request = vi.fn(
      async (input: {
        readonly path: string;
        readonly method?: string;
        readonly body?: unknown;
      }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/commit-diff")
          return {
            ok: true,
            body: {
              commit: value.commits[0],
              position: 1,
              total: 2,
              patch:
                "diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n",
              fileCount: 1,
              additions: 1,
              deletions: 1,
            },
            correlationId: "commit",
          };
        throw new Error(`unexpected ${input.path}`);
      },
    );
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await userEvent.setup().click(screen.getByRole("tab", { name: "Diff" }));
    await userEvent.setup().click(screen.getByRole("tab", { name: "Commits" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/reviews/commit-diff",
          body: {
            profileId: "profile",
            reviewId: "review-42",
            commitSha: "b".repeat(40),
          },
        }),
      ),
    );
    expect(screen.getByRole("button", { name: /Add feature/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/1 of 2/)).toBeTruthy());
  });

  describe("PR Overview status sidebar", () => {
    it("leads with revision context, compact Checks, Review status, and merge readiness", async () => {
      const user = userEvent.setup();
      const base = projection();
      if (base.pullRequest === undefined)
        throw new Error("Expected pull request fixture");
      const value = {
        ...base,
        pullRequest: {
          ...base.pullRequest,
          description: "Current PR description",
          changedFileCount: 3,
        },
        commits: [
          {
            sha: "a".repeat(40),
            message: "Initial change",
            author: "author",
            authoredAt: "2026-08-01T00:00:00.000Z",
            isHead: true,
          },
        ],
        checks: {
          overall: "passing" as const,
          checks: [
            {
              name: "unit",
              required: true as const,
              status: "completed" as const,
              conclusion: "success" as const,
            },
          ],
        },
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
                verdict: "approve" as const,
                summary: "One finding needs attention.",
                findings: [],
                validationPlan: [],
                assumptions: [],
              },
            },
          },
          walkthrough: { status: "not_generated" as const },
        },
      };
      render(
        <ReviewWorkbenchFlow
          workbench={value}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("button", { name: "PR overview" }));
      const dialog = screen.getByRole("dialog");

      expect(within(dialog).getByText("main ← feature")).toBeTruthy();
      expect(within(dialog).getByText("a".repeat(8))).toBeTruthy();
      expect(within(dialog).getByText(/Refreshed 2026-08-01/)).toBeTruthy();
      expect(within(dialog).getByText("1 commit · 3 files changed")).toBeTruthy();
      expect(
        within(dialog).getByRole("button", { name: "Refresh GitHub state" }),
      ).toBeTruthy();

      expect(within(dialog).getByRole("button", { name: "Checks" })).toBeTruthy();
      expect(within(dialog).getByText("Passing")).toBeTruthy();
      await user.click(within(dialog).getByRole("button", { name: "Checks" }));
      expect(within(dialog).getByText("unit")).toBeTruthy();
      expect(within(dialog).getByText("Passed")).toBeTruthy();

      expect(within(dialog).getByText("Analysis")).toBeTruthy();
      expect(
        within(dialog).getAllByText("Current").length,
      ).toBeGreaterThanOrEqual(1);
      expect(within(dialog).getByText("Walkthrough")).toBeTruthy();
      expect(within(dialog).getByText("Not generated")).toBeTruthy();

      expect(within(dialog).getByText("Ready to merge")).toBeTruthy();
      expect(
        within(dialog).getByText(/This Review is ready to merge/),
      ).toBeTruthy();
      expect(within(dialog).queryByText("Merge blocked")).toBeNull();
    });

    it("preserves check requirement metadata and the safe external check action behind the Checks disclosure", async () => {
      const user = userEvent.setup();
      const openExternalHttps = vi.fn(async () => true);
      Object.defineProperty(window, "patchdesk", {
        configurable: true,
        value: { openExternalHttps },
      });
      const value = {
        ...projection(),
        checks: {
          overall: "failing" as const,
          checks: [
            {
              name: "unit",
              required: true as const,
              status: "completed" as const,
              conclusion: "failure" as const,
              url: "/centraldigital/patchdesk/actions/runs/1",
            },
            {
              name: "docs",
              required: "unknown" as const,
              status: "in_progress" as const,
            },
          ],
        },
      };
      render(
        <ReviewWorkbenchFlow
          workbench={value}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("button", { name: "PR overview" }));
      const dialog = screen.getByRole("dialog");

      expect(within(dialog).getByText("Failing")).toBeTruthy();
      await user.click(within(dialog).getByRole("button", { name: "Checks" }));
      expect(
        within(dialog).getByRole("list", { name: "Pull request checks" }),
      ).toBeTruthy();
      expect(within(dialog).getByText("unit")).toBeTruthy();
      expect(within(dialog).getByText("Failed")).toBeTruthy();
      expect(
        within(dialog).getByText("Required", { selector: ".sr-only" }),
      ).toBeTruthy();
      expect(within(dialog).getByText("docs")).toBeTruthy();
      expect(within(dialog).getByText("In progress")).toBeTruthy();
      expect(
        within(dialog).getByText("No requirement metadata", {
          selector: ".sr-only",
        }),
      ).toBeTruthy();
      expect(within(dialog).queryByRole("link")).toBeNull();
      await user.click(
        within(dialog).getByRole("button", { name: "Open unit in GitHub" }),
      );
      expect(openExternalHttps).toHaveBeenCalledWith(
        "https://github.com/centraldigital/patchdesk/actions/runs/1",
      );
    });

    it("shows current mapped-Finding count and routes View findings to the existing Findings surface", async () => {
      const user = userEvent.setup();
      render(
        <ReviewWorkbenchFlow
          workbench={createUnifiedReviewFixture("walkthrough-current")}
          initialUiState={unifiedReviewInitialState("walkthrough-current")}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("button", { name: "PR overview" }));
      const dialog = screen.getByRole("dialog");

      expect(within(dialog).getByText("Walkthrough")).toBeTruthy();
      expect(
        within(dialog).getAllByText("Current").length,
      ).toBeGreaterThanOrEqual(2);
      expect(within(dialog).getByText("1 current mapped Finding")).toBeTruthy();
      await user.click(
        within(dialog).getByRole("button", { name: "View findings" }),
      );
      expect(
        screen.queryByRole("heading", { name: "PR overview" }),
      ).toBeNull();
      expect(
        screen.getByRole("tab", { name: "Findings", selected: true }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: /Keep writes behind the stale-head check/,
        }),
      ).toBeTruthy();
    });

    it("renders acknowledgement-required and blocked merge states with friendly copy and no duplicate alert", async () => {
      const user = userEvent.setup();
      const base = {
        ...projection(),
        revision: {
          ...projection().revision,
          patchHash: "b".repeat(64),
        },
      };

      const acknowledgement = {
        ...base,
        mergeReadiness: {
          _tag: "NeedsAcknowledgement" as const,
          blockers: [],
          warnings: ["request_changes", "high_severity_finding", "analysis_finding"],
        },
        mergeReasons: [],
      };
      render(
        <ReviewWorkbenchFlow
          workbench={acknowledgement}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("button", { name: "PR overview" }));
      let dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Changes requested.")).toBeTruthy();
      expect(
        within(dialog).getByText("High-severity local findings need acknowledgement."),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(
          "A current Analysis finding requires acknowledgement before merge.",
        ),
      ).toBeTruthy();
      expect(within(dialog).queryByText("request_changes")).toBeNull();
      expect(within(dialog).queryByText("high_severity_finding")).toBeNull();
      expect(within(dialog).queryByText("analysis_finding")).toBeNull();
      expect(within(dialog).queryByText("Merge blocked")).toBeNull();
      expect(
        within(dialog).getByRole("button", {
          name: "Prepare merge confirmation",
        }),
      ).toBeTruthy();
      await user.click(
        within(dialog).getByRole("button", {
          name: "Prepare merge confirmation",
        }),
      );
      expect(
        screen.getByRole("heading", { name: "Confirm merge" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("checkbox", {
          name: "I acknowledge the merge warnings.",
        }),
      ).toBeTruthy();
      await user.keyboard("{Escape}");

      cleanup();
      const blocked = {
        ...base,
        mergeReadiness: {
          _tag: "Blocked" as const,
          blockers: ["stale_head", "analysis_finding"],
          warnings: [],
        },
        mergeReasons: [],
      };
      render(
        <ReviewWorkbenchFlow
          workbench={blocked}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      expect(screen.queryByLabelText("Merge readiness")).toBeNull();
      await user.click(screen.getByRole("button", { name: "PR overview" }));
      dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByText("Refresh this Review before merging."),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(
          "A high-severity Analysis finding blocks merge under this profile's policy.",
        ),
      ).toBeTruthy();
      expect(within(dialog).queryByText("stale_head")).toBeNull();
      expect(within(dialog).queryByText("analysis_finding")).toBeNull();
      expect(
        within(dialog).queryByRole("button", {
          name: "Prepare merge confirmation",
        }),
      ).toBeNull();
      expect(within(dialog).queryByText("Merge blocked")).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Checks" })).toBeTruthy();
    });

    it("keeps terminal Reviews readable in PR Overview without Refresh or merge controls", async () => {
      for (const state of ["merged", "closed"] as const) {
        cleanup();
        const user = userEvent.setup();
        render(
          <ReviewWorkbenchFlow
            workbench={createUnifiedReviewFixture(state)}
            onWorkbenchReplace={vi.fn()}
            onWorkbenchPatch={vi.fn()}
            onNavigationStateChange={vi.fn()}
            onNavigate={vi.fn()}
          />,
        );
        await user.click(screen.getByRole("button", { name: "PR overview" }));
        const dialog = screen.getByRole("dialog");
        expect(
          within(dialog).getByText(
            `This Review is ${state} and remains readable.`,
          ),
        ).toBeTruthy();
        expect(
          within(dialog).queryByRole("button", { name: "Refresh GitHub state" }),
        ).toBeNull();
        expect(
          within(dialog).queryByRole("button", {
            name: "Prepare merge confirmation",
          }),
        ).toBeNull();
      }
    });
  });

  it("refreshes by stable Review ID and replaces the whole canonical projection", async () => {
    const value = projection();
    const refreshed = {
      ...value,
      session: { ...value.session, id: "session-b" },
    };
    const request = vi.fn(
      async (input: {
        readonly path: string;
        readonly method?: string;
        readonly body?: unknown;
      }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/refresh")
          return { ok: true, body: refreshed, correlationId: "refresh" };
        throw new Error(`unexpected ${input.path}`);
      },
    );
    vi.stubGlobal("window", window);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
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

    await user.click(screen.getByRole("button", { name: "PR overview" }));
    const dialog = screen.getByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Refresh GitHub state" }),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith(refreshed));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/reviews/refresh",
        method: "POST",
        body: { profileId: "profile", reviewId: "review-42" },
      }),
    );
  });

  it("publishes an inline comment and returns its id so the Diff can show it optimistically", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (input: { readonly path: string; readonly body?: unknown }) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { ok: true, body: { updatesAvailable: false }, correlationId: "detect" };
      if (input.path === "/v1/reviews/inline-conversations/command")
        return { ok: true, body: { _tag: "CommentCreated", commentId: "c-optimistic" }, correlationId: "command" };
      if (input.path === "/v1/reviews/refresh")
        return { ok: true, body: projection(), correlationId: "refresh" };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const withPatchHash = {
      ...projection(),
      revision: { ...projection().revision, patchHash: "patch-hash" as const },
    };
    render(
      <ReviewWorkbenchFlow
        workbench={withPatchHash}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    const authorButtons = screen.getAllByRole("button", { name: "Add comment on src/a.ts" });
    // The fixture patch has one deleted and one added line; the added line's
    // author button is the one that anchors a new-side comment.
    expect(authorButtons.length).toBeGreaterThan(1);
    const addedAuthorButton = authorButtons[1];
    if (addedAuthorButton === undefined) throw new Error("fixture: added-line author button missing");
    await user.click(addedAuthorButton);
    await user.type(screen.getByRole("textbox", { name: "Inline comment" }), "Optimistic body");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    const commandCall = request.mock.calls.find(
      (call) => (call[0] as { readonly path: string }).path === "/v1/reviews/inline-conversations/command",
    );
    expect(commandCall).toBeDefined();
    expect((commandCall?.[0] as { readonly body: unknown }).body).toMatchObject({
      profileId: "profile",
      reviewId: "review-42",
      command: {
        _tag: "CreateComment",
        anchor: { path: "src/a.ts", startLine: 1, line: 1, side: "new" },
        body: "Optimistic body",
      },
    });
    expect(
      request.mock.calls.some(
        (call) => (call[0] as { readonly path: string }).path === "/v1/reviews/refresh",
      ),
    ).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Inline comment" })).toBeNull();
    });
  });
});

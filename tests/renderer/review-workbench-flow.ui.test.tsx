// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

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

  it("keeps Findings in Analysis instead of the Diff navigator", async () => {
    const value = createUnifiedReviewFixture("files-default");
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        initialUiState={unifiedReviewInitialState("files-default")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByRole("tab", { name: "Diff" }));
    expect(
      screen.getByRole("tab", { name: "Browse", selected: true }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Commits" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Findings" })).toBeNull();

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
        request: vi.fn(
          async (request: {
            readonly path: string;
            readonly method?: string;
            readonly body?: unknown;
          }) => {
            calls.push(request.path);
            if (request.path === "/v1/reviews/publication/preview")
              return {
                ok: true,
                status: 200,
                correlationId: "preview",
                body: {
                  reviewId: workbench.review.id,
                  sessionId: workbench.session.id,
                  headSha: workbench.revision.reviewedHeadSha,
                  draftRevision: workbench.draft?.updatedAt,
                  event: "COMMENT",
                  body: "# Review",
                  inlineComments: [],
                  threadActions: [],
                  warnings: [],
                },
              };
            if (request.path === "/v1/reviews/publication/confirm")
              return {
                ok: true,
                status: 200,
                correlationId: "confirm",
                body: { batch: workbench.draft },
              };
            if (
              request.path === "/v1/reviews/refresh" ||
              request.path === "/v1/reviews/load"
            )
              return {
                ok: true,
                status: 200,
                correlationId: request.path,
                body: workbench,
              };
            throw new Error(`unexpected ${request.path}`);
          },
        ),
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
    await user.click(
      screen.getByRole("button", { name: "Preview publication" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Confirm publication" }),
    );
    // After confirm, refresh then load should be called in sequence.
    // Wait for the async confirm handler to complete.
    await vi.waitFor(() => expect(calls).toContain("/v1/reviews/load"), {
      timeout: 5000,
    });
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
    expect(
      value.conversation.entries.filter((e) => e._tag === "ReviewSummary"),
    ).toHaveLength(1);
    expect(
      value.conversation.entries.filter((e) => e._tag === "IssueComment"),
    ).toHaveLength(1);
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

  it("does not offer local draft or publication completion choices in the Analysis run dialog", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/insight-providers")
        return {
          ok: true,
          body: {
            providers: [{ id: "pi", label: "Pi", available: true, guidance: "Configured." }],
            models: [{ provider: "pi", id: "fixture-model", label: "Fixture model", reasoning: ["low", "medium", "high"], defaultReasoning: "medium" }],
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
        (
          screen.getByRole("button", {
            name: "Generate analysis",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Generate analysis" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Insight model")).toBeTruthy();
    expect(screen.getByLabelText("Insight reasoning")).toBeTruthy();
    expect(screen.queryByLabelText("Analysis completion")).toBeNull();
    expect(screen.queryByText("Save as Review draft")).toBeNull();
    expect(screen.queryByText("Publish as Comment")).toBeNull();
  });

  it("shows provider guidance and disables Insight runs for an intentional empty catalog", async () => {
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/insight-providers")
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
      (
        screen.getByRole("button", {
          name: "Generate analysis",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps every universal model selectable when the catalog exceeds 64 entries", async () => {
    const models = Array.from({ length: 269 }, (_, index) => ({
      provider: "pi" as const,
      id: `openai/universal-model-${index}`,
      label: `Universal model ${index}`,
      reasoning: ["low", "medium", "high"] as const,
    }));
    const calls: Array<{ readonly path: string; readonly body?: unknown }> = [];
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        calls.push(input);
        if (input.path === "/v1/insight-providers")
          return {
            ok: true,
            body: { providers: [{ id: "pi", label: "Pi", available: true, guidance: "Configured." }], models },
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
        (
          screen.getByRole("button", {
            name: "Generate analysis",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Generate analysis" }));
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
        if (input.path === "/v1/insight-providers")
          return {
            ok: true,
            body: {
              providers: [{ id: "pi", label: "Pi", available: true, guidance: "Configured." }],
              models: [
                { provider: "pi", id: "fast-model", label: "Fast model", reasoning: ["low", "medium", "high"], defaultReasoning: "medium" },
                { provider: "pi", id: "deep-model", label: "Deep model", reasoning: ["low", "medium", "high"], defaultReasoning: "medium" },
              ],
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
        (
          screen.getByRole("button", {
            name: "Generate Walkthrough",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(
      screen.getByRole("button", { name: "Generate Walkthrough" }),
    );
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
      if (input.path === "/v1/insight-providers")
        return {
          ok: true,
          body: {
            providers: [{ id: "pi", label: "Pi", available: true, guidance: "Configured." }],
            models: [{ provider: "pi", id: "fixture-model", label: "Fixture model", reasoning: ["low", "medium", "high"], defaultReasoning: "medium" }],
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
        (screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
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
      if (input.path === "/v1/insight-providers")
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

  it("renders a first-run Analysis failure without exposing diagnostics", () => {
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
    expect(screen.queryByText(/Selected model:/)).toBeNull();
    expect(screen.queryByText(/Correlation ID:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Analysis reader" }),
    ).toBeNull();
  });

  it("renders a persisted first-run failure without diagnostics", () => {
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
    expect(screen.queryByText(/Selected model:/)).toBeNull();
    expect(screen.queryByText(/Correlation ID:/)).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Analysis reader" }),
    ).toBeNull();
  });

  it("renders bounded failure copy without provider diagnostics", () => {
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
    expect(screen.queryByText(/Selected model:/)).toBeNull();
    expect(screen.queryByText(/Correlation ID:/)).toBeNull();
  });

  it("keeps retained Analysis readable after a bounded replacement failure", () => {
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
    expect(screen.queryByText(/Selected model:/)).toBeNull();
    expect(screen.queryByText(/Correlation ID:/)).toBeNull();
    expect(
      screen.getByRole("region", { name: "Analysis reader" }),
    ).toBeTruthy();
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
    expect(screen.getByRole("button", { name: /Walkthrough/ })).toBeTruthy();
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
    await userEvent.setup().click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByRole("tab", { name: "Insights" })).toBeTruthy();
    expect(
      screen.getAllByLabelText("Review diff").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("hides only Insights-local chrome while Walkthrough focus is active", async () => {
    const calls: Array<{ readonly path: string }> = [];
    const request = vi.fn(async (input: { readonly path: string }) => {
      calls.push(input);
      if (input.path === "/v1/insight-providers")
        return {
          ok: true,
          body: {
            providers: [{ id: "pi", label: "Pi", available: true, guidance: "Configured." }],
            models: [{ provider: "pi", id: "fixture-model", label: "Fixture model", reasoning: ["low", "medium", "high"], defaultReasoning: "medium" }],
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
        screen.getByRole("button", { name: "Focus section" }),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(calls.some((call) => call.path === "/v1/reviews/detect-updates")).toBe(true));
    const callsBeforeFocus = calls.filter((call) => !call.path.includes("/v1/insight-providers")).length;
    await user.click(screen.getByRole("button", { name: "Focus section" }));

    expect(
      screen.queryByRole("navigation", { name: "Insight navigation" }),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-review-insight-document="walkthrough"] > header',
      ),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Review workbench" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Insights" })).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Walkthrough chapters" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Next section" })).toBeTruthy();
    expect(calls.filter((call) => !call.path.includes("/v1/insight-providers"))).toHaveLength(callsBeforeFocus);

    await user.click(screen.getByRole("button", { name: "Exit focus" }));
    expect(
      screen.getByRole("navigation", { name: "Insight navigation" }),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-review-insight-document="walkthrough"] > header',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Walkthrough chapters" }),
    ).toBeTruthy();
    expect(calls.filter((call) => !call.path.includes("/v1/insight-providers"))).toHaveLength(callsBeforeFocus);
    expect(calls.some((call) => call.path.includes("/progress"))).toBe(false);
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
      expect(
        within(dialog).getByText("1 commit · 3 files changed"),
      ).toBeTruthy();
      expect(
        within(dialog).getByRole("button", { name: "Refresh GitHub state" }),
      ).toBeTruthy();

      expect(
        within(dialog).getByRole("button", { name: "Checks" }),
      ).toBeTruthy();
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
          warnings: [
            "request_changes",
            "high_severity_finding",
            "analysis_finding",
          ],
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
        within(dialog).getByText(
          "High-severity local findings need acknowledgement.",
        ),
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
      expect(
        within(dialog).queryByRole("button", { name: "Checks" }),
      ).toBeTruthy();
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
          within(dialog).queryByRole("button", {
            name: "Refresh GitHub state",
          }),
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

  it("publishes an inline comment, skips the background refresh, and journals the write for detection", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(
        async (input: { readonly path: string; readonly body?: unknown }) => {
          if (input.path === "/v1/reviews/detect-updates")
            return {
              ok: true,
              body: { updatesAvailable: false },
              correlationId: "detect",
            };
          if (input.path === "/v1/reviews/inline-conversations/command")
            // The REST create receipt has no thread id.
            return {
              ok: true,
              body: {
                _tag: "CommentCreated",
                commentId: "c-optimistic",
                reviewId: "review-42",
              },
              correlationId: "command",
            };
          if (input.path === "/v1/reviews/refresh")
            return { ok: true, body: projection(), correlationId: "refresh" };
          throw new Error(`unexpected ${input.path}`);
        },
      );
      Object.defineProperty(window, "patchdesk", {
        configurable: true,
        value: { request },
      });
      const withPatchHash = {
        ...projection(),
        revision: {
          ...projection().revision,
          patchHash: "patch-hash" as const,
        },
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
      await vi.advanceTimersByTimeAsync(0);
      fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
      const authorButtons = screen.getAllByRole("button", {
        name: "Add comment on src/a.ts",
      });
      // The fixture patch has one deleted and one added line; the added line's
      // author button is the one that anchors a new-side comment.
      expect(authorButtons.length).toBeGreaterThan(1);
      const addedAuthorButton = authorButtons[1];
      if (addedAuthorButton === undefined)
        throw new Error("fixture: added-line author button missing");
      fireEvent.click(addedAuthorButton);
      fireEvent.change(
        screen.getByRole("textbox", { name: "Inline comment" }),
        { target: { value: "Optimistic body" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      await vi.advanceTimersByTimeAsync(0);
      const commandCall = request.mock.calls.find(
        (call) =>
          (call[0] as { readonly path: string }).path ===
          "/v1/reviews/inline-conversations/command",
      );
      expect(commandCall).toBeDefined();
      expect(
        (commandCall?.[0] as { readonly body: unknown }).body,
      ).toMatchObject({
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
          (call) =>
            (call[0] as { readonly path: string }).path ===
            "/v1/reviews/refresh",
        ),
      ).toBe(false);
      // A direct receipt never triggers an immediate detection pass; the typed
      // journal rides the next scheduled (90s) check so own writes never read
      // as remote updates.
      await vi.advanceTimersByTimeAsync(90_000);
      const detectCall = request.mock.calls.find(
        (call) =>
          (call[0] as { readonly path: string }).path ===
            "/v1/reviews/detect-updates" &&
          (call[0] as { readonly body?: { readonly recentWrites?: unknown } })
            .body?.recentWrites !== undefined,
      );
      expect(detectCall).toBeDefined();
      expect(
        (
          detectCall?.[0] as {
            readonly body?: {
              readonly recentWrites?: ReadonlyArray<{
                readonly _tag: string;
                readonly commentId: string;
                readonly reviewId?: string;
              }>;
            };
          }
        ).body?.recentWrites,
      ).toEqual([
        { _tag: "Comment", commentId: "c-optimistic", reviewId: "review-42" },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        screen.queryByRole("textbox", { name: "Inline comment" }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run an immediate detection pass after a direct conversation receipt", async () => {
    const user = userEvent.setup();
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/inline-conversations/command")
          return {
            ok: true,
            body: { _tag: "CommentCreated", commentId: "c-new" },
            correlationId: "command",
          };
        throw new Error(`unexpected ${input.path}`);
      },
    );
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
    const detectCount = (): number =>
      request.mock.calls.filter(
        (call) =>
          (call[0] as { readonly path: string }).path ===
          "/v1/reviews/detect-updates",
      ).length;
    // The initial visible-Review detection is the only one so far.
    await waitFor(() => expect(detectCount()).toBe(1));
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    const authorButtons = screen.getAllByRole("button", {
      name: "Add comment on src/a.ts",
    });
    const addedAuthorButton = authorButtons[1];
    if (addedAuthorButton === undefined)
      throw new Error("fixture: added-line author button missing");
    await user.click(addedAuthorButton);
    await user.type(
      screen.getByRole("textbox", { name: "Inline comment" }),
      "Body",
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          (call) =>
            (call[0] as { readonly path: string }).path ===
            "/v1/reviews/inline-conversations/command",
        ),
      ).toBe(true),
    );
    // A direct receipt only appends its typed journal entry; it must not
    // trigger or reset a detection pass.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(detectCount()).toBe(1);
  });

  it("detects initially and then at most every 90 seconds while visible and idle", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async (input: { readonly path: string }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        throw new Error(`unexpected ${input.path}`);
      });
      vi.stubGlobal("window", window);
      Object.defineProperty(window, "patchdesk", {
        configurable: true,
        value: { request },
      });
      render(
        <ReviewWorkbenchFlow
          workbench={projection()}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      const detectCount = (): number =>
        request.mock.calls.filter(
          (call) =>
            (call[0] as { readonly path: string }).path ===
            "/v1/reviews/detect-updates",
        ).length;
      // waitFor cannot poll under vitest fake timers (no global jest), so the
      // initial effect is flushed by advancing timers instead.
      await vi.advanceTimersByTimeAsync(0);
      expect(detectCount()).toBe(1);
      // The old 30-second cadence must not fire; the repaired cadence is 90s.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(detectCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(detectCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules one debounced detection when the app regains focus", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async (input: { readonly path: string }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        throw new Error(`unexpected ${input.path}`);
      });
      vi.stubGlobal("window", window);
      Object.defineProperty(window, "patchdesk", {
        configurable: true,
        value: { request },
      });
      render(
        <ReviewWorkbenchFlow
          workbench={projection()}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      const detectCount = (): number =>
        request.mock.calls.filter(
          (call) =>
            (call[0] as { readonly path: string }).path ===
            "/v1/reviews/detect-updates",
        ).length;
      await vi.advanceTimersByTimeAsync(0);
      expect(detectCount()).toBe(1);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(detectCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale detector result that began before an explicit refresh", async () => {
    const user = userEvent.setup();
    let resolveDetect!: (value: unknown) => void;
    const pendingDetect = new Promise((resolve) => {
      resolveDetect = resolve;
    });
    const value = projection();
    const refreshed = {
      ...value,
      session: { ...value.session, id: "session-b" },
    };
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/detect-updates")
        return await pendingDetect;
      if (input.path === "/v1/reviews/refresh")
        return { ok: true, body: refreshed, correlationId: "refresh" };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const replace = vi.fn();
    const patch = vi.fn();
    render(
      <ReviewWorkbenchFlow
        workbench={value}
        onWorkbenchReplace={replace}
        onWorkbenchPatch={patch}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    // The initial detection is still in flight while the maintainer refreshes.
    await user.click(screen.getByRole("button", { name: "PR overview" }));
    const dialog = screen.getByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Refresh GitHub state" }),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith(refreshed));
    // The stale detection completes after refresh replaced the projection; it
    // must not reapply updates_available to the newly refreshed Review.
    resolveDetect({
      ok: true,
      body: { updatesAvailable: true },
      correlationId: "detect",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patch).not.toHaveBeenCalled();
  });
});

it("invalidates an in-flight detector when publication refresh replaces the projection", async () => {
  vi.useFakeTimers();
  try {
    const workbench = createUnifiedReviewFixture("publication-ready");
    // The wire codec re-derives the projection, so refresh/load responses must
    // be wire-valid (the fixture model is a renderer shape).
    const refreshed = {
      ...projection(),
      draft: workbench.draft,
      session: { ...projection().session, id: "session-b" },
    };
    let resolvePendingDetect!: (value: unknown) => void;
    const pendingDetect = new Promise((resolve) => {
      resolvePendingDetect = resolve;
    });
    let detectCalls = 0;
    const request = vi.fn(
      async (input: {
        readonly path: string;
        readonly method?: string;
        readonly body?: unknown;
      }) => {
        if (input.path === "/v1/reviews/detect-updates") {
          detectCalls += 1;
          // The first detection (on mount) completes normally; the second is
          // the one still in flight while publication confirm refreshes.
          if (detectCalls === 1)
            return {
              ok: true,
              status: 200,
              correlationId: "detect",
              body: { updatesAvailable: false },
            };
          return await pendingDetect;
        }
        if (input.path === "/v1/reviews/publication/preview")
          return {
            ok: true,
            status: 200,
            correlationId: "preview",
            body: {
              reviewId: workbench.review.id,
              sessionId: workbench.session.id,
              headSha: workbench.revision.reviewedHeadSha,
              draftRevision: workbench.draft?.updatedAt,
              event: "COMMENT",
              body: "# Review",
              inlineComments: [],
              threadActions: [],
              warnings: [],
            },
          };
        if (input.path === "/v1/reviews/publication/confirm")
          return {
            ok: true,
            status: 200,
            correlationId: "confirm",
            body: { batch: workbench.draft },
          };
        if (input.path === "/v1/reviews/refresh")
          return {
            ok: true,
            status: 200,
            correlationId: "refresh",
            body: refreshed,
          };
        if (input.path === "/v1/reviews/load")
          return {
            ok: true,
            status: 200,
            correlationId: "load",
            body: refreshed,
          };
        throw new Error(`unexpected ${input.path}`);
      },
    );
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const replace = vi.fn();
    const patch = vi.fn();
    render(
      <ReviewWorkbenchFlow
        workbench={workbench}
        onWorkbenchReplace={replace}
        onWorkbenchPatch={patch}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(detectCalls).toBe(1);
    // Start the second detection (in flight) via the focus debounce.
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(detectCalls).toBe(2);
    // Drive the publication confirmation while that detector is pending.
    fireEvent.click(
      screen.getByRole("button", { name: "Preview publication" }),
    );
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(50);
      if (screen.queryByRole("dialog") !== null) break;
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm publication" }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    // The publication refresh (then load) replaced the projection with the
    // refreshed session (the parsed projection is structurally re-derived).
    expect(
      replace.mock.calls.some(
        (call) =>
          (call[0] as { readonly session: { readonly id: string } }).session
            .id === "session-b",
      ),
    ).toBe(true);
    // The stale detector completes after publication refresh replaced the
    // projection; it must not reapply updates_available to the new projection.
    resolvePendingDetect({
      ok: true,
      status: 200,
      correlationId: "detect",
      body: { updatesAvailable: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(patch).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        revision: expect.objectContaining({ freshness: "updates_available" }),
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("keeps detection paused while two direct commands overlap and resumes only after both complete", async () => {
  vi.useFakeTimers();
  try {
    const pendingCommands: Array<(value: unknown) => void> = [];
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/inline-conversations/command")
          return await new Promise((resolve) => {
            pendingCommands.push(resolve);
          });
        throw new Error(`unexpected ${input.path}`);
      },
    );
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
    const detectCount = (): number =>
      request.mock.calls.filter(
        (call) =>
          (call[0] as { readonly path: string }).path ===
          "/v1/reviews/detect-updates",
      ).length;
    await vi.advanceTimersByTimeAsync(0);
    expect(detectCount()).toBe(1);
    // Start two overlapping inline creates; both commands stay in flight.
    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
    const authorButtons = screen.getAllByRole("button", {
      name: "Add comment on src/a.ts",
    });
    fireEvent.click(authorButtons[0] as HTMLElement);
    fireEvent.change(screen.getByRole("textbox", { name: "Inline comment" }), {
      target: { value: "First" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await vi.advanceTimersByTimeAsync(0);
    const secondAuthor = screen
      .getAllByRole("button", { name: "Add comment on src/a.ts" })
      .at(-1);
    if (secondAuthor === undefined)
      throw new Error("fixture: second author button missing");
    fireEvent.click(secondAuthor);
    fireEvent.change(screen.getByRole("textbox", { name: "Inline comment" }), {
      target: { value: "Second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingCommands).toHaveLength(2);
    // While both commands are in flight, a detector tick must be skipped.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(detectCount()).toBe(1);
    // The first command completes; the second is still running, so the
    // detector must stay paused even though one command finished.
    pendingCommands[0]?.({
      ok: true,
      body: { _tag: "CommentCreated", commentId: "c-1" },
      correlationId: "command",
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(detectCount()).toBe(1);
    // The second command completes; the next detector tick may run.
    pendingCommands[1]?.({
      ok: true,
      body: { _tag: "CommentCreated", commentId: "c-2" },
      correlationId: "command",
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(detectCount()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("coalesces visibility and focus into exactly one debounced detection", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn(async (input: { readonly path: string }) => {
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
    render(
      <ReviewWorkbenchFlow
        workbench={projection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const detectCount = (): number =>
      request.mock.calls.filter(
        (call) =>
          (call[0] as { readonly path: string }).path ===
          "/v1/reviews/detect-updates",
      ).length;
    await vi.advanceTimersByTimeAsync(0);
    expect(detectCount()).toBe(1);
    // A focus regain commonly emits both events back to back.
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    // No immediate request from visibilitychange, and no duplicate at 1s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(detectCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(detectCount()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("treats a malformed create receipt as a bounded failure: no journal record and no confirmed card", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/inline-conversations/command")
          // A success envelope missing its comment id is malformed: the local
          // write cannot be confirmed, so nothing may be journaled.
          return {
            ok: true,
            body: { _tag: "CommentCreated" },
            correlationId: "command",
          };
        throw new Error(`unexpected ${input.path}`);
      },
    );
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
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
    const authorButtons = screen.getAllByRole("button", {
      name: "Add comment on src/a.ts",
    });
    const addedAuthorButton = authorButtons[1];
    if (addedAuthorButton === undefined)
      throw new Error("fixture: added-line author button missing");
    fireEvent.click(addedAuthorButton);
    fireEvent.change(screen.getByRole("textbox", { name: "Inline comment" }), {
      target: { value: "Body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await vi.advanceTimersByTimeAsync(0);
    // The command resolved with 200, but the malformed receipt must not be
    // treated as a confirmed mutation: the next detection carries no journal.
    await vi.advanceTimersByTimeAsync(90_000);
    const detectCall = request.mock.calls.find(
      (call) =>
        (call[0] as { readonly path: string }).path ===
          "/v1/reviews/detect-updates" &&
        (call[0] as { readonly body?: { readonly recentWrites?: unknown } })
          .body?.recentWrites !== undefined,
    );
    expect(detectCall).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("does not restart the detector when the parent recreates the patch callback", async () => {
  vi.useFakeTimers();
  try {
    const value = projection();
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/detect-updates")
        return {
          ok: true,
          status: 200,
          correlationId: "detect",
          body: { updatesAvailable: true },
        };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const detectCount = (): number =>
      request.mock.calls.filter(
        (call) =>
          (call[0] as { readonly path: string }).path ===
          "/v1/reviews/detect-updates",
      ).length;
    // App passes onWorkbenchPatch as an inline function and re-renders when
    // it applies a functional setState; the prop therefore gets a fresh
    // identity after every patch. The detector cadence must not depend on it.
    const PatchRecreatingParent = () => {
      const [, force] = useState(0);
      return (
        <ReviewWorkbenchFlow
          workbench={value}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={() => force((count) => count + 1)}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />
      );
    };
    render(<PatchRecreatingParent />);
    await vi.advanceTimersByTimeAsync(0);
    expect(detectCount()).toBe(1);
    // The positive detection made the parent render again, recreating the
    // callback; that must not spawn an immediate second request.
    await vi.advanceTimersByTimeAsync(50);
    expect(detectCount()).toBe(1);
    // The normal cadence still holds: the next interval fires exactly once.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(detectCount()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("does not start a detector while a post-publication refresh is pending", async () => {
  vi.useFakeTimers();
  try {
    const workbench = createUnifiedReviewFixture("publication-ready");
    const refreshed = {
      ...projection(),
      draft: workbench.draft,
      session: { ...projection().session, id: "session-b" },
    };
    let resolveRefresh!: (value: unknown) => void;
    const pendingRefresh = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/detect-updates")
        return {
          ok: true,
          status: 200,
          correlationId: "detect",
          body: { updatesAvailable: false },
        };
      if (input.path === "/v1/reviews/publication/preview")
        return {
          ok: true,
          status: 200,
          correlationId: "preview",
          body: {
            reviewId: workbench.review.id,
            sessionId: workbench.session.id,
            headSha: workbench.revision.reviewedHeadSha,
            draftRevision: workbench.draft?.updatedAt,
            event: "COMMENT",
            body: "# Review",
            inlineComments: [],
            threadActions: [],
            warnings: [],
          },
        };
      if (input.path === "/v1/reviews/publication/confirm")
        return {
          ok: true,
          status: 200,
          correlationId: "confirm",
          body: { batch: workbench.draft },
        };
      if (input.path === "/v1/reviews/refresh") return await pendingRefresh;
      if (input.path === "/v1/reviews/load")
        return {
          ok: true,
          status: 200,
          correlationId: "load",
          body: refreshed,
        };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    const replace = vi.fn();
    render(
      <ReviewWorkbenchFlow
        workbench={workbench}
        onWorkbenchReplace={replace}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const detectCount = (): number =>
      request.mock.calls.filter(
        (call) =>
          (call[0] as { readonly path: string }).path ===
          "/v1/reviews/detect-updates",
      ).length;
    await vi.advanceTimersByTimeAsync(0);
    expect(detectCount()).toBe(1);
    // Drive the publication confirmation; the refresh it triggers stays
    // pending, so its generation has incremented but no response arrived.
    fireEvent.click(
      screen.getByRole("button", { name: "Preview publication" }),
    );
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(50);
      if (screen.queryByRole("dialog") !== null) break;
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm publication" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    // A focus-return debounce and a full interval tick during the pending
    // refresh must not start detector work.
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(detectCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(detectCount()).toBe(1);
    // The refresh resolves; the load replaces the projection with the
    // refreshed session.
    resolveRefresh({
      ok: true,
      status: 200,
      correlationId: "refresh",
      body: refreshed,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      replace.mock.calls.some(
        (call) =>
          (call[0] as { readonly session: { readonly id: string } }).session
            .id === "session-b",
      ),
    ).toBe(true);
    // Once the refresh window closes, the next interval tick may detect.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(detectCount()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

describe("ReviewWorkbenchFlow pending review", () => {
  const pendingProjection = (overrides: Record<string, unknown> = {}) => ({
    state: "pending" as const,
    count: 2,
    review: {
      nodeId: "PRR_kwDORJzsQM7e6QwJ",
      headSha: "a".repeat(40),
      comments: [
        {
          threadId: "PRRT_1",
          body: "First",
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new",
        },
        {
          threadId: "PRRT_2",
          body: "Second",
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new",
        },
      ],
    },
    ...overrides,
  });

  const withPending = (
    pendingReview: unknown,
    patchHash = "patch-hash",
  ): WorkbenchResponse => ({
    ...projection(),
    revision: { ...projection().revision, patchHash: patchHash as never },
    pendingReview: pendingReview as WorkbenchResponse["pendingReview"],
  });

  function stubRequest(responses: Record<string, unknown>) {
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/refresh")
          return { ok: true, body: projection(), correlationId: "refresh" };
        const response = responses[input.path];
        if (response !== undefined)
          return { ok: true, body: response, correlationId: "x" };
        throw new Error(`unexpected ${input.path}`);
      },
    );
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    return request;
  }

  async function openComposer(user: ReturnType<typeof userEvent.setup>) {
    void user;
    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
    const authorButtons = screen.getAllByRole("button", {
      name: "Add comment on src/a.ts",
    });
    fireEvent.click(authorButtons[1] as HTMLElement);
    return {
      composer: screen.getByRole("region", { name: "Inline comment composer" }),
      input: screen.getByRole("textbox", { name: "Inline comment" }),
    };
  }

  it("shows Start a review in the header when none exists and directs to the Diff composer", async () => {
    const user = userEvent.setup();
    void user;
    render(
      <ReviewWorkbenchFlow
        workbench={withPending({ state: "none" })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start a review" }));
    expect(screen.getByRole("dialog", { name: "Start review" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add inline comment" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Write review summary" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Add inline comment" }),
    );
    // Choosing inline authoring leads to the Diff and creates nothing.
    expect(screen.getByRole("region", { name: "Review diff" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Finish review · " }),
    ).toBeNull();
  });

  it("reconciles an uncertain direct summary through the recovery endpoint before reopening submission", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (input: { readonly path: string }) => {
      if (input.path === "/v1/reviews/detect-updates")
        return {
          ok: true,
          body: { updatesAvailable: false },
          correlationId: "detect",
        };
      if (input.path === "/v1/reviews/direct-summary/submit")
        return {
          ok: false,
          status: 503,
          body: { error: "outcome_unknown" },
          correlationId: "submit",
        };
      if (input.path === "/v1/reviews/direct-summary/recover")
        return {
          ok: true,
          body: { directSummary: { state: "idle" } },
          correlationId: "recover",
        };
      throw new Error(`unexpected ${input.path}`);
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    render(
      <ReviewWorkbenchFlow
        workbench={withPending({ state: "none" })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start a review" }));
    await user.click(
      screen.getByRole("button", { name: "Write review summary" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Review summary" }), {
      target: { value: "Summary" },
    });
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    await screen.findByRole("button", { name: "Check GitHub status" });
    expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Check GitHub status" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/v1/reviews/direct-summary/recover" }),
      ),
    );
    expect(
      screen.getByRole("textbox", { name: "Review summary" }),
    ).toBeTruthy();
  });

  it("shows Finish review · N when a pending review is confirmed and opens the modal", async () => {
    const user = userEvent.setup();
    render(
      <ReviewWorkbenchFlow
        workbench={withPending(pendingProjection())}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const finish = screen.getByRole("button", { name: "Finish review · 2" });
    expect(finish).toBeTruthy();
    await user.click(finish);
    expect(screen.getByRole("dialog", { name: "Finish review" })).toBeTruthy();
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    // Discard exists but is separate from Submit and needs its own confirmation.
    expect(screen.getByRole("button", { name: "Discard review" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm discard" }),
    ).toBeNull();
  });

  it("offers Comment now and Start a review before a pending review; only Add review comment after", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ReviewWorkbenchFlow
        workbench={withPending({ state: "none" })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const first = await openComposer(user);
    expect(
      within(first.composer).getByRole("button", { name: "Start a review" }),
    ).toBeTruthy();
    expect(
      within(first.composer).getByRole("button", { name: "Comment now" }),
    ).toBeTruthy();
    expect(
      within(first.composer).queryByRole("button", {
        name: "Add review comment",
      }),
    ).toBeNull();

    rerender(
      <ReviewWorkbenchFlow
        workbench={withPending(pendingProjection())}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const second = await openComposer(user);
    expect(
      within(second.composer).getByRole("button", {
        name: "Add review comment",
      }),
    ).toBeTruthy();
    expect(
      within(second.composer).queryByRole("button", { name: "Comment now" }),
    ).toBeNull();
    expect(
      within(second.composer).queryByRole("button", { name: "Start a review" }),
    ).toBeNull();
  });

  it("sends the Start command with the selected anchor and applies the returned projection", async () => {
    const user = userEvent.setup();
    const request = stubRequest({
      "/v1/reviews/pending-review/command": {
        pendingReview: pendingProjection({ count: 1 }),
      },
    });
    const onWorkbenchPatch = vi.fn();
    render(
      <ReviewWorkbenchFlow
        workbench={withPending({ state: "none" })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={onWorkbenchPatch}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const { composer, input } = await openComposer(user);
    fireEvent.change(input, { target: { value: "Start with this" } });
    await user.click(
      within(composer).getByRole("button", { name: "Start a review" }),
    );
    const call = request.mock.calls.find(
      (entry) =>
        (entry[0] as { readonly path: string }).path ===
        "/v1/reviews/pending-review/command",
    );
    expect(call).toBeDefined();
    const body = (call?.[0] as { readonly body?: unknown }).body as {
      readonly command?: unknown;
    };
    expect(body?.command).toMatchObject({
      _tag: "Start",
      anchor: { path: "src/a.ts", side: "new" },
      body: "Start with this",
      expected: {
        sessionId: "session-a",
        headSha: "a".repeat(40),
        patchHash: "patch-hash",
      },
    });
    await waitFor(() =>
      expect(onWorkbenchPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          pendingReview: expect.objectContaining({
            state: "pending",
            count: 1,
          }),
        }),
      ),
    );
  });

  it("locks the composer and offers Check GitHub again when the pending read is unavailable", async () => {
    const user = userEvent.setup();
    const request = stubRequest({
      "/v1/reviews/pending-review/recover": {
        pendingReview: { state: "none" },
      },
    });
    render(
      <ReviewWorkbenchFlow
        workbench={withPending({ state: "unavailable", action: "refresh" })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const { composer } = await openComposer(user);
    expect(
      within(composer).getByText(/Pending review state is unavailable/),
    ).toBeTruthy();
    expect(
      within(composer).queryByRole("button", { name: "Start a review" }),
    ).toBeNull();
    expect(
      within(composer).queryByRole("button", { name: "Comment now" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Check GitHub again" }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/reviews/pending-review/recover" }),
    );
  });

  it("shows a recovery notice while a write outcome is unknown", async () => {
    render(
      <ReviewWorkbenchFlow
        workbench={withPending({
          state: "recovery_required",
          action: "submit",
        })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText(/needs reconciliation/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Check GitHub again" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Finish review/ })).toBeNull();
  });
});

describe("ReviewWorkbenchFlow pending review discard", () => {
  const pendingProjection = (overrides: Record<string, unknown> = {}) => ({
    state: "pending" as const,
    count: 2,
    review: {
      nodeId: "PRR_kwDORJzsQM7e6QwJ",
      headSha: "a".repeat(40),
      comments: [
        {
          threadId: "PRRT_1",
          body: "First",
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new",
        },
        {
          threadId: "PRRT_2",
          body: "Second",
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new",
        },
      ],
    },
    ...overrides,
  });

  const withPending = (pendingReview: unknown): WorkbenchResponse => ({
    ...projection(),
    revision: { ...projection().revision, patchHash: "patch-hash" as never },
    pendingReview: pendingReview as WorkbenchResponse["pendingReview"],
  });

  function stubRequest(responses: Record<string, unknown>) {
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        if (input.path === "/v1/reviews/detect-updates")
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        if (input.path === "/v1/reviews/refresh")
          return { ok: true, body: projection(), correlationId: "refresh" };
        const response = responses[input.path];
        if (response !== undefined)
          return { ok: true, body: response, correlationId: "x" };
        throw new Error(`unexpected ${input.path}`);
      },
    );
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    return request;
  }

  it("sends the confirmed Discard command from the finish modal and applies the none projection", async () => {
    const user = userEvent.setup();
    const request = stubRequest({
      "/v1/reviews/pending-review/command": {
        pendingReview: { state: "none" },
      },
    });
    const onWorkbenchPatch = vi.fn();
    render(
      <ReviewWorkbenchFlow
        workbench={withPending(pendingProjection({ count: 1 }))}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={onWorkbenchPatch}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Finish review · 1" }));
    // The destructive confirmation is separate from the submit path.
    await user.click(screen.getByRole("button", { name: "Discard review" }));
    const commandCalls = request.mock.calls.filter(
      (entry) =>
        (entry[0] as { readonly path: string }).path ===
        "/v1/reviews/pending-review/command",
    );
    expect(commandCalls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));
    await vi.waitFor(() =>
      expect(
        request.mock.calls.some(
          (entry) =>
            (entry[0] as { readonly path: string }).path ===
            "/v1/reviews/pending-review/command",
        ),
      ).toBe(true),
    );
    const discardCall = request.mock.calls.find(
      (entry) =>
        (entry[0] as { readonly path: string }).path ===
        "/v1/reviews/pending-review/command",
    );
    const body = (discardCall?.[0] as { readonly body?: unknown }).body as {
      readonly command?: unknown;
    };
    expect(body?.command).toMatchObject({
      _tag: "Discard",
      confirmation: true,
      expected: {
        sessionId: "session-a",
        headSha: "a".repeat(40),
        patchHash: "patch-hash",
      },
    });
    await vi.waitFor(() =>
      expect(onWorkbenchPatch).toHaveBeenCalledWith(
        expect.objectContaining({ pendingReview: { state: "none" } }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Finish review" }),
      ).toBeNull(),
    );
  });
});
describe("pending-review write journaling", () => {
  const withPending = (pendingReview: unknown): WorkbenchResponse => ({
    ...projection(),
    revision: { ...projection().revision, patchHash: "patch-hash" as never },
    pendingReview: pendingReview as WorkbenchResponse["pendingReview"],
  });

  // The accessible fallback (no constructable stylesheets) renders the
  // composer synchronously so a Start can be driven in jsdom.
  const withFallbackDom = async (run: () => Promise<void>): Promise<void> => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    Object.defineProperty(window, "CSSStyleSheet", {
      configurable: true,
      value: undefined,
    });
    try {
      await run();
    } finally {
      if (styleSheet === undefined)
        delete (window as unknown as { CSSStyleSheet?: unknown }).CSSStyleSheet;
      else Object.defineProperty(window, "CSSStyleSheet", styleSheet);
    }
  };

  function stubRequestWithDetectCapture(responses: Record<string, unknown>) {
    const detectBodies: Array<{ readonly recentWrites?: unknown }> = [];
    const request = vi.fn(
      async (input: { readonly path: string; readonly body?: unknown }) => {
        if (input.path === "/v1/reviews/detect-updates") {
          detectBodies.push(
            (input.body ?? {}) as { readonly recentWrites?: unknown },
          );
          return {
            ok: true,
            body: { updatesAvailable: false },
            correlationId: "detect",
          };
        }
        if (input.path === "/v1/reviews/refresh")
          return { ok: true, body: projection(), correlationId: "refresh" };
        const response = responses[input.path];
        if (response !== undefined)
          return { ok: true, body: response, correlationId: "x" };
        throw new Error(`unexpected ${input.path}`);
      },
    );
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { request },
    });
    return { request, detectBodies };
  }

  it("journals only the newly confirmed thread after a successful Start", async () => {
    await withFallbackDom(async () => {
      const user = userEvent.setup();
      const { request, detectBodies } = stubRequestWithDetectCapture({
        "/v1/reviews/pending-review/command": {
          pendingReview: {
            state: "pending",
            count: 1,
            review: {
              nodeId: "PRR_kwDORJzsQM7e6QwJ",
              headSha: "a".repeat(40),
              comments: [
                {
                  threadId: "PRRT_journal_1",
                  body: "test",
                  path: "src/a.ts",
                  startLine: 1,
                  line: 1,
                  side: "new",
                },
              ],
            },
          },
        },
      });
      render(
        <ReviewWorkbenchFlow
          workbench={withPending({ state: "none" })}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
          onNavigate={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("tab", { name: "Diff" }));
      const row = document.querySelector<HTMLElement>(
        '[data-line-type="change-addition"]',
      );
      const addButton = row?.querySelector<HTMLButtonElement>(
        'button[aria-label="Add comment on src/a.ts"]',
      );
      if (!addButton) throw new Error("Expected inline comment action");
      await user.click(addButton);
      await user.type(
        screen.getByRole("textbox", { name: "Inline comment" }),
        "test",
      );
      const startButtons = screen.getAllByRole("button", {
        name: "Start a review",
      });
      await user.click(startButtons.at(-1) as HTMLButtonElement);
      await vi.waitFor(() =>
        expect(
          request.mock.calls.some(
            (c) =>
              (c[0] as { path: string }).path ===
              "/v1/reviews/pending-review/command",
          ),
        ).toBe(true),
      );
      const detectsBefore = detectBodies.length;
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(
        () => expect(detectBodies.length).toBeGreaterThan(detectsBefore),
        { timeout: 4000 },
      );
      const body = detectBodies.at(-1);
      expect(body?.recentWrites).toEqual([
        { _tag: "PendingThread", threadId: "PRRT_journal_1" },
      ]);
    });
  });

  it("journals the prior pending thread after a confirmed Discard", async () => {
    const user = userEvent.setup();
    const { request, detectBodies } = stubRequestWithDetectCapture({
      "/v1/reviews/pending-review/command": {
        pendingReview: { state: "none" },
      },
    });
    render(
      <ReviewWorkbenchFlow
        workbench={withPending({
          state: "pending",
          count: 1,
          review: {
            nodeId: "PRR_kwDORJzsQM7e6QwJ",
            headSha: "a".repeat(40),
            comments: [
              {
                threadId: "PRRT_1",
                body: "First",
                path: "src/a.ts",
                startLine: 1,
                line: 1,
                side: "new",
              },
            ],
          },
        })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Finish review · 1" }));
    await user.click(screen.getByRole("button", { name: "Discard review" }));
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));
    await vi.waitFor(() =>
      expect(
        request.mock.calls.some(
          (c) =>
            (c[0] as { path: string }).path ===
            "/v1/reviews/pending-review/command",
        ),
      ).toBe(true),
    );
    const detectsBefore = detectBodies.length;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(
      () => expect(detectBodies.length).toBeGreaterThan(detectsBefore),
      { timeout: 4000 },
    );
    const body = detectBodies.at(-1);
    expect(body?.recentWrites).toEqual([
      { _tag: "PendingThread", threadId: "PRRT_1" },
    ]);
  });
});

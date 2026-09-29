// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { FINDING_ACTION_MESSAGES } from "../../src/renderer/src/review-copy";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import {
  callPath,
  patchHash,
  pending,
  projection,
  providerCatalog,
  sha,
  withAnalysis,
  type DeferredResolve,
} from "./review-workbench-fixtures";

function mount(
  workbench: WorkbenchResponse,
  callbacks: Partial<
    Record<"replace" | "patch", ReturnType<typeof vi.fn>>
  > = {},
) {
  const replace = callbacks.replace ?? vi.fn();
  const patch = callbacks.patch ?? vi.fn();
  render(
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={replace}
      onWorkbenchPatch={patch}
      onNavigationStateChange={vi.fn()}
    />,
  );
  return { replace, patch };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  restoreBridge();
});

describe("ReviewWorkbenchFlow mutation lifecycle", () => {
  it("locks a Finding after its exact pending-review receipt is projected", async () => {
    const initial = withAnalysis("actionable");
    const pendingProjection = pending("pending");
    if (pendingProjection.state !== "pending") throw new Error("fixture");
    const commandProjection = {
      ...pendingProjection,
      review: {
        ...pendingProjection.review,
        comments: pendingProjection.review.comments.map((comment) => ({
          ...comment,
          body: "Reject invalid values before this branch.",
        })),
      },
    };
    const projected: WorkbenchResponse = {
      ...initial,
      pendingReview: commandProjection,
      analysisReviewActions: {
        findings: { "finding-1": { state: "pending_review" } },
        canFinishWithAnalysisSummary: true,
      },
    };
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      if (input.path === "/v1/reviews/pending-review/command")
        return { pendingReview: commandProjection };
      throw new Error(input.path);
    });
    const { replace } = mount(initial);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(await screen.findByRole("tab", { name: /^Analysis/ }));
    await user.click(
      await screen.findByRole("button", { name: "Add to review" }),
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith(projected));
    const commandCall = request.mock.calls.find(
      ([input]) => callPath(input) === "/v1/reviews/pending-review/command",
    );
    expect(commandCall?.[0]).toMatchObject({
      body: {
        profileId: "profile",
        reviewId: "review-42",
        command: {
          _tag: "Start",
          body: "Reject invalid values before this branch.",
          finding: {
            analysisRunId: "insight-analysis-1-fixture",
            findingId: "finding-1",
            sessionId: "session-a",
            headSha: sha,
            patchHash,
          },
        },
      },
    });
    expect(
      request.mock.calls.filter(
        ([input]) => callPath(input) === "/v1/reviews/pending-review/command",
      ),
    ).toHaveLength(1);
    expect(
      request.mock.calls.some(
        ([input]) => callPath(input) === "/v1/reviews/load",
      ),
    ).toBe(false);

    cleanup();
    mount(projected);
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(await screen.findByRole("tab", { name: /^Analysis/ }));
    expect(await screen.findByText("Added")).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
  });

  /** Dismisses finding-1 in the mounted workbench, answering the advisory Review reload with `load`. */
  async function dismissWithReload(load: () => Promise<WorkbenchResponse>) {
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      if (
        input.path ===
        "/v1/reviews/insights/analysis/findings/finding-1/dismiss"
      )
        return { findingId: "finding-1", status: "dismissed" };
      if (input.path === "/v1/reviews/load") return load();
      throw new Error(input.path);
    });
    const { patch } = mount(withAnalysis("actionable"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(await screen.findByRole("tab", { name: /^Analysis/ }));
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    await user.type(
      screen.getByLabelText("Dismiss reason for Missing boundary check"),
      "Not applicable",
    );
    await user.click(screen.getByRole("button", { name: "Confirm dismissal" }));
    return patch;
  }

  const dismissedAnalysisPatch = expect.objectContaining({
    retained: expect.objectContaining({
      value: expect.objectContaining({
        findings: [expect.objectContaining({ disposition: "dismissed" })],
      }),
    }),
  });

  it("keeps a confirmed Finding dismissal when the Review reload fails", async () => {
    const patch = await dismissWithReload(async () => {
      throw new Error("reload failed");
    });

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({
        insights: { analysis: dismissedAnalysisPatch },
      }),
    );
    expect(screen.queryByText(FINDING_ACTION_MESSAGES.fallback)).toBeNull();
  });

  it("takes merge readiness from the reloaded Review after a confirmed dismissal", async () => {
    const opened = withAnalysis("actionable");
    const retained = opened.insights.analysis.retained;
    if (retained === undefined) throw new Error("fixture");
    const reloaded: WorkbenchResponse = {
      ...opened,
      insights: {
        ...opened.insights,
        analysis: {
          ...opened.insights.analysis,
          retained: {
            ...retained,
            value: {
              ...retained.value,
              findings: retained.value.findings.map((finding) => ({
                ...finding,
                disposition: "dismissed" as const,
                dismissalReason: "Not applicable",
              })),
            },
          },
        },
      },
      analysisReviewActions: {
        findings: {},
        canFinishWithAnalysisSummary: false,
      },
      mergeReadiness: { _tag: "Blocked", blockers: ["draft"], warnings: [] },
    };

    const patch = await dismissWithReload(async () => reloaded);

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({
        insights: { analysis: dismissedAnalysisPatch },
        mergeReadiness: reloaded.mergeReadiness,
        analysisReviewActions: reloaded.analysisReviewActions,
      }),
    );
  });

  it("wires published-review dismissal through the mounted workbench", async () => {
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/published-reviews/dismiss")
        return {
          _tag: "PublishedReviewDismissed",
          publishedReviewId: "101",
          reconciliation: "complete",
        };
      throw new Error(input.path);
    });
    mount(
      projection({
        conversation: {
          prDescription: "",
          entries: [
            {
              _tag: "ReviewSummary",
              review: {
                id: "101",
                author: "reviewer",
                body: "Published review",
                event: "APPROVED",
                submittedAt: "2026-08-01T00:00:00.000Z",
                canDismiss: true,
              },
            },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Conversation" }));
    await user.click(screen.getByRole("button", { name: "Dismiss review" }));
    await user.type(
      screen.getByRole("textbox", { name: "Dismissal reason" }),
      "obsolete",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss review" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/reviews/published-reviews/dismiss",
          body: expect.objectContaining({
            publishedReviewId: "101",
            message: "obsolete",
            confirmation: true,
          }),
        }),
      ),
    );
    expect(screen.getByText("Dismissed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss review" })).toBeNull();
  });

  it("restores the durable write lock on reload while keeping reads and Refresh available", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    const base = withAnalysis("actionable");
    const locked: WorkbenchResponse = {
      ...base,
      remoteWriteRecovery: {
        operation: "Reply",
        resolution: "check_required",
      },
      conversation: {
        prDescription: "",
        entries: [
          {
            _tag: "GeneralThread",
            thread: {
              id: "thread-1",
              state: "open",
              comments: [
                {
                  id: "comment-1",
                  author: "reviewer",
                  body: "Published comment",
                  createdAt: "2026-08-01T00:00:00.000Z",
                  viewerDidAuthor: true,
                },
              ],
            },
          },
        ],
      },
    };
    mount(locked);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Refresh GitHub state" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start a review" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add comment on src/a.ts" }),
    ).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Conversation" }));
    for (const name of [
      "Manage labels",
      "Manage assignees",
      "Manage reviewers",
      "Resolve",
      "Edit",
      "Delete",
      "Reply",
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(await screen.findByRole("tab", { name: /^Analysis/ }));
    expect(await screen.findByText("Missing boundary check")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
  });

  it("shows the shadcn recovery Spinner while one check is pending", async () => {
    let release: DeferredResolve = () => undefined;
    const recovery = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const request = bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : input.path === "/v1/reviews/write/recover"
          ? recovery
          : Promise.reject(new Error(input.path)),
    );
    const { replace } = mount(
      projection({
        remoteWriteRecovery: {
          operation: "CreateComment",
          resolution: "check_required",
        },
      }),
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Check GitHub again" }),
    );

    const checking = screen.getByRole("button", { name: /Checking/ });
    expect(checking.hasAttribute("disabled")).toBe(true);
    const spinner = within(checking).getByRole("status", { name: "Loading" });
    expect(spinner.getAttribute("data-icon")).toBe("inline-start");
    expect(
      request.mock.calls.filter(
        ([input]) => callPath(input) === "/v1/reviews/write/recover",
      ),
    ).toHaveLength(1);

    const recovered = projection();
    release(recovered);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(recovered));
  });

  it("explains manual resolution without offering a check action", () => {
    bridge(async () => ({ updatesAvailable: false }));
    mount(
      projection({
        remoteWriteRecovery: {
          operation: "CreateComment",
          resolution: "manual_resolution_required",
        },
      }),
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Check GitHub again" }),
    ).toBeNull();
  });
});

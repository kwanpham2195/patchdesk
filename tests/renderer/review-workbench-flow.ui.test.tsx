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

import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";

const sha = "a".repeat(40);
const patchHash = "b".repeat(64);

function projection(
  overrides: Partial<WorkbenchResponse> = {},
): WorkbenchResponse {
  return {
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
        headSha: sha,
      },
    },
    revision: {
      reviewedHeadSha: sha,
      currentHeadSha: sha,
      freshness: "fresh",
      refreshedAt: "2026-08-01T00:00:00.000Z",
      patchHash: patchHash as never,
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
      author: "fixture",
      headBranch: "feature",
      baseBranch: "main",
      headSha: sha,
      isOpen: true,
      isDraft: false,
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
    conversation: { prDescription: "Represented description", entries: [] },
    checks: { overall: "passing", checks: [] },
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
    ...overrides,
  } as WorkbenchResponse;
}

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
      onNavigate={vi.fn()}
    />,
  );
  return { replace, patch };
}

function bridge(
  handler: (input: {
    readonly path: string;
    readonly body?: unknown;
  }) => Promise<unknown> | unknown,
) {
  const request = vi.fn(
    async (input: { readonly path: string; readonly body?: unknown }) => {
      const body = await handler(input);
      return { ok: true, status: 200, correlationId: input.path, body };
    },
  );
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request },
  });
  return request;
}

const analysisResult = {
  changeSummary: "The current change adds a guarded branch.",
  verdict: "comment" as const,
  summary: "The branch needs a boundary check.",
  findings: [
    {
      id: "finding-1",
      severity: "P1" as const,
      title: "Missing boundary check",
      file: "src/a.ts",
      lineStart: 1,
      lineEnd: 1,
      diffSide: "new" as const,
      explanation: "The added branch accepts an invalid value.",
      suggestedComment: "Reject invalid values before this branch.",
      confidence: "high" as const,
      mappingStatus: "mapped" as const,
    },
  ],
  validationPlan: ["Verify invalid values are rejected."],
  assumptions: [],
};

const providerCatalog = {
  providers: [
    {
      id: "pi",
      label: "Pi",
      available: true,
      guidance: "Available for local review.",
    },
  ],
  models: [
    {
      provider: "pi",
      id: "fixture-model",
      label: "Fixture model",
      reasoning: ["medium"],
      defaultReasoning: "medium",
    },
  ],
};

function withAnalysis(
  findingState: "actionable" | "pending_review",
): WorkbenchResponse {
  return projection({
    insights: {
      analysis: {
        status: "current",
        artifactStatus: "verified",
        retained: {
          runId: "insight-analysis-1-fixture",
          sessionId: "session-a",
          headSha: sha,
          generatedAt: "2026-08-01T00:00:00.000Z",
          value: analysisResult,
        },
      },
      walkthrough: { status: "not_generated" },
    },
    analysisReviewActions: {
      findings: { "finding-1": { state: findingState } },
      canFinishWithAnalysisSummary: findingState === "pending_review",
    },
    pendingReview: pending(findingState === "actionable" ? "none" : "pending"),
  } as never);
}

async function openAddedLineComposer(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Diff" }));
  const add = (
    await screen.findAllByRole("button", { name: "Add comment on src/a.ts" })
  ).at(-1);
  if (add === undefined) throw new Error("missing added-line comment action");
  await user.click(add);
  return screen.getByRole("region", { name: "Inline comment composer" });
}

function pending(
  state: "none" | "pending" | "unavailable" | "recovery_required" = "pending",
) {
  if (state === "none") return { state };
  if (state === "unavailable") return { state, action: "refresh" };
  if (state === "recovery_required") return { state, action: "start" };
  return {
    state,
    count: 1,
    review: {
      nodeId: "PRR_1",
      headSha: sha,
      comments: [
        {
          threadId: "PRRT_1",
          body: "Finding",
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new",
        },
      ],
    },
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("ReviewWorkbenchFlow current Review protocol", () => {
  it("renders the represented Review and maintains pressed outer tabs", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    mount(projection());
    expect(
      screen.getByRole("region", { name: "Review workbench" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Canonical workbench" }),
    ).toBeTruthy();
    const conversation = screen.getByRole("button", { name: "Conversation" });
    const diff = screen.getByRole("button", { name: "Diff" });
    const insights = screen.getByRole("button", { name: "Insights" });
    expect(diff.getAttribute("aria-pressed")).toBe("true");
    await userEvent.setup().click(conversation);
    expect(conversation.getAttribute("aria-pressed")).toBe("true");
    expect(diff.getAttribute("aria-pressed")).toBe("false");
    expect(insights.getAttribute("aria-pressed")).toBe("false");
  });

  it("refreshes only by reviewId and replaces the canonical projection", async () => {
    const refreshed = projection({
      session: { ...projection().session, id: "session-b" },
    });
    const request = bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : input.path === "/v1/reviews/refresh"
          ? refreshed
          : Promise.reject(new Error(input.path)),
    );
    const { replace } = mount(projection());
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "PR overview" }));
    await userEvent.setup().click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Refresh GitHub state",
      }),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith(refreshed));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/reviews/refresh",
        body: { profileId: "profile", reviewId: "review-42" },
      }),
    );
  });

  it.each(["Reconciled", "RevisionChanged", "Unavailable", "Terminal"])(
    "does not apply a stale direct-summary %s observation after Refresh",
    async (outcome) => {
      let observe!: (value: unknown) => void;
      const deferred = new Promise((resolve) => {
        observe = resolve;
      });
      const refreshed = projection({
        session: { ...projection().session, id: "session-b" },
        revision: {
          ...projection().revision,
          refreshedAt: "2026-08-02T00:00:00.000Z",
        },
      });
      const request = bridge(async (input) => {
        if (input.path === "/v1/reviews/detect-updates") return deferred;
        if (input.path === "/v1/reviews/direct-summary/submit")
          return {
            directSummary: {
              state: "confirmed",
              receipt: { reviewId: "9002", event: "COMMENT" },
            },
          };
        if (input.path === "/v1/reviews/refresh") return refreshed;
        throw new Error(input.path);
      });
      const { replace, patch } = mount(
        projection({ pendingReview: pending("none") as never }),
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Start a review" }));
      await user.click(
        screen.getByRole("button", { name: "Write review summary" }),
      );
      await user.type(
        screen.getByRole("textbox", { name: "Review summary" }),
        "Confirmed body",
      );
      await user.click(screen.getByRole("button", { name: "Submit review" }));
      await waitFor(() =>
        expect(
          within(screen.getByRole("dialog")).getByRole("status").textContent,
        ).toBe("Review summary #9002 was published to GitHub."),
      );
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/reviews/detect-updates",
          body: expect.objectContaining({
            recentWrites: [{ _tag: "DirectSummaryReview", reviewId: "9002" }],
          }),
        }),
      );
      const close = within(screen.getByRole("dialog"))
        .getAllByRole("button", { name: "Close" })
        .at(0);
      if (close === undefined) throw new Error("missing summary close button");
      await user.click(close);
      await user.click(screen.getByRole("button", { name: "PR overview" }));
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Refresh GitHub state",
        }),
      );
      await waitFor(() => expect(replace).toHaveBeenCalledWith(refreshed));
      observe(
        outcome === "Reconciled"
          ? { _tag: outcome, projection: refreshed }
          : outcome === "Terminal"
            ? { _tag: outcome, status: "merged" }
            : { _tag: outcome },
      );
      await Promise.resolve();
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it("keeps a confirmed direct-summary receipt visible before deferred observation", async () => {
    let observe!: (value: unknown) => void;
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return new Promise((resolve) => {
          observe = resolve;
        });
      if (input.path === "/v1/reviews/direct-summary/submit")
        return {
          directSummary: {
            state: "confirmed",
            receipt: { reviewId: "exact-receipt", event: "COMMENT" },
          },
        };
      throw new Error(input.path);
    });
    mount(projection({ pendingReview: pending("none") as never }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start a review" }));
    await user.click(
      screen.getByRole("button", { name: "Write review summary" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Review summary" }),
      "Body",
    );
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("status").textContent,
      ).toBe("Review summary #exact-receipt was published to GitHub."),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/reviews/detect-updates",
        body: expect.objectContaining({
          recentWrites: [
            { _tag: "DirectSummaryReview", reviewId: "exact-receipt" },
          ],
        }),
      }),
    );
    observe({ _tag: "Unavailable" });
  });

  it("sends a pending-review Start command with the represented anchor and revision", async () => {
    const nextPending = pending("pending");
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/pending-review/command")
        return { pendingReview: nextPending };
      throw new Error(input.path);
    });
    const { patch } = mount(
      projection({ pendingReview: pending("none") as never }),
    );
    const user = userEvent.setup();
    const composer = await openAddedLineComposer(user);
    await user.type(
      within(composer).getByRole("textbox", { name: "Inline comment" }),
      "Start with this finding",
    );
    await user.click(
      within(composer).getByRole("button", { name: "Start a review" }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/reviews/pending-review/command",
          body: {
            profileId: "profile",
            reviewId: "review-42",
            command: expect.objectContaining({
              _tag: "Start",
              expected: {
                sessionId: "session-a",
                headSha: sha,
                patchHash,
              },
              anchor: expect.objectContaining({
                path: "src/a.ts",
                side: "new",
              }),
              body: "Start with this finding",
            }),
          },
        }),
      ),
    );
    expect(patch).toHaveBeenCalledWith({ pendingReview: nextPending });
  });

  it("locks a Finding after its exact pending-review receipt is projected", async () => {
    const initial = withAnalysis("actionable");
    const projected = withAnalysis("pending_review");
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      if (input.path === "/v1/reviews/pending-review/command")
        return { pendingReview: pending("pending") };
      if (input.path === "/v1/reviews/load") return projected;
      throw new Error(input.path);
    });
    const { replace } = mount(initial);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Insights" }));
    await user.click(
      await screen.findByRole("button", { name: "Add to review" }),
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith(projected));
    const commandCall = request.mock.calls.find(
      ([input]) =>
        (input as { readonly path: string }).path ===
        "/v1/reviews/pending-review/command",
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
        ([input]) =>
          (input as { readonly path: string }).path ===
          "/v1/reviews/pending-review/command",
      ),
    ).toHaveLength(1);

    cleanup();
    mount(projected);
    await user.click(screen.getByRole("button", { name: "Insights" }));
    expect(await screen.findByText("pending review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
  });

  it("prefills only the Finish review summary from a Finding-backed Analysis", async () => {
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      throw new Error(input.path);
    });
    mount(withAnalysis("pending_review"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Insights" }));
    await user.click(
      await screen.findByRole("button", { name: "Finish review" }),
    );

    const summary = screen.getByRole("textbox", {
      name: "Final review summary",
    }) as HTMLTextAreaElement;
    expect(summary.value).toContain("# Review Scope");
    expect(summary.value).toContain(
      "The current change adds a guarded branch.",
    );
    expect(summary.value).toContain("# Verdict");
    expect(summary.value).not.toContain("# Findings");
    expect(summary.value).not.toContain("Missing boundary check");
    expect(summary.value).not.toContain(
      "Reject invalid values before this branch.",
    );
    expect(
      request.mock.calls.some(
        ([input]) =>
          (input as { readonly path: string }).path ===
          "/v1/reviews/pending-review/command",
      ),
    ).toBe(false);
  });

  it("pauses detection until all overlapping direct commands complete", async () => {
    vi.useFakeTimers();
    try {
      const commands: Array<(value: unknown) => void> = [];
      const request = bridge(async (input) => {
        if (input.path === "/v1/reviews/detect-updates")
          return { updatesAvailable: false };
        if (input.path === "/v1/reviews/inline-conversations/command")
          return await new Promise((resolve) => commands.push(resolve));
        throw new Error(input.path);
      });
      mount(projection());
      const detectCount = (): number =>
        request.mock.calls.filter(
          ([input]) =>
            (input as { readonly path: string }).path ===
            "/v1/reviews/detect-updates",
        ).length;
      await vi.advanceTimersByTimeAsync(0);
      expect(detectCount()).toBe(1);

      fireEvent.click(screen.getByRole("button", { name: "Diff" }));
      const firstAdd = screen
        .getAllByRole("button", { name: "Add comment on src/a.ts" })
        .at(0);
      if (firstAdd === undefined)
        throw new Error("missing first comment action");
      fireEvent.click(firstAdd);
      fireEvent.change(
        screen.getByRole("textbox", { name: "Inline comment" }),
        { target: { value: "First" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      await vi.advanceTimersByTimeAsync(0);

      const secondAdd = screen
        .getAllByRole("button", { name: "Add comment on src/a.ts" })
        .at(-1);
      if (secondAdd === undefined)
        throw new Error("missing second comment action");
      fireEvent.click(secondAdd);
      fireEvent.change(
        screen.getByRole("textbox", { name: "Inline comment" }),
        { target: { value: "Second" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(commands).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(90_000);
      expect(detectCount()).toBe(1);
      commands[0]?.({ _tag: "CommentCreated", commentId: "comment-1" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(detectCount()).toBe(1);
      commands[1]?.({ _tag: "CommentCreated", commentId: "comment-2" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(detectCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a malformed direct-comment receipt as an unconfirmed bounded failure", async () => {
    vi.useFakeTimers();
    try {
      const request = bridge(async (input) => {
        if (input.path === "/v1/reviews/detect-updates")
          return { updatesAvailable: false };
        if (input.path === "/v1/reviews/inline-conversations/command")
          return { _tag: "CommentCreated" };
        throw new Error(input.path);
      });
      mount(projection());
      await vi.advanceTimersByTimeAsync(0);
      fireEvent.click(screen.getByRole("button", { name: "Diff" }));
      const add = screen
        .getAllByRole("button", { name: "Add comment on src/a.ts" })
        .at(-1);
      if (add === undefined) throw new Error("missing comment action");
      fireEvent.click(add);
      fireEvent.change(
        screen.getByRole("textbox", { name: "Inline comment" }),
        { target: { value: "Unconfirmed body" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(90_000);
      expect(
        request.mock.calls.some(
          ([input]) =>
            (
              input as {
                readonly path: string;
                readonly body?: { readonly recentWrites?: unknown };
              }
            ).path === "/v1/reviews/detect-updates" &&
            (input as { readonly body?: { readonly recentWrites?: unknown } })
              .body?.recentWrites !== undefined,
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("locks unavailable pending state until explicit recovery reloads the Review", async () => {
    const reloaded = projection({ pendingReview: pending("none") as never });
    const request = bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : input.path === "/v1/reviews/pending-review/recover"
          ? { pendingReview: pending("none") }
          : input.path === "/v1/reviews/load"
            ? reloaded
            : Promise.reject(new Error(input.path)),
    );
    const { replace } = mount(
      projection({ pendingReview: pending("unavailable") as never }),
    );
    expect(
      document.querySelector("[data-review-pending-recovery]")?.textContent,
    ).toMatch(/pending review state is unavailable/i);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check GitHub again" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(reloaded));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/reviews/pending-review/recover",
        body: { profileId: "profile", reviewId: "review-42" },
      }),
    );
  });

  it("hides Review writes after a terminal remote state", () => {
    bridge(async () => ({ updatesAvailable: false }));
    mount(
      projection({
        review: { id: "review-42", status: "merged" },
        pendingReview: pending("pending") as never,
      }),
    );
    expect(screen.queryByRole("button", { name: "Start a review" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Refresh GitHub state" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Canonical workbench" }),
    ).toBeTruthy();
  });

  it("uses merge recovery alone for an uncertain merge", async () => {
    const uncertain = projection({
      mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
      mergeReasons: [
        { code: "outcome_unknown", message: "Merge outcome is unknown." },
      ] as never,
    });
    const request = bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : input.path === "/v1/reviews/merge"
          ? Promise.reject(new Error("unconfirmed"))
          : input.path === "/v1/reviews/merge/recover"
            ? projection()
            : Promise.reject(new Error(input.path)),
    );
    mount(uncertain);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await user.click(
      screen.getByRole("button", { name: "Check GitHub status" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/reviews/merge/recover",
          body: { profileId: "profile", reviewId: "review-42" },
        }),
      ),
    );
    expect(
      request.mock.calls.filter(
        ([call]) => (call as { path: string }).path === "/v1/reviews/merge",
      ),
    ).toHaveLength(1);
  });
});

// @vitest-environment jsdom
import {
  act,
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
import type * as PierreDiffs from "@pierre/diffs";

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real. Only tests that also shim `CSSStyleSheet.prototype.replaceSync` reach Pierre's CodeView path at all; every other test in this file renders through the accessible plain-text fallback, which never calls `preloadHighlighter`.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

const sha = "a".repeat(40);
const patchHash = "b".repeat(64);

// A deferred test-control Promise resolver: each call site resolves it with
// a differently-shaped mocked observation/detection payload, so `unknown`
// here is the honest type, not an unparsed I/O boundary value.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above
type DeferredResolve = (value: unknown) => void;

// `request.mock.calls` entries are `[requestInput, ...]` where the mocked
// `bridge()` is always invoked with `{ path, body? }`; these narrow the
// otherwise-untyped mock-call argument to read the fields most assertions
// below need. `body` stays `unknown` on the way out because each test's
// mocked request carries a differently-shaped body; that is fixture data
// this generic test helper cannot name, not an unparsed I/O boundary value.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above
function callPath(input: unknown): string | undefined {
  // SAFETY: `bridge()`'s mock request is always invoked with an object
  // carrying at least a `path` string; this narrows the untyped mock-call
  // argument to read it.
  return (input as { readonly path?: string } | undefined)?.path;
}
function callBody(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above callPath
  input: unknown,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above callPath
): unknown {
  // SAFETY: same invariant as `callPath` above; `body` is whatever the
  // calling code constructed for that request.
  return (input as { readonly body?: unknown } | undefined)?.body;
}

function projection(
  overrides: Partial<WorkbenchResponse> = {},
): WorkbenchResponse {
  // SAFETY: this literal matches the `WorkbenchResponse` wire shape the
  // flow under test parses via `parseWorkbenchResponse`; it is fixture
  // data, not a runtime-decoded value.
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
      // SAFETY: `patchHash` is a branded hex-digest fixture; `as never`
      // widens the plain fixture string into the branded PatchHash type.
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
  onNavigationStateChange: ReturnType<typeof vi.fn> = vi.fn(),
) {
  const replace = callbacks.replace ?? vi.fn();
  const patch = callbacks.patch ?? vi.fn();
  const view = render(
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={replace}
      onWorkbenchPatch={patch}
      onNavigationStateChange={onNavigationStateChange}
      onNavigate={vi.fn()}
    />,
  );
  return { replace, patch, view };
}

// This generic mocked bridge harness intentionally has no fixed response
// shape: each test's own `handler` decides the JSON per request path, so
// the echoed value is legitimately whatever that test needs it to be, not
// a domain type this file could name.
type BridgeHandler = (input: {
  readonly path: string;
  readonly body?: unknown;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above
}) => Promise<unknown> | unknown;

function bridge(handler: BridgeHandler) {
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
  mappingStatus: "mapped" | "invalid_line" = "mapped",
): WorkbenchResponse {
  // SAFETY: `analysisReviewActions`/`pendingReview` here are wider fixture
  // shapes than the strict unions `projection()`'s parameter type expects;
  // this is fixture data, not a runtime-decoded value.
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
          value: {
            ...analysisResult,
            findings: analysisResult.findings.map((finding) => ({
              ...finding,
              mappingStatus,
            })),
          },
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
      let observe!: DeferredResolve;
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
      // SAFETY: `pending("none")` returns a wider fixture shape than the
      // strict `pendingReview` union; this is test fixture data, not a
      // runtime-decoded value.
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
    let observe!: DeferredResolve;
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
    // SAFETY: `pending("none")` returns a wider fixture shape than the
    // strict `pendingReview` union; this is test fixture data, not a
    // runtime-decoded value.
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
    // SAFETY: `pending("none")` returns a wider fixture shape than the
    // strict `pendingReview` union; this is test fixture data, not a
    // runtime-decoded value.
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

  it("hides Add to review for a Finding whose location is not on the diff", async () => {
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      throw new Error(input.path);
    });
    mount(withAnalysis("actionable", "invalid_line"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Insights" }));
    await screen.findByText("Missing boundary check");
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
  });

  it("reports write_pending while a pending-review command is in flight", async () => {
    const navigation = vi.fn();
    let release: DeferredResolve = () => undefined;
    const gate = new Promise((done) => {
      release = done;
    });
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      if (input.path === "/v1/reviews/pending-review/command")
        return await gate;
      throw new Error(input.path);
    });
    mount(withAnalysis("actionable"), {}, navigation);
    const user = userEvent.setup();
    const composer = await openAddedLineComposer(user);
    await user.type(
      within(composer).getByRole("textbox", { name: "Inline comment" }),
      "Hanging write",
    );
    await user.click(
      within(composer).getByRole("button", { name: "Start a review" }),
    );
    await waitFor(() =>
      expect(navigation).toHaveBeenCalledWith("write_pending"),
    );
    release({ pendingReview: pending("pending") });
    await waitFor(() =>
      expect(navigation).toHaveBeenCalledWith("clear"),
    );
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
        callPath(input) ===
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
          callPath(input) ===
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

    // SAFETY: the "Final review summary" textbox role is only rendered by a
    // real <textarea>, so this narrows the generic HTMLElement accessor.
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
          callPath(input) ===
          "/v1/reviews/pending-review/command",
      ),
    ).toBe(false);
  });

  it("rejects a detector response from a replaced snapshot", async () => {
    let resolveDetection!: DeferredResolve;
    const detection = new Promise<unknown>((resolve) => {
      resolveDetection = resolve;
    });
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates") return detection;
      throw new Error(input.path);
    });
    const patch = vi.fn();
    const replace = vi.fn();
    const rendered = mount(projection(), { patch, replace });
    const newer = projection({
      session: { ...projection().session, id: "session-b" },
    });
    rendered.view.rerender(
      <ReviewWorkbenchFlow
        workbench={newer}
        onWorkbenchReplace={replace}
        onWorkbenchPatch={patch}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await act(async () => {
      resolveDetection({ _tag: "RevisionChanged" });
      await detection;
    });
    expect(patch).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("coalesces focus and visibility events while detection is active", async () => {
    vi.useFakeTimers();
    try {
      const detection = new Promise<unknown>(() => undefined);
      const request = bridge(async (input) => {
        if (input.path === "/v1/reviews/detect-updates") return detection;
        throw new Error(input.path);
      });
      mount(projection());
      fireEvent.focus(window);
      fireEvent(document, new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(500);
      expect(
        request.mock.calls.filter(
          ([input]) =>
            callPath(input) ===
            "/v1/reviews/detect-updates",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a same-generation result to the latest committed callback", async () => {
    let resolveDetection!: DeferredResolve;
    const detection = new Promise<unknown>((resolve) => {
      resolveDetection = resolve;
    });
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates") return detection;
      throw new Error(input.path);
    });
    const firstPatch = vi.fn();
    const secondPatch = vi.fn();
    const rendered = mount(projection(), { patch: firstPatch });
    rendered.view.rerender(
      <ReviewWorkbenchFlow
        workbench={projection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={secondPatch}
        onNavigationStateChange={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await act(async () => {
      resolveDetection({ _tag: "RevisionChanged" });
      await detection;
    });
    expect(firstPatch).not.toHaveBeenCalled();
    expect(secondPatch).toHaveBeenCalledWith({
      revision: { ...projection().revision, freshness: "updates_available" },
    });
  });

  it("clears scheduled detection and ignores its late response after unmount", async () => {
    vi.useFakeTimers();
    try {
      let resolveDetection!: DeferredResolve;
      const detection = new Promise<unknown>((resolve) => {
        resolveDetection = resolve;
      });
      bridge(async (input) => {
        if (input.path === "/v1/reviews/detect-updates") return detection;
        throw new Error(input.path);
      });
      const patch = vi.fn();
      const { view } = mount(projection(), { patch });
      view.unmount();
      await vi.advanceTimersByTimeAsync(90_000);
      await act(async () => {
        resolveDetection({ _tag: "RevisionChanged" });
        await detection;
      });
      expect(patch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("pauses detection until all overlapping direct commands complete", async () => {
    vi.useFakeTimers();
    try {
      const commands: Array<DeferredResolve> = [];
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
            callPath(input) ===
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
        request.mock.calls.some(([input]) => {
          // SAFETY: `callBody` already narrows to `{ body?: unknown }`; a
          // second narrow here only reads its optional `recentWrites` key.
          const body = callBody(input) as
            | { readonly recentWrites?: unknown }
            | undefined;
          return (
            callPath(input) === "/v1/reviews/detect-updates" &&
            body?.recentWrites !== undefined
          );
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // These two tests need Pierre's CodeView path (not the accessible
  // plain-text fallback every other test in this file renders through)
  // because only a rendered `ConversationThreadCard` proves whether
  // `saveInlineComment`'s resolved threadId reached the card. CodeView needs
  // real timers for its own async mount, so — unlike the rest of this
  // file — these two do not use fake timers.
  it("upgrades a created comment's card to full controls when the receipt confirms a threadId", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      styleSheet?.value !== undefined &&
      styleSheet.value.prototype.replaceSync === undefined
    ) {
      styleSheet.value.prototype.replaceSync = () => undefined;
    }
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
    try {
      bridge(async (input) => {
        if (input.path === "/v1/reviews/detect-updates")
          return { updatesAvailable: false };
        if (input.path === "/v1/reviews/inline-conversations/command")
          return {
            _tag: "CommentCreated",
            commentId: "comment-1",
            threadId: "thread-1",
          };
        throw new Error(input.path);
      });
      const user = userEvent.setup();
      mount(projection());
      fireEvent.click(screen.getByRole("button", { name: "Diff" }));
      const authorButtons = await screen.findAllByRole("button", {
        name: "Add comment on src/a.ts",
      });
      const commentButton = authorButtons.at(-1);
      if (commentButton === undefined)
        throw new Error("missing comment action");
      commentButton.dataset.lineNumber = "1";
      commentButton.dataset.lineSide = "additions";
      await user.click(commentButton);
      await user.type(
        screen.getByRole("textbox", { name: "Inline comment" }),
        "Confirmed body",
      );
      await user.click(screen.getByRole("button", { name: "Comment" }));
      // The confirmed threadId reaches the card in the same round trip: no
      // separate refresh is needed, and the fallback copy never appears.
      expect(
        await screen.findByRole("textbox", { name: "Reply" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
      expect(
        screen.queryByText(/Reply and Resolve aren.t available/i),
      ).toBeNull();
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });

  it("leaves a created comment's card comment-only when the receipt omits threadId", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      styleSheet?.value !== undefined &&
      styleSheet.value.prototype.replaceSync === undefined
    ) {
      styleSheet.value.prototype.replaceSync = () => undefined;
    }
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
    try {
      bridge(async (input) => {
        if (input.path === "/v1/reviews/detect-updates")
          return { updatesAvailable: false };
        if (input.path === "/v1/reviews/inline-conversations/command")
          return { _tag: "CommentCreated", commentId: "comment-1" };
        throw new Error(input.path);
      });
      const user = userEvent.setup();
      mount(projection());
      fireEvent.click(screen.getByRole("button", { name: "Diff" }));
      const authorButtons = await screen.findAllByRole("button", {
        name: "Add comment on src/a.ts",
      });
      const commentButton = authorButtons.at(-1);
      if (commentButton === undefined)
        throw new Error("missing comment action");
      commentButton.dataset.lineNumber = "1";
      commentButton.dataset.lineSide = "additions";
      await user.click(commentButton);
      await user.type(
        screen.getByRole("textbox", { name: "Inline comment" }),
        "Unresolved body",
      );
      await user.click(screen.getByRole("button", { name: "Comment" }));
      // No threadId was confirmed: the flow never synthesizes one, so the
      // card stays comment-only and explains why.
      expect(
        await screen.findByText(/Reply and Resolve aren.t available/i),
      ).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });

  it("journals a Reply issued from the Conversation tab so detect-updates carries it forward", async () => {
    vi.useFakeTimers();
    try {
      const request = bridge(async (input) => {
        if (input.path === "/v1/reviews/detect-updates")
          return { updatesAvailable: false };
        if (input.path === "/v1/reviews/inline-conversations/command")
          return { _tag: "ReplyCreated", commentId: "comment-general-1" };
        throw new Error(input.path);
      });
      // SAFETY: this `conversation` override matches the `GeneralThread`
      // wire shape the flow parses via `parseWorkbenchResponse`; it is
      // fixture data, not a runtime-decoded value.
      mount(
        projection({
          conversation: {
            prDescription: "",
            entries: [
              {
                _tag: "GeneralThread",
                thread: {
                  id: "thread-general-1",
                  state: "open",
                  complete: true,
                  comments: [
                    {
                      id: "c-general-1",
                      author: "reviewer",
                      body: "A general PR comment.",
                      createdAt: "2026-08-01T00:00:00.000Z",
                      viewerDidAuthor: true,
                    },
                  ],
                },
              },
            ],
          },
        } as never),
      );
      await vi.advanceTimersByTimeAsync(0);
      // The Conversation tab is not the default tab; select it explicitly.
      fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
        target: { value: "A general reply" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      await vi.advanceTimersByTimeAsync(0);

      expect(
        request.mock.calls.some(([input]) => {
          // SAFETY: `bridge()`'s mock request is always invoked with an
          // object shaped `{ path, body? }`; this narrows the untyped
          // mock-call argument to read the direct-command fields this
          // assertion needs.
          const typed = input as {
            readonly path: string;
            readonly body?: {
              readonly command?: {
                readonly _tag?: string;
                readonly threadId?: string;
              };
            };
          };
          return (
            typed.path === "/v1/reviews/inline-conversations/command" &&
            typed.body?.command?._tag === "Reply" &&
            typed.body.command.threadId === "thread-general-1"
          );
        }),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(90_000);
      expect(
        request.mock.calls.some(([input]) => {
          // SAFETY: same invariant as the `typed` narrow above; this reads
          // the `recentWrites` journal field a detect-updates request body
          // may carry.
          const typed = input as {
            readonly path: string;
            readonly body?: {
              readonly recentWrites?: ReadonlyArray<{
                readonly _tag?: string;
                readonly commentId?: string;
              }>;
            };
          };
          return (
            typed.path === "/v1/reviews/detect-updates" &&
            (typed.body?.recentWrites ?? []).some(
              (write) =>
                write._tag === "Comment" &&
                write.commentId === "comment-general-1",
            )
          );
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("locks unavailable pending state until explicit recovery reloads the Review", async () => {
    // SAFETY: `pending(...)` returns a wider fixture shape than the strict
    // `pendingReview` union; this is test fixture data, not a
    // runtime-decoded value.
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
    // SAFETY: `pending(...)` returns a wider fixture shape than the strict
    // `pendingReview` union; this is test fixture data, not a
    // runtime-decoded value.
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
    // SAFETY: `pending(...)` returns a wider fixture shape than the strict
    // `pendingReview` union; this is test fixture data, not a
    // runtime-decoded value.
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
    // SAFETY: `mergeReasons` here is a wider fixture shape than the strict
    // union `projection()`'s parameter type expects; this is fixture data,
    // not a runtime-decoded value.
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
        ([call]) => callPath(call) === "/v1/reviews/merge",
      ),
    ).toHaveLength(1);
  });
});

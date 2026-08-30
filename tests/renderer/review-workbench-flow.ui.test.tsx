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
import type * as PierreDiffs from "@pierre/diffs";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import {
  callBody,
  callPath,
  pending,
  projection,
  providerCatalog,
  withAnalysis,
  type DeferredResolve,
} from "./review-workbench-fixtures";

/**
 * What `ReviewWorkbenchFlow` does that its hooks cannot see themselves: which
 * projection each screen renders, and that every writer on the screen is
 * handed the `runDirectCommand` gate `useReviewObservation` returns. The
 * state machines behind those hooks are argued directly in
 * `use-review-observation.test.ts`, `use-pending-review-actions.test.ts`, and
 * `use-direct-summary-actions.test.ts`; a hook test supplies its own adapters,
 * so it can never observe the wiring below.
 */

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real. Only tests that also shim `CSSStyleSheet.prototype.replaceSync` reach Pierre's CodeView path at all; every other test in this file renders through the accessible plain-text fallback, which never calls `preloadHighlighter`.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

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
    />,
  );
  return { replace, patch, view };
}

/**
 * Opening the inline comment composer selects its line, which scrolls
 * Pierre's CodeView to it. That scroll suspends pointer events on the
 * CodeView's sticky container for a real, un-fakeable
 * `DEFAULT_SCROLL_INTERACTION_RESTORE_DELAY_MS` (120ms — see
 * `suspendScrollInteractions`/`restoreScrollInteractions` in
 * `@pierre/diffs/dist/components/CodeView.js`) so hover/click interactions
 * do not land mid-scroll. `user.type` focuses its target with a click
 * first, and userEvent's pointer-events check throws while that suspension
 * is still in effect. Retry the focusing click — rather than guess how
 * long the suspension lasts — until Pierre lifts it, then type without
 * clicking again.
 */
async function typePastPierreScrollSuspend(
  user: ReturnType<typeof userEvent.setup>,
  element: HTMLElement,
  text: string,
): Promise<void> {
  await waitFor(() => user.click(element));
  await user.type(element, text, { skipClick: true });
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  restoreBridge();
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
  it("opens PR overview from either colored status button", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    mount(
      projection({
        mergeReadiness: { _tag: "Blocked", blockers: [], warnings: [] },
      }),
    );
    const checks = screen.getByRole("button", {
      name: "Open PR overview: checks passing",
    });
    const merge = screen.getByRole("button", {
      name: "Open PR overview: merge blocked",
    });
    expect(checks.className).toContain("text-status-success");
    expect(merge.className).toContain("text-destructive");
    expect(screen.queryByRole("button", { name: "PR overview" })).toBeNull();

    const user = userEvent.setup();
    await user.click(checks);
    expect(screen.getByRole("dialog", { name: "PR overview" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "PR overview" })).toBeNull(),
    );
    await user.click(merge);
    expect(screen.getByRole("dialog", { name: "PR overview" })).toBeTruthy();
  });

  it("shows why the Review is metadata-only when local checkout preparation fails", () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    const metadataOnly = projection({
      localCheckout: {
        state: "metadata_only",
        message:
          "The local checkout could not be prepared. This Review uses the GitHub snapshot; local file expansion and commit inspection are unavailable.",
      },
    });
    mount(metadataOnly);
    expect(
      screen
        .getByText(
          "The local checkout could not be prepared. This Review uses the GitHub snapshot; local file expansion and commit inspection are unavailable.",
        )
        .getAttribute("data-review-local-checkout-warning"),
    ).toBe("true");
  });

  it("renders real GitHub label chips in the Conversation rail's Labels section when the pull request carries labels", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    const basePullRequest = projection().pullRequest;
    if (basePullRequest === undefined) throw new Error("fixture");
    const labeled = projection({
      pullRequest: {
        ...basePullRequest,
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "enhancement", color: "a2eeef" },
        ],
      },
    });
    mount(labeled);
    expect(
      screen.getByRole("heading", { name: "Canonical workbench" }),
    ).toBeTruthy();
    // The rail only renders inside the Conversation tab's content (it is
    // never rendered on Diff, the tab this flow defaults to).
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Conversation" }));
    expect(
      screen.getByRole("complementary", { name: "Pull request metadata" }),
    ).toBeTruthy();
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("enhancement")).toBeTruthy();
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
      .click(screen.getByRole("button", { name: "Refresh GitHub state" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(refreshed));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/reviews/refresh",
        body: { profileId: "profile", reviewId: "review-42" },
      }),
    );
  });

  it("reconciles merge readiness after approving a pending review", async () => {
    let detectCalls = 0;
    // SAFETY: `pending("pending")` returns a wider fixture shape than the
    // strict `pendingReview` union; this is test fixture data, not a
    // runtime-decoded value.
    const initial = projection({ pendingReview: pending("pending") as never });
    // SAFETY: `pending("none")` returns a wider fixture shape than the
    // strict `pendingReview` union; this is test fixture data, not a
    // runtime-decoded value.
    const reconciled = projection({
      pendingReview: pending("none") as never,
      mergeReadiness: {
        _tag: "Ready",
        blockers: [],
        warnings: [],
      },
    });
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates") {
        detectCalls += 1;
        return detectCalls === 1
          ? { updatesAvailable: false }
          : { _tag: "Reconciled", projection: reconciled };
      }
      if (input.path === "/v1/reviews/pending-review/command")
        return { pendingReview: pending("none") };
      throw new Error(input.path);
    });
    const { replace } = mount(initial);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Finish review/ }));
    await user.click(screen.getByRole("combobox", { name: "Review decision" }));
    await user.click(await screen.findByRole("option", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith(reconciled));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/reviews/pending-review/command",
        body: expect.objectContaining({
          command: expect.objectContaining({
            _tag: "Submit",
            event: "APPROVE",
          }),
        }),
      }),
    );
  });

  it("opens the review-summary dialog directly from Start a review", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    // SAFETY: `pending("none")` returns a wider fixture shape than the
    // strict `pendingReview` union; this is test fixture data, not a
    // runtime-decoded value.
    mount(projection({ pendingReview: pending("none") as never }));

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Start a review" }));

    expect(
      screen.getByRole("textbox", { name: "Review summary" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add inline comment" }),
    ).toBeNull();
  });

  /**
   * The one wiring proof no hook test can make: `useReviewObservation` returns
   * `runDirectCommand`, and `ReviewWorkbenchFlow` must hand it to every writer
   * on the screen (`review-workbench-flow.tsx`). A `renderHook` test supplies
   * its own `runDirectCommand`, so it cannot see whether a given writer got
   * the real one. Each row below is a different writer whose request must not
   * leave while a detection is still in flight; the hook test
   * "holds a direct command until the in-flight detection completes" owns the
   * gate's own behaviour.
   */
  const gatedWriters = [
    {
      name: "a review summary",
      workbench: (): WorkbenchResponse =>
        // SAFETY: `pending("none")` returns a wider fixture shape than the
        // strict `pendingReview` union; this is test fixture data, not a
        // runtime-decoded value.
        projection({ pendingReview: pending("none") as never }),
      path: "/v1/reviews/direct-summary/submit",
      answer: {
        directSummary: {
          state: "confirmed",
          receipt: { reviewId: "9002", event: "COMMENT" },
        },
      },
      write: (): void => {
        fireEvent.click(screen.getByRole("button", { name: "Start a review" }));
        fireEvent.change(
          screen.getByRole("textbox", { name: "Review summary" }),
          { target: { value: "Current review" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Submit review" }));
      },
    },
    {
      name: "a merge",
      workbench: (): WorkbenchResponse => projection(),
      path: "/v1/reviews/merge",
      answer: undefined,
      write: (): void => {
        fireEvent.click(screen.getByRole("button", { name: "Merge" }));
      },
    },
    {
      name: "an Analysis Finding added to review",
      workbench: (): WorkbenchResponse => withAnalysis("actionable"),
      path: "/v1/reviews/pending-review/command",
      answer: {},
      write: (): void => {
        fireEvent.click(screen.getByRole("button", { name: "Insights" }));
        fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
      },
    },
    {
      name: "an inline comment",
      workbench: (): WorkbenchResponse => projection(),
      path: "/v1/reviews/inline-conversations/command",
      answer: { _tag: "CommentCreated", commentId: "comment-1" },
      write: (): void => {
        fireEvent.click(screen.getByRole("button", { name: "Diff" }));
        const add = screen
          .getAllByRole("button", { name: "Add comment on src/a.ts" })
          .at(-1);
        if (add === undefined) throw new Error("missing comment action");
        fireEvent.click(add);
        fireEvent.change(
          screen.getByRole("textbox", { name: "Inline comment" }),
          { target: { value: "Current comment" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      },
    },
  ];

  it.each(gatedWriters)(
    "holds $name until the active detection completes",
    async ({ workbench, path, answer, write }) => {
      vi.useFakeTimers();
      try {
        let resolveDetection: DeferredResolve = () => undefined;
        const detection = new Promise<unknown>((resolve) => {
          resolveDetection = resolve;
        });
        const request = bridge(async (input) => {
          if (input.path === "/v1/reviews/detect-updates") return detection;
          if (input.path === path) return answer;
          if (input.path === "/v1/insight-providers") return providerCatalog;
          if (input.path === "/v1/reviews/load") return projection();
          throw new Error(input.path);
        });
        mount(workbench());
        await vi.advanceTimersByTimeAsync(0);
        const writes = (): number =>
          request.mock.calls.filter(([input]) => callPath(input) === path)
            .length;

        write();
        await vi.advanceTimersByTimeAsync(0);
        expect(writes()).toBe(0);

        resolveDetection({ updatesAvailable: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(writes()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("opens the Analysis run dialog with the default set in Settings", async () => {
    // Settings and the run dialog now share one storage key
    // (`insight-run-preferences`, type "analysis"); this seeds it exactly as
    // `ReviewPreferences` in settings-flow.tsx would, to prove the run
    // dialog actually opens with that saved default instead of the
    // hardcoded pi/medium fallback.
    localStorage.setItem(
      "patchdesk.insight-run.v1.analysis.profile",
      JSON.stringify({
        provider: "pi",
        model: "settings-model",
        reasoning: "high",
      }),
    );
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers")
        return {
          ...providerCatalog,
          models: [
            ...providerCatalog.models,
            {
              provider: "pi",
              id: "settings-model",
              label: "Settings model",
              reasoning: ["medium", "high"],
              defaultReasoning: "medium",
            },
          ],
        };
      throw new Error(input.path);
    });
    mount(projection());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Insights" }));
    await user.click(
      await screen.findByRole("button", { name: "Generate analysis" }),
    );

    const model = await screen.findByRole("combobox", {
      name: "Insight model",
    });
    // SAFETY: `ModelCombobox` renders its trigger as a plain text input; the
    // accessible-name query above only matches that element.
    expect((model as HTMLInputElement).value).toBe("Settings model");
    const reasoning = screen.getByRole("combobox", {
      name: "Insight reasoning",
    });
    expect(reasoning).not.toBeInstanceOf(HTMLSelectElement);
    expect(reasoning.getAttribute("data-slot")).toBe("select-trigger");
    expect(reasoning.textContent).toContain("high");
    reasoning.focus();
    await user.keyboard("{Enter}");
    expect(
      screen
        .getByRole("option", { name: "high" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("selects the saved preference's Codex model after activation, not the first one", async () => {
    // Regression for a bug where `activateCodex` always picked
    // `codexModels[0]` and ignored a saved preference, unlike
    // `changeProvider`'s precedence for the Pi provider above.
    localStorage.setItem(
      "patchdesk.insight-run.v1.analysis.profile",
      JSON.stringify({
        provider: "codex-cli-account",
        model: "codex/preferred",
        reasoning: "high",
      }),
    );
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      if (input.path === "/v1/insight-providers/codex/models")
        return {
          providers: [
            {
              id: "codex-cli-account",
              label: "Codex CLI account",
              available: true,
              guidance: "Use the existing local Codex CLI login.",
            },
          ],
          models: [
            {
              provider: "codex-cli-account",
              id: "codex/first",
              label: "Codex First",
              reasoning: ["medium", "high"],
              defaultReasoning: "medium",
            },
            {
              provider: "codex-cli-account",
              id: "codex/preferred",
              label: "Codex Preferred",
              reasoning: ["medium", "high"],
              defaultReasoning: "medium",
            },
          ],
        };
      throw new Error(input.path);
    });
    mount(projection());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Insights" }));
    await user.click(
      await screen.findByRole("button", { name: "Generate analysis" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Load Codex models" }),
    );

    const model = await screen.findByRole("combobox", {
      name: "Insight model",
    });
    // SAFETY: `ModelCombobox` renders its trigger as a plain text input; the
    // accessible-name query above only matches that element.
    expect((model as HTMLInputElement).value).toBe("Codex Preferred");
    const reasoning = screen.getByRole("combobox", {
      name: "Insight reasoning",
    });
    expect(reasoning).not.toBeInstanceOf(HTMLSelectElement);
    expect(reasoning.getAttribute("data-slot")).toBe("select-trigger");
    expect(reasoning.textContent).toContain("high");
    reasoning.focus();
    await user.keyboard("{Enter}");
    expect(
      screen
        .getByRole("option", { name: "high" })
        .getAttribute("aria-selected"),
    ).toBe("true");
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
    await waitFor(() => expect(navigation).toHaveBeenCalledWith("clear"));
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
        ([input]) => callPath(input) === "/v1/reviews/pending-review/command",
      ),
    ).toBe(false);
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
      await typePastPierreScrollSuspend(
        user,
        screen.getByRole("textbox", { name: "Inline comment" }),
        "Confirmed body",
      );
      // Typing can itself grow the composer and re-trigger Pierre's layout,
      // restarting the same scroll-interaction suspension described above.
      // Retry the submit click for the same reason as the focusing click.
      await waitFor(() =>
        user.click(screen.getByRole("button", { name: "Comment" })),
      );
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
      await typePastPierreScrollSuspend(
        user,
        screen.getByRole("textbox", { name: "Inline comment" }),
        "Unresolved body",
      );
      // Typing can itself grow the composer and re-trigger Pierre's layout,
      // restarting the same scroll-interaction suspension described above.
      // Retry the submit click for the same reason as the focusing click.
      await waitFor(() =>
        user.click(screen.getByRole("button", { name: "Comment" })),
      );
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

  it("shows the pending-review recovery banner while the pending state is unavailable", () => {
    bridge(async () => ({ updatesAvailable: false }));
    // SAFETY: `pending(...)` returns a wider fixture shape than the strict
    // `pendingReview` union; this is test fixture data, not a runtime-decoded
    // value.
    mount(projection({ pendingReview: pending("unavailable") as never }));
    // `usePendingReviewActions` decides what recovery does (see
    // `use-pending-review-actions.test.ts`); only a mounted Review shows that
    // the header renders the lock and its one recovery control.
    expect(
      document.querySelector("[data-review-pending-recovery]")?.textContent,
    ).toMatch(/pending review state is unavailable/i);
    expect(
      screen.getByRole("button", { name: "Check GitHub again" }),
    ).toBeTruthy();
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
      screen.getByText(
        "Pull request merged on GitHub. This Review remains readable.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Merge · Merged")).toBeTruthy();
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

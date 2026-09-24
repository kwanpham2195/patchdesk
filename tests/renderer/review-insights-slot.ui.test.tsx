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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { DesktopResponse } from "../../src/main/ipc-contract";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { InsightsSlot } from "../../src/renderer/src/components/review-insights-slot";
import {
  ReviewWorkbenchFindingNavigationContext,
  type FindingFocusRequest,
} from "../../src/renderer/src/components/review-workbench-finding-navigation";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import {
  briefInsight,
  projection,
  providerCatalog,
  withAnalysis,
  withWalkthrough,
} from "./review-workbench-fixtures";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function json(value: typeof providerCatalog): RawJsonValue {
  // SAFETY: these renderer fixtures contain only JSON-compatible records.
  return structuredClone(value) as RawJsonValue;
}

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  desktop?.restore();
  desktop = undefined;
  window.localStorage.clear();
});

function renderInsights(
  workbench = projection(),
  initialDetail?: "analysis" | "walkthrough",
): void {
  render(
    <InsightsSlot
      workbench={workbench}
      {...(initialDetail === undefined ? {} : { initialDetail })}
      onWorkbenchReplace={() => undefined}
      onWorkbenchPatch={() => undefined}
      onReprepare={async () => workbench}
    />,
  );
}

describe("InsightsSlot reading order", () => {
  it("lists the three Insights and lands on the one with a result", () => {
    renderInsights(withAnalysis("actionable"));

    const rail = within(
      screen.getByRole("navigation", { name: "Insight navigation" }),
    );
    expect(rail.getAllByRole("tab")).toHaveLength(3);
    expect(rail.queryByRole("tab", { name: /^Overview/ })).toBeNull();
    expect(rail.getByRole("tab", { selected: true }).textContent).toMatch(
      /^Analysis/,
    );
  });
});

describe("InsightsSlot finding focus", () => {
  function renderWithFindingFocus(request: FindingFocusRequest | undefined) {
    return (
      <ReviewWorkbenchFindingNavigationContext.Provider
        value={{
          openFindingInDiff: () => undefined,
          findingFocusRequest: request,
        }}
      >
        <InsightsSlot
          workbench={withAnalysis("actionable")}
          initialDetail="walkthrough"
          onWorkbenchReplace={() => undefined}
          onWorkbenchPatch={() => undefined}
          onReprepare={async () => withAnalysis("actionable")}
        />
      </ReviewWorkbenchFindingNavigationContext.Provider>
    );
  }
  function selectedRailItem(): string | undefined {
    return screen.getByRole("tab", { selected: true }).textContent;
  }

  it("honours a focus request once so the sub-nav can leave Analysis", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      renderWithFindingFocus({ findingId: "finding-1", token: 1 }),
    );
    expect(selectedRailItem()).toMatch(/^Analysis/);

    await user.click(screen.getByRole("tab", { name: /^Brief/ }));
    expect(selectedRailItem()).toMatch(/^Brief/);

    rerender(renderWithFindingFocus({ findingId: "finding-1", token: 2 }));
    expect(selectedRailItem()).toMatch(/^Analysis/);
  });
});

describe("InsightsSlot empty states", () => {
  const emptyInsights = [
    {
      type: "brief",
      tabName: /^Brief/,
      action: "Generate brief",
      dialogTitle: "Run Brief",
    },
    {
      type: "walkthrough",
      tabName: /^Walkthrough/,
      action: "Generate walkthrough",
      dialogTitle: "Run Walkthrough",
    },
    {
      type: "analysis",
      tabName: /^Analysis/,
      action: "Generate analysis",
      dialogTitle: "Run Analysis",
    },
  ] as const;

  for (const emptyInsight of emptyInsights) {
    it(`uses the shared empty state and action for ${emptyInsight.type}`, async () => {
      desktop = installDesktopDouble({
        "/v1/insight-providers": () => success(json(providerCatalog)),
      });
      const user = userEvent.setup();
      renderInsights();

      await user.click(screen.getByRole("tab", { name: emptyInsight.tabName }));
      await user.click(
        await screen.findByRole("button", { name: emptyInsight.action }),
      );
      expect(
        screen.getByRole("heading", { name: emptyInsight.dialogTitle }),
      ).toBeTruthy();
    });
  }
});

// The header's Merge chip states a Review is merged or closed, so the Insights tab no longer repeats it (#348).
const REMOVED_TERMINAL_REASON =
  /merged or closed; Insights cannot be generated/;

describe("InsightsSlot on a merged Review", () => {
  it("draws no Generate button and no terminal reason line on each empty Insight", async () => {
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
    });
    const user = userEvent.setup();
    renderInsights(
      projection({ review: { id: "review-42", status: "merged" } }),
    );

    for (const [tab, action] of [
      [/^Brief/, "Generate brief"],
      [/^Walkthrough/, "Generate walkthrough"],
      [/^Analysis/, "Generate analysis"],
    ] as const) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(screen.queryByText(REMOVED_TERMINAL_REASON)).toBeNull();
      expect(screen.queryByRole("button", { name: action })).toBeNull();
    }
  });

  it("hides both Brief Regenerate controls and draws no terminal reason line", () => {
    renderInsights(
      projection({
        review: { id: "review-42", status: "closed" },
        insights: {
          analysis: { status: "not_generated" },
          walkthrough: { status: "not_generated" },
          brief: briefInsight(),
        },
      }),
    );

    expect(screen.getByRole("region", { name: "Provenance" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(screen.queryByText(REMOVED_TERMINAL_REASON)).toBeNull();
  });

  it.each([
    { status: "open", offersRun: true },
    { status: "closed", offersRun: false },
    { status: "merged", offersRun: false },
  ] as const)(
    "offers Try again and Start here's Generate walkthrough on a $status Review: $offersRun",
    async ({ status, offersRun }) => {
      const user = userEvent.setup();
      const retainedBrief = briefInsight().retained;
      if (retainedBrief === undefined)
        throw new Error("Brief fixture lost its retained result");
      renderInsights(
        projection({
          review: { id: "review-42", status },
          insights: {
            analysis: { status: "failed" },
            walkthrough: { status: "not_generated" },
            brief: briefInsight({
              retained: {
                ...retainedBrief,
                value: {
                  ...retainedBrief.value,
                  startHere: {
                    lead: "Read the writer first.",
                    order: [{ path: "src/a.ts" }],
                  },
                },
              },
            }),
          },
        }),
      );

      expect(
        screen.queryByRole("button", { name: "Generate walkthrough" }) !== null,
      ).toBe(offersRun);
      await user.click(screen.getByRole("tab", { name: /^Analysis/ }));
      expect(screen.queryByRole("button", { name: "Try again" }) !== null).toBe(
        offersRun,
      );
    },
  );

  it.each(["open", "closed"] as const)(
    "offers Run for latest revision on an outdated Brief of a %s Review only when open",
    (status) => {
      renderInsights(
        projection({
          review: { id: "review-42", status },
          insights: {
            analysis: { status: "not_generated" },
            walkthrough: { status: "not_generated" },
            brief: briefInsight({ status: "outdated" }),
          },
        }),
      );

      expect(
        screen.queryByRole("button", { name: "Run for latest revision" }) !==
          null,
      ).toBe(status === "open");
    },
  );

  it.each([
    { status: "open", offersActions: true },
    { status: "closed", offersActions: false },
    { status: "merged", offersActions: false },
  ] as const)(
    "offers Add, Add all, and Dismiss on a saved Analysis finding of a $status Review: $offersActions",
    ({ status, offersActions }) => {
      const workbench = withAnalysis("actionable");
      render(
        <InsightsSlot
          workbench={{ ...workbench, review: { ...workbench.review, status } }}
          initialDetail="analysis"
          onWorkbenchReplace={() => undefined}
          onWorkbenchPatch={() => undefined}
          onReprepare={async () => workbench}
          onAddFinding={async () => undefined}
          addAllFindings={{
            progress: undefined,
            addAll: async () => ({ _tag: "completed" }),
            stop: () => undefined,
          }}
        />,
      );

      for (const name of ["Add to review", "Add all to review", "Dismiss"]) {
        expect(screen.queryByRole("button", { name }) !== null).toBe(
          offersActions,
        );
      }
    },
  );

  it.each([
    { status: "open", offersMark: true },
    { status: "closed", offersMark: false },
    { status: "merged", offersMark: false },
  ] as const)(
    "offers Mark section reviewed on a Walkthrough of a $status Review: $offersMark",
    ({ status, offersMark }) => {
      const workbench = withWalkthrough();
      renderInsights(
        { ...workbench, review: { ...workbench.review, status } },
        "walkthrough",
      );

      expect(
        screen.queryByRole("button", { name: "Mark section reviewed" }) !==
          null,
      ).toBe(offersMark);
    },
  );

  it("keeps a stored reviewed marker visible and unchangeable on a closed Review", () => {
    const workbench = withWalkthrough();
    renderInsights(
      {
        ...workbench,
        review: { ...workbench.review, status: "closed" },
        insights: {
          ...workbench.insights,
          walkthrough: {
            ...workbench.insights.walkthrough,
            progress: {
              reviewedSectionIds: ["section-1"],
              supportReviewed: false,
            },
          },
        },
      },
      "walkthrough",
    );

    const marker = screen.getByRole("button", { name: "Section reviewed" });
    expect(marker.getAttribute("aria-pressed")).toBe("true");
    expect(marker.hasAttribute("disabled")).toBe(true);
  });

  it("hides the Analysis Regenerate on a closed Review and draws no terminal reason line", () => {
    const workbench = withAnalysis("actionable");
    renderInsights(
      { ...workbench, review: { ...workbench.review, status: "closed" } },
      "analysis",
    );

    expect(
      screen.getByRole("region", { name: "Analysis reader" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(screen.queryByText(REMOVED_TERMINAL_REASON)).toBeNull();
  });

  it("gives no reason on an open Review with a provider", async () => {
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
    });
    renderInsights();

    const generate = await screen.findByRole("button", {
      name: "Generate brief",
    });
    await waitFor(() => expect(generate.getAttribute("disabled")).toBeNull());
    expect(generate.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("InsightsSlot run requests", () => {
  it("marks retained readers as insight results", () => {
    renderInsights(withAnalysis("actionable"), "analysis");

    expect(document.querySelector("[data-insight-result]")).toBeTruthy();
  });
  it("transitions Walkthrough focus without interrupting docked focus restoration", async () => {
    const frames: FrameRequestCallback[] = [];
    // oxlint-disable-next-line patchdesk/no-method-spying -- The Walkthrough focus transition schedules through `window.requestAnimationFrame` with no frame-scheduler seam, so the spy holds each frame for the test to run by hand.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const user = userEvent.setup();
    renderInsights(withWalkthrough(), "walkthrough");

    const transition = screen.getByRole("region", {
      name: "Review insights",
    });
    await user.click(screen.getByRole("button", { name: "Focus section" }));
    expect(transition.dataset.walkthroughFocusTransition).toBe("leaving");
    expect(
      document.querySelector('[data-walkthrough-layout="docked"]'),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Focus section" }));
    expect(transition.dataset.walkthroughFocusTransition).toBe("leaving");

    const enteringTransitionEnd = new Event("transitionend", {
      bubbles: true,
    });
    Object.defineProperty(enteringTransitionEnd, "propertyName", {
      value: "opacity",
    });
    frames.length = 0;
    fireEvent(transition, enteringTransitionEnd);
    expect(transition.dataset.walkthroughFocusTransition).toBe("entering");
    expect(
      document.querySelector('[data-walkthrough-layout="focused"]'),
    ).toBeTruthy();
    const enteringFrame = frames.shift();
    if (enteringFrame === undefined)
      throw new Error("Expected an entering frame");
    act(() => enteringFrame(0));
    expect(transition.dataset.walkthroughFocusTransition).toBe("entering");
    const idleEnteringFrame = frames.shift();
    if (idleEnteringFrame === undefined)
      throw new Error("Expected an entering idle frame");
    act(() => idleEnteringFrame(0));
    expect(transition.dataset.walkthroughFocusTransition).toBe("idle");

    const takeover = document.querySelector<HTMLElement>(
      "[data-walkthrough-takeover]",
    );
    if (takeover === null) throw new Error("Expected focused walkthrough");
    fireEvent.keyDown(takeover, { key: "Escape" });
    expect(transition.dataset.walkthroughFocusTransition).toBe("leaving");
    const exitingTransitionEnd = new Event("transitionend", {
      bubbles: true,
    });
    Object.defineProperty(exitingTransitionEnd, "propertyName", {
      value: "opacity",
    });
    frames.length = 0;
    fireEvent(transition, exitingTransitionEnd);
    expect(
      document.querySelector('[data-walkthrough-layout="docked"]'),
    ).toBeTruthy();
    const exitingFrame = frames.shift();
    if (exitingFrame === undefined)
      throw new Error("Expected an exiting frame");
    act(() => exitingFrame(0));
    expect(transition.dataset.walkthroughFocusTransition).toBe("entering");
    const idleExitingFrame = frames.shift();
    if (idleExitingFrame === undefined)
      throw new Error("Expected an exiting idle frame");
    act(() => idleExitingFrame(0));

    expect(transition.dataset.walkthroughFocusTransition).toBe("idle");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Focus section" }),
    );
  });

  it("defaults Language to English, sends the chosen language, and preselects it next time", async () => {
    const runBodies: unknown[] = [];
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
      "/v1/reviews/insights/analysis/run": (input) => {
        runBodies.push(input.body);
        return success({ runId: "run-vi", type: "analysis", status: "queued" });
      },
      // The poll never settles, so the accepted run stays queued.
      "/v1/reviews/insights/runs/run-vi": () => new Promise(() => undefined),
    });
    const user = userEvent.setup();
    renderInsights(projection(), "analysis");

    await user.click(
      await screen.findByRole("button", { name: "Generate analysis" }),
    );
    const language = screen.getByRole("combobox", { name: "Insight language" });
    expect(language.textContent).toContain("English");
    await user.click(language);
    await user.click(await screen.findByRole("option", { name: "Vietnamese" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(runBodies).toHaveLength(1));
    expect(runBodies[0]).toMatchObject({ type: "analysis", language: "vi" });

    cleanup();
    renderInsights(projection(), "analysis");
    await user.click(
      await screen.findByRole("button", { name: "Generate analysis" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Insight language" }).textContent,
    ).toContain("Vietnamese");
  });

  it.each([
    { language: "vi" as const, named: "Vietnamese" },
    { language: "en" as const, named: undefined },
  ])(
    "names the $language result's language in the header only when it is not English",
    ({ language, named }) => {
      const retained = briefInsight().retained;
      if (retained === undefined)
        throw new Error("Brief fixture lost its retained result");
      renderInsights(
        projection({
          insights: {
            analysis: { status: "not_generated" },
            walkthrough: { status: "not_generated" },
            brief: briefInsight({
              retained: {
                ...retained,
                provenance: {
                  provider: "pi",
                  model: "fixture-model",
                  reasoning: "medium",
                  language,
                },
              },
            }),
          },
        }),
      );

      const insights = screen.getByRole("region", { name: "Review insights" });
      expect(within(insights).queryByText(/Vietnamese/) !== null).toBe(
        named !== undefined,
      );
      expect(within(insights).queryByText(/English/)).toBeNull();
    },
  );

  it("keeps start pending visible and shows a bounded start failure", async () => {
    const start = deferred<DesktopResponse>();
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
      "/v1/reviews/insights/analysis/run": () => start.promise,
    });
    const user = userEvent.setup();
    renderInsights(projection(), "analysis");

    await user.click(
      await screen.findByRole("button", { name: "Generate analysis" }),
    );
    await user.click(screen.getByRole("button", { name: "Start run" }));
    const starting = screen.getByRole("button", { name: "Starting…" });
    expect(starting.getAttribute("disabled")).not.toBeNull();
    expect(starting.querySelector('[data-icon="inline-start"]')).toBeTruthy();

    start.resolve(failure({ message: "runtime unavailable" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Analysis could not start");
    expect(screen.getByRole("button", { name: "Start run" })).toBeTruthy();
  });

  it("shows a bounded status failure while retaining the active run", async () => {
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
      "/v1/reviews/insights/runs/run-a": () =>
        failure({ message: "status unavailable" }),
    });
    renderInsights(
      projection({
        insights: {
          analysis: {
            status: "running",
            activeRun: {
              runId: "run-a",
              sessionId: "session-a",
              startedAt: "2026-08-01T00:00:00.000Z",
            },
          },
          walkthrough: { status: "not_generated" },
        },
      }),
      "analysis",
    );

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((alert) =>
            alert.textContent?.includes("Analysis status refresh failed"),
          ),
      ).toBe(true),
    );
    expect(
      screen
        .getAllByRole("alert")
        .find((alert) =>
          alert.textContent?.includes("Analysis status refresh failed"),
        )
        ?.getAttribute("data-slot"),
    ).toBe("inline-error");
    expect(
      screen.getByRole("button", { name: "Cancel Analysis" }),
    ).toBeTruthy();
  });

  it("uses an icon-only cancelling state and preserves the active run after failure", async () => {
    const cancellation = deferred<DesktopResponse>();
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
      "/v1/reviews/insights/runs/run-a": () =>
        new Promise<DesktopResponse>(() => undefined),
      "/v1/reviews/insights/analysis/cancel": () => cancellation.promise,
    });
    const user = userEvent.setup();
    renderInsights(
      projection({
        insights: {
          analysis: {
            status: "running",
            activeRun: {
              runId: "run-a",
              sessionId: "session-a",
              startedAt: "2026-08-01T00:00:00.000Z",
            },
          },
          walkthrough: { status: "not_generated" },
        },
      }),
      "analysis",
    );

    const cancel = await screen.findByRole("button", {
      name: "Cancel Analysis",
    });
    expect(cancel.textContent).toBe("");
    await user.click(cancel);
    const cancelling = screen.getByRole("button", {
      name: "Cancelling Analysis…",
    });
    expect(cancelling.getAttribute("disabled")).not.toBeNull();
    expect(cancelling.querySelector("svg")).toBeTruthy();

    cancellation.resolve(failure({ message: "cancel unavailable" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel Analysis" }),
      ).toBeTruthy(),
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Analysis cancel failed");
    expect(alert.getAttribute("data-slot")).toBe("inline-error");
    expect(screen.getByText("Analysis is running")).toBeTruthy();
  });
});

describe("InsightsSlot Verification ticks", () => {
  it("keeps a ticked step after switching to Brief and back", async () => {
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
      "/v1/reviews/insights/analysis/verification": () =>
        success({ checkedStepIndexes: [0] }),
    });
    const user = userEvent.setup();
    renderInsights(withAnalysis("actionable"));
    const stepName = "Verify invalid values are rejected.";

    await user.click(screen.getByRole("checkbox", { name: stepName }));
    await user.click(screen.getByRole("tab", { name: /^Brief/ }));
    await user.click(screen.getByRole("tab", { name: /^Analysis/ }));

    expect(
      screen
        .getByRole("checkbox", { name: stepName })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("InsightsSlot Walkthrough progress", () => {
  it("keeps a reviewed section after switching to Brief and back", async () => {
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
      "/v1/reviews/insights/walkthrough/progress": () =>
        success({ status: "saved" }),
    });
    const user = userEvent.setup();
    render(<PatchedInsights initial={withWalkthrough()} />);

    await user.click(
      screen.getByRole("button", { name: "Mark section reviewed" }),
    );
    await user.click(screen.getByRole("tab", { name: /^Brief/ }));
    await user.click(screen.getByRole("tab", { name: /^Walkthrough/ }));

    const marker = await screen.findByRole("button", {
      name: "Section reviewed",
    });
    expect(marker.getAttribute("aria-pressed")).toBe("true");
  });
});

/** Applies workbench patches the way the app shell does, so a remounted reader sees them. */
function PatchedInsights({
  initial,
}: {
  readonly initial: WorkbenchResponse;
}): React.JSX.Element {
  const [workbench, setWorkbench] = useState(initial);
  return (
    <InsightsSlot
      workbench={workbench}
      initialDetail="walkthrough"
      onWorkbenchReplace={() => undefined}
      onWorkbenchPatch={({ insights, ...rest }) =>
        setWorkbench((current) => ({
          ...current,
          ...rest,
          insights: { ...current.insights, ...insights },
        }))
      }
      onReprepare={async () => workbench}
    />
  );
}

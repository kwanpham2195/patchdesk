// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { DesktopResponse } from "../../src/main/ipc-contract";
import {
  parseContentHash,
  parseGitSha,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";
import { InsightsSlot } from "../../src/renderer/src/components/review-insights-slot";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import {
  projection,
  providerCatalog,
  withAnalysis,
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
    />,
  );
}

function valueOf<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid walkthrough fixture");
  return result.value;
}

function walkthroughProjection() {
  const walkthrough = {
    snapshot: {
      profileId: valueOf(parseWorkspaceProfileId("profile")),
      sessionId: valueOf(
        parseReviewSessionId(
          "github.com__centraldigital__patchdesk__pr-42__sha-22222222__base-00000000__abcdef123456",
        ),
      ),
      headSha: valueOf(parseGitSha("2222222222222222222222222222222222222222")),
      patchHash: valueOf(
        parseContentHash(
          "0000000000000000000000000000000000000000000000000000000000000000",
        ),
      ),
    },
    citationStatus: "verified" as const,
    title: "Fixture walkthrough",
    focus: "Read the fixture walkthrough.",
    chapters: [
      {
        id: "chapter-1",
        title: "Fixture chapter",
        sections: [
          {
            id: "section-1",
            title: "Fixture section",
            prose: "The retained walkthrough is ready to read.",
            hunkIds: [],
            hunks: [],
          },
        ],
      },
    ],
    support: {
      id: "support" as const,
      title: "Support" as const,
      hunkIds: [],
      hunks: [],
    },
  };
  return projection({
    insights: {
      analysis: { status: "not_generated" },
      walkthrough: {
        status: "current",
        artifactStatus: "verified",
        retained: {
          runId: "walkthrough-1",
          sessionId: "session-a",
          headSha: "2222222222222222222222222222222222222222",
          generatedAt: "2026-08-01T00:00:00.000Z",
          value: walkthrough,
        },
      },
    },
  });
}

describe("InsightsSlot run requests", () => {
  it("marks retained readers as insight results", () => {
    renderInsights(withAnalysis("actionable"));

    expect(document.querySelector("[data-insight-result]")).toBeTruthy();
  });
  it("transitions Walkthrough focus without interrupting docked focus restoration", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const user = userEvent.setup();
    renderInsights(walkthroughProjection(), "walkthrough");

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

  it("keeps start pending visible and shows a bounded start failure", async () => {
    const start = deferred<DesktopResponse>();
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
      "/v1/reviews/insights/analysis/run": () => start.promise,
    });
    const user = userEvent.setup();
    renderInsights();

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
    );

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((alert) =>
            alert.textContent?.includes(
              "Analysis status could not be refreshed",
            ),
          ),
      ).toBe(true),
    );
    expect(
      screen
        .getAllByRole("alert")
        .find((alert) =>
          alert.textContent?.includes("Analysis status could not be refreshed"),
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
    expect(alert.textContent).toContain("Analysis cancellation failed");
    expect(alert.getAttribute("data-slot")).toBe("inline-error");
    expect(screen.getByText("Analysis is running")).toBeTruthy();
  });
});

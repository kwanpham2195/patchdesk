// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { DesktopResponse } from "../../src/main/ipc-contract";
import { InsightsSlot } from "../../src/renderer/src/components/review-insights-slot";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { projection, providerCatalog } from "./review-workbench-fixtures";

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
  desktop?.restore();
  desktop = undefined;
  window.localStorage.clear();
});

function renderInsights(workbench = projection()): void {
  render(
    <InsightsSlot
      workbench={workbench}
      onWorkbenchReplace={() => undefined}
      onWorkbenchPatch={() => undefined}
    />,
  );
}

describe("InsightsSlot run requests", () => {
  it("keeps start pending visible and shows a bounded start failure", async () => {
    const start = deferred<DesktopResponse>();
    desktop = installDesktopDouble({
      "/v1/insight-providers": () => success(json(providerCatalog)),
      "/v1/reviews/insights/analysis/run": () => start.promise,
      "/v1/logs": () => success(null),
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
      "/v1/logs": () => success(null),
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
      "/v1/logs": () => success(null),
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

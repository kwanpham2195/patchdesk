// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

/**
 * What the mounted workbench header renders for each revision freshness, and
 * that refresh stays its one control. `useReviewObservation` decides which
 * freshness a detection produces (`use-review-observation.test.ts`); only a
 * mounted Review shows what the header does with the answer.
 */

function mount(workbench: WorkbenchResponse): void {
  render(
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={vi.fn()}
      onWorkbenchPatch={vi.fn()}
      onNavigationStateChange={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

describe("ReviewWorkbenchFlow revision freshness", () => {
  it("keeps the header refresh control reachable while GitHub state is unavailable, and never offers refresh inside the drawer", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    mount(
      projection({
        revision: { ...projection().revision, freshness: "unavailable" },
      }),
    );
    expect(screen.getByText(/Remote state unavailable/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Refresh GitHub state" })
        .hasAttribute("disabled"),
    ).toBe(false);

    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Open PR overview: checks passing",
      }),
    );
    // The drawer reads GitHub state; refresh stays the header's one control.
    expect(
      within(screen.getByRole("dialog", { name: "PR overview" })).queryByRole(
        "button",
        { name: "Refresh GitHub state" },
      ),
    ).toBeNull();
  });

  it("signals Updates available in the header as a status without a refresh control of its own", () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: true }
        : Promise.reject(new Error(input.path)),
    );
    mount(
      projection({
        revision: { ...projection().revision, freshness: "updates_available" },
      }),
    );
    const signal = screen
      .getAllByRole("status")
      .find((candidate) => candidate.textContent === "Updates available");
    if (signal === undefined)
      throw new Error("missing Updates available signal");
    expect(within(signal).queryByRole("button")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Refresh GitHub state" }),
    ).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

function mount(workbench: WorkbenchResponse): HTMLElement {
  bridge(async () => ({ updatesAvailable: false }));
  render(
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={vi.fn()}
      onWorkbenchPatch={vi.fn()}
      onNavigationStateChange={vi.fn()}
    />,
  );
  const header = screen
    .getByRole("heading", { name: "#42 Canonical workbench" })
    .closest("header");
  if (header === null) throw new Error("missing workbench header");
  return header;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

describe("ReviewWorkbenchHeader layout", () => {
  it.each([
    { state: "open", status: "open", merge: /^Open PR overview: merge / },
    {
      state: "merged",
      status: "merged",
      merge: "Open PR overview: merge merged",
    },
    {
      state: "closed",
      status: "closed",
      merge: "Open PR overview: merge closed",
    },
  ] as const)(
    "puts the status chips on their own row under the title for an $state Review",
    ({ status, merge }) => {
      const header = mount(projection({ review: { id: "review-42", status } }));
      const title = within(header).getByRole("heading", { level: 1 });
      const chips = within(header).getByRole("group", {
        name: "Pull request status",
      });
      const actions = within(header).getByRole("group", {
        name: "Pull request actions",
      });

      // The title shares its row with nothing; the chips row is its sibling.
      expect(chips.parentElement?.parentElement).toBe(title.parentElement);
      expect(actions.parentElement).toBe(chips.parentElement);
      expect(
        within(chips).getByRole("button", {
          name: /^Open PR overview: checks/,
        }),
      ).toBeTruthy();
      expect(within(chips).getByRole("button", { name: merge })).toBeTruthy();
      expect(
        within(actions).getByRole("button", { name: "Open on GitHub" }),
      ).toBeTruthy();
    },
  );

  it("offers refresh on an open Review", () => {
    const header = mount(projection());

    expect(
      within(header).getByRole("button", { name: "Refresh GitHub state" }),
    ).toBeTruthy();
  });

  it("states a merged Review once, through the Merge chip, with no status banner", () => {
    const header = mount(
      projection({ review: { id: "review-42", status: "merged" } }),
    );

    expect(
      within(header).getByRole("button", {
        name: "Open PR overview: merge merged",
      }),
    ).toBeTruthy();
    expect(within(header).queryAllByRole("status")).toHaveLength(0);
    expect(
      within(header).queryByRole("button", { name: "Refresh GitHub state" }),
    ).toBeNull();
  });
});

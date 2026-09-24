// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";
import { revisionFreshnessLabel } from "../../src/renderer/src/rail-freshness";

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

  it("drops the freshness words from a merged Review's revision line", () => {
    const freshness = revisionFreshnessLabel("fresh");
    const open = mount(projection());
    expect(open.textContent).toContain(freshness);
    cleanup();

    const merged = mount(
      projection({ review: { id: "review-42", status: "merged" } }),
    );
    expect(merged.textContent).toContain("a".repeat(8));
    expect(merged.textContent).not.toContain(freshness);
    expect(merged.textContent).not.toContain("checked");
  });

  it.each(["merged", "closed"] as const)(
    "drops the updates notice from a %s Review GitHub has moved past",
    (status) => {
      const header = mount(
        projection({
          review: { id: "review-42", status },
          revision: {
            ...projection().revision,
            currentHeadSha: "b".repeat(40),
            freshness: "updates_available",
          },
        }),
      );

      expect(within(header).queryAllByRole("status")).toHaveLength(0);
    },
  );

  it("hides the Checks chip on a merged Review whose checks are unknown", () => {
    const header = mount(
      projection({
        review: { id: "review-42", status: "merged" },
        checks: { overall: "unknown", checks: [] },
      }),
    );

    expect(
      within(header).queryByRole("button", {
        name: /^Open PR overview: checks/,
      }),
    ).toBeNull();
  });

  it("names the first merge blocker, counts the rest, and lists them all in the accessible name", () => {
    const header = mount(
      projection({
        mergeReadiness: {
          _tag: "Blocked",
          blockers: ["draft", "conflicting"],
          warnings: [],
        },
      }),
    );

    const chip = within(header).getByRole("button", {
      name: "Open PR overview: merge blocked: draft, conflicts",
    });
    expect(chip.textContent).toBe("Merge · Blocked · Draft +1");
  });
});

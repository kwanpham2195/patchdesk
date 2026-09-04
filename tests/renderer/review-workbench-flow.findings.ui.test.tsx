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

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type * as PierreDiffs from "@pierre/diffs";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { providerCatalog, withAnalysis } from "./review-workbench-fixtures";

/**
 * The finding-to-diff-to-finding loop `ReviewWorkbenchFlow` wires between the
 * Insights slot and the Diff tab. Split from `review-workbench-flow.ui.test.tsx`
 * only because that file sits at the size ceiling.
 */

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

/** The current Analysis's one P1 finding, counted by merge readiness. */
function withFindingsWarning(): WorkbenchResponse {
  return {
    ...withAnalysis("actionable"),
    mergeReadiness: {
      _tag: "NeedsAcknowledgement",
      blockers: [],
      warnings: [
        { code: "findings_need_acknowledgement", findingIds: ["finding-1"] },
      ],
    },
  };
}

describe("ReviewWorkbenchFlow finding navigation", () => {
  it("opens PR overview at Merge readiness from the header chip and leads from its findings card to the Finding row", async () => {
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      throw new Error(input.path);
    });
    render(
      <ReviewWorkbenchFlow
        workbench={withFindingsWarning()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Open PR overview: merge warnings" }),
    );
    const dialog = screen.getByRole("dialog", { name: "PR overview" });
    const readinessRow = within(dialog).getByRole("button", {
      name: "Merge readiness",
    });
    await waitFor(() => expect(document.activeElement).toBe(readinessRow));
    expect(readinessRow.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(dialog).getAllByRole("group", {
        name: "1 finding needs acknowledgement before merge",
      }),
    ).toHaveLength(1);

    await user.click(
      within(dialog).getByRole("button", { name: "Review findings" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "PR overview" })).toBeNull(),
    );
    expect(
      screen
        .getByRole("button", { name: "Insights" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const row = await screen.findByText("Missing boundary check");
    await waitFor(() => expect(document.activeElement).toBe(row.closest("li")));
  });

  it("links an Analysis Finding to its diff lines and the diff card back to the Finding row", async () => {
    // Pierre's CodeView only mounts when `CSSStyleSheet.replaceSync` exists;
    // jsdom lacks it, and the plain-text fallback draws no finding cards.
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
        if (input.path === "/v1/insight-providers") return providerCatalog;
        throw new Error(input.path);
      });
      render(
        <ReviewWorkbenchFlow
          workbench={withAnalysis("actionable")}
          onWorkbenchReplace={vi.fn()}
          onWorkbenchPatch={vi.fn()}
          onNavigationStateChange={vi.fn()}
        />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Insights" }));
      await user.click(
        await screen.findByRole("button", { name: /^Analysis/ }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Open in diff: src/a.ts:1" }),
      );

      expect(
        screen
          .getByRole("button", { name: "Diff" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      const diff = screen.getByRole("region", { name: "Review diff" });
      expect(diff.getAttribute("data-selected-path")).toBe("src/a.ts");
      const card = await screen.findByRole("article", {
        name: "P1 finding: Missing boundary check",
      });

      // Selecting the finding's line scrolls Pierre's CodeView, which suspends
      // pointer events briefly; retry the click until Pierre lifts that.
      await waitFor(() =>
        user.click(
          within(card).getByRole("button", {
            name: "Open finding in Analysis",
          }),
        ),
      );
      expect(
        screen
          .getByRole("button", { name: "Insights" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      const row = await screen.findByText("Missing boundary check");
      await waitFor(() =>
        expect(document.activeElement).toBe(row.closest("li")),
      );
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });
});

describe("ReviewWorkbenchFlow finding actions", () => {
  it("hides Add to review for a Finding whose location is not on the diff", async () => {
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      throw new Error(input.path);
    });
    render(
      <ReviewWorkbenchFlow
        workbench={withAnalysis("actionable", "invalid_line")}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Insights" }));
    await user.click(await screen.findByRole("button", { name: /^Analysis/ }));
    await screen.findByText("Missing boundary check");
    expect(screen.queryByRole("button", { name: "Add to review" })).toBeNull();
  });
});

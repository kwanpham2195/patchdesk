// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { changeScopeFromPatch } from "../../src/domain/change-scope";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type * as PierreDiffs from "@pierre/diffs";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

/**
 * The Scope filter `ReviewWorkbenchFlow` wires between the Insights Scope card,
 * the Browse tree, and the diff toolbar. Split from
 * `review-workbench-flow.ui.test.tsx` only because that file sits at the size
 * ceiling.
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

/** The Browse tree's rows, read from the file tree's shadow root. */
function browsedPaths(): ReadonlyArray<string> {
  const tree = document
    .querySelector("file-tree-container")
    ?.shadowRoot?.querySelectorAll("[data-item-path]");
  if (tree === undefined) throw new Error("Expected a Browse file tree");
  return [...tree].map((row) => row.getAttribute("data-item-path") ?? "");
}

describe("ReviewWorkbenchFlow Scope filter", () => {
  it("filters the Diff to a Scope bucket and restores it from the toolbar chip", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    const scopedPatch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/docs/guide.md b/docs/guide.md",
      "--- a/docs/guide.md",
      "+++ b/docs/guide.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const scope = changeScopeFromPatch(scopedPatch);
    render(
      <ReviewWorkbenchFlow
        workbench={projection({
          fullPatch: scopedPatch,
          // The wire type the projection carries is mutable; the domain's is not.
          scope: { ...scope, buckets: [...scope.buckets] },
        })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.click(screen.getByRole("button", { name: /Docs/ }));

    expect(
      screen.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(browsedPaths()).toEqual(["docs/", "docs/guide.md"]);

    await user.click(
      screen.getByRole("button", { name: "Clear Scope filter: Docs" }),
    );
    expect(browsedPaths()).toEqual([
      "docs/",
      "docs/guide.md",
      "src/",
      "src/a.ts",
    ]);
  });
});

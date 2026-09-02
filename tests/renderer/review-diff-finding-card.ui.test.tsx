// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDiffView } from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";
import type * as PierreDiffs from "@pierre/diffs";

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

afterEach(cleanup);

describe("inline finding cards", () => {
  it("opens the finding in Analysis from its card and badges the file header with the finding count", async () => {
    // Pierre's renderers only mount when `CSSStyleSheet.replaceSync` exists;
    // jsdom lacks it, and without it the plain-text fallback (which draws no
    // annotation cards) renders instead.
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
    const onOpenFindingInAnalysis = vi.fn();
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const parsed = parseReviewDiff(patch);
    const user = userEvent.setup();
    try {
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          findingCountsByPath={
            new Map([["src/a.ts", { count: 2, highest: "P1" as const }]])
          }
          selectedPath="src/a.ts"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          annotations={[
            {
              id: "finding-1",
              path: "src/a.ts",
              start: 1,
              end: 1,
              side: "new",
              severity: "P1",
              title: "Missing boundary check",
              explanation: "The added branch accepts an invalid value.",
            },
          ]}
          onOpenFindingInAnalysis={onOpenFindingInAnalysis}
          virtualized={false}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("article", {
            name: "P1 finding: Missing boundary check",
          }),
        ).toBeTruthy(),
      );
      expect(
        screen.getByRole("img", { name: "2 findings, highest P1" }),
      ).toBeTruthy();
      await user.click(
        screen.getByRole("button", { name: "Open finding in Analysis" }),
      );
      expect(onOpenFindingInAnalysis).toHaveBeenCalledWith("finding-1");
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });
});

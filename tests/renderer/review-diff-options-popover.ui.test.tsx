// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

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

describe("diff view options", () => {
  const patch =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const renderDiff = (
    overrides: Partial<ComponentProps<typeof ReviewDiffView>> = {},
  ) => {
    const parsed = parseReviewDiff(patch);
    return render(
      <ReviewDiffView
        patch={patch}
        parsedFiles={parsed.files}
        fileStatsByPath={parsed.statsByPath}
        selectedPath="src/a.ts"
        preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
        collapsedPaths={new Set()}
        onPreferencesChange={() => undefined}
        onCollapsedPathsChange={() => undefined}
        virtualized={false}
        {...overrides}
      />,
    );
  };

  // The Pierre code view needs constructable stylesheets, which jsdom leaves
  // without a `replaceSync`.
  const withCodeViewDom = (): void => {
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
  };
  const openViewOptions = async (): Promise<void> => {
    await userEvent.click(screen.getByRole("button", { name: "View options" }));
    await screen.findByRole("switch", { name: "Split view" });
  };
  const diffPre = async (): Promise<HTMLPreElement> => {
    let pre: HTMLPreElement | null = null;
    await waitFor(() => {
      const host = document.querySelector("diffs-container");
      pre = host?.shadowRoot?.querySelector("pre") ?? null;
      if (pre === null || pre.getAttributeNames().length === 0)
        throw new Error("the diff has not rendered yet");
    });
    if (pre === null) throw new Error("the diff has not rendered yet");
    return pre;
  };

  it("offers split view, wrapping, line numbers and backgrounds as switches", async () => {
    renderDiff();
    await openViewOptions();

    expect(
      ["Split view", "Wrap lines", "Line numbers", "Backgrounds"].map((name) =>
        screen.getByRole("switch", { name }).getAttribute("aria-checked"),
      ),
    ).toEqual(["false", "false", "true", "true"]);
    expect(screen.queryByRole("button", { name: "Unified" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wrap" })).toBeNull();
  });

  it("saves each toggled option through the preference callback", async () => {
    const onPreferencesChange = vi.fn();
    renderDiff({ onPreferencesChange });
    await openViewOptions();

    for (const name of [
      "Split view",
      "Wrap lines",
      "Line numbers",
      "Backgrounds",
    ]) {
      await userEvent.click(screen.getByRole("switch", { name }));
    }

    expect(onPreferencesChange.mock.calls.map(([update]) => update)).toEqual([
      { diffStyle: "split" },
      { overflow: "wrap" },
      { lineNumbers: false },
      { backgrounds: false },
    ]);
  });

  it("reads the switches back from the saved preferences", async () => {
    renderDiff({
      preferences: {
        ...DEFAULT_REVIEW_VIEW_PREFERENCES,
        diffStyle: "split",
        overflow: "wrap",
        lineNumbers: false,
        backgrounds: false,
      },
    });
    await openViewOptions();

    expect(
      ["Split view", "Wrap lines", "Line numbers", "Backgrounds"].map((name) =>
        screen.getByRole("switch", { name }).getAttribute("aria-checked"),
      ),
    ).toEqual(["true", "true", "false", "false"]);
  });

  it("draws line numbers and backgrounds while both preferences are on", async () => {
    withCodeViewDom();
    renderDiff();

    const pre = await diffPre();
    expect(pre.hasAttribute("data-disable-line-numbers")).toBe(false);
    expect(pre.hasAttribute("data-background")).toBe(true);
  });

  it("drops line numbers and backgrounds when both preferences are off", async () => {
    withCodeViewDom();
    renderDiff({
      preferences: {
        ...DEFAULT_REVIEW_VIEW_PREFERENCES,
        lineNumbers: false,
        backgrounds: false,
      },
    });

    const pre = await diffPre();
    expect(pre.hasAttribute("data-disable-line-numbers")).toBe(true);
    expect(pre.hasAttribute("data-background")).toBe(false);
  });
});

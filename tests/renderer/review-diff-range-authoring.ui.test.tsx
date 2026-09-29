// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReviewDiffView,
  type LocalCommentAuthoring,
} from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";
import { dragDiffGutter, type GutterLine } from "./pierre-gutter";

const range = (from: number, to: number, prefix: string) =>
  Array.from({ length: to - from + 1 }, (_, index) => {
    const line = from + index;
    return `${prefix}line ${String(line)}`;
  });
// Hunk one changes lines 12-18 on both sides; hunk two changes line 41.
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,10 +10,10 @@",
  " line 10",
  " line 11",
  ...range(12, 18, "-old "),
  ...range(12, 18, "+new "),
  " line 19",
  "@@ -40,3 +40,3 @@",
  " line 40",
  "-old line 41",
  "+new line 41",
  " line 42",
  "",
].join("\n");

const stubbedReplaceSync = CSSStyleSheet.prototype.replaceSync === undefined;
beforeEach(() => {
  if (stubbedReplaceSync) CSSStyleSheet.prototype.replaceSync = () => undefined;
});
afterEach(() => {
  cleanup();
  if (stubbedReplaceSync)
    Reflect.deleteProperty(CSSStyleSheet.prototype, "replaceSync");
});

function renderDiff(
  authoring: LocalCommentAuthoring,
  virtualized: boolean,
): void {
  const parsed = parseReviewDiff(PATCH);
  render(
    <ReviewDiffView
      patch={PATCH}
      parsedFiles={parsed.files}
      fileStatsByPath={parsed.statsByPath}
      selectedPath="src/a.ts"
      // Split view keeps both hunks inside the rows CodeView renders in jsdom.
      preferences={{ ...DEFAULT_REVIEW_VIEW_PREFERENCES, diffStyle: "split" }}
      collapsedPaths={new Set()}
      onPreferencesChange={() => undefined}
      onCollapsedPathsChange={() => undefined}
      localCommentAuthoring={authoring}
      virtualized={virtualized}
    />,
  );
}

// Pierre's CodeView suspends pointer events for 120 ms after a layout pass.
const setupUser = () =>
  userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });

describe("gutter range authoring", () => {
  it.each([
    {
      name: "down the new side of the Diff tab",
      virtualized: true,
      from: { line: 12 },
      to: { line: 18 },
      saved: { startLine: 12, line: 18, side: "new" },
    },
    {
      name: "up the new side of the Diff tab",
      virtualized: true,
      from: { line: 18 },
      to: { line: 12 },
      saved: { startLine: 12, line: 18, side: "new" },
    },
    {
      name: "down the old side of the Diff tab",
      virtualized: true,
      from: { line: 12, side: "deletions" },
      to: { line: 14, side: "deletions" },
      saved: { startLine: 12, line: 14, side: "old" },
    },
    {
      name: "down the new side of a Walkthrough hunk",
      virtualized: false,
      from: { line: 12 },
      to: { line: 18 },
      saved: { startLine: 12, line: 18, side: "new" },
    },
  ] satisfies ReadonlyArray<{
    name: string;
    virtualized: boolean;
    from: GutterLine;
    to: GutterLine;
    saved: { startLine: number; line: number; side: "new" | "old" };
  }>)(
    "a gutter drag $name opens one note composer and saves the range",
    async ({ virtualized, from, to, saved }) => {
      const onSave = vi.fn(async () => undefined);
      renderDiff({ enabled: true, kind: "note", onSave }, virtualized);
      const user = setupUser();

      await dragDiffGutter(from, to);

      const [composer, ...others] = await screen.findAllByRole("region", {
        name: "Note composer",
      });
      expect(others).toEqual([]);
      if (composer === undefined) throw new Error("expected a composer");
      expect(
        within(composer).getByText(
          new RegExp(`Lines ${String(saved.startLine)}–${String(saved.line)}`),
        ),
      ).toBeTruthy();
      await user.type(
        within(composer).getByRole("textbox", { name: "Note" }),
        "Split this block.",
      );
      await user.click(
        within(composer).getByRole("button", { name: "Add note" }),
      );
      expect(onSave).toHaveBeenCalledWith({
        path: "src/a.ts",
        ...saved,
        body: "Split this block.",
      });
    },
  );

  it("publishes a pull request range comment with the range's fingerprint", async () => {
    const onSave = vi.fn(async () => undefined);
    renderDiff({ enabled: true, onSave }, true);
    const user = setupUser();

    await dragDiffGutter({ line: 12 }, { line: 18 });
    await user.type(
      await screen.findByRole("textbox", { name: "Inline comment" }),
      "Split this block.",
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "src/a.ts",
        startLine: 12,
        line: 18,
        side: "new",
        fingerprint: expect.objectContaining({
          startLine: 12,
          line: 18,
          selectedLines: range(12, 18, "new "),
        }),
      }),
    );
  });

  it.each([
    {
      name: "across sides",
      from: { line: 12, side: "deletions" },
      to: { line: 18 },
    },
    { name: "across hunks", from: { line: 12 }, to: { line: 41 } },
  ] satisfies ReadonlyArray<{
    name: string;
    from: GutterLine;
    to: GutterLine;
  }>)("refuses a gutter drag $name and says why", async ({ from, to }) => {
    const onSave = vi.fn(async () => undefined);
    renderDiff({ enabled: true, kind: "note", onSave }, true);
    const user = setupUser();

    await dragDiffGutter(from, to);

    const refusal = await screen.findByRole("status", {
      name: "Lines not selected",
    });
    expect(screen.queryByRole("region", { name: "Note composer" })).toBeNull();
    await user.click(within(refusal).getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByRole("status", { name: "Lines not selected" }),
    ).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { useReviewDiffModel } from "../../src/renderer/src/hooks/use-review-diff-model";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import type { ReviewInlineAnnotation } from "../../src/renderer/src/components/review-diff-view";
import {
  installDesktopDouble,
  type DesktopDouble,
} from "./fake-desktop-response";

function fileSection(path: string, text: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-old ${text}`,
    `+new ${text}`,
  ].join("\n");
}

const testsPatch = fileSection("internal/errors_test.go", "errors");
const fullPatch = `${fileSection("docs/README.md", "readme")}\n${testsPatch}\n`;

let desktop: DesktopDouble | undefined;

afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

type ModelProps = {
  readonly patch: string;
  readonly selectedPath: string;
};

/**
 * Every `items` list this model rendered, in order. CodeView throws on a
 * duplicate id, so the invariant is about every intermediate render, not only
 * the settled one.
 */
function renderModel(initialProps: ModelProps) {
  const renderedItemIds: Array<ReadonlyArray<string>> = [];
  const viewer: RefObject<CodeViewHandle<
    ReviewInlineAnnotation | undefined
  > | null> = { current: null };
  const { rerender } = renderHook(
    ({ patch, selectedPath }: ModelProps) => {
      const model = useReviewDiffModel({
        patch,
        parsedFiles: parseReviewDiff(patch).files,
        selectedPath,
        selectedRange: undefined,
        annotations: [],
        preferences: { fileMode: "all" },
        collapsedPaths: new Set(),
        expandUnchanged: false,
        themePreferences: { light: "pierre-light", dark: "pierre-dark" },
        sourceSession: { profileId: "profile", sessionId: "session" },
        virtualized: true,
        viewer,
        onActiveFileChange: undefined,
      });
      renderedItemIds.push(model.items.map((item) => item.id));
      return model;
    },
    { initialProps },
  );
  return { renderedItemIds, rerender };
}

describe("useReviewDiffModel", () => {
  it("never hands CodeView two items with the same id across a Scope filter", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/diff-file": async (input) => ({
        ok: true,
        status: 200,
        correlationId: input.path,
        body: {
          state: "ready",
          oldFile: { name: "unused", contents: "old\n" },
          newFile: { name: "unused", contents: "new\n" },
        },
      }),
    });
    const { renderedItemIds, rerender } = renderModel({
      patch: fullPatch,
      selectedPath: "docs/README.md",
    });
    await act(async () => undefined);

    // Applying a Scope bucket narrows the patch. The diff pane can still point
    // at a file the bucket hid, because clearing the workbench selection drops
    // it back to the path it held before the filter.
    rerender({ patch: testsPatch, selectedPath: "docs/README.md" });
    await act(async () => undefined);

    // Choosing "All files" widens the patch again.
    rerender({ patch: fullPatch, selectedPath: "docs/README.md" });
    await act(async () => undefined);

    for (const ids of renderedItemIds) expect(ids).toEqual([...new Set(ids)]);
    expect(renderedItemIds.at(-1)).toEqual([
      "docs/README.md",
      "internal/errors_test.go",
    ]);
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as PierreDiffs from "@pierre/diffs";

import { ReviewDiffView } from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs owns the rendering boundary; its WASM highlighter cannot run in jsdom, so this test retains every export and replaces only preloadHighlighter.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return { ...actual, preloadHighlighter: vi.fn(async () => undefined) };
});

let restorePierre: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restorePierre?.();
  restorePierre = undefined;
});

function enablePierre(): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
  if (
    window.CSSStyleSheet === undefined ||
    window.CSSStyleSheet.prototype.replaceSync !== undefined
  )
    return;
  window.CSSStyleSheet.prototype.replaceSync = () => undefined;
  restorePierre = () => {
    if (descriptor?.value !== undefined)
      delete descriptor.value.prototype.replaceSync;
  };
}

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-oldA",
  "+newA",
  "@@ -10 +10 @@",
  "-oldB",
  "+newB",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -3 +3 @@",
  "-oldC",
  "+newC",
  "",
].join("\n");

const annotations = [
  {
    id: "conversation:a",
    path: "src/a.ts",
    start: 1,
    end: 1,
    side: "new" as const,
    severity: "conversation",
    title: "Open thread A",
    explanation: "",
    conversationThread: {
      target: { _tag: "unresolved" as const },
      state: "open" as const,
      comments: [],
    },
  },
  {
    id: "conversation:b",
    path: "src/b.ts",
    start: 3,
    end: 3,
    side: "new" as const,
    severity: "conversation",
    title: "Open thread B",
    explanation: "",
    conversationThread: {
      target: { _tag: "unresolved" as const },
      state: "open" as const,
      comments: [],
    },
  },
];

function renderNavigationDiff(
  onActiveFileChange = vi.fn(),
): ReturnType<typeof vi.fn> {
  const parsed = parseReviewDiff(patch);
  render(
    <ReviewDiffView
      patch={patch}
      parsedFiles={parsed.files}
      fileStatsByPath={parsed.statsByPath}
      selectedPath="src/a.ts"
      annotations={annotations}
      preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
      collapsedPaths={new Set()}
      onPreferencesChange={() => undefined}
      onCollapsedPathsChange={() => undefined}
      onActiveFileChange={onActiveFileChange}
    />,
  );
  return onActiveFileChange;
}

function waitForFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}
function press(key: string): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

async function expectStatus(input: {
  kind: string;
  state: string;
  total: number;
  position?: number;
  path?: string;
  line?: number;
}): Promise<void> {
  await waitFor(() => {
    const status = screen.getByRole("status", {
      name: "Diff navigation status",
    });
    expect(status.dataset.navigationKind).toBe(input.kind);
    expect(status.dataset.navigationState).toBe(input.state);
    expect(status.dataset.navigationTotal).toBe(String(input.total));
    expect(status.dataset.navigationPosition).toBe(
      input.position === undefined ? undefined : String(input.position),
    );
    expect(status.dataset.navigationPath).toBe(input.path);
    expect(status.dataset.navigationLine).toBe(
      input.line === undefined ? undefined : String(input.line),
    );
  });
}

async function expectFileTargetOrFirst(): Promise<void> {
  await waitFor(() => {
    const status = screen.getByRole("status", {
      name: "Diff navigation status",
    });
    expect(status.dataset.navigationKind).toBe("file");
    expect(["target", "first"]).toContain(status.dataset.navigationState);
  });
}

async function expectHunkTargetOrFirst(): Promise<void> {
  await waitFor(() => {
    const status = screen.getByRole("status", {
      name: "Diff navigation status",
    });
    expect(status.dataset.navigationKind).toBe("hunk");
    expect(["target", "first"]).toContain(status.dataset.navigationState);
  });
}

describe("ReviewDiffView navigation feedback", () => {
  it("shows one structured landed or boundary status for file, hunk, and comment navigation", async () => {
    enablePierre();
    renderNavigationDiff();
    press(",");
    await expectFileTargetOrFirst();
    press(",");
    await expectStatus({ kind: "file", state: "first", total: 2 });
    press(".");
    await expectStatus({
      kind: "file",
      state: "target",
      position: 2,
      total: 2,
      path: "src/b.ts",
    });
    press(".");
    await expectStatus({ kind: "file", state: "last", total: 2 });
    press(",");
    await expectStatus({
      kind: "file",
      state: "target",
      position: 1,
      total: 2,
      path: "src/a.ts",
    });
    press(",");
    await expectStatus({ kind: "file", state: "first", total: 2 });
    press("[");
    await expectHunkTargetOrFirst();
    press("[");
    await expectHunkTargetOrFirst();
    press("[");
    await expectStatus({ kind: "hunk", state: "first", total: 3 });
    press("]");
    await expectStatus({
      kind: "hunk",
      state: "target",
      position: 2,
      total: 3,
      path: "src/a.ts",
      line: 10,
    });
    press("]");
    await expectStatus({
      kind: "hunk",
      state: "target",
      position: 3,
      total: 3,
      path: "src/b.ts",
      line: 3,
    });
    press("]");
    await expectStatus({ kind: "hunk", state: "last", total: 3 });
    press("}");
    await expectStatus({
      kind: "comment",
      state: "target",
      position: 1,
      total: 2,
      path: "src/a.ts",
      line: 1,
    });
    press("}");
    await expectStatus({
      kind: "comment",
      state: "target",
      position: 2,
      total: 2,
      path: "src/b.ts",
      line: 3,
    });
    press("}");
    await expectStatus({ kind: "comment", state: "last", total: 2 });
    expect(
      screen.getAllByRole("status", { name: "Diff navigation status" }),
    ).toHaveLength(1);
  });

  it("keeps the later cross-kind operation and disables fallback navigation", async () => {
    enablePierre();
    const onActiveFileChange = renderNavigationDiff();
    press(".");
    press("]");
    await expectStatus({
      kind: "hunk",
      state: "target",
      position: 2,
      total: 3,
      path: "src/a.ts",
      line: 10,
    });
    expect(onActiveFileChange).not.toHaveBeenCalledWith("src/b.ts");
    cleanup();
    const descriptor = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    Object.defineProperty(window, "CSSStyleSheet", {
      configurable: true,
      value: undefined,
    });
    try {
      renderNavigationDiff();
      press(".");
      press("]");
      press("}");
      expect(
        screen.queryByRole("status", { name: "Diff navigation status" }),
      ).toBeNull();
    } finally {
      if (descriptor === undefined)
        Reflect.deleteProperty(window, "CSSStyleSheet");
      else Object.defineProperty(window, "CSSStyleSheet", descriptor);
    }
  });
  it("clears feedback and restarts file navigation after the file mode resets", async () => {
    enablePierre();
    const parsed = parseReviewDiff(patch);
    const view = (fileMode: "all" | "selected"): React.JSX.Element => (
      <ReviewDiffView
        patch={patch}
        parsedFiles={parsed.files}
        fileStatsByPath={parsed.statsByPath}
        selectedPath="src/a.ts"
        annotations={annotations}
        preferences={{ ...DEFAULT_REVIEW_VIEW_PREFERENCES, fileMode }}
        collapsedPaths={new Set()}
        onPreferencesChange={() => undefined}
        onCollapsedPathsChange={() => undefined}
      />
    );
    const { rerender } = render(view("all"));

    press(".");
    await expectStatus({
      kind: "file",
      state: "target",
      position: 2,
      total: 2,
      path: "src/b.ts",
    });

    rerender(view("selected"));
    expect(
      screen.queryByRole("status", { name: "Diff navigation status" }),
    ).toBeNull();
    rerender(view("all"));
    expect(
      screen.queryByRole("status", { name: "Diff navigation status" }),
    ).toBeNull();

    press(".");
    await expectStatus({
      kind: "file",
      state: "target",
      position: 2,
      total: 2,
      path: "src/b.ts",
    });
  });

  it("invalidates a pending comment operation when its annotation version changes", async () => {
    enablePierre();
    const parsed = parseReviewDiff(patch);
    const onActiveFileChange = vi.fn();
    const sentinel = document.createElement("button");
    document.body.append(sentinel);
    sentinel.focus();
    const view = (
      displayedAnnotations: typeof annotations,
    ): React.JSX.Element => (
      <ReviewDiffView
        patch={patch}
        parsedFiles={parsed.files}
        fileStatsByPath={parsed.statsByPath}
        selectedPath="src/a.ts"
        annotations={displayedAnnotations}
        preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
        collapsedPaths={new Set()}
        onPreferencesChange={() => undefined}
        onCollapsedPathsChange={() => undefined}
        onActiveFileChange={onActiveFileChange}
      />
    );
    const { rerender } = render(view(annotations));

    const frames: Array<FrameRequestCallback> = [];
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    try {
      press("}");
      rerender(
        view(
          annotations.map((annotation) => ({
            ...annotation,
            title: `${annotation.title} updated`,
          })),
        ),
      );
      while (frames.length > 0) frames.shift()?.(0);

      expect(onActiveFileChange).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("status", { name: "Diff navigation status" }),
      ).toBeNull();
      expect(document.activeElement).toBe(sentinel);
    } finally {
      requestFrame.mockRestore();
    }

    press("}");
    await expectStatus({
      kind: "comment",
      state: "target",
      position: 1,
      total: 2,
      path: "src/a.ts",
      line: 1,
    });
  });

  it("does not report a successful navigation after the viewer unmounts", async () => {
    enablePierre();
    const onActiveFileChange = renderNavigationDiff();

    press(".");
    cleanup();
    await waitForFrames();

    expect(onActiveFileChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("status", { name: "Diff navigation status" }),
    ).toBeNull();
  });
});

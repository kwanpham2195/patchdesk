// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ onSelectedLinesChange, renderGutterUtility, items, renderAnnotation }: { readonly onSelectedLinesChange?: (selection: unknown) => void; readonly renderGutterUtility?: (getHoveredLine: () => unknown, item: unknown) => React.ReactNode; readonly items?: ReadonlyArray<{ readonly annotations?: ReadonlyArray<{ readonly side: "additions" | "deletions"; readonly lineNumber: number; readonly metadata: unknown }> }>; readonly renderAnnotation?: (annotation: { readonly side: "additions" | "deletions"; readonly lineNumber: number; readonly metadata: unknown }) => React.ReactNode }) => <div><button onClick={() => onSelectedLinesChange?.({ id: "src/a.ts", range: { start: 4, end: 5, side: "additions" } })}>Select changed range</button><button onClick={() => onSelectedLinesChange?.({ id: "src/a.ts", range: { start: 3, end: 3, side: "deletions" } })}>Select deleted line</button>{renderGutterUtility?.(() => ({ lineNumber: 4, side: "additions" }), { id: "src/a.ts", type: "diff" })}{items?.flatMap((item) => item.annotations ?? []).map((annotation, index) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}</div>,
  PatchDiff: () => <div />,
  FileDiff: () => <div />,
}));

import { ReviewDiffView } from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";

afterEach(() => cleanup());

describe("review diff local comment composer", () => {
  it("saves a selected changed range locally and clears the composer", async () => {
    Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value: () => undefined });
    const onSave = vi.fn(async () => undefined);
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+another\n";
    const parsed = parseReviewDiff(patch);
    const user = userEvent.setup();
    render(<ReviewDiffView patch={patch} parsedFiles={parsed.files} fileStatsByPath={parsed.statsByPath} selectedPath="src/a.ts" preferences={DEFAULT_REVIEW_VIEW_PREFERENCES} collapsedPaths={new Set()} onPreferencesChange={() => undefined} onCollapsedPathsChange={() => undefined} localCommentAuthoring={{ enabled: true, onSave }} />);

    await user.click(screen.getByRole("button", { name: "Select changed range" }));
    expect(screen.getByLabelText("Local comment composer")).toBeTruthy();
    await user.type(screen.getByLabelText("Local comment"), "Explain the guard");
    await user.click(screen.getByRole("button", { name: "Save local comment" }));

    expect(onSave).toHaveBeenCalledWith({ path: "src/a.ts", startLine: 4, line: 5, side: "new", body: "Explain the guard" });
    expect(screen.queryByLabelText("Local comment composer")).toBeNull();
  });

  it("captures exact diff context with a pre-review local comment", async () => {
    Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value: () => undefined });
    const onSave = vi.fn(async () => undefined);
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +4,2 @@\n-old\n+new\n+another\n";
    const parsed = parseReviewDiff(patch);
    const user = userEvent.setup();
    render(<ReviewDiffView patch={patch} parsedFiles={parsed.files} fileStatsByPath={parsed.statsByPath} selectedPath="src/a.ts" preferences={DEFAULT_REVIEW_VIEW_PREFERENCES} collapsedPaths={new Set()} onPreferencesChange={() => undefined} onCollapsedPathsChange={() => undefined} localCommentAuthoring={{ enabled: true, onSave }} />);

    await user.click(screen.getByRole("button", { name: "Select changed range" }));
    await user.type(screen.getByLabelText("Local comment"), "Explain the guard");
    await user.click(screen.getByRole("button", { name: "Save local comment" }));

    expect(onSave).toHaveBeenCalledWith({
      path: "src/a.ts",
      startLine: 4,
      line: 5,
      side: "new",
      body: "Explain the guard",
      fingerprint: {
        path: "src/a.ts",
        side: "new",
        startLine: 4,
        line: 5,
        selectedLines: ["new", "another"],
        before: [],
        after: [],
      },
    });
  });

  it("cancels with Escape without saving", () => {
    Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value: () => undefined });
    const onSave = vi.fn(async () => undefined);
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const parsed = parseReviewDiff(patch);
    render(<ReviewDiffView patch={patch} parsedFiles={parsed.files} fileStatsByPath={parsed.statsByPath} selectedPath="src/a.ts" preferences={DEFAULT_REVIEW_VIEW_PREFERENCES} collapsedPaths={new Set()} onPreferencesChange={() => undefined} onCollapsedPathsChange={() => undefined} localCommentAuthoring={{ enabled: true, onSave }} />);

    fireEvent.click(screen.getByRole("button", { name: "Select changed range" }));
    fireEvent.keyDown(screen.getByLabelText("Local comment"), { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Local comment composer")).toBeNull();
  });

  it("saves a deleted line on the old side", async () => {
    Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value: () => undefined });
    const onSave = vi.fn(async () => undefined);
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const parsed = parseReviewDiff(patch);
    const user = userEvent.setup();
    render(<ReviewDiffView patch={patch} parsedFiles={parsed.files} fileStatsByPath={parsed.statsByPath} selectedPath="src/a.ts" preferences={DEFAULT_REVIEW_VIEW_PREFERENCES} collapsedPaths={new Set()} onPreferencesChange={() => undefined} onCollapsedPathsChange={() => undefined} localCommentAuthoring={{ enabled: true, onSave }} />);

    await user.click(screen.getByRole("button", { name: "Select deleted line" }));
    await user.type(screen.getByRole("textbox", { name: "Local comment" }), "Explain the removal");
    await user.click(screen.getByRole("button", { name: "Save local comment" }));

    expect(onSave).toHaveBeenCalledWith({ path: "src/a.ts", startLine: 3, line: 3, side: "old", body: "Explain the removal" });
  });

  it("does not hydrate a filtered non-virtualized walkthrough diff", () => {
    const request = vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: {
        state: "ready",
        oldFile: { name: "src/a.ts", contents: "before\nold tail\n" },
        newFile: { name: "src/a.ts", contents: "after\nnew tail\nnew tail 2\n" },
      },
      correlationId: "test",
    }));
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request,
        openExternalHttps: async () => true,
        onNavigate: () => () => undefined,
        qaScrollDiagnosticsEnabled: false,
      },
    });
    const filteredPatch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-before\n+after\n";
    const parsed = parseReviewDiff(filteredPatch);

    render(
      <ReviewDiffView
        patch={filteredPatch}
        parsedFiles={parsed.files}
        fileStatsByPath={parsed.statsByPath}
        selectedPath="src/a.ts"
        preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
        collapsedPaths={new Set()}
        onPreferencesChange={() => undefined}
        onCollapsedPathsChange={() => undefined}
        sourceSession={{ profileId: "cfw", sessionId: "session" }}
        virtualized={false}
      />,
    );

    expect(request).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDiffView } from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";

vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

afterEach(() => cleanup());

describe("review diff hydration", () => {
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
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-before\n+after\n";
    const parsed = parseReviewDiff(patch);

    render(
      <ReviewDiffView
        patch={patch}
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

  it("submits a fingerprinted inline comment through the accessible fallback", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    Object.defineProperty(window, "CSSStyleSheet", { configurable: true, value: undefined });
    const onSave = vi.fn(async () => undefined);
    const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const parsed = parseReviewDiff(patch);
    const user = userEvent.setup();
    try {
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="src/a.ts"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          localCommentAuthoring={{ enabled: true, onSave }}
          virtualized={false}
        />,
      );
      const addition = document.querySelector<HTMLElement>('[data-line-type="change-addition"]');
      const commentButton = addition?.querySelector<HTMLButtonElement>('button[aria-label="Add comment on src/a.ts"]');
      if (commentButton === null || commentButton === undefined) throw new Error("Expected an inline comment action");
      expect(commentButton.getAttribute("title")).toBe("Add comment on src/a.ts line 1");
      await user.click(commentButton);
      await user.type(screen.getByRole("textbox", { name: "Inline comment" }), "Publish this");
      await user.click(screen.getByRole("button", { name: "Comment" }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ path: "src/a.ts", startLine: 1, line: 1, side: "new", fingerprint: expect.objectContaining({ path: "src/a.ts", startLine: 1, line: 1, side: "new" }) }));
    } finally {
      if (styleSheet === undefined) delete (window as unknown as { CSSStyleSheet?: unknown }).CSSStyleSheet;
      else Object.defineProperty(window, "CSSStyleSheet", styleSheet);
    }
  });

  it("keeps a saved local comment rendered on its anchored line", async () => {
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
    const patch = "diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n";
    const parsed = parseReviewDiff(patch);
    try {
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="src/a.ts"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          annotations={[{
            id: "local-draft:comment-1",
            path: "src/a.ts",
            start: 1,
            end: 1,
            side: "new",
            severity: "info",
            title: "Local comment",
            explanation: "Keep this local",
            localComment: { body: "Keep this local" },
          }]}
          virtualized={false}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("article", {
            name: "Saved local comment on src/a.ts:1",
          }),
        ).toBeTruthy(),
      );
      expect(screen.getByText("Keep this local")).toBeTruthy();
      expect(screen.getByText("Mock reviewer")).toBeTruthy();
      expect(screen.getByText("Thanks — threaded replies are UI-only for now.")).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Add reply…" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });

  it("preloads walkthrough languages and active themes before the non-virtualized diff", async () => {
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
      const { preloadHighlighter } = await import("@pierre/diffs");
      const preload = vi.mocked(preloadHighlighter);
      const patch =
        "diff --git a/src/main.go b/src/main.go\n--- a/src/main.go\n+++ b/src/main.go\n@@ -1 +1,2 @@\n package main\n+func main() {}\n";
      const parsed = parseReviewDiff(patch);
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="src/main.go"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          virtualized={false}
        />,
      );
      await waitFor(() => expect(preload).toHaveBeenCalled());
      expect(preload.mock.calls[0]?.[0]).toEqual({
        langs: ["go"],
        themes: ["pierre-dark", "pierre-light"],
      });
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });
});

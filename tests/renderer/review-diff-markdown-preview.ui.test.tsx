// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDiffView } from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

const patch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-# Before",
  "+# Complete head",
  "",
].join("\n");

function installVerifiedHead(): void {
  desktop = installDesktopDouble({
    "/v1/reviews/diff-file": () =>
      success({
        state: "ready",
        oldFile: { name: "README.md", contents: "# Before\n\nTail\n" },
        newFile: {
          name: "README.md",
          contents: "# Complete head\n\nTail paragraph\n",
        },
      }),
  });
}

function renderPreview(markdownPreviewActive: boolean) {
  const parsed = parseReviewDiff(patch);
  return render(
    <ReviewDiffView
      patch={patch}
      parsedFiles={parsed.files}
      fileStatsByPath={parsed.statsByPath}
      selectedPath="README.md"
      preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
      collapsedPaths={new Set()}
      markdownPreviewActive={markdownPreviewActive}
      onMarkdownPreviewChange={() => undefined}
      onPreferencesChange={() => undefined}
      onCollapsedPathsChange={() => undefined}
      sourceSession={{ profileId: "profile", sessionId: "session" }}
      localCommentAuthoring={{
        enabled: true,
        onSave: vi.fn(async () => undefined),
      }}
    />,
  );
}

/** Stubs Pierre's shadow-root stylesheet requirement in for one test body. */
async function withPierreSupport(body: () => Promise<void>): Promise<void> {
  const stubbed = window.CSSStyleSheet.prototype.replaceSync === undefined;
  if (stubbed) window.CSSStyleSheet.prototype.replaceSync = () => undefined;
  try {
    await body();
  } finally {
    if (stubbed) {
      // oxlint-disable-next-line no-dynamic-delete -- restores the exact own property this helper added.
      delete (window.CSSStyleSheet.prototype as { replaceSync?: unknown })
        .replaceSync;
    }
  }
}

describe("review diff Markdown preview", () => {
  it("replaces the code view with its own scrolling preview pane", async () => {
    installVerifiedHead();
    await withPierreSupport(async () => {
      const { container, rerender } = renderPreview(true);

      const preview = await screen.findByRole("article", {
        name: "Preview of README.md",
      });
      expect(preview.getAttribute("data-review-diff-markdown-pane")).toBe(
        "README.md",
      );
      expect(
        screen.getByRole("heading", { name: "Complete head" }),
      ).toBeTruthy();
      expect(preview.textContent).toContain("Tail paragraph");
      expect(preview.textContent).not.toContain("Before");
      // The virtualized viewport is gone, not merely empty: a collapsed
      // CodeView item is 44 virtual pixels tall however long the Markdown is,
      // which shortens the scroll range for every file after it.
      expect(container.querySelector(".review-diff-viewport")).toBeNull();

      const parsed = parseReviewDiff(patch);
      rerender(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="README.md"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          markdownPreviewActive={false}
          onMarkdownPreviewChange={() => undefined}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          sourceSession={{ profileId: "profile", sessionId: "session" }}
          localCommentAuthoring={{
            enabled: true,
            onSave: vi.fn(async () => undefined),
          }}
        />,
      );

      await waitFor(() =>
        expect(
          screen.queryByRole("article", { name: "Preview of README.md" }),
        ).toBeNull(),
      );
      expect(container.querySelector(".review-diff-viewport")).toBeTruthy();
    });
  });

  it("previews rather than falling back to the plain text patch", async () => {
    installVerifiedHead();
    renderPreview(true);

    const preview = await screen.findByRole("article", {
      name: "Preview of README.md",
    });
    expect(preview.textContent).toContain("Tail paragraph");
    expect(
      screen.queryByRole("region", { name: "Plain text diff" }),
    ).toBeNull();
  });
});

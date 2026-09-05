// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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

describe("review diff Markdown preview", () => {
  it("renders complete verified head Markdown without inline commenting", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
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
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-# Before",
      "+# Complete head",
      "",
    ].join("\n");
    const parsed = parseReviewDiff(patch);
    try {
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="README.md"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          markdownPreviewPaths={new Set(["README.md"])}
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

      const preview = await screen.findByRole("article", {
        name: "Preview of README.md",
      });
      expect(
        screen.getByRole("heading", { name: "Complete head" }),
      ).toBeTruthy();
      expect(preview.textContent).toContain("Tail paragraph");
      expect(preview.textContent).not.toContain("Before");
      expect(
        screen.queryByRole("button", { name: "Add comment on README.md" }),
      ).toBeNull();
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });
});

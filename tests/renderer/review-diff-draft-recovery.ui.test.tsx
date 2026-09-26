// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReviewDiffView,
  type LocalCommentLocation,
  type PendingReviewComposerActions,
} from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";
import { PatchdeskApiError } from "../../src/renderer/src/api-client";

afterEach(cleanup);

const BEFORE_REFRESH =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
// Refresh removed the added line the draft was on; the change is now on line 3.
const AFTER_REFRESH =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n two\n-old\n+newer\n";

/** The accessible fallback renders the composer synchronously, without Pierre's code view. */
async function withFallbackDom(run: () => Promise<void>): Promise<void> {
  const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
  Object.defineProperty(window, "CSSStyleSheet", {
    configurable: true,
    value: undefined,
  });
  try {
    await run();
  } finally {
    if (styleSheet === undefined)
      Reflect.deleteProperty(window, "CSSStyleSheet");
    else Object.defineProperty(window, "CSSStyleSheet", styleSheet);
  }
}

function diffView(
  patch: string,
  authorableLine: number,
  pendingReviewComposer: PendingReviewComposerActions,
): React.JSX.Element {
  const parsed = parseReviewDiff(patch);
  return (
    <ReviewDiffView
      patch={patch}
      parsedFiles={parsed.files}
      fileStatsByPath={parsed.statsByPath}
      selectedPath="src/a.ts"
      preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
      collapsedPaths={new Set()}
      onPreferencesChange={() => undefined}
      onCollapsedPathsChange={() => undefined}
      localCommentAuthoring={{
        enabled: true,
        canAuthor: (location: LocalCommentLocation) =>
          location.line === authorableLine,
        onSave: vi.fn(async () => undefined),
      }}
      pendingReviewComposer={pendingReviewComposer}
      virtualized={false}
    />
  );
}

function addedLineCommentButton(): HTMLButtonElement {
  const button = document
    .querySelector('[data-line-type="change-addition"]')
    ?.querySelector<HTMLButtonElement>(
      'button[aria-label="Add comment on src/a.ts"]',
    );
  if (!button) throw new Error("Expected an inline comment action");
  return button;
}

describe("a failed inline draft whose lines Refresh removed", () => {
  it("shows the recovery prompt, and selecting a new line restores the draft into the composer", async () => {
    await withFallbackDom(async () => {
      const user = userEvent.setup();
      const pendingReviewComposer: PendingReviewComposerActions = {
        state: { state: "none" },
        busy: false,
        onStartReview: vi.fn(async () => {
          throw new PatchdeskApiError(
            "pending_review",
            409,
            false,
            "corr",
            "A pending review already exists.",
          );
        }),
        onAddReviewComment: vi.fn(async () => undefined),
      };
      const view = render(diffView(BEFORE_REFRESH, 1, pendingReviewComposer));
      await user.click(addedLineCommentButton());
      await user.type(
        screen.getByRole("textbox", { name: "Inline comment" }),
        "Keep this draft",
      );
      await user.click(screen.getByRole("button", { name: "Start a review" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("textbox", { name: "Inline comment" }),
        ).toBeNull(),
      );

      view.rerender(diffView(AFTER_REFRESH, 3, pendingReviewComposer));

      expect(screen.getByRole("region", { name: "Saved draft" })).toBeTruthy();
      await user.click(addedLineCommentButton());
      expect(
        (
          screen.getByRole("textbox", {
            name: "Inline comment",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Keep this draft");
      expect(screen.queryByRole("region", { name: "Saved draft" })).toBeNull();
    });
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderReviewDiffAnnotation } from "../../src/renderer/src/components/review-diff-finding-card";
import {
  ReviewDiffView,
  type ReviewInlineAnnotation,
} from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";
import { parseGitHubThreadId } from "../../src/domain/ids";
import { parsePullRequestInput } from "../../src/domain/pull-request";
import { installDesktopDouble, success } from "./fake-desktop-response";
import type * as PierreDiffs from "@pierre/diffs";

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

let desktop: ReturnType<typeof installDesktopDouble> | undefined;
afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

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

const imageMarkdown =
  "![Screenshot](/centraldigital/patchdesk/raw/main/shot.png)";

const pullRequest = (() => {
  const parsed = parsePullRequestInput(
    "https://github.com/centraldigital/patchdesk/pull/42",
  );
  if (parsed._tag === "err") throw new Error("Fixture pull request is invalid");
  return parsed.value;
})();

const threadId = parseGitHubThreadId("thread-1");
if (threadId._tag === "err")
  throw new Error("test fixture thread id must parse");

const baseAnnotation = {
  id: "annotation-1",
  path: "src/a.ts",
  start: 1,
  end: 1,
  side: "new",
  severity: "P1",
  title: "Missing boundary check",
  explanation: "The added branch accepts an invalid value.",
} satisfies ReviewInlineAnnotation;

/** One inline card per body-carrying overlay `renderReviewDiffAnnotation` dispatches on. */
const bodyCards = [
  {
    name: "pending conversation",
    overlay: {
      pendingConversation: {
        localId: "local-1",
        status: "sending",
        body: imageMarkdown,
        onDismiss: () => undefined,
      },
    },
  },
  {
    name: "pending review write",
    overlay: {
      pendingReviewWrite: {
        localId: "local-2",
        status: "sending",
        action: "start",
        body: imageMarkdown,
        onDismiss: () => undefined,
      },
    },
  },
  {
    name: "pending review thread",
    overlay: {
      pendingReviewThread: {
        threadId: threadId.value,
        body: imageMarkdown,
        nodeId: "PRRC_1",
      },
    },
  },
  {
    name: "conversation thread",
    overlay: {
      conversationThread: {
        target: { _tag: "thread", id: threadId.value },
        state: "open",
        comments: [
          {
            id: "c-1",
            author: "reviewer",
            body: imageMarkdown,
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    },
  },
] satisfies ReadonlyArray<{
  readonly name: string;
  readonly overlay: Partial<ReviewInlineAnnotation>;
}>;

function renderAnnotationCard(
  overlay: Partial<ReviewInlineAnnotation>,
  bodyContext: Parameters<typeof renderReviewDiffAnnotation>[3],
): void {
  const card = renderReviewDiffAnnotation(
    {
      side: "additions",
      lineNumber: 1,
      metadata: { ...baseAnnotation, ...overlay },
    },
    (thread) => thread,
    undefined,
    bodyContext,
  );
  if (card === null) throw new Error("expected an inline annotation card");
  render(card);
}

describe("inline card body context", () => {
  it.each(bodyCards)(
    "resolves an image in a $name card against the body context it is given",
    async ({ overlay }) => {
      const dataUri = "data:image/png;base64,AAAA";
      desktop = installDesktopDouble({
        "/v1/reviews/markdown-image": () => success({ dataUri }),
      });

      renderAnnotationCard(overlay, {
        pullRequest,
        profileId: "centraldigital",
      });

      const image = await screen.findByRole("img", { name: "Screenshot" });
      expect(image.getAttribute("src")).toBe(dataUri);
    },
  );

  it.each(bodyCards)(
    "keeps the placeholder in a $name card when no body context is given",
    ({ overlay }) => {
      renderAnnotationCard(overlay, {});

      expect(screen.getByText(/Screenshot/)).toBeTruthy();
      expect(screen.queryByRole("img")).toBeNull();
    },
  );
});

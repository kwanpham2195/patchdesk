// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import {
  callBody,
  callPath,
  pending,
  projection,
  providerCatalog,
  sha,
} from "./review-workbench-fixtures";

const reviewedSha = "b".repeat(40);
// Old-side line 1 is `base` here but `reviewed` in the since-review patch: same number, different code.
const fullPatch =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-base\n+changed\n+later\n";
const sincePatch =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-reviewed\n+changed\n+later\n";

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

describe("ReviewWorkbenchFlow Since your review", () => {
  it("offers comments only on head-side lines and anchors them to the head", async () => {
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/insight-providers") return providerCatalog;
      if (input.path === "/v1/reviews/since-review-diff")
        return { baseSha: reviewedSha, headSha: sha, patch: sincePatch };
      if (input.path === "/v1/reviews/pending-review/command")
        return { pendingReview: pending("pending") };
      throw new Error(input.path);
    });
    render(
      <ReviewWorkbenchFlow
        workbench={projection({
          fullPatch,
          pendingReview: pending("none"),
          commits: [reviewedSha, sha].map((commit) => ({
            sha: commit,
            message: "Commit",
            author: "author",
            authoredAt: "2026-08-01T00:00:00.000Z",
            isHead: commit === sha,
          })),
          conversation: {
            prDescription: "",
            entries: [
              {
                _tag: "ReviewSummary",
                review: {
                  id: "1",
                  author: "octocat",
                  body: "",
                  event: "COMMENTED",
                  submittedAt: "2026-08-01T00:00:00.000Z",
                  canDismiss: false,
                  commitId: reviewedSha,
                },
              },
            ],
          },
        })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await user.click(
      await screen.findByRole("button", { name: "Since your review" }),
    );
    await screen.findAllByText(/reviewed/);

    const commentTargets = screen
      .getAllByRole("button", { name: "Add comment on src/a.ts" })
      .map((button) => button.closest("li")?.textContent ?? "");
    expect(commentTargets.some((row) => row.includes("reviewed"))).toBe(false);
    expect(commentTargets.some((row) => row.includes("later"))).toBe(true);

    const laterRow = screen
      .getAllByRole("button", { name: "Add comment on src/a.ts" })
      .find((button) => button.closest("li")?.textContent?.includes("later"));
    if (laterRow === undefined) throw new Error("missing head-side action");
    await user.click(laterRow);
    const composer = screen.getByRole("region", {
      name: "Inline comment composer",
    });
    await user.type(
      within(composer).getByRole("textbox", { name: "Inline comment" }),
      "After the review",
    );
    await user.click(
      within(composer).getByRole("button", { name: "Start a review" }),
    );

    const command = request.mock.calls.find(
      ([input]) => callPath(input) === "/v1/reviews/pending-review/command",
    );
    expect(JSON.stringify(callBody(command?.[0]))).toContain(
      '"path":"src/a.ts","startLine":2,"line":2,"side":"new"',
    );
  });
});

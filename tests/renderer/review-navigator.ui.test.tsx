// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewNavigator } from "../../src/renderer/src/components/review-navigator";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { ReviewInlineAnnotation } from "../../src/renderer/src/components/review-diff-view";

const callbacks = {
  onSectionChange: vi.fn(),
  onFileSelect: vi.fn(),
  onCommitSelect: vi.fn(),
  onThreadSelect: vi.fn(),
};

function renderNavigator(commits: WorkbenchResponse["commits"]): void {
  render(
    <ReviewNavigator
      patch=""
      commits={commits}
      conversationThreadEntries={[]}
      section="commits"
      {...callbacks}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("review navigator", () => {
  it("shows a zero count beside Commits", () => {
    renderNavigator([]);

    expect(screen.getByRole("tab", { name: "Commits 0" })).toBeTruthy();
  });

  it("shows the complete commit count beside Commits", () => {
    renderNavigator([
      {
        sha: "a".repeat(40),
        message: "First commit",
        author: "Author",
        authoredAt: "2026-08-01T00:00:00.000Z",
        isHead: false,
      },
      {
        sha: "b".repeat(40),
        message: "Second commit",
        author: "Author",
        authoredAt: "2026-08-02T00:00:00.000Z",
        isHead: true,
      },
    ]);

    expect(screen.getByRole("tab", { name: "Commits 2" })).toBeTruthy();
  });

  it("browses only the Scope filter's files while Commits and Threads stay complete", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/docs/guide.md b/docs/guide.md",
      "--- a/docs/guide.md",
      "+++ b/docs/guide.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const thread: ReviewInlineAnnotation = {
      id: "thread-1",
      path: "docs/guide.md",
      start: 1,
      end: 1,
      side: "new",
      severity: "info",
      title: "Thread",
      explanation: "",
      // SAFETY: `threadId` is a branded GitHub node id; `as never` widens the
      // plain fixture string the same way the workbench fixtures do.
      pendingReviewThread: {
        threadId: "PRRT_1" as never,
        body: "Pending reply",
        nodeId: "PRR_1",
      },
    };
    const commits: WorkbenchResponse["commits"] = [
      {
        sha: "a".repeat(40),
        message: "First commit",
        author: "Author",
        authoredAt: "2026-08-01T00:00:00.000Z",
        isHead: true,
      },
    ];
    const { container } = render(
      <ReviewNavigator
        patch={patch}
        commits={commits}
        conversationThreadEntries={[thread]}
        section="files"
        visiblePaths={new Set(["src/a.ts"])}
        {...callbacks}
      />,
    );

    const tree = container.querySelector("file-tree-container")?.shadowRoot;
    if (tree === null || tree === undefined)
      throw new Error("Expected a tree shadow root");
    expect(
      [...tree.querySelectorAll("[data-item-path]")].map((row) =>
        row.getAttribute("data-item-path"),
      ),
    ).toEqual(["src/", "src/a.ts"]);
    expect(screen.getByRole("tab", { name: "Commits 1" })).toBeTruthy();
    // The Threads count is projected from every changed file, so a thread on
    // the filtered-out docs file still has a row.
    expect(screen.getByRole("tab", { name: "Threads 1" })).toBeTruthy();
  });
});

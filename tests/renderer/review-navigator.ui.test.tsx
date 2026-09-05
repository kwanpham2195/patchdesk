// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewNavigator } from "../../src/renderer/src/components/review-navigator";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";

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
});

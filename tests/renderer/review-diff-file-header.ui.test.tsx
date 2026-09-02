// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FileChangeCounts } from "../../src/renderer/src/components/review-diff-file-header";

afterEach(cleanup);

const stats = { path: "src/a.ts", additions: 3, deletions: 1 };

describe("FileChangeCounts", () => {
  it("badges a file that Analysis findings cite with their count and highest severity", () => {
    render(
      <FileChangeCounts stats={stats} findings={{ count: 2, highest: "P1" }} />,
    );
    const badge = screen.getByRole("img", { name: "2 findings, highest P1" });
    expect(badge.textContent).toBe("2");
    expect(badge.className).toContain("text-destructive");
    expect(screen.getByLabelText("3 additions, 1 deletions")).toBeTruthy();
  });

  it("shows no badge for a file without findings", () => {
    render(<FileChangeCounts stats={stats} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("3 additions, 1 deletions")).toBeTruthy();
  });
});

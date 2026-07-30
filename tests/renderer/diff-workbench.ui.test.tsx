// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffWorkbench } from "../../src/renderer/src/components/diff-workbench";

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n";
afterEach(cleanup);
describe("diff workbench", () => {
  it("uses the Pierre navigator and opens a mapped finding without filter controls", () => {
    render(<DiffWorkbench patch={patch} finding={{ file: "src/b.ts", lineStart: 1, diffSide: "new" }} />);
    expect(screen.queryByLabelText("Search changed files")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Findings" })).toBeNull();
    expect(screen.getByText("src/b.ts", { selector: "p" })).toBeTruthy();
  });

  it("keeps normal PR context out of the standalone diff surface", () => {
    render(<DiffWorkbench patch={patch} />);

    expect(screen.queryByLabelText("Review context")).toBeNull();
    expect(screen.getByLabelText("Diff workbench").className).not.toContain(
      "_18rem",
    );
  });
});

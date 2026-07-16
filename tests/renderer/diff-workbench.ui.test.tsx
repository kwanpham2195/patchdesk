// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffWorkbench } from "../../src/renderer/src/components/diff-workbench";

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n";
describe("diff workbench", () => {
  it("filters changed files and navigates a mapped finding", async () => {
    const user = userEvent.setup(); render(<DiffWorkbench patch={patch} finding={{ file: "src/b.ts", lineStart: 1, diffSide: "new" }} />);
    await user.type(screen.getByLabelText("Search changed files"), "b.ts"); expect(screen.queryByRole("button", { name: "src/a.ts" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Go to finding" })); expect(screen.getByText("Selected file: src/b.ts")).toBeTruthy();
  });
});

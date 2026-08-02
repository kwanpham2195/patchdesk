// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DiffWorkbench } from "../../src/renderer/src/components/diff-workbench";

afterEach(() => {
  cleanup();
});

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

describe("docked diff state boundaries", () => {
  it("keeps the docked workbench within its desktop scroll boundary", () => {
    render(<DiffWorkbench patch={patch} />);

    expect(screen.getByText("src/a.ts", { selector: "p" })).toBeTruthy();
    expect(screen.getByLabelText("Diff workbench").className).toContain(
      "min-[1100px]:h-[calc(100vh-3.5rem)]",
    );
    expect(screen.getByLabelText("Diff workbench").className).toContain(
      "overflow-hidden",
    );
  });
});

// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const treeState = vi.hoisted(() => ({
  options: undefined as { onSelectionChange?: (paths: readonly string[]) => void } | undefined,
  model: {
    selectOnlyPath: vi.fn<(path: string) => void>(),
    scrollToPath: vi.fn<(path: string, options: { focus: boolean; offset: "nearest" }) => void>(),
  },
}));

vi.mock("@pierre/trees/react", () => ({
  FileTree: (props: { "data-active-path"?: string }) => (
    <div data-active-path={props["data-active-path"]} />
  ),
  useFileTree: (options: typeof treeState.options) => {
    treeState.options = options;
    return { model: treeState.model };
  },
}));

vi.mock("../../src/renderer/src/components/review-diff-view", () => ({
  ReviewDiffView: (props: { onActiveFileChange?: (path: string) => void }) => (
    <button type="button" onClick={() => props.onActiveFileChange?.("src/b.ts")}>
      Emit active path
    </button>
  ),
}));

import { DiffWorkbench } from "../../src/renderer/src/components/diff-workbench";
import { PierreFileTree } from "../../src/renderer/src/components/pierre-file-tree";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  treeState.options = undefined;
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
  it("keeps direct selection separate from a passive active path", async () => {
    const user = userEvent.setup();
    render(<DiffWorkbench patch={patch} />);

    expect(screen.getByText("src/a.ts", { selector: "p" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Emit active path" }));

    expect(screen.getByText("src/a.ts", { selector: "p" })).toBeTruthy();
    expect(screen.getByLabelText("Diff workbench").className).toContain(
      "min-[1100px]:h-[calc(100vh-3.5rem)]",
    );
    expect(screen.getByLabelText("Diff workbench").className).toContain(
      "overflow-hidden",
    );
    expect(screen.getByLabelText("Diff workbench").querySelector("[data-active-path=\"src/b.ts\"]")).toBeTruthy();
  });

  it("guards passive tree selection from the explicit callback", () => {
    const onSelect = vi.fn();
    render(
      <PierreFileTree
        files={[
          { path: "src/a.ts", stats: { path: "src/a.ts", additions: 1, deletions: 0 }, gitStatus: undefined },
          { path: "src/b.ts", stats: { path: "src/b.ts", additions: 1, deletions: 0 }, gitStatus: undefined },
        ]}
        activePath="src/a.ts"
        onSelect={onSelect}
      />,
    );

    expect(treeState.model.selectOnlyPath).toHaveBeenCalledWith("src/a.ts");
    expect(treeState.model.scrollToPath).toHaveBeenCalledWith("src/a.ts", {
      focus: false,
      offset: "nearest",
    });
    expect(onSelect).not.toHaveBeenCalled();

    act(() => treeState.options?.onSelectionChange?.(["src/b.ts"]));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("src/b.ts");
  });
});

// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  PierreFileTree,
  type PierreFileTreeItem,
} from "../../src/renderer/src/components/pierre-file-tree";

afterEach(cleanup);

const fileA: PierreFileTreeItem = {
  path: "src/a.ts",
  stats: { path: "src/a.ts", additions: 1, deletions: 1 },
  gitStatus: undefined,
};
const fileB: PierreFileTreeItem = {
  path: "src/b.ts",
  stats: { path: "src/b.ts", additions: 1, deletions: 1 },
  gitStatus: undefined,
};
const fileC: PierreFileTreeItem = {
  path: "src/c.ts",
  stats: { path: "src/c.ts", additions: 1, deletions: 1 },
  gitStatus: undefined,
};

function treeContainer(container: HTMLElement): Element {
  const element = container.querySelector("file-tree-container");
  if (element === null) throw new Error("Expected a file-tree-container");
  return element;
}

describe("PierreFileTree", () => {
  it("keeps the same tree instance when only the active file changes", () => {
    const { container, rerender } = render(
      <PierreFileTree
        files={[fileA, fileB]}
        activePath="src/a.ts"
        onSelect={() => {}}
      />,
    );
    const before = treeContainer(container);

    rerender(
      <PierreFileTree
        files={[fileA, fileB]}
        activePath="src/b.ts"
        onSelect={() => {}}
      />,
    );
    const after = treeContainer(container);

    // This is the load-bearing proof: `useFileTree` captures its
    // `paths`/`gitStatus` options once at construction and never re-reads
    // them, so the tree only needs to be rebuilt when the file SET changes,
    // not when the active file moves within an unchanged set. Element
    // identity (not just "still renders") proves no unmount/remount
    // happened for this prop change.
    expect(after).toBe(before);
  });

  it("rebuilds the tree when the file set (a different reviewed revision) changes", () => {
    const { container, rerender } = render(
      <PierreFileTree
        files={[fileA, fileB]}
        activePath="src/a.ts"
        onSelect={() => {}}
      />,
    );
    const before = treeContainer(container);

    // A different revision is a different file set: `useFileTree` captured
    // the old `paths`/`gitStatus` once and never re-reads them, so this
    // case -- unlike an active-file change -- does need a fresh model.
    rerender(
      <PierreFileTree
        files={[fileA, fileB, fileC]}
        activePath="src/a.ts"
        onSelect={() => {}}
      />,
    );
    const after = treeContainer(container);

    expect(after).not.toBe(before);
  });
});

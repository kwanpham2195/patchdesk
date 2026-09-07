// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { changeScopeFromPatch } from "../../src/domain/change-scope";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type * as PierreDiffs from "@pierre/diffs";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

/**
 * The Scope filter `ReviewWorkbenchFlow` wires between the Insights Scope card,
 * the Browse tree, and the diff toolbar. Split from
 * `review-workbench-flow.ui.test.tsx` only because that file sits at the size
 * ceiling.
 */

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

/** The Browse tree's rows, read from the file tree's shadow root. */
function browsedPaths(): ReadonlyArray<string> {
  const tree = document
    .querySelector("file-tree-container")
    ?.shadowRoot?.querySelectorAll("[data-item-path]");
  if (tree === undefined) throw new Error("Expected a Browse file tree");
  return [...tree].map((row) => row.getAttribute("data-item-path") ?? "");
}

/** What the pane header, the Browse tree and the diff pane each name. */
function namedFile() {
  const attribute = (selector: string, name: string): string | undefined =>
    document.querySelector(selector)?.getAttribute(name) ?? undefined;
  return {
    header: attribute(
      "[data-diff-workbench-header-path]",
      "data-diff-workbench-header-path",
    ),
    tree: attribute("[data-active-path]", "data-active-path"),
    pane:
      screen
        .getByRole("region", { name: "Review diff" })
        .getAttribute("data-selected-path") ?? undefined,
  };
}

/**
 * Opens the toolbar's Scope menu. Base UI's menu trigger opens on a real
 * mousedown, which jsdom's synthetic pointer sequence does not satisfy, so the
 * keyboard is the only way in here; the pointer path is checked live.
 */
async function openScopeMenu(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  screen.getByRole("button", { name: "Scope filter" }).focus();
  await user.keyboard("{Enter}");
}

const scopedPatch = [
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

const commitSha = "c".repeat(40);

/** The canonical projection carrying the two-bucket patch and its Scope card. */
function scopedProjection(
  overrides: Parameters<typeof projection>[0] = {},
): ReturnType<typeof projection> {
  const scope = changeScopeFromPatch(scopedPatch);
  return projection({
    fullPatch: scopedPatch,
    // The wire type the projection carries is mutable; the domain's is not.
    scope: { ...scope, buckets: [...scope.buckets] },
    ...overrides,
  });
}

describe("ReviewWorkbenchFlow Scope filter", () => {
  it("filters the Diff to a Scope bucket and restores it from the toolbar picker", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    render(
      <ReviewWorkbenchFlow
        workbench={scopedProjection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.click(screen.getByRole("button", { name: /Docs/ }));

    expect(
      screen.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(browsedPaths()).toEqual(["docs/", "docs/guide.md"]);

    await openScopeMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: "All files" }));
    expect(browsedPaths()).toEqual([
      "docs/",
      "docs/guide.md",
      "src/",
      "src/a.ts",
    ]);
  });

  it("chooses a Scope bucket from the Diff toolbar and shows it on the Scope card", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    render(
      <ReviewWorkbenchFlow
        workbench={scopedProjection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await openScopeMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: /Docs/ }));
    expect(browsedPaths()).toEqual(["docs/", "docs/guide.md"]);

    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    expect(
      screen.getByRole("button", { name: /Docs/ }).getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await openScopeMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: "All files" }));
    expect(browsedPaths()).toEqual([
      "docs/",
      "docs/guide.md",
      "src/",
      "src/a.ts",
    ]);
  });

  it("keeps the header, the tree and the pane on one visible file across a section switch", async () => {
    bridge(async (input) =>
      input.path === "/v1/reviews/detect-updates"
        ? { updatesAvailable: false }
        : Promise.reject(new Error(input.path)),
    );
    render(
      <ReviewWorkbenchFlow
        workbench={scopedProjection()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await openScopeMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: /Docs/ }));
    expect(namedFile()).toEqual({
      header: "docs/guide.md",
      tree: "docs/guide.md",
      pane: "docs/guide.md",
    });

    // Threads and Browse are ways into the diff, not file choices, so the
    // selection has to survive them rather than fall back to a file the Docs
    // bucket hides.
    await user.click(screen.getByRole("tab", { name: /^Threads/ }));
    await user.click(screen.getByRole("tab", { name: /^Browse/ }));
    expect(namedFile()).toEqual({
      header: "docs/guide.md",
      tree: "docs/guide.md",
      pane: "docs/guide.md",
    });

    await openScopeMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: "All files" }));
    expect(namedFile()).toEqual({
      header: "docs/guide.md",
      tree: "docs/guide.md",
      pane: "docs/guide.md",
    });
    expect(browsedPaths()).toContain("docs/guide.md");
  });

  it("clears the Scope filter when a commit is selected", async () => {
    const commitDiff = {
      commit: {
        sha: commitSha,
        message: "Rewrite the guide",
        author: "fixture",
        authoredAt: "2026-08-01T00:00:00.000Z",
        isHead: true,
      },
      position: 1,
      total: 1,
      patch: scopedPatch,
      fileCount: 2,
      additions: 2,
      deletions: 2,
    };
    bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/commit-diff") return commitDiff;
      throw new Error(input.path);
    });
    render(
      <ReviewWorkbenchFlow
        workbench={scopedProjection({ commits: [commitDiff.commit] })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.click(screen.getByRole("button", { name: /Docs/ }));
    expect(browsedPaths()).toEqual(["docs/", "docs/guide.md"]);

    // Opening Commits selects the first commit on its own, so the filter has
    // to be gone by then, not only once a commit row is clicked.
    await user.click(screen.getByRole("tab", { name: /^Commits/ }));
    expect(screen.queryByRole("button", { name: "Scope filter" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Rewrite the guide/ }));

    expect(screen.queryByRole("button", { name: "Scope filter" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: /^Browse/ }));
    expect(browsedPaths()).toEqual([
      "docs/",
      "docs/guide.md",
      "src/",
      "src/a.ts",
    ]);
  });
});

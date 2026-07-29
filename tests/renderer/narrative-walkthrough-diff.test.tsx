// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: ({
    patch,
    options,
  }: {
    patch: string;
    options: { diffStyle: "unified" | "split"; overflow: "scroll" | "wrap" };
  }) => (
    <div
      data-pierre-mock="true"
      data-diff-style={options.diffStyle}
      data-overflow={options.overflow}
      data-patch={patch}
    />
  ),
}));

import { NarrativeWalkthroughDiff } from "../../src/renderer/src/components/narrative-walkthrough-diff";
import type { NarrativeHunk } from "../../src/domain/narrative-walkthrough";

afterEach(() => cleanup());

const hunk: NarrativeHunk = {
  id: "h1",
  path: "src/example.ts" as never,
  header: "@@ -10 +10 @@",
  raw: "@@ -10 +10 @@\n-old\n+new",
  oldStart: 10,
  oldLines: 1,
  newStart: 10,
  newLines: 1,
};

describe("narrative walkthrough diff block", () => {
  it("renders a unique block id and the filtered raw patch", () => {
    render(<NarrativeWalkthroughDiff blockId="block-1" hunkIds={[hunk.id]} hunks={[hunk]} allHunks={[hunk]} />);
    const block = document.querySelector('[data-walkthrough-diff-block]');
    expect(block).toBeTruthy();
    expect(block?.getAttribute("data-walkthrough-diff-block")).toBe("block-1");
  });

  it("filters the original raw patch to the requested hunk and preserves its file header", () => {
    const secondHunk: NarrativeHunk = {
      ...hunk,
      id: "h2",
      path: "src/second.ts" as never,
      header: "@@ -20 +20 @@",
      raw: "@@ -20 +20 @@\n-old-second\n+new-second",
      oldStart: 20,
      newStart: 20,
    };
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      hunk.raw,
      "diff --git a/src/second.ts b/src/second.ts",
      "--- a/src/second.ts",
      "+++ b/src/second.ts",
      secondHunk.raw,
      "",
    ].join("\n");
    render(
      <NarrativeWalkthroughDiff
        blockId="block-filter"
        patch={patch}
        hunkIds={[secondHunk.id]}
        hunks={[secondHunk]}
        allHunks={[hunk, secondHunk]}
      />,
    );
    const renderedPatch = document.querySelector('[data-pierre-mock="true"]')?.getAttribute("data-patch") ?? "";
    expect(renderedPatch).toContain("diff --git a/src/second.ts b/src/second.ts");
    expect(renderedPatch).not.toContain("src/example.ts");
  });

  it("honors the unified/split and wrap preferences from the user", async () => {
    const user = userEvent.setup();
    const { container } = render(<NarrativeWalkthroughDiff blockId="block-prefs" hunkIds={[hunk.id]} hunks={[hunk]} allHunks={[hunk]} />);
    const buttons = container.querySelectorAll('button');
    const splitButton = Array.from(buttons).find((b) => b.textContent?.includes('Split'));
    const wrapButton = Array.from(buttons).find((b) => b.textContent?.includes('Wrap'));
    if (!splitButton || !wrapButton) throw new Error("Missing buttons");
    await user.click(splitButton);
    let block = container.querySelector('[data-pierre-mock="true"]');
    expect(block?.getAttribute("data-diff-style")).toBe("split");
    await user.click(wrapButton);
    block = container.querySelector('[data-pierre-mock="true"]');
    expect(block?.getAttribute("data-overflow")).toBe("wrap");
  });

  it("honors appearance and diff-theme events", () => {
    const { container } = render(<NarrativeWalkthroughDiff blockId="block-theme" hunkIds={[hunk.id]} hunks={[hunk]} allHunks={[hunk]} />);
    const event = new CustomEvent("patchdesk:appearance", { detail: "light" });
    window.dispatchEvent(event);
    const themeEvent = new CustomEvent("patchdesk:diff-theme", { detail: { light: "github-light", dark: "github-dark" } });
    window.dispatchEvent(themeEvent);
    expect(container.querySelectorAll('[data-pierre-mock="true"]').length).toBeGreaterThan(0);
  });
});

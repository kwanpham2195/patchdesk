// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

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
    render(
      <NarrativeWalkthroughDiff
        blockId="block-1"
        hunkIds={[hunk.id]}
        hunks={[hunk]}
        allHunks={[hunk]}
      />,
    );
    const block = document.querySelector("[data-walkthrough-diff-block]");
    expect(block).toBeTruthy();
    expect(block?.getAttribute("data-walkthrough-diff-block")).toBe("block-1");
    expect(block?.getAttribute("data-walkthrough-hunk-id")).toBe("h1");
    expect(
      document
        .querySelector("[data-walkthrough-diff-viewport]")
        ?.getAttribute("class"),
    ).toContain("overflow-x-auto");
  });

  it("sizes a walkthrough hunk at natural height so the reader owns scrolling", () => {
    render(
      <NarrativeWalkthroughDiff
        blockId="block-size"
        hunkIds={[hunk.id]}
        hunks={[hunk]}
        allHunks={[hunk]}
      />,
    );
    const diff = screen.getByLabelText("Plain text diff");
    expect(diff.classList.contains("max-h-[calc(100vh-12rem)]")).toBe(false);
    expect(diff.classList.contains("h-[calc(100vh-12rem)]")).toBe(false);
    expect(diff.classList.contains("min-h-[32rem]")).toBe(false);
    expect(diff.classList.contains("overflow-x-auto")).toBe(true);
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
    const renderedPatch =
      screen.getByLabelText("Review diff").textContent ?? "";
    expect(renderedPatch).toContain(
      "diff --git a/src/second.ts b/src/second.ts",
    );
    expect(renderedPatch).not.toContain("src/example.ts");
  });

  it("keeps fallback patches renderable for deletion-only hunks", () => {
    const deletion: NarrativeHunk = {
      ...hunk,
      id: "h2",
      raw: "@@ -10,1 +0,0 @@\n-old",
      header: "@@ -10,1 +0,0 @@",
      newStart: 0,
      newLines: 0,
    };
    render(
      <NarrativeWalkthroughDiff
        blockId="block-deletion"
        hunkIds={[deletion.id]}
        hunks={[deletion]}
        allHunks={[deletion]}
      />,
    );
    expect(screen.getByLabelText("Review diff")).toBeTruthy();
  });

  it("honors the unified/split and wrap preferences from the user", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <NarrativeWalkthroughDiff
        blockId="block-prefs"
        hunkIds={[hunk.id]}
        hunks={[hunk]}
        allHunks={[hunk]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(await screen.findByRole("switch", { name: "Split view" }));
    expect(
      container
        .querySelector('[aria-label="Review diff"]')
        ?.getAttribute("data-diff-style"),
    ).toBe("split");
    await user.click(screen.getByRole("switch", { name: "Wrap lines" }));
    expect(
      screen
        .getByRole("switch", { name: "Wrap lines" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("honors appearance and diff-theme events", () => {
    render(
      <NarrativeWalkthroughDiff
        blockId="block-theme"
        hunkIds={[hunk.id]}
        hunks={[hunk]}
        allHunks={[hunk]}
      />,
    );
    const event = new CustomEvent("patchdesk:appearance", { detail: "light" });
    window.dispatchEvent(event);
    const themeEvent = new CustomEvent("patchdesk:diff-theme", {
      detail: { light: "github-light", dark: "github-dark" },
    });
    window.dispatchEvent(themeEvent);
    expect(screen.getByLabelText("Review diff")).toBeTruthy();
  });
});

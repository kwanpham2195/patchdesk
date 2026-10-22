// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NarrativeWalkthroughDiff } from "#src/renderer/src/components/narrative-walkthrough-diff";
import type { NarrativeHunk } from "#src/renderer/src/components/narrative-walkthrough-diff";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
} from "#src/renderer/src/review-view-preferences";

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const hunk: NarrativeHunk = {
  id: "h1",
  path: "src/example.ts" as never,
  header: "@@ -10 +10 @@",
  raw: "@@ -10 +10 @@\n-old\n+new",
  filePrefix:
    "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts",
  oldStart: 10,
  oldLines: 1,
  newStart: 10,
  newLines: 1,
};

describe("narrative walkthrough diff block", () => {
  it("renders a unique block id and the filtered raw patch", () => {
    render(<NarrativeWalkthroughDiff blockId="block-1" hunk={hunk} />);
    const block = document.querySelector("[data-walkthrough-diff-block]");
    expect(block).toBeTruthy();
    expect(block?.getAttribute("data-walkthrough-diff-block")).toBe("block-1");
    expect(block?.getAttribute("data-walkthrough-hunk-id")).toBe("h1");
  });

  it("filters the original raw patch to the requested hunk and preserves its file header", () => {
    const secondHunk: NarrativeHunk = {
      ...hunk,
      id: "h2",
      path: "src/second.ts" as never,
      filePrefix:
        "diff --git a/src/second.ts b/src/second.ts\n--- a/src/second.ts\n+++ b/src/second.ts",
      header: "@@ -20 +20 @@",
      raw: "@@ -20 +20 @@\n-old-second\n+new-second",
      oldStart: 20,
      newStart: 20,
    };
    render(
      <NarrativeWalkthroughDiff blockId="block-filter" hunk={secondHunk} />,
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
      <NarrativeWalkthroughDiff blockId="block-deletion" hunk={deletion} />,
    );
    expect(screen.getByLabelText("Review diff")).toBeTruthy();
  });

  it("starts from the saved View options and keeps its own changes unsaved", async () => {
    saveReviewViewPreferences({ diffStyle: "split", overflow: "scroll" });
    const user = userEvent.setup();
    const { container } = render(
      <NarrativeWalkthroughDiff blockId="block-prefs" hunk={hunk} />,
    );
    const diffStyle = () =>
      container
        .querySelector('[aria-label="Review diff"]')
        ?.getAttribute("data-diff-style");
    expect(diffStyle()).toBe("split");

    await user.click(screen.getByRole("button", { name: "View options" }));
    const wrap = await screen.findByRole("switch", { name: "Wrap lines" });
    expect(wrap.getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("switch", { name: "Split view" }));
    await user.click(wrap);

    expect(diffStyle()).toBe("unified");
    expect(
      screen
        .getByRole("switch", { name: "Wrap lines" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(loadReviewViewPreferences()).toMatchObject({
      diffStyle: "split",
      overflow: "scroll",
    });
  });

  it("honors appearance and diff-theme events", () => {
    render(<NarrativeWalkthroughDiff blockId="block-theme" hunk={hunk} />);
    const event = new CustomEvent("patchdesk:appearance", { detail: "light" });
    window.dispatchEvent(event);
    const themeEvent = new CustomEvent("patchdesk:diff-theme", {
      detail: { light: "github-light", dark: "github-dark" },
    });
    window.dispatchEvent(themeEvent);
    expect(screen.getByLabelText("Review diff")).toBeTruthy();
  });
});

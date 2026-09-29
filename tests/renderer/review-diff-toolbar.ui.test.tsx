// @vitest-environment jsdom
import { processFile, type FileDiffMetadata } from "@pierre/diffs";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDiffToolbar } from "../../src/renderer/src/components/review-diff-toolbar";
import type { SinceReviewControl } from "../../src/renderer/src/components/review-diff-changes-menu";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";
import { openToolbarMenu, VIEWED_COUNT } from "./diff-toolbar-menus";

afterEach(cleanup);

const contextControl = {
  disabled: false,
  label: "Context",
  description: "Expand unchanged context",
} as const;

function changedFile(path: string): FileDiffMetadata {
  const file = processFile(
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  );
  if (file === undefined) throw new Error("fixture patch did not parse");
  return file;
}

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof ReviewDiffToolbar>> = {},
): void {
  render(
    <ReviewDiffToolbar
      virtualized
      preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
      selectedPath="README.md"
      onPreferencesChange={vi.fn()}
      contextControl={contextControl}
      contextStatus="ready"
      expandUnchanged={false}
      onExpandUnchangedChange={vi.fn()}
      collapsedPaths={new Set()}
      files={[]}
      onSetAllCollapsed={vi.fn()}
      scopeFilter={{
        buckets: [{ bucket: "docs", files: 1 }],
        activeBucket: undefined,
        onSelect: vi.fn(),
        onClear: vi.fn(),
      }}
      {...overrides}
    />,
  );
}

function sinceReview(
  overrides: Partial<SinceReviewControl> = {},
): SinceReviewControl {
  return {
    active: false,
    disabledReason: undefined,
    loading: false,
    onChange: vi.fn(),
    ...overrides,
  };
}

async function openViewOptions(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "View options" }));
  await screen.findByRole("switch", { name: "Split view" });
}

const displayMode = "Display mode for README.md";

describe("ReviewDiffToolbar Markdown preview switch", () => {
  it("offers no display mode switch for a file without a preview", () => {
    renderToolbar();

    expect(screen.queryByRole("group", { name: displayMode })).toBeNull();
    for (const name of ["Scope filter", "View options", VIEWED_COUNT]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("switches the previewable file to Preview through its callback", async () => {
    const onChange = vi.fn();
    renderToolbar({
      markdownPreview: { path: "README.md", active: false, onChange },
    });

    const group = screen.getByRole("group", { name: displayMode });
    expect(
      ["Diff", "Preview"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      ),
    ).toEqual(["true", "false"]);
    expect(
      group.contains(screen.getByRole("button", { name: "Preview" })),
    ).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("drops the code view's own controls while a preview is showing", () => {
    renderToolbar({
      markdownPreview: {
        path: "README.md",
        active: true,
        onChange: vi.fn(),
      },
      changes: { sinceReview: sinceReview() },
    });

    expect(
      ["Diff", "Preview"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      ),
    ).toEqual(["false", "true"]);
    for (const name of ["Changes", "View options", VIEWED_COUNT]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Scope filter" })).toBeTruthy();
  });

  it("keeps the Patch view choice while a preview is showing", () => {
    renderToolbar({
      markdownPreview: { path: "README.md", active: true, onChange: vi.fn() },
      changes: { patchView: { selected: "committed", onSelect: vi.fn() } },
    });

    expect(
      screen.getByRole("button", { name: "Changes" }).textContent,
    ).toContain("Committed");
  });
});

describe("ReviewDiffToolbar Changes menu", () => {
  it("is absent without a submitted review or a Patch view", () => {
    renderToolbar();

    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
  });

  it("enters the since-review diff in All files mode", async () => {
    const control = sinceReview();
    const onPreferencesChange = vi.fn();
    renderToolbar({ changes: { sinceReview: control }, onPreferencesChange });
    const user = userEvent.setup();

    expect(
      screen.getByRole("button", { name: "Changes" }).textContent,
    ).toContain("All changes");
    await openToolbarMenu(user, "Changes");
    await user.click(
      screen.getByRole("menuitemradio", { name: "Since your review" }),
    );

    expect(control.onChange).toHaveBeenCalledWith(true);
    expect(onPreferencesChange).toHaveBeenCalledWith({ fileMode: "all" });
  });

  it("leaves the since-review diff from All changes", async () => {
    const control = sinceReview({ active: true });
    renderToolbar({ changes: { sinceReview: control } });
    const user = userEvent.setup();

    expect(
      screen.getByRole("button", { name: "Changes" }).textContent,
    ).toContain("Since your review");
    await openToolbarMenu(user, "Changes");
    expect(
      screen
        .getByRole("menuitemradio", { name: "Since your review" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(
      screen.getByRole("menuitemradio", { name: "All changes" }),
    );

    expect(control.onChange).toHaveBeenCalledWith(false);
  });

  it("disables Since your review and says why when the reviewed commit cannot be diffed", async () => {
    const disabledReason = "No commits since your review";
    renderToolbar({
      changes: { sinceReview: sinceReview({ disabledReason }) },
    });
    await openToolbarMenu(userEvent.setup(), "Changes");

    const option = screen.getByRole("menuitemradio", {
      name: "Since your review",
    });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.contains(screen.getByText(disabledReason))).toBe(true);
  });

  it("switches a local Review's Patch view and names it on the trigger", async () => {
    const onSelect = vi.fn();
    renderToolbar({
      changes: { patchView: { selected: "committed", onSelect } },
    });
    const user = userEvent.setup();

    expect(
      screen.getByRole("button", { name: "Changes" }).textContent,
    ).toContain("Committed");
    await openToolbarMenu(user, "Changes");
    const views = screen.getByRole("group", { name: "Patch view" });
    expect(
      ["Combined", "Committed", "Uncommitted"].map((name) =>
        screen
          .getByRole("menuitemradio", { name })
          .getAttribute("aria-checked"),
      ),
    ).toEqual(["false", "true", "false"]);
    expect(views.textContent).toContain("Checkout HEAD to Local snapshot");
    await user.click(
      screen.getByRole("menuitemradio", { name: "Uncommitted" }),
    );

    expect(onSelect).toHaveBeenCalledWith("uncommitted");
  });
});

describe("ReviewDiffToolbar View options", () => {
  it.each(["click", "keyboard"] as const)(
    "opens by %s without the navigation keys tooltip, and one Escape closes it",
    async (opener) => {
      renderToolbar();
      const user = userEvent.setup();

      if (opener === "click")
        await user.click(screen.getByRole("button", { name: "View options" }));
      else await openToolbarMenu(user, "View options");
      await screen.findByRole("dialog", { name: "View options" });

      expect(screen.queryByRole("tooltip")).toBeNull();
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "View options" }),
        ).toBeNull(),
      );
    },
  );

  it.each([
    { name: "All files", from: "selected", to: "all" },
    { name: "Selected", from: "all", to: "selected" },
  ] as const)(
    "chooses $name as the file display mode and names it on the trigger",
    async ({ name, from, to }) => {
      const onPreferencesChange = vi.fn();
      renderToolbar({
        preferences: { ...DEFAULT_REVIEW_VIEW_PREFERENCES, fileMode: from },
        onPreferencesChange,
      });

      expect(
        screen.getByRole("button", { name: "View options" }).textContent,
      ).toContain(from === "all" ? "All files" : "Selected");
      await openViewOptions();
      await userEvent.click(screen.getByRole("button", { name }));

      expect(onPreferencesChange).toHaveBeenCalledWith({ fileMode: to });
    },
  );

  it("leaves the since-review diff when a file display mode is chosen", async () => {
    const control = sinceReview({ active: true });
    renderToolbar({ changes: { sinceReview: control } });
    await openViewOptions();

    expect(
      ["All files", "Selected"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      ),
    ).toEqual(["false", "false"]);
    await userEvent.click(screen.getByRole("button", { name: "All files" }));

    expect(control.onChange).toHaveBeenCalledWith(false);
  });

  it("disables Selected until a file is selected", async () => {
    renderToolbar({ selectedPath: undefined });
    await openViewOptions();

    expect(
      screen.getByRole("button", { name: "Selected" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("expands unchanged context from its switch", async () => {
    const onExpandUnchangedChange = vi.fn();
    renderToolbar({ onExpandUnchangedChange });
    await openViewOptions();

    await userEvent.click(screen.getByRole("switch", { name: "Context" }));

    expect(onExpandUnchangedChange).toHaveBeenCalledWith(true);
  });

  it("disables the Context switch and says why when context cannot load", async () => {
    renderToolbar({
      contextControl: {
        disabled: true,
        label: "Context unavailable",
        description: "The file is too large to load unchanged context",
      },
    });
    await openViewOptions();

    expect(
      screen
        .getByRole("switch", { name: "Context unavailable" })
        .hasAttribute("data-disabled"),
    ).toBe(true);
    expect(
      screen.getByText("The file is too large to load unchanged context"),
    ).toBeTruthy();
  });
});

describe("ReviewDiffToolbar viewed count", () => {
  const files = [changedFile("src/a.ts"), changedFile("src/b.ts")];

  it("counts viewed files and marks every shown file viewed from its menu", async () => {
    const onSetAllCollapsed = vi.fn();
    renderToolbar({
      files,
      collapsedPaths: new Set(["src/a.ts"]),
      onSetAllCollapsed,
    });
    const user = userEvent.setup();

    expect(screen.getByRole("status").textContent).toBe("1/2 viewed");
    await openToolbarMenu(user, VIEWED_COUNT);
    await user.click(screen.getByRole("menuitem", { name: "Mark all viewed" }));

    expect(onSetAllCollapsed).toHaveBeenCalledWith(true);
  });

  it("offers Show all once every file is viewed", async () => {
    const onSetAllCollapsed = vi.fn();
    renderToolbar({
      files,
      collapsedPaths: new Set(["src/a.ts", "src/b.ts"]),
      onSetAllCollapsed,
    });
    const user = userEvent.setup();

    await openToolbarMenu(user, VIEWED_COUNT);
    await user.click(screen.getByRole("menuitem", { name: "Show all" }));

    expect(onSetAllCollapsed).toHaveBeenCalledWith(false);
  });
});

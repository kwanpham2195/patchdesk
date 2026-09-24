// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDiffToolbar } from "../../src/renderer/src/components/review-diff-toolbar";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";

afterEach(cleanup);

const contextControl = {
  disabled: false,
  label: "Context",
  description: "Expand unchanged context",
} as const;

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

const displayMode = "Display mode for README.md";

describe("ReviewDiffToolbar Markdown preview switch", () => {
  it("offers no display mode switch for a file without a preview", () => {
    renderToolbar();

    expect(screen.queryByRole("group", { name: displayMode })).toBeNull();
    for (const name of [
      "All files",
      "Selected",
      "View options",
      contextControl.description,
      "Mark all viewed",
      "Scope filter",
    ]) {
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
    });

    expect(
      ["Diff", "Preview"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      ),
    ).toEqual(["false", "true"]);
    for (const name of [
      "All files",
      "Selected",
      "View options",
      contextControl.description,
      "Mark all viewed",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Scope filter" })).toBeTruthy();
  });
});

describe("ReviewDiffToolbar Since your review option", () => {
  const sinceReview = (
    overrides: Partial<
      NonNullable<React.ComponentProps<typeof ReviewDiffToolbar>["sinceReview"]>
    > = {},
  ) => ({
    active: false,
    disabledReason: undefined,
    loading: false,
    onChange: vi.fn(),
    ...overrides,
  });

  it("is absent without a submitted review", () => {
    renderToolbar();

    expect(
      screen.queryByRole("button", { name: "Since your review" }),
    ).toBeNull();
  });

  it("enters the since-review diff in All files mode", async () => {
    const control = sinceReview();
    const onPreferencesChange = vi.fn();
    renderToolbar({ sinceReview: control, onPreferencesChange });

    await userEvent.click(
      screen.getByRole("button", { name: "Since your review" }),
    );

    expect(control.onChange).toHaveBeenCalledWith(true);
    expect(onPreferencesChange).toHaveBeenCalledWith({ fileMode: "all" });
  });

  it("leaves the since-review diff when All files is chosen", async () => {
    const control = sinceReview({ active: true });
    renderToolbar({ sinceReview: control });

    expect(
      ["All files", "Since your review"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      ),
    ).toEqual(["false", "true"]);
    await userEvent.click(screen.getByRole("button", { name: "All files" }));

    expect(control.onChange).toHaveBeenCalledWith(false);
  });

  it("disables the option when the reviewed commit cannot be diffed", () => {
    renderToolbar({
      sinceReview: sinceReview({ disabledReason: "unavailable" }),
    });

    expect(
      screen
        .getByRole("button", { name: "Since your review" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxFiltersBar } from "../../src/renderer/src/components/inbox-filters-bar";

afterEach(() => {
  cleanup();
});

function renderFiltersBar(
  overrides: Partial<React.ComponentProps<typeof InboxFiltersBar>>,
): void {
  render(
    <InboxFiltersBar
      state="open"
      onStateChange={vi.fn()}
      awaitingMyReview={false}
      onAwaitingMyReviewChange={vi.fn()}
      onReviewStateChange={vi.fn()}
      onCheckStatusChange={vi.fn()}
      onAuthorChange={vi.fn()}
      onBaseBranchChange={vi.fn()}
      onClearInboxMoreFilters={vi.fn()}
      rowCount={1}
      listPending={false}
      inspectorOpen={false}
      onToggleInspector={vi.fn()}
      {...overrides}
    />,
  );
}

describe("InboxFiltersBar More filters text fields", () => {
  it("keeps a refused author on screen, marks the field invalid, and clears that on the next good value", async () => {
    const user = userEvent.setup();
    const onAuthorChange = vi.fn((value: string | undefined) =>
      value === "John Smith" ? ("characters" as const) : undefined,
    );
    renderFiltersBar({ onAuthorChange });

    await user.click(screen.getByRole("button", { name: "More filters" }));
    await user.type(screen.getByLabelText("Author"), "John Smith");
    await user.keyboard("{Enter}");

    expect(onAuthorChange).toHaveBeenCalledWith("John Smith");
    const refused = screen.getByLabelText("Author") as HTMLInputElement;
    expect(refused.value).toBe("John Smith");
    expect(refused.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("No spaces or quotes");

    onAuthorChange.mockClear();
    await user.clear(screen.getByLabelText("Author"));
    await user.type(screen.getByLabelText("Author"), "octocat");
    await user.keyboard("{Enter}");

    expect(onAuthorChange).toHaveBeenCalledWith("octocat");
    expect(
      (screen.getByLabelText("Author") as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a refused base branch message on Escape without committing", async () => {
    const user = userEvent.setup();
    const onBaseBranchChange = vi.fn(() => "characters" as const);
    renderFiltersBar({ onBaseBranchChange });

    await user.click(screen.getByRole("button", { name: "More filters" }));
    await user.type(screen.getByLabelText("Base branch"), "release 1.0");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("No spaces or quotes");

    onBaseBranchChange.mockClear();
    await user.keyboard("{Escape}");

    expect(onBaseBranchChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (screen.getByLabelText("Base branch") as HTMLInputElement).value,
    ).toBe("");
  });
});

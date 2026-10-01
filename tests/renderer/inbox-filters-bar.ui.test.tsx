// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboxFilterChange } from "../../src/domain/maintainer-inbox";
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
      onPresetChange={vi.fn()}
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

describe("InboxFiltersBar search length limit", () => {
  const fitsOnlyClearing = (change: InboxFilterChange): boolean =>
    Object.values(change).every((value) => value === undefined);

  it("disables a preset toggle that would not fit and gives the reason", async () => {
    const user = userEvent.setup();
    const onPresetChange = vi.fn();
    renderFiltersBar({ changeFits: fitsOnlyClearing, onPresetChange });

    const toggle = screen.getByRole("button", {
      name: "Awaiting review from you",
    });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    const reason = screen.getByText("Too long alongside the other filters");
    expect(reason.id).not.toBe("");
    expect(toggle.getAttribute("aria-describedby")).toBe(reason.id);
    expect(
      screen
        .getByRole("button", { name: "Your pull requests" })
        .getAttribute("aria-describedby"),
    ).toBe(reason.id);
    await user.click(toggle);
    expect(onPresetChange).not.toHaveBeenCalled();
  });

  it("disables Review state and Check status options that would not fit and gives the reason", async () => {
    const user = userEvent.setup();
    const onReviewStateChange = vi.fn();
    renderFiltersBar({ changeFits: fitsOnlyClearing, onReviewStateChange });

    await user.click(screen.getByRole("button", { name: "More filters" }));
    await user.click(screen.getByLabelText("Review state"));

    // The preset line beside the toggles and the menu's own line.
    expect(
      screen.getAllByText("Too long alongside the other filters"),
    ).toHaveLength(2);
    const approved = screen.getByRole("option", { name: "Approved" });
    expect(approved.getAttribute("aria-disabled")).toBe("true");
    await user.click(approved);
    expect(onReviewStateChange).not.toHaveBeenCalled();
  });

  it("shows no preset reason while every preset fits", () => {
    renderFiltersBar({});

    expect(
      screen.queryByText("Too long alongside the other filters"),
    ).toBeNull();
  });

  it("names the filters a repository change dropped", () => {
    renderFiltersBar({ droppedFilters: ["Author", "Base branch"] });

    expect(screen.getByRole("status").textContent).toContain(
      "Dropped Author, Base branch",
    );
  });
});

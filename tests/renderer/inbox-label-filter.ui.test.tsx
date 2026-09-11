// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabelFilterPopover } from "../../src/renderer/src/components/inbox-label-filter";

afterEach(() => {
  cleanup();
});

const fetchLabels = () =>
  Promise.resolve({
    state: "ready" as const,
    labels: [
      { id: "LA_bug", name: "bug", color: "d73a4a" },
      { id: "LA_wontfix", name: "wontfix", color: "ffffff" },
    ],
    totalCount: 2,
  });

describe("LabelFilterPopover", () => {
  it("refuses the label the filter has no room left for", async () => {
    const user = userEvent.setup();
    const onLabelChange = vi.fn();
    render(
      <LabelFilterPopover
        fetchLabels={fetchLabels}
        selectedLabels={[]}
        onLabelChange={onLabelChange}
        labelFits={(name) => name !== "wontfix"}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter by label" }));
    const refused = await screen.findByRole("checkbox", { name: "wontfix" });

    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "bug" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    await user.click(refused);
    expect(onLabelChange).not.toHaveBeenCalled();
  });

  it("keeps a selected label clearable even when nothing more fits", async () => {
    const user = userEvent.setup();
    const onLabelChange = vi.fn();
    render(
      <LabelFilterPopover
        fetchLabels={fetchLabels}
        selectedLabels={["wontfix"]}
        onLabelChange={onLabelChange}
        labelFits={() => false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Filter by label" }));
    await user.click(await screen.findByRole("checkbox", { name: "wontfix" }));

    expect(onLabelChange).toHaveBeenCalledWith([]);
  });
});

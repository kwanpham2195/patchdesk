// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RendererRecovery } from "../../src/renderer/src/components/renderer-recovery";

describe("RendererRecovery", () => {
  it("renders the owned reload action", async () => {
    const reload = vi.fn();
    const user = userEvent.setup();
    render(<RendererRecovery onReload={reload} />);

    const button = screen.getByRole("button", { name: "Reload Patchdesk" });
    expect(button.getAttribute("data-slot")).toBe("button");
    await user.click(button);
    expect(reload).toHaveBeenCalledOnce();
  });
});

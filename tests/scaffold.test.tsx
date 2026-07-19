// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/src/app";
import { RendererRecovery } from "../src/renderer/src/components/renderer-recovery";

describe("Patchdesk dashboard scaffold", () => {
  it("shows an actionable first-run setup path", () => {
    render(<App />);

    expect(screen.getByText("Patchdesk")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Set up Patchdesk" }),
    ).toBeTruthy();
    expect(screen.getByText("1. Confirm GitHub access")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open Settings to finish setup" }),
    ).toBeTruthy();
  });

  it("renders recovery with the owned product button", async () => {
    const reload = vi.fn();
    const user = userEvent.setup();
    render(<RendererRecovery onReload={reload} />);

    const button = screen.getByRole("button", { name: "Reload Patchdesk" });
    expect(button.getAttribute("data-slot")).toBe("button");
    await user.click(button);
    expect(reload).toHaveBeenCalledOnce();
  });
});

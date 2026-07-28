// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../../src/renderer/src/components/app-shell";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AppShell settings overlay entry points", () => {
  it("opens Settings without making it a destination or changing the main scroll owner", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(
      <AppShell
        destination={{ kind: "dashboard" }}
        profileId="cfw"
        profileLabel="CFW"
        repositoryCount={0}
        onNavigate={() => undefined}
        onOpenSettings={onOpenSettings}
      >
        <div>Inbox content</div>
      </AppShell>,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("main").className).toContain("overflow-hidden");
    expect(screen.queryByText("Settings content")).toBeNull();
  });
});

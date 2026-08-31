// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../../src/renderer/src/components/app-shell";
import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AppShell settings overlay entry points", () => {
  it("opens Settings without making it a destination or changing the main scroll owner", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          onOpenSettings={onOpenSettings}
        >
          <div>Inbox content</div>
        </AppShell>
      </BusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("main").className).toContain("overflow-hidden");
    expect(screen.queryByText("Settings content")).toBeNull();
    expect(screen.queryByLabelText("Workspace navigation")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /application sidebar/i }),
    ).toBeNull();
  });

  it("keeps Command Palette motion-free", async () => {
    const user = userEvent.setup();

    render(
      <BusyProvider>
        <AppShell
          destination={{ kind: "dashboard" }}
          onNavigate={() => undefined}
          onOpenSettings={() => undefined}
        >
          <div>Inbox content</div>
        </AppShell>
      </BusyProvider>,
    );

    await user.click(screen.getByRole("button", { name: /^Navigate/ }));

    expect(
      screen.getByRole("dialog", { name: "Navigate Patchdesk" }).dataset.motion,
    ).toBe("none");
    expect(
      document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')
        ?.dataset.motion,
    ).toBe("none");
  });
});

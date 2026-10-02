// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { AvailableAppUpdate } from "../../src/domain/app-update";
import { AppUpdateControl } from "../../src/renderer/src/components/app-update-control";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

function release(
  installedBy: AvailableAppUpdate["installedBy"],
  canInstall: boolean,
): AvailableAppUpdate {
  return {
    version: "0.0.18",
    releaseUrl:
      "https://github.com/kwanpham2195/patchdesk/releases/tag/v0.0.18",
    installedBy,
    canInstall,
    installing: false,
  };
}

describe("AppUpdateControl", () => {
  it("shows a newer release the main process pushes, and hides it once Dismiss is answered", async () => {
    const user = userEvent.setup();
    const double = installDesktopDouble(
      {},
      {
        operations: {
          dismissAppUpdate: () => {
            double.sendAppUpdate({});
            return success({});
          },
        },
      },
    );
    desktop = double;
    render(<AppUpdateControl />);
    expect(screen.queryByRole("button", { name: /available/ })).toBeNull();

    act(() => double.sendAppUpdate({ available: release("homebrew", true) }));
    await user.click(screen.getByRole("button", { name: "0.0.18 available" }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(double.request).toHaveBeenCalledWith({
      operation: "dismissAppUpdate",
      notice: "available",
    });
    expect(
      screen.queryByRole("button", { name: "0.0.18 available" }),
    ).toBeNull();
  });

  it("asks the main process to update an install it can replace", async () => {
    const user = userEvent.setup();
    desktop = installDesktopDouble(
      {},
      {
        appUpdateAtLoad: { available: release("installer", true) },
        operations: { installAppUpdate: () => success({}) },
      },
    );
    render(<AppUpdateControl />);

    await user.click(screen.getByRole("button", { name: "0.0.18 available" }));
    await user.click(screen.getByRole("button", { name: "Update now" }));

    expect(desktop.request).toHaveBeenCalledWith({
      operation: "installAppUpdate",
    });
  });

  it.each([
    {
      installedBy: "homebrew",
      command:
        "brew upgrade --cask patchdesk && xattr -dr com.apple.quarantine /Applications/Patchdesk.app",
    },
    {
      installedBy: "installer",
      command:
        "curl -fsSL https://raw.githubusercontent.com/kwanpham2195/patchdesk/main/scripts/install-release.sh | sh -s -- --update",
    },
    {
      installedBy: "notInstalled",
      command:
        "curl -fsSL https://raw.githubusercontent.com/kwanpham2195/patchdesk/main/scripts/install-release.sh | sh",
    },
  ] as const)(
    "copies the $installedBy command instead of offering Update now when the app cannot update itself",
    async ({ installedBy, command }) => {
      const user = userEvent.setup();
      desktop = installDesktopDouble(
        {},
        { appUpdateAtLoad: { available: release(installedBy, false) } },
      );
      render(<AppUpdateControl />);

      await user.click(
        screen.getByRole("button", { name: "0.0.18 available" }),
      );
      await user.click(screen.getByRole("button", { name: "Copy command" }));

      expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
      expect(await navigator.clipboard.readText()).toBe(command);
    },
  );
});

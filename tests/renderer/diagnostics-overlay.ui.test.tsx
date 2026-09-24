// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { App } from "../../src/renderer/src/app";
import { DiagnosticsModal } from "../../src/renderer/src/components/diagnostics-modal";
import { useDiagnosticsOverlay } from "../../src/renderer/src/hooks/use-diagnostics-overlay";
import { saveSettingsRestore } from "../../src/renderer/src/lib/screen-restore";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const profile = {
  id: "acme",
  label: "ACME",
  githubHost: "github.com",
  ghAccount: "patchdesk",
};

let installed: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  installed?.restore();
  installed = undefined;
});

describe("Diagnostics overlay in the app", () => {
  it("opens from Help → Diagnostics with Logs and Review activity, and Escape returns focus", async () => {
    const desktop = installApp();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Pull requests" });
    const opener = screen.getByRole("button", { name: "Settings" });
    opener.focus();

    act(() => desktop.sendMenuAction("openDiagnostics"));

    const dialog = await screen.findByRole("dialog", { name: "Diagnostics" });
    expect(
      within(dialog)
        .getByRole("tab", { name: "Logs" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(dialog).getByRole("tab", { name: "Review activity" }),
    ).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Diagnostics" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("reopens a Settings restore saved on the old Logs section on General", async () => {
    saveSettingsRestore("logs");
    installApp();
    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(dialog)
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("useDiagnosticsOverlay", () => {
  it.each(["dirty_draft", "write_pending"] as const)(
    "stays closed while navigation is %s, as Settings does",
    (navigationState) => {
      const { result } = renderHook(() =>
        useDiagnosticsOverlay(navigationState),
      );

      act(() => result.current.openDiagnostics());

      expect(result.current.diagnosticsOpen).toBe(false);
    },
  );
});

describe("DiagnosticsModal Review activity", () => {
  it("shows successful empty Review activity only after loading the active profile", async () => {
    const desktop = installModalApi({ activity: { events: [] } });
    const user = userEvent.setup();
    renderModal("acme");
    await user.click(screen.getByRole("tab", { name: "Review activity" }));

    const activityCard = screen.getByTestId("review-activity-card");
    expect(within(activityCard).queryByRole("status")).toBeNull();

    await user.click(
      within(activityCard).getByRole("button", { name: "Load activity" }),
    );

    await waitFor(() =>
      expect(desktop.request).toHaveBeenCalledWith({
        path: "/v1/diagnostics?profileId=acme",
      }),
    );
    expect(within(activityCard).getAllByRole("status")).toHaveLength(1);
    expect(
      within(activityCard).queryByRole("list", {
        name: "Review activity log",
      }),
    ).toBeNull();
  });

  it("keeps a failed Review activity load distinct from a successful empty result", async () => {
    installModalApi({ activityFails: true });
    const user = userEvent.setup();
    renderModal("acme");
    await user.click(screen.getByRole("tab", { name: "Review activity" }));

    const activityCard = screen.getByTestId("review-activity-card");
    await user.click(
      within(activityCard).getByRole("button", { name: "Load activity" }),
    );

    expect(await within(activityCard).findByRole("alert")).toBeTruthy();
    expect(within(activityCard).queryByRole("status")).toBeNull();
    expect(
      within(activityCard).queryByRole("list", {
        name: "Review activity log",
      }),
    ).toBeNull();
  });
});

function renderModal(profileId: string | undefined): void {
  render(
    <DiagnosticsModal
      open
      onOpenChange={() => undefined}
      opener={undefined}
      profileId={profileId}
    />,
  );
}

function installApp(): DesktopDouble {
  installed = installDesktopDouble(
    {
      ...APP_BOOT_ROUTES,
      "/v1/profiles": () => success([profile]),
      "/v1/inbox": () =>
        success({
          profile,
          inbox: { rows: [], repositories: [], snapshot: {} },
        }),
    },
    { operations: APP_BOOT_OPERATIONS },
  );
  return installed;
}

function installModalApi(options: {
  readonly activity?: RawJsonValue;
  readonly activityFails?: boolean;
}): DesktopDouble {
  installed = installDesktopDouble({
    "/v1/logs": () => success({ entries: [] }),
    "/v1/diagnostics": () =>
      options.activityFails === true
        ? failure({ error: "diagnostics_unavailable" })
        : success(options.activity ?? { events: [] }),
  });
  return installed;
}

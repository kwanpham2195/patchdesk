// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "../../src/renderer/src/components/settings-modal";
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
  workspaceRoots: ["/workspace/acme"],
  rulePaths: ["/workspace/acme/AGENTS.md"],
};

const dashboard = { profile, dashboard: { repos: [] } };

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  desktop?.restore();
  desktop = undefined;
});

describe("SettingsModal", () => {
  it("uses Field composition for the General appearance controls", () => {
    installDesktopApi();

    renderModal();

    expect(screen.getByText("Theme").getAttribute("data-slot")).toBe(
      "field-label",
    );
    expect(screen.getByText("Light appearance").getAttribute("data-slot")).toBe(
      "field-label",
    );
    expect(screen.getByText("Dark appearance").getAttribute("data-slot")).toBe(
      "field-label",
    );
    expect(document.querySelectorAll('[data-slot="field-group"]').length).toBe(
      3,
    );
    expect(screen.getByRole("combobox", { name: "Appearance" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Light diff theme" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Dark diff theme" }),
    ).toBeTruthy();

    expect(
      screen.getByRole("dialog", { name: "Settings" }).dataset.motion,
    ).toBe("standard");
    expect(
      document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')
        ?.dataset.motion,
    ).toBe("standard");
  });

  it("saves the Notifications toggles from General", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();
    renderModal(vi.fn());

    const enabled = await screen.findByRole("switch", {
      name: "Send notifications",
    });
    await waitFor(() =>
      expect(enabled.getAttribute("aria-checked")).toBe("true"),
    );
    await user.click(enabled);

    await waitFor(() =>
      expect(
        desktopApi.request.mock.calls.some(
          ([input]) =>
            "path" in input &&
            input.path === "/v1/settings" &&
            input.method === "PATCH",
        ),
      ).toBe(true),
    );
    expect(
      screen
        .getByRole("switch", { name: "Review ready and merge completed" })
        .hasAttribute("disabled") ||
        screen
          .getByRole("switch", { name: "Review ready and merge completed" })
          .getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("opens on General and exposes only the two local-data controls", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderModal(onOpenChange);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("settings-section-general")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Settings content" }),
    ).toBeTruthy();
    expect(screen.queryByText("Saved reviews")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Logs" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Repositories" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(screen.getByRole("region", { name: "Repositories" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    expect(screen.getByText("Local review data")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear cache" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Clear local review data" }),
    ).toBeTruthy();
    expect(screen.queryByText(/quarantine/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Load activity" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Clear local review data" }),
    );
    expect(
      screen.getByRole("heading", { name: "Clear local review data?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This removes completed and failed local reviews. An active review and diagnostic reports stay.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear local data" }));

    await waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
        path: "/v1/storage/clear-local-data",
        method: "POST",
        body: { profileId: "acme" },
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows what each clear frees and the log size, and measures again after a clear", async () => {
    let usage = {
      cacheBytes: 4_800_000,
      localReviewDataBytes: 14_000_000,
      logsBytes: 2_100_000,
    };
    installDesktopApi({ storageUsage: () => usage });
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    const storage = within(screen.getByTestId("local-review-data-card"));
    expect(await storage.findByText("· 4.8 MB")).toBeTruthy();
    expect(storage.getByText("· 14 MB")).toBeTruthy();
    expect(storage.getByText("· 2.1 MB")).toBeTruthy();

    usage = { ...usage, localReviewDataBytes: 0 };
    await user.click(
      screen.getByRole("button", { name: "Clear local review data" }),
    );
    await user.click(screen.getByRole("button", { name: "Clear local data" }));

    expect(await storage.findByText("· 0 B")).toBeTruthy();
  });

  it("targets the current initialSection on every open, not only the first", async () => {
    installDesktopApi();
    const user = userEvent.setup();
    let open = true;
    const onOpenChange = (next: boolean): void => {
      open = next;
    };

    const view = render(
      <SettingsModal
        open={open}
        onOpenChange={onOpenChange}
        dashboard={dashboard}
        appearance="system"
        onAppearanceChange={() => undefined}
        diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
        onDiffThemeChange={() => undefined}
        profiles={[profile]}
        onWorkspaceReload={async () => undefined}
        initialSection="data"
        onSectionChange={() => undefined}
      />,
    );

    expect(
      screen
        .getByRole("tab", { name: "Data & recovery" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("settings-section-data")).toBeTruthy();

    // Close, then reopen the same mounted instance targeting a different
    // section: a later, distinct openSettings() call must still land on the
    // section it asked for, not fall back to General.
    await user.click(screen.getByRole("button", { name: "Close" }));
    const modalProps = {
      open,
      onOpenChange,
      dashboard,
      appearance: "system" as const,
      onAppearanceChange: () => undefined,
      diffThemePreferences: {
        light: "pierre-light",
        dark: "github-dark",
      } as const,
      onDiffThemeChange: () => undefined,
      profiles: [profile],
      onWorkspaceReload: async () => undefined,
      initialSection: "workspace" as const,
      onSectionChange: () => undefined,
    };
    view.rerender(<SettingsModal {...modalProps} open={false} />);
    view.rerender(<SettingsModal {...modalProps} open />);
    expect(
      screen
        .getByRole("tab", { name: "Workspace" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("reports section switches through onSectionChange", async () => {
    installDesktopApi();
    const user = userEvent.setup();
    const onSectionChange = vi.fn();

    render(
      <SettingsModal
        open
        onOpenChange={() => undefined}
        dashboard={dashboard}
        appearance="system"
        onAppearanceChange={() => undefined}
        diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
        onDiffThemeChange={() => undefined}
        profiles={[profile]}
        onWorkspaceReload={async () => undefined}
        onSectionChange={onSectionChange}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    expect(onSectionChange).toHaveBeenCalledWith("data");
  });

  it("keeps a failed cleanup confirmation open with retry context", async () => {
    installDesktopApi({ clearLocalDataFails: true });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    await user.click(
      screen.getByRole("button", { name: "Clear local review data" }),
    );
    await user.click(screen.getByRole("button", { name: "Clear local data" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not clear local review data",
    );
    expect(
      screen.getByRole("heading", { name: "Clear local review data?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Clear local data" }),
    ).toBeTruthy();
  });

  it("does not offer cleanup that has no active profile to target", async () => {
    installDesktopApi();
    const user = userEvent.setup();

    render(
      <SettingsModal
        open
        onOpenChange={() => undefined}
        appearance="system"
        onAppearanceChange={() => undefined}
        diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
        onDiffThemeChange={() => undefined}
        profiles={[]}
        onWorkspaceReload={async () => undefined}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    expect(screen.getByText("No active workspace")).toBeTruthy();
    // SAFETY: "Clear cache" is rendered by `<Button>`
    // (src/renderer/src/components/ui/button.tsx), which wraps base-ui's
    // `Button` with `nativeButton` left at its default `true` and renders a
    // native `<button>` element.
    expect(
      (screen.getByRole("button", { name: "Clear cache" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // SAFETY: "Clear local review data" is the same `<Button>` component,
    // which renders a native `<button>` element.
    expect(
      (
        screen.getByRole("button", {
          name: "Clear local review data",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows the log size with no active workspace, asking for no workspace's usage", async () => {
    const desktopApi = installDesktopApi({
      storageUsage: () => ({ logsBytes: 2_100_000 }),
    });
    const user = userEvent.setup();

    render(
      <SettingsModal
        open
        onOpenChange={() => undefined}
        appearance="system"
        onAppearanceChange={() => undefined}
        diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
        onDiffThemeChange={() => undefined}
        profiles={[]}
        onWorkspaceReload={async () => undefined}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    const storage = within(screen.getByTestId("local-review-data-card"));
    expect(await storage.findByText("· 2.1 MB")).toBeTruthy();
    const usagePaths = desktopApi.request.mock.calls.flatMap(([input]) =>
      "path" in input && input.path.startsWith("/v1/storage/usage")
        ? [input.path]
        : [],
    );
    expect(usagePaths).toEqual(["/v1/storage/usage"]);
  });

  it("rolls a size that rounds to 1000 over to the next unit", async () => {
    installDesktopApi({
      storageUsage: () => ({
        cacheBytes: 999_950,
        localReviewDataBytes: 0,
        logsBytes: 0,
      }),
    });
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    const storage = within(screen.getByTestId("local-review-data-card"));
    expect(await storage.findByText("· 1.0 MB")).toBeTruthy();
  });

  it("returns focus to the opener after closing", async () => {
    installDesktopApi();
    const opener = document.createElement("button");
    document.body.append(opener);
    const user = userEvent.setup();
    const view = renderModal(vi.fn(), true, opener);

    await user.click(screen.getByRole("button", { name: "Close" }));
    view.rerender(
      <SettingsModal
        open={false}
        onOpenChange={() => undefined}
        opener={opener}
        dashboard={dashboard}
        appearance="system"
        onAppearanceChange={() => undefined}
        diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
        onDiffThemeChange={() => undefined}
        profiles={[profile]}
        onWorkspaceReload={async () => undefined}
      />,
    );

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

function renderModal(
  onOpenChange = vi.fn(),
  open = true,
  opener?: HTMLElement,
): ReturnType<typeof render> {
  return render(
    <SettingsModal
      open={open}
      {...(opener === undefined ? {} : { opener })}
      onOpenChange={onOpenChange}
      dashboard={dashboard}
      appearance="system"
      onAppearanceChange={() => undefined}
      diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
      onDiffThemeChange={() => undefined}
      profiles={[profile]}
      onWorkspaceReload={async () => undefined}
    />,
  );
}

function installDesktopApi(
  options: {
    readonly clearLocalDataFails?: boolean;
    readonly storageUsage?: () => {
      readonly cacheBytes?: number;
      readonly localReviewDataBytes?: number;
      readonly logsBytes: number;
    };
  } = {},
): DesktopDouble {
  desktop = installDesktopDouble({
    "/v1/storage/usage": () =>
      success(
        options.storageUsage?.() ?? {
          cacheBytes: 0,
          localReviewDataBytes: 0,
          logsBytes: 0,
        },
      ),
    "/v1/environment": () => success({}),
    // `lib/logger.ts` flushes the renderer log queue through the bridge.
    "/v1/logs": () => success({ entries: [] }),
    "/v1/watchlist/suggestions": () =>
      success([{ root: "/workspace/acme", state: "ready", repositories: [] }]),
    "/v1/profiles": () => success({}),
    "/v1/settings": (input) =>
      success(
        input.method === "PATCH"
          ? {
              notifications: {
                enabled: false,
                preparationAndMerge: false,
                intervalMinutes: 3,
              },
            }
          : {},
      ),
    "/v1/storage/clear-local-data": () =>
      options.clearLocalDataFails === true
        ? failure({ error: "storage_unavailable" })
        : success({}),
  });
  return desktop;
}

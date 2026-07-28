// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "../../src/renderer/src/components/settings-modal";

const profile = {
  id: "cfw",
  label: "CFW",
  githubHost: "github.com",
  ghAccount: "patchdesk",
  workspaceRoots: ["/workspace/cfw"],
  ownerFilters: ["centraldigital"],
  rulePaths: ["/workspace/cfw/AGENTS.md"],
};

const dashboard = { profile, dashboard: { rows: [], repos: [] } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsModal", () => {
  it("opens on General and exposes only the two local-data controls", async () => {
    const request = installDesktopApi();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderModal(onOpenChange);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("settings-section-general")).toBeTruthy();
    expect(screen.queryByText("Saved reviews")).toBeNull();
    expect(screen.queryByText("Watchlist")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    expect(screen.getByText("Local review data")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear cache" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear local review data" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    expect(screen.queryByText(/quarantine/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear local review data" }));
    expect(screen.getByRole("heading", { name: "Clear local review data?" })).toBeTruthy();
    expect(screen.getByText("This removes discarded and unusable local review data. Reviews you can still open or resume, and diagnostic reports, stay.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear local data" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        path: "/v1/storage/clear-local-data",
        method: "POST",
        body: { profileId: "cfw" },
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps a failed cleanup confirmation open with retry context", async () => {
    installDesktopApi({ clearLocalDataFails: true });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    await user.click(screen.getByRole("button", { name: "Clear local review data" }));
    await user.click(screen.getByRole("button", { name: "Clear local data" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Could not clear local review data");
    expect(screen.getByRole("heading", { name: "Clear local review data?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear local data" })).toBeTruthy();
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

  it("requires an explicit dirty-draft choice before closing", async () => {
    installDesktopApi();
    const user = userEvent.setup();

    renderModal();
    await user.type(screen.getByLabelText("Label"), " changed");
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.getByRole("heading", { name: "Discard profile changes?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});

function renderModal(onOpenChange = vi.fn(), open = true, opener?: HTMLElement): ReturnType<typeof render> {
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
      onRepositoryRefresh={() => undefined}
    />,
  );
}

function installDesktopApi(options: { readonly clearLocalDataFails?: boolean } = {}): ReturnType<typeof vi.fn> {
  const request = vi.fn(async (input: { readonly path?: string; readonly method?: string; readonly body?: unknown; readonly operation?: string }) => {
    if (input.operation === "selectDirectory") return success({ path: "/picked/workspace" });
    if (input.path === "/v1/environment") return success({});
    if (input.path === "/v1/storage/clear-local-data" && options.clearLocalDataFails === true)
      return failure({ error: "storage_unavailable" });
    return success({});
  });
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request, onNavigate: () => () => undefined },
  });
  return request;
}

function success(body: unknown): { readonly ok: true; readonly status: 200; readonly body: unknown; readonly correlationId: string } {
  return { ok: true, status: 200, body, correlationId: "test" };
}

function failure(body: unknown): { readonly ok: false; readonly status: 503; readonly body: unknown; readonly correlationId: string } {
  return { ok: false, status: 503, body, correlationId: "test" };
}

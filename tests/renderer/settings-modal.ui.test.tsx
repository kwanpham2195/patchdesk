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
  window.localStorage.clear();
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
    expect(screen.getByRole("region", { name: "Settings content" })).toBeTruthy();
    expect(screen.queryByText("Saved reviews")).toBeNull();
    expect(screen.queryByText("Watchlist")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(screen.getByRole("region", { name: "Watchlist" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    expect(screen.getByText("Local review data")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear cache" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear local review data" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    expect(screen.queryByText(/quarantine/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear local review data" }));
    expect(screen.getByRole("heading", { name: "Clear local review data?" })).toBeTruthy();
    expect(screen.getByText("This removes completed and failed local reviews. An active review and diagnostic reports stay.")).toBeTruthy();
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
        onRepositoryRefresh={() => undefined}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    expect(screen.getByText("Choose a workspace profile before clearing its local data.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Clear cache" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Clear local review data" }) as HTMLButtonElement).disabled).toBe(true);
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

  it("offers Save in the dirty-draft guard and closes only after saving", async () => {
    const request = installDesktopApi();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderModal(onOpenChange);
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    await user.type(screen.getByLabelText("Label"), " changed");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: "/v1/profiles", method: "PUT" })));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("requires an explicit dirty-draft choice before closing", async () => {
    installDesktopApi();
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
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

  it("selects an enabled default review model and saves it for this profile", async () => {
    const request = installDesktopApi({
      models: {
        models: [
          { id: "deepseek-flash", label: "DeepSeek Flash" },
          { id: "openai-codex", label: "OpenAI Codex" },
        ],
        defaultModel: "deepseek-flash",
      },
    });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Review" }));
    const model = await screen.findByRole("combobox", { name: "Default model" });
    expect((model as HTMLInputElement).value).toBe("DeepSeek Flash");
    await user.click(model);
    await user.click(await screen.findByRole("option", { name: "OpenAI Codex" }));

    expect(
      window.localStorage.getItem("patchdesk.review-execution.v1.cfw"),
    ).toBe(JSON.stringify({ model: "openai-codex", reasoning: "medium" }));
    expect(request).toHaveBeenCalledWith({ path: "/v1/reviews/models" });
  });

  it("searches a late default model by canonical ID and selects it with the keyboard", async () => {
    installDesktopApi({
      models: {
        models: Array.from({ length: 493 }, (_, index) => ({
          id: `provider/model-${index}`,
          label: `Model ${index}`,
        })),
        defaultModel: "provider/model-0",
      },
    });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Review" }));
    const model = await screen.findByRole("combobox", { name: "Default model" });
    await user.click(model);
    await user.clear(model);
    await user.type(model, "MODEL-492");
    expect(await screen.findByRole("option", { name: "Model 492" })).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(window.localStorage.getItem("patchdesk.review-execution.v1.cfw")).toBe(
      JSON.stringify({ model: "provider/model-492", reasoning: "medium" }),
    );
  });

  it("gives long select options room without overflowing the viewport", async () => {
    installDesktopApi({
      models: {
        models: [{ id: "long-model", label: "A model with a deliberately long label" }],
        defaultModel: "long-model",
      },
    });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Review" }));
    await user.click(await screen.findByRole("combobox", { name: "Default model" }));

    const content = document.querySelector('[data-slot="model-combobox-content"]');
    expect(content).not.toBeNull();
    expect(content?.classList.contains("max-w-[var(--available-width)]")).toBe(true);
    expect(content?.querySelector('[data-slot="combobox-list"]') ?? content?.textContent).toBeTruthy();
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

function installDesktopApi(options: {
  readonly clearLocalDataFails?: boolean;
  readonly models?: unknown;
} = {}): ReturnType<typeof vi.fn> {
  const request = vi.fn(async (input: { readonly path?: string; readonly method?: string; readonly body?: unknown; readonly operation?: string }) => {
    if (input.operation === "selectDirectory") return success({ path: "/picked/workspace" });
    if (input.path === "/v1/environment") return success({});
    if (input.path === "/v1/reviews/models") return success(options.models ?? {});
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

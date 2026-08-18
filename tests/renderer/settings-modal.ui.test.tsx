// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "../../src/renderer/src/components/settings-modal";
import { failure, success } from "./fake-desktop-response";

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
    expect(screen.queryByText("Watchlist")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(screen.getByRole("region", { name: "Watchlist" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    expect(screen.getByText("Local review data")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear cache" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Clear local review data" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    expect(screen.queryByText(/quarantine/i)).toBeNull();

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
      expect(request).toHaveBeenCalledWith({
        path: "/v1/storage/clear-local-data",
        method: "POST",
        body: { profileId: "cfw" },
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
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
        initialSection="logs"
        onSectionChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("tab", { name: "Logs" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("settings-section-logs")).toBeTruthy();

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

    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(onSectionChange).toHaveBeenCalledWith("logs");
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
    expect(
      screen.getByText(
        "Choose a workspace profile before clearing its local data.",
      ),
    ).toBeTruthy();
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

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/v1/profiles", method: "PUT" }),
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps a failed profile save retryable before a later save closes", async () => {
    const request = installDesktopApi({ profileSaveFailures: 1 });
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderModal(onOpenChange);
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    await user.type(screen.getByLabelText("Label"), " changed");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/v1/profiles", method: "PUT" }),
      ),
    );
    // SAFETY: "Save" here is `AlertDialogAction`
    // (src/renderer/src/components/ui/alert-dialog.tsx), which renders
    // `<Button>` and so, like the other `<Button>` casts in this file, is a
    // native `<button>` element.
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("requires an explicit dirty-draft choice before closing", async () => {
    installDesktopApi();
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    await user.type(screen.getByLabelText("Label"), " changed");
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(
      screen.getByRole("heading", { name: "Discard profile changes?" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("selects an enabled default review model and saves it for this profile", async () => {
    const request = installDesktopApi({
      models: {
        providers: [
          { id: "pi", label: "Pi", available: true, guidance: "Configured." },
        ],
        models: [
          {
            provider: "pi",
            id: "deepseek-flash",
            label: "DeepSeek Flash",
            reasoning: ["medium"],
            defaultReasoning: "medium",
          },
          {
            provider: "pi",
            id: "openai-codex",
            label: "OpenAI Codex",
            reasoning: ["medium"],
            defaultReasoning: "medium",
          },
        ],
      },
    });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Review" }));
    const model = await screen.findByRole("combobox", {
      name: "Default model",
    });
    // SAFETY: the "Default model" combobox is `ModelCombobox`
    // (src/renderer/src/components/model-combobox.tsx), whose `role="combobox"`
    // is base-ui's `Combobox.Input`, an `<input>` element.
    expect((model as HTMLInputElement).value).toBe("DeepSeek Flash");
    await user.click(model);
    await user.click(
      await screen.findByRole("option", { name: "OpenAI Codex" }),
    );

    expect(
      window.localStorage.getItem("patchdesk.insight-run.v1.analysis.cfw"),
    ).toBe(
      JSON.stringify({
        provider: "pi",
        model: "openai-codex",
        reasoning: "medium",
      }),
    );
    expect(request).toHaveBeenCalledWith({ path: "/v1/insight-providers" });
  });

  it("offers the full reasoning range and saves a chosen default under the shared Analysis key", async () => {
    installDesktopApi({
      models: {
        providers: [
          { id: "pi", label: "Pi", available: true, guidance: "Configured." },
        ],
        models: [
          {
            provider: "pi",
            id: "deepseek-flash",
            label: "DeepSeek Flash",
            reasoning: ["minimal", "low", "medium", "high", "xhigh"],
            defaultReasoning: "medium",
          },
        ],
      },
    });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Review" }));
    const reasoning = await screen.findByRole("combobox", {
      name: "Default reasoning",
    });
    await user.click(reasoning);
    await screen.findByRole("option", { name: "Minimal" });
    expect(
      ["Minimal", "Low", "Medium", "High", "Extra high"].map(
        (name) => screen.getByRole("option", { name }).textContent,
      ),
    ).toEqual(["Minimal", "Low", "Medium", "High", "Extra high"]);
    await user.click(screen.getByRole("option", { name: "Extra high" }));

    expect(
      window.localStorage.getItem("patchdesk.insight-run.v1.analysis.cfw"),
    ).toBe(
      JSON.stringify({
        provider: "pi",
        model: "deepseek-flash",
        reasoning: "xhigh",
      }),
    );
  });

  it("does not overwrite a Codex-provider Analysis preference just by opening Settings", async () => {
    window.localStorage.setItem(
      "patchdesk.insight-run.v1.analysis.cfw",
      JSON.stringify({
        provider: "codex-cli-account",
        model: "gpt-5-codex",
        reasoning: "high",
      }),
    );
    installDesktopApi({
      models: {
        providers: [
          { id: "pi", label: "Pi", available: true, guidance: "Configured." },
        ],
        models: [
          {
            provider: "pi",
            id: "deepseek-flash",
            label: "DeepSeek Flash",
            reasoning: ["medium"],
            defaultReasoning: "medium",
          },
        ],
      },
    });

    renderModal();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Review" }));
    await screen.findByRole("combobox", { name: "Default model" });

    expect(
      window.localStorage.getItem("patchdesk.insight-run.v1.analysis.cfw"),
    ).toBe(
      JSON.stringify({
        provider: "codex-cli-account",
        model: "gpt-5-codex",
        reasoning: "high",
      }),
    );
  });

  it("searches a late default model by canonical ID and selects it with the keyboard", async () => {
    installDesktopApi({
      models: {
        providers: [
          { id: "pi", label: "Pi", available: true, guidance: "Configured." },
        ],
        models: Array.from({ length: 493 }, (_, index) => ({
          provider: "pi",
          id: `provider/model-${index}`,
          label: `Model ${index}`,
          reasoning: ["medium"],
          defaultReasoning: "medium",
        })),
      },
    });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Review" }));
    const model = await screen.findByRole("combobox", {
      name: "Default model",
    });
    await user.click(model);
    await user.clear(model);
    await user.type(model, "MODEL-492");
    expect(
      await screen.findByRole("option", { name: "Model 492" }),
    ).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(
      window.localStorage.getItem("patchdesk.insight-run.v1.analysis.cfw"),
    ).toBe(
      JSON.stringify({
        provider: "pi",
        model: "provider/model-492",
        reasoning: "medium",
      }),
    );
  });

  it("gives long select options room without overflowing the viewport", async () => {
    installDesktopApi({
      models: {
        providers: [
          { id: "pi", label: "Pi", available: true, guidance: "Configured." },
        ],
        models: [
          {
            provider: "pi",
            id: "long-model",
            label: "A model with a deliberately long label",
            reasoning: ["medium"],
            defaultReasoning: "medium",
          },
        ],
      },
    });
    const user = userEvent.setup();

    renderModal();
    await user.click(screen.getByRole("tab", { name: "Review" }));
    await user.click(
      await screen.findByRole("combobox", { name: "Default model" }),
    );

    const content = document.querySelector(
      '[data-slot="model-combobox-content"]',
    );
    expect(content).not.toBeNull();
    expect(content?.classList.contains("max-w-[var(--available-width)]")).toBe(
      true,
    );
    expect(
      content?.querySelector('[data-slot="combobox-list"]') ??
        content?.textContent,
    ).toBeTruthy();
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
    readonly models?: unknown;
    readonly profileSaveFailures?: number;
  } = {},
): ReturnType<typeof vi.fn> {
  let profileSaveFailures = options.profileSaveFailures ?? 0;
  const request = vi.fn(
    async (input: {
      readonly path?: string;
      readonly method?: string;
      readonly body?: unknown;
      readonly operation?: string;
    }) => {
      if (input.operation === "selectDirectory")
        return success({ path: "/picked/workspace" });
      if (input.path === "/v1/environment") return success({});
      if (input.path === "/v1/insight-providers")
        return success(options.models ?? {});
      if (
        input.path === "/v1/profiles" &&
        input.method === "PUT" &&
        profileSaveFailures > 0
      ) {
        profileSaveFailures -= 1;
        return failure({ error: "profile_save_failed" });
      }
      if (
        input.path === "/v1/storage/clear-local-data" &&
        options.clearLocalDataFails === true
      )
        return failure({ error: "storage_unavailable" });
      return success({});
    },
  );
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request, onNavigate: () => () => undefined },
  });
  return request;
}

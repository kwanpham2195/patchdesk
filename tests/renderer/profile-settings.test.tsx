// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsFlow } from "../../src/renderer/src/flows/settings-flow";
import type { Profile } from "../../src/renderer/src/renderer-models";
import { failure, success } from "./fake-desktop-response";

const profile: Profile = {
  id: "cfw",
  label: "CFW",
  githubHost: "github.com",
  ghAccount: "patchdesk",
  workspaceRoots: ["/workspace/cfw"],
  ownerFilters: ["centraldigital"],
  rulePaths: ["/workspace/cfw/AGENTS.md"],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspace profile settings", () => {
  it("creates a selected profile with every editable profile list", async () => {
    const request = installDesktopApi();
    const user = userEvent.setup();
    const reload = vi.fn(async () => undefined);

    renderSettings(reload);

    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "New profile" }));
    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
      false,
    );

    await user.type(screen.getByLabelText("Profile ID"), "enterprise");
    await user.type(screen.getByLabelText("Label"), "Enterprise");
    await user.clear(screen.getByLabelText("GitHub host"));
    await user.type(
      screen.getByLabelText("GitHub host"),
      "github.example.test",
    );
    await user.type(screen.getByLabelText("GitHub account"), "enterprise-user");
    await user.type(
      screen.getByLabelText("workspace root 1"),
      "/workspace/enterprise",
    );
    await user.click(
      screen.getByRole("button", { name: "Add workspace root" }),
    );
    const chooseFolders = screen.getAllByRole("button", {
      name: "Choose folder",
    });
    const secondChooseFolder = chooseFolders[1];
    if (secondChooseFolder === undefined)
      throw new Error("Expected a second workspace root picker.");
    await user.click(secondChooseFolder);
    await user.click(
      screen.getByRole("button", { name: "Remove workspace root 1" }),
    );
    await user.type(screen.getByLabelText("owner filter 1"), "enterprise");
    await user.click(screen.getByRole("button", { name: "Add rule path" }));
    await user.type(
      screen.getByLabelText("rule path 1"),
      "/workspace/enterprise/AGENTS.md",
    );
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        path: "/v1/profiles",
        method: "POST",
        body: {
          id: "enterprise",
          label: "Enterprise",
          githubHost: "github.example.test",
          ghAccount: "enterprise-user",
          workspaceRoots: ["/picked/enterprise"],
          ownerFilters: ["enterprise"],
          rulePaths: ["/workspace/enterprise/AGENTS.md"],
        },
      }),
    );
    expect(request).toHaveBeenCalledWith({
      path: "/v1/profiles/select",
      method: "POST",
      body: { id: "enterprise" },
    });
    expect(reload).toHaveBeenCalled();
  });

  it("keeps edits made while a profile save is pending", async () => {
    let releaseSave!: () => void;
    const pendingSave = new Promise<ReturnType<typeof success>>((resolve) => {
      releaseSave = () => resolve(success({}));
    });
    installDesktopApi({ pendingProfileSave: pendingSave });
    const user = userEvent.setup();

    renderSettings();
    const label = screen.getByLabelText("Label");
    await user.clear(label);
    await user.type(label, "Saved");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await user.clear(label);
    await user.type(label, "Newer");

    releaseSave();
    await vi.waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe(
        "Newer",
      ),
    );
  });

  it("shows inline validation for a blank list entry without saving", async () => {
    const request = installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "Add owner filter" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      screen.getByText("Owner filters cannot contain blank entries."),
    ).toBeTruthy();
    expect(
      request.mock.calls.some(([input]) => input.path === "/v1/profiles"),
    ).toBe(false);
  });

  it("shows a save error inline when the profile API rejects the request", async () => {
    const request = installDesktopApi({ rejectProfileSave: true });
    const user = userEvent.setup();

    renderSettings();
    await user.type(screen.getByLabelText("Label"), " changed");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText(
        "Patchdesk could not save the local review state.",
      ),
    ).toBeTruthy();
    expect(
      request.mock.calls.some(([input]) => input.path === "/v1/profiles"),
    ).toBe(true);
  });
});

describe("workspace root discovery", () => {
  it("shows a per-root count of repositories found and watched", async () => {
    installDesktopApi({
      suggestions: [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          localPath: "/workspace/cfw/patchdesk",
        },
      ],
    });
    const watchedProfile: Profile = {
      ...profile,
      repos: [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "watched-repo",
          localPath: "/workspace/cfw/watched-repo",
        },
      ],
    };

    renderSettings(undefined, watchedProfile);

    expect(
      await screen.findByText("2 repositories found · 1 watched"),
    ).toBeTruthy();
  });

  it("shows the explicit zero-found state for a saved root with no discoveries", async () => {
    installDesktopApi({ suggestions: [] });

    renderSettings();

    expect(
      await screen.findByText(
        "No git repositories with GitHub remotes found in this folder.",
      ),
    ).toBeTruthy();
  });

  it("shows a failure state when the discovery scan errors", async () => {
    installDesktopApi({ suggestions: "reject" });

    renderSettings();

    expect(
      await screen.findByText("Could not scan this folder for repositories."),
    ).toBeTruthy();
  });

  it("shows a save affordance instead of a count for a root that hasn't been saved yet", async () => {
    installDesktopApi({ suggestions: [] });
    const user = userEvent.setup();

    renderSettings();
    await screen.findByText(
      "No git repositories with GitHub remotes found in this folder.",
    );
    await user.click(
      screen.getByRole("button", { name: "Add workspace root" }),
    );
    await user.type(
      screen.getByLabelText("workspace root 2"),
      "/workspace/unsaved",
    );

    expect(
      screen.getByText(
        "Save the profile to scan this folder for repositories.",
      ),
    ).toBeTruthy();
  });
});

describe("watchlist toggling", () => {
  it("ticking an unwatched repository adds it to the watchlist", async () => {
    const request = installDesktopApi({
      suggestions: [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          localPath: "/workspace/cfw/patchdesk",
        },
      ],
    });
    const user = userEvent.setup();

    renderSettings();

    const checkbox = await repositoryCheckbox("centraldigital/patchdesk");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await user.click(checkbox);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        path: "/v1/watchlist",
        method: "POST",
        body: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          localPath: "/workspace/cfw/patchdesk",
        },
      }),
    );
  });

  it("unticking a watched repository removes it from the watchlist", async () => {
    const request = installDesktopApi({ suggestions: [] });
    const watchedProfile: Profile = {
      ...profile,
      repos: [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "watched-repo",
          localPath: "/workspace/cfw/watched-repo",
        },
      ],
    };
    const user = userEvent.setup();

    renderSettings(undefined, watchedProfile);

    const checkbox = await repositoryCheckbox("centraldigital/watched-repo");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await user.click(checkbox);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        path: "/v1/watchlist",
        method: "DELETE",
        body: {
          host: "github.com",
          owner: "centraldigital",
          repo: "watched-repo",
        },
      }),
    );
  });

  it("renders a watched repository with no recorded local path", async () => {
    installDesktopApi({ suggestions: [] });
    const watchedProfile: Profile = {
      ...profile,
      repos: [
        { host: "github.com", owner: "centraldigital", repo: "no-path-repo" },
      ],
    };

    renderSettings(undefined, watchedProfile);

    const checkbox = await repositoryCheckbox("centraldigital/no-path-repo");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    const row = checkbox.closest("label");
    if (row === null)
      throw new Error("Expected the repository row to render inside a label.");
    // The row still renders with an empty local-path line rather than
    // omitting it or throwing, confirming the `localPath: ""` normalisation.
    expect(
      within(row).getByText("centraldigital/no-path-repo").nextSibling
        ?.textContent,
    ).toBe("");
  });

  it("shows a watched repository whose local path matches no saved workspace root", async () => {
    installDesktopApi({ suggestions: [] });
    const watchedProfile: Profile = {
      ...profile,
      repos: [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "outside-repo",
          localPath: "/elsewhere/outside-repo",
        },
      ],
    };

    renderSettings(undefined, watchedProfile);

    expect(
      await screen.findByText("Watched outside current workspace roots"),
    ).toBeTruthy();
    const outsideGroup = screen.getByLabelText(
      "Repositories watched outside current workspace roots",
    );
    const checkbox = within(outsideGroup).getByRole("checkbox");
    expect(
      within(outsideGroup).getByText("centraldigital/outside-repo"),
    ).toBeTruthy();
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  });
});

/** Finds the repository checklist row for `ownerSlashRepo` (rendered by `RepositoryChecklist`) and returns its checkbox. */
async function repositoryCheckbox(
  ownerSlashRepo: string,
): Promise<HTMLElement> {
  const text = await screen.findByText(ownerSlashRepo);
  const row = text.closest("label");
  if (row === null)
    throw new Error("Expected the repository row to render inside a label.");
  return within(row).getByRole("checkbox");
}

function renderSettings(
  onWorkspaceReload: () => Promise<void> = async () => undefined,
  activeProfile: Profile = profile,
): void {
  render(
    <SettingsFlow
      dashboard={{ profile: activeProfile, dashboard: { repos: [] } }}
      appearance="system"
      onAppearanceChange={() => undefined}
      diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
      onDiffThemeChange={() => undefined}
      profiles={[activeProfile]}
      onWorkspaceReload={onWorkspaceReload}
      section="workspace"
    />,
  );
}

function installDesktopApi(
  options: {
    readonly rejectProfileSave?: boolean;
    readonly pendingProfileSave?: Promise<ReturnType<typeof success>>;
    readonly suggestions?:
      | "reject"
      | ReadonlyArray<{
          readonly host: string;
          readonly owner: string;
          readonly repo: string;
          readonly localPath: string;
        }>;
  } = {},
): ReturnType<typeof vi.fn> {
  const request = vi.fn(
    async (input: {
      readonly path?: string;
      readonly method?: string;
      readonly body?: unknown;
      readonly operation?: string;
    }) => {
      if (input.operation === "selectDirectory")
        return success({ path: "/picked/enterprise" });
      if (input.path === "/v1/environment") return success({});
      if (input.path === "/v1/watchlist/suggestions") {
        return options.suggestions === "reject"
          ? failure({ error: "storage" })
          : success(options.suggestions ?? []);
      }
      if (
        input.path === "/v1/profiles" &&
        options.pendingProfileSave !== undefined
      )
        return options.pendingProfileSave;
      if (input.path === "/v1/profiles" && options.rejectProfileSave === true)
        return failure({ error: "storage" });
      return success({});
    },
  );
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request, onNavigate: () => () => undefined },
  });
  return request;
}

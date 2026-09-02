// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "../../src/renderer/src/components/settings-modal";
import type { RawJsonValue } from "../../src/domain/json";
import { SettingsFlow } from "../../src/renderer/src/flows/settings-flow";
import type { Profile } from "../../src/renderer/src/renderer-models";
import type { WorkspaceRootDiscovery } from "../../src/renderer/src/workspace-root-discovery-contract";
import type {
  ProfileSwitchResult,
  ProfileSwitchState,
} from "../../src/renderer/src/hooks/use-profile-switch";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const profile: Profile = {
  id: "cfw",
  label: "CFW",
  githubHost: "github.com",
  ghAccount: "patchdesk",
  workspaceRoots: ["/workspace/cfw"],
  ownerFilters: ["centraldigital"],
  rulePaths: ["/workspace/cfw/AGENTS.md"],
};

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  desktop?.restore();
  desktop = undefined;
});

describe("workspace profile settings", () => {
  it("guards a dirty profile draft before starting a new profile", async () => {
    installDesktopApi();
    const user = userEvent.setup();

    renderSettingsModal();
    const label = screen.getByLabelText("Label");
    await user.clear(label);
    await user.type(label, "Draft CFW");
    await user.click(screen.getByRole("button", { name: "New profile" }));

    expect(
      screen.getByRole("alertdialog", { name: "Discard profile changes?" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe(
      "Draft CFW",
    );
    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
      true,
    );

    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await vi.waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe(""),
    );
    expect(screen.getByLabelText<HTMLInputElement>("Profile ID").value).toBe(
      "",
    );
    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("saves a dirty existing profile before opening a new draft", async () => {
    let releaseSave!: () => void;
    const pendingSave = new Promise<ReturnType<typeof success>>((resolve) => {
      releaseSave = () => resolve(success({}));
    });
    const desktopApi = installDesktopApi({ pendingProfileSave: pendingSave });
    const user = userEvent.setup();

    renderSettingsModal();
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "Saved CFW");
    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
        path: "/v1/profiles",
        method: "PUT",
        body: {
          id: profile.id,
          label: "Saved CFW",
          githubHost: profile.githubHost,
          ghAccount: profile.ghAccount,
          workspaceRoots: profile.workspaceRoots,
          ownerFilters: profile.ownerFilters,
          rulePaths: profile.rulePaths,
        },
      }),
    );
    expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe(
      "Saved CFW",
    );
    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
      true,
    );

    releaseSave();
    await vi.waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe(""),
    );
    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("guards a dirty new-profile draft before replacing or selecting it", async () => {
    installDesktopApi();
    const user = userEvent.setup();
    const otherProfile: Profile = { ...profile, id: "other", label: "Other" };

    renderSettingsModal([profile, otherProfile]);
    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.click(screen.getByRole("button", { name: "New profile" }));
    expect(
      screen.getByRole("alertdialog", { name: "Discard profile changes?" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText<HTMLInputElement>("Profile ID").value).toBe(
      "",
    );

    await user.click(screen.getByRole("combobox", { name: "Active profile" }));
    await user.click(await screen.findByRole("option", { name: "Other" }));
    expect(
      screen.getByRole("alertdialog", { name: "Discard profile changes?" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText<HTMLInputElement>("Profile ID").value).toBe(
      "",
    );
    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("shares a pending save with the New profile guard continuation", async () => {
    let releaseSave!: () => void;
    const pendingSave = new Promise<ReturnType<typeof success>>((resolve) => {
      releaseSave = () => resolve(success({}));
    });
    const desktopApi = installDesktopApi({ pendingProfileSave: pendingSave });
    const user = userEvent.setup();

    renderSettingsModal();
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "Saved CFW");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(profileSaveRequests(desktopApi)).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe(
      "Saved CFW",
    );

    releaseSave();
    await vi.waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe(""),
    );
    expect(profileSaveRequests(desktopApi)).toHaveLength(1);
  });

  it("treats a whitespace-equivalent newer new-profile ID as an existing draft", async () => {
    let releaseSave!: () => void;
    const pendingSave = new Promise<ReturnType<typeof success>>((resolve) => {
      releaseSave = () => resolve(success({}));
    });
    const desktopApi = installDesktopApi({ pendingProfileSave: pendingSave });
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.type(screen.getByLabelText("Profile ID"), "first");
    await user.type(screen.getByLabelText("Label"), "First");
    await user.type(screen.getByLabelText("GitHub account"), "first-user");
    await user.type(
      screen.getByLabelText("workspace root 1"),
      "/workspace/first",
    );
    await user.type(screen.getByLabelText("owner filter 1"), "first-owner");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await user.clear(screen.getByLabelText("Profile ID"));
    await user.type(screen.getByLabelText("Profile ID"), "first ");

    releaseSave();
    await vi.waitFor(() =>
      expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
        true,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await vi.waitFor(() =>
      expect(profileSaveRequests(desktopApi)).toContainEqual({
        path: "/v1/profiles",
        method: "PUT",
        body: expect.objectContaining({ id: "first" }),
      }),
    );
  });

  it("keeps a newer new-profile ID editable after its earlier POST settles", async () => {
    let releaseSave!: () => void;
    const pendingSave = new Promise<ReturnType<typeof success>>((resolve) => {
      releaseSave = () => resolve(success({}));
    });
    const desktopApi = installDesktopApi({ pendingProfileSave: pendingSave });
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.type(screen.getByLabelText("Profile ID"), "first");
    await user.type(screen.getByLabelText("Label"), "First");
    await user.type(screen.getByLabelText("GitHub account"), "first-user");
    await user.type(
      screen.getByLabelText("workspace root 1"),
      "/workspace/first",
    );
    await user.type(screen.getByLabelText("owner filter 1"), "first-owner");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/profiles",
          method: "POST",
          body: expect.objectContaining({ id: "first" }),
        }),
      ),
    );
    await user.clear(screen.getByLabelText("Profile ID"));
    await user.type(screen.getByLabelText("Profile ID"), "second");

    releaseSave();
    await vi.waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Profile ID").value).toBe(
        "second",
      ),
    );
    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(
      false,
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Save profile" })).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/profiles",
          method: "POST",
          body: expect.objectContaining({ id: "second" }),
        }),
      ),
    );
  });

  it("creates a selected profile with every editable profile list", async () => {
    const desktopApi = installDesktopApi();
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
      expect(desktopApi.request).toHaveBeenCalledWith({
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
    expect(desktopApi.request).toHaveBeenCalledWith({
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
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "Add owner filter" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      screen.getByText("Owner filters cannot contain blank entries."),
    ).toBeTruthy();
    expect(
      desktopApi.request.mock.calls.some(
        ([input]) => "path" in input && input.path === "/v1/profiles",
      ),
    ).toBe(false);
  });

  it("associates every invalid profile scalar with its field before saving", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.type(screen.getByLabelText("Profile ID"), "invalid/id");
    await user.type(screen.getByLabelText("Label"), "   ");
    await user.clear(screen.getByLabelText("GitHub host"));
    await user.type(
      screen.getByLabelText("GitHub host"),
      "https://github.example.test/path",
    );
    await user.clear(screen.getByLabelText("GitHub account"));
    await user.type(screen.getByLabelText("GitHub account"), "x".repeat(40));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    for (const [label, errorId] of [
      ["Profile ID", "profile-id-error"],
      ["Label", "profile-label-error"],
      ["GitHub host", "profile-github-host-error"],
      ["GitHub account", "profile-gh-account-error"],
    ] as const) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toBe(errorId);
      expect(document.getElementById(errorId)?.textContent).not.toBe("");
    }
    expect(profileSaveRequests(desktopApi)).toHaveLength(0);

    await user.clear(screen.getByLabelText("Profile ID"));
    await user.type(screen.getByLabelText("Profile ID"), "valid-id");

    expect(
      screen.getByLabelText("Profile ID").getAttribute("aria-invalid"),
    ).toBeNull();
    for (const field of [
      screen.getByLabelText("Label"),
      screen.getByLabelText("GitHub host"),
      screen.getByLabelText("GitHub account"),
    ])
      expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("exposes invalid manual account fields after a disclosure closes", async () => {
    installDesktopApi({
      environment: {
        git: "ready",
        gh: "ready",
        githubAuth: "ready",
        githubAccounts: [
          { host: "github.com", login: "patchdesk", active: true },
        ],
      },
    });
    const user = userEvent.setup();

    renderSettings();
    await user.click(
      await screen.findByRole("button", { name: "Use a different account" }),
    );
    await user.clear(screen.getByLabelText("GitHub host"));
    await user.type(screen.getByLabelText("GitHub host"), "https://bad.test");
    await user.clear(screen.getByLabelText("GitHub account"));
    await user.type(screen.getByLabelText("GitHub account"), "x".repeat(40));
    await user.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    const host = screen.getByLabelText("GitHub host");
    const account = screen.getByLabelText("GitHub account");
    expect(host.getAttribute("aria-describedby")).toBe(
      "profile-github-host-error",
    );
    expect(account.getAttribute("aria-describedby")).toBe(
      "profile-gh-account-error",
    );
    expect(
      document.getElementById("profile-github-host-error")?.textContent,
    ).not.toBe("");
    expect(
      document.getElementById("profile-gh-account-error")?.textContent,
    ).not.toBe("");

    await user.clear(host);
    await user.type(host, "github.com");
    expect(host.getAttribute("aria-invalid")).toBeNull();
    expect(account.getAttribute("aria-invalid")).toBe("true");
  });

  it("renders manual account fields when GitHub authentication fails", async () => {
    installDesktopApi({
      environment: {
        git: "ready",
        gh: "ready",
        githubAuth: "authentication_required",
        githubAccounts: [],
      },
    });

    renderSettings();

    expect(await screen.findByLabelText("GitHub host")).toBeTruthy();
    expect(screen.getByLabelText("GitHub account")).toBeTruthy();
  });

  it("trims valid profile scalars before requesting a save", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.type(screen.getByLabelText("Profile ID"), "  spaced-id  ");
    await user.type(screen.getByLabelText("Label"), "  Spaced label  ");
    await user.clear(screen.getByLabelText("GitHub host"));
    await user.type(
      screen.getByLabelText("GitHub host"),
      " github.example.test ",
    );
    await user.clear(screen.getByLabelText("GitHub account"));
    await user.type(screen.getByLabelText("GitHub account"), " spaced-user ");
    await user.type(
      screen.getByLabelText("workspace root 1"),
      "/workspace/spaced",
    );
    await user.type(screen.getByLabelText("owner filter 1"), "spaced-owner");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await vi.waitFor(() =>
      expect(profileSaveRequests(desktopApi)).toContainEqual({
        path: "/v1/profiles",
        method: "POST",
        body: expect.objectContaining({
          id: "spaced-id",
          label: "Spaced label",
          githubHost: "github.example.test",
          ghAccount: "spaced-user",
        }),
      }),
    );
  });

  it("shows a save error inline when the profile API rejects the request", async () => {
    const desktopApi = installDesktopApi({ rejectProfileSave: true });
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
      desktopApi.request.mock.calls.some(
        ([input]) => "path" in input && input.path === "/v1/profiles",
      ),
    ).toBe(true);
  });
  it("uses the control-linked field error for a Settings-owned profile switch failure", () => {
    installDesktopApi();

    renderSettings(undefined, profile, {
      profileSwitchState: {
        pendingTarget: undefined,
        pendingOwner: undefined,
        error: { owner: "settings", message: "Profile switch failed" },
      },
    });

    expect(
      screen
        .getAllByRole("alert")
        .find((candidate) => candidate.dataset.slot === "field-error"),
    ).toBeTruthy();
  });

  it("preserves every profile draft field when profile switching fails", async () => {
    installDesktopApi();
    const user = userEvent.setup();
    const otherProfile: Profile = {
      ...profile,
      id: "other",
      label: "Other",
      workspaceRoots: ["/workspace/other"],
    };

    renderSettings(undefined, profile, {
      profiles: [profile, otherProfile],
      onProfileSwitch: async () => "failed",
    });
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "Draft label");
    await user.clear(screen.getByLabelText("workspace root 1"));
    await user.type(
      screen.getByLabelText("workspace root 1"),
      "/workspace/draft",
    );

    await user.click(screen.getByRole("combobox", { name: "Active profile" }));
    await user.click(await screen.findByRole("option", { name: "Other" }));

    expect(screen.getByLabelText<HTMLInputElement>("Label").value).toBe(
      "Draft label",
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("workspace root 1").value,
    ).toBe("/workspace/draft");
    expect(
      screen.getByLabelText<HTMLInputElement>("GitHub account").value,
    ).toBe(profile.ghAccount);
  });
});

describe("watchlist toggling", () => {
  it("ticking an unwatched repository adds it to the watchlist", async () => {
    const desktopApi = installDesktopApi({
      suggestions: readyDiscovery("/workspace/cfw", [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          localPath: "/workspace/cfw/patchdesk",
        },
      ]),
    });
    const user = userEvent.setup();

    renderSettings();

    const checkbox = await repositoryCheckbox("centraldigital/patchdesk");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await user.click(checkbox);

    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
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
    const desktopApi = installDesktopApi({
      suggestions: readyDiscovery("/workspace/cfw", []),
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
    const user = userEvent.setup();

    renderSettings(undefined, watchedProfile);

    const checkbox = await repositoryCheckbox("centraldigital/watched-repo");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await user.click(checkbox);

    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
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
    installDesktopApi({ suggestions: readyDiscovery("/workspace/cfw", []) });
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

  it("renders a failed watchlist mutation as an action-local error", async () => {
    installDesktopApi({
      rejectWatchlist: true,
      suggestions: readyDiscovery("/workspace/cfw", [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          localPath: "/workspace/cfw/patchdesk",
        },
      ]),
    });
    const user = userEvent.setup();

    renderSettings();
    await user.click(await repositoryCheckbox("centraldigital/patchdesk"));

    await vi.waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((candidate) => candidate.dataset.slot === "inline-error"),
      ).toBe(true),
    );
  });

  it("shows a watched repository whose local path matches no saved workspace root", async () => {
    installDesktopApi({ suggestions: readyDiscovery("/workspace/cfw", []) });
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

function profileSaveRequests(desktopApi: DesktopDouble) {
  return desktopApi.request.mock.calls
    .map(([input]) => input)
    .filter((input) => "path" in input && input.path === "/v1/profiles");
}

function renderSettings(
  onWorkspaceReload: () => Promise<void> = async () => undefined,
  activeProfile: Profile = profile,
  options: {
    readonly profiles?: ReadonlyArray<Profile>;
    readonly onProfileSwitch?: () => Promise<ProfileSwitchResult>;
    readonly profileSwitchState?: ProfileSwitchState;
  } = {},
): void {
  render(
    <SettingsFlow
      dashboard={{ profile: activeProfile, dashboard: { repos: [] } }}
      appearance="system"
      onAppearanceChange={() => undefined}
      diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
      onDiffThemeChange={() => undefined}
      profiles={options.profiles ?? [activeProfile]}
      onWorkspaceReload={onWorkspaceReload}
      onProfileSwitchRequest={(_profileId, proceed) => proceed()}
      {...(options.profileSwitchState === undefined
        ? {}
        : { profileSwitchState: options.profileSwitchState })}
      {...(options.onProfileSwitch === undefined
        ? {}
        : { onProfileSwitch: options.onProfileSwitch })}
      section="workspace"
    />,
  );
}

function renderSettingsModal(
  profiles: ReadonlyArray<Profile> = [profile],
): void {
  render(
    <SettingsModal
      open
      onOpenChange={() => undefined}
      dashboard={{ profile, dashboard: { repos: [] } }}
      appearance="system"
      onAppearanceChange={() => undefined}
      diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
      onDiffThemeChange={() => undefined}
      profiles={profiles}
      onWorkspaceReload={async () => undefined}
      onProfileSwitch={async () => "applied"}
      initialSection="workspace"
    />,
  );
}

function installDesktopApi(
  options: {
    readonly rejectProfileSave?: boolean;
    readonly rejectWatchlist?: boolean;
    readonly pendingProfileSave?: Promise<ReturnType<typeof success>>;
    readonly environment?: RawJsonValue;
    readonly suggestions?: "reject" | ReadonlyArray<WorkspaceRootDiscovery>;
  } = {},
): DesktopDouble {
  desktop = installDesktopDouble(
    {
      "/v1/environment": () => success(options.environment ?? {}),
      "/v1/profiles/select": () => success({}),
      "/v1/watchlist": () =>
        options.rejectWatchlist === true
          ? failure({ error: "storage" })
          : success({}),
      "/v1/watchlist/suggestions": () =>
        options.suggestions === "reject"
          ? failure({ error: "storage" })
          : success(
              options.suggestions ?? readyDiscovery("/workspace/cfw", []),
            ),
      "/v1/profiles": () => {
        if (options.pendingProfileSave !== undefined)
          return options.pendingProfileSave;
        if (options.rejectProfileSave === true)
          return failure({ error: "storage" });
        return success({});
      },
    },
    {
      operations: {
        selectDirectory: () => success({ path: "/picked/enterprise" }),
      },
    },
  );
  return desktop;
}

function readyDiscovery(
  root: string,
  repositories: ReadonlyArray<{
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
    readonly localPath: string;
  }>,
): ReadonlyArray<WorkspaceRootDiscovery> {
  return [{ root, state: "ready", repositories: [...repositories] }];
}

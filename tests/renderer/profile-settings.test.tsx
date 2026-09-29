// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { SettingsFlow } from "../../src/renderer/src/flows/settings-flow";
import type { Profile } from "../../src/renderer/src/renderer-models";
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
  id: "acme",
  label: "ACME",
  githubHost: "github.com",
  ghAccount: "patchdesk",
  rulePaths: ["/workspace/acme/AGENTS.md"],
};

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  desktop?.restore();
  desktop = undefined;
});

describe("workspace profile settings", () => {
  it("saves the rule path list on the edit that changed it", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();
    const reload = vi.fn(async () => undefined);

    renderSettings(reload);

    await user.click(screen.getByRole("button", { name: "Add rule path" }));
    await user.type(
      screen.getByLabelText("Rule path 2"),
      "/workspace/acme/CONTRIBUTING.md",
    );
    await user.tab();

    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
        path: "/v1/profiles",
        method: "PUT",
        body: {
          id: "acme",
          label: "ACME",
          githubHost: "github.com",
          ghAccount: "patchdesk",
          rulePaths: [
            "/workspace/acme/AGENTS.md",
            "/workspace/acme/CONTRIBUTING.md",
          ],
        },
      }),
    );
    expect(reload).toHaveBeenCalled();
  });

  it("keeps a blank list row local until it carries a value", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "Add rule path" }));
    await user.click(screen.getByLabelText("Rule path 2"));
    await user.tab();

    expect(profileSaveRequests(desktopApi)).toHaveLength(0);
    expect(screen.getByLabelText("Rule path 2")).toBeTruthy();
  });

  it("reports every invalid scalar beside its own field without sending it", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await openWorkspaceCard(user);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "   ");
    await user.tab();
    await user.clear(screen.getByLabelText("GitHub host"));
    await user.type(
      screen.getByLabelText("GitHub host"),
      "https://github.example.test/path",
    );
    await user.tab();
    await user.clear(screen.getByLabelText("GitHub account"));
    await user.type(screen.getByLabelText("GitHub account"), "x".repeat(40));
    await user.tab();

    for (const [label, statusId] of [
      ["Name", "profile-label-status"],
      ["GitHub host", "profile-github-host-status"],
      ["GitHub account", "profile-gh-account-status"],
    ] as const) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toBe(statusId);
      expect(document.getElementById(statusId)?.textContent).not.toBe("");
    }
    expect(profileSaveRequests(desktopApi)).toHaveLength(0);

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Named");
    await user.tab();

    await vi.waitFor(() =>
      expect(
        screen.getByLabelText("Name").getAttribute("aria-invalid"),
      ).toBeNull(),
    );
    for (const field of [
      screen.getByLabelText("GitHub host"),
      screen.getByLabelText("GitHub account"),
    ])
      expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps rejected manual account fields on screen with their reason", async () => {
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
    await user.tab();

    // A rejected value keeps its field on screen: the disclosure that would
    // have hidden it is replaced by the fields themselves.
    expect(
      screen.queryByRole("button", { name: "Use a different account" }),
    ).toBeNull();
    expect(
      screen.getByLabelText("GitHub host").getAttribute("aria-describedby"),
    ).toBe("profile-github-host-status");
    expect(
      document.getElementById("profile-github-host-status")?.textContent,
    ).not.toBe("");
    expect(
      screen.getByLabelText("GitHub account").getAttribute("aria-invalid"),
    ).toBeNull();

    await user.clear(screen.getByLabelText("GitHub host"));
    await user.type(screen.getByLabelText("GitHub host"), "github.com");
    await user.tab();

    // Restoring a value the profile can hold puts the fields back behind the
    // disclosure they came from.
    expect(
      await screen.findByRole("button", { name: "Use a different account" }),
    ).toBeTruthy();
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

  it("trims a scalar on commit before sending it", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await openWorkspaceCard(user);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "  Spaced label  ");
    await user.tab();
    await user.clear(screen.getByLabelText("GitHub host"));
    await user.type(
      screen.getByLabelText("GitHub host"),
      " github.example.test ",
    );
    await user.tab();
    await user.clear(screen.getByLabelText("GitHub account"));
    await user.type(screen.getByLabelText("GitHub account"), " spaced-user ");
    await user.tab();

    await vi.waitFor(() =>
      expect(profileSaveRequests(desktopApi)).toContainEqual({
        path: "/v1/profiles",
        method: "PUT",
        body: expect.objectContaining({
          id: "acme",
          label: "Spaced label",
          githubHost: "github.example.test",
          ghAccount: "spaced-user",
        }),
      }),
    );
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Spaced label",
    );
  });

  it("shows a rejected save beside the control that caused it", async () => {
    const desktopApi = installDesktopApi({ rejectProfileSave: true });
    const user = userEvent.setup();

    renderSettings();
    await openWorkspaceCard(user);
    await user.type(screen.getByLabelText("Name"), " changed");
    await user.tab();

    expect(
      await screen.findByText(
        "Patchdesk could not save the local review state.",
      ),
    ).toBeTruthy();
    expect(profileSaveRequests(desktopApi)).toHaveLength(1);
    // The typed value stays, so the edit can be retried where it was made.
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "ACME changed",
    );
  });
  it("opens Advanced only when the workspace already carries a rule path", async () => {
    installDesktopApi();

    renderSettings();
    expect(screen.getByLabelText("Rule path 1")).toBeTruthy();
    cleanup();

    renderSettings(undefined, { ...profile, rulePaths: [] });
    expect(screen.queryByLabelText("Rule path 1")).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: "Add rule path" })).toBeTruthy();
  });

  it("keeps the Workspace card closed until it is opened", async () => {
    installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    expect(screen.queryByLabelText("Name")).toBeNull();

    await openWorkspaceCard(user);

    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("ACME");
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

  it("keeps every profile field on screen when profile switching fails", async () => {
    installDesktopApi();
    const user = userEvent.setup();
    const otherProfile: Profile = {
      ...profile,
      id: "other",
      label: "Other",
    };

    renderSettings(undefined, profile, {
      profiles: [profile, otherProfile],
      onProfileSwitch: async () => "failed",
    });
    await openWorkspaceCard(user);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Draft label");

    await user.click(
      screen.getByRole("combobox", { name: "Active workspace" }),
    );
    await user.click(await screen.findByRole("option", { name: "Other" }));

    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Draft label",
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("GitHub account").value,
    ).toBe(profile.ghAccount);
  });
});

describe("watched repositories", () => {
  it("lists each watched repository with its checkout, or none chosen", async () => {
    installDesktopApi();

    renderSettings(undefined, {
      ...profile,
      repos: [
        {
          host: "github.com",
          owner: "octo-org",
          repo: "patchdesk",
          localPath: "/workspace/acme/patchdesk",
        },
        { host: "github.com", owner: "octo-org", repo: "no-checkout" },
      ],
    });

    const list = await screen.findByRole("list", {
      name: "Watched repositories",
    });
    expect(
      within(
        within(list).getByRole("listitem", { name: "octo-org/patchdesk" }),
      ).getByText("/workspace/acme/patchdesk"),
    ).toBeTruthy();
    expect(
      within(
        within(list).getByRole("listitem", { name: "octo-org/no-checkout" }),
      ).getByText("No checkout chosen"),
    ).toBeTruthy();
  });

  it("saves the folder picked with Choose checkout for that repository", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();
    const reload = vi.fn(async () => undefined);

    renderSettings(reload, {
      ...profile,
      repos: [{ host: "github.com", owner: "octo-org", repo: "patchdesk" }],
    });
    await user.click(
      within(
        await screen.findByRole("listitem", { name: "octo-org/patchdesk" }),
      ).getByRole("button", { name: "Choose checkout" }),
    );

    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
        path: "/v1/watchlist/checkout",
        method: "PUT",
        body: {
          profileId: "acme",
          host: "github.com",
          owner: "octo-org",
          repo: "patchdesk",
          localPath: "/picked/patchdesk",
        },
      }),
    );
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  });
});

/** Opens the Workspace disclosure card, which is collapsed until the user asks for it. */
async function openWorkspaceCard(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Workspace" }));
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

function installDesktopApi(
  options: {
    readonly rejectProfileSave?: boolean;
    readonly environment?: RawJsonValue;
  } = {},
): DesktopDouble {
  desktop = installDesktopDouble(
    {
      "/v1/environment": () => success(options.environment ?? {}),
      "/v1/profiles/select": () => success({}),
      "/v1/watchlist": () => success({}),
      "/v1/watchlist/checkout": () => success({}),
      "/v1/profiles": () => {
        if (options.rejectProfileSave === true)
          return failure({ error: "storage" });
        return success({});
      },
    },
    {
      operations: {
        selectDirectory: () => success({ path: "/picked/patchdesk" }),
      },
    },
  );
  return desktop;
}

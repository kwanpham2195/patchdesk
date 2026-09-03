// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { SettingsFlow } from "../../src/renderer/src/flows/settings-flow";
import type { Profile } from "../../src/renderer/src/renderer-models";
import type { WorkspaceRootDiscovery } from "../../src/renderer/src/workspace-root-discovery-contract";
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
  rulePaths: ["/workspace/cfw/AGENTS.md"],
};

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  desktop?.restore();
  desktop = undefined;
});

describe("workspace root discovery", () => {
  it("shows a per-root count of repositories found and watched", async () => {
    installDesktopApi({
      suggestions: readyDiscovery("/workspace/cfw", [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          localPath: "/workspace/cfw/patchdesk",
        },
      ]),
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

    renderSettings(watchedProfile);

    expect(
      await screen.findByText("2 repositories found · 1 watched"),
    ).toBeTruthy();
  });

  it("shows the explicit zero-found state for a saved root with no discoveries", async () => {
    installDesktopApi({ suggestions: readyDiscovery("/workspace/cfw", []) });

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

  it("says nothing about a folder row the saved profile does not carry", async () => {
    installDesktopApi({ suggestions: readyDiscovery("/workspace/cfw", []) });
    const user = userEvent.setup();

    renderSettings();

    const savedRootStatus = await screen.findByRole("status");
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    await user.type(await screen.findByLabelText("Folder 2"), "/not-saved-yet");

    // Discovery runs server-side against the saved profile, so an unsaved row
    // reports nothing rather than scanning forever.
    expect(screen.getAllByRole("status")).toEqual([savedRootStatus]);
  });

  it("keeps a ready root usable when another saved root scan fails", async () => {
    const desktopApi = installDesktopApi({
      environment: readyEnvironment,
      suggestions: [
        {
          root: "/ready",
          state: "ready",
          repositories: [
            {
              host: "github.com",
              owner: "centraldigital",
              repo: "ready-repo",
              localPath: "/ready/ready-repo",
            },
            {
              host: "github.com",
              owner: "centraldigital",
              repo: "unwatched-failed-repo",
              localPath: "/failed/unwatched-failed-repo",
            },
          ],
        },
        { root: "/failed", state: "failed", reason: "scan_failed" },
      ],
    });
    const user = userEvent.setup();
    const profileWithPartialDiscovery: Profile = {
      ...profile,
      workspaceRoots: ["/ready", "/failed"],
      repos: [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "watched-failed-repo",
          localPath: "/failed/watched-failed-repo",
        },
      ],
    };

    renderSettings(profileWithPartialDiscovery);

    const readyRepositories = await screen.findByLabelText(
      "Repositories under /ready",
    );
    const readyCheckbox = within(readyRepositories).getByRole("checkbox");
    const failedRepositories = screen.getByLabelText(
      "Repositories under /failed",
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(
      within(failedRepositories)
        .getByRole("checkbox", {
          name: "centraldigital/watched-failed-repo /failed/watched-failed-repo",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(failedRepositories).queryByRole("checkbox", {
        name: "centraldigital/unwatched-failed-repo /failed/unwatched-failed-repo",
      }),
    ).toBeNull();

    await user.click(readyCheckbox);
    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
        path: "/v1/watchlist",
        method: "POST",
        body: {
          host: "github.com",
          owner: "centraldigital",
          repo: "ready-repo",
          localPath: "/ready/ready-repo",
        },
      }),
    );
  });

  it("treats a missing saved-root outcome as a scan error", async () => {
    installDesktopApi({
      environment: readyEnvironment,
      suggestions: readyDiscovery("/ready", []),
    });
    const profileWithMissingOutcome: Profile = {
      ...profile,
      workspaceRoots: ["/ready", "/missing"],
    };

    renderSettings(profileWithMissingOutcome);

    await screen.findByLabelText("Folder 2");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});

function renderSettings(activeProfile: Profile = profile): void {
  render(
    <SettingsFlow
      dashboard={{ profile: activeProfile, dashboard: { repos: [] } }}
      appearance="system"
      onAppearanceChange={() => undefined}
      diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
      onDiffThemeChange={() => undefined}
      profiles={[activeProfile]}
      onWorkspaceReload={async () => undefined}
      section="workspace"
    />,
  );
}

function installDesktopApi(
  options: {
    readonly environment?: RawJsonValue;
    readonly suggestions?: "reject" | ReadonlyArray<WorkspaceRootDiscovery>;
  } = {},
): DesktopDouble {
  desktop = installDesktopDouble({
    "/v1/environment": () => success(options.environment ?? {}),
    "/v1/watchlist": () => success({}),
    "/v1/watchlist/suggestions": () =>
      options.suggestions === "reject"
        ? failure({ error: "storage" })
        : success(options.suggestions ?? readyDiscovery("/workspace/cfw", [])),
  });
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

const readyEnvironment: RawJsonValue = {
  git: "ready",
  gh: "ready",
  githubAuth: "ready",
  githubAccounts: [{ host: "github.com", login: "patchdesk", active: true }],
};

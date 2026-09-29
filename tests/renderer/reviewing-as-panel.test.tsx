// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsFlow } from "../../src/renderer/src/flows/settings-flow";
import type { EnvironmentCheckResponse } from "../../src/renderer/src/renderer-contracts";
import type {
  Dashboard,
  Profile,
} from "../../src/renderer/src/renderer-models";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

function makeProfile(
  overrides: {
    readonly ghAccount?: string;
    readonly githubHost?: string;
  } = {},
) {
  return {
    id: "acme",
    label: "ACME",
    githubHost: overrides.githubHost ?? "github.com",
    ghAccount: overrides.ghAccount ?? "",
    rulePaths: [],
  } satisfies Profile;
}

const profile = makeProfile();

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  desktop?.restore();
  desktop = undefined;
});

describe("Reviewing as panel", () => {
  it("renders a resolved statement for exactly one authenticated account, with manual entry behind a disclosure", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [
        { host: "github.com", login: "patchdesk", active: true },
      ],
    }));
    const user = userEvent.setup();
    renderSettings();

    // The statement's wording is the panel's to change; what a maintainer
    // acts on is which account and host it names.
    expect(await screen.findByText("patchdesk")).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    expect(screen.getByLabelText("GitHub account")).toBeTruthy();
    expect(screen.getByLabelText("GitHub host")).toBeTruthy();
  });

  it("adopts the sole authenticated account into an empty profile draft", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [
        { host: "github.com", login: "patchdesk", active: true },
      ],
    }));
    const user = userEvent.setup();
    renderSettings();

    await screen.findByRole("button", { name: "Use a different account" });

    await user.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("GitHub account").value,
    ).toBe("patchdesk");
    expect(screen.getByLabelText<HTMLInputElement>("GitHub host").value).toBe(
      "github.com",
    );
  });

  it("offers a Select for several authenticated accounts, defaulting to the active one", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [
        { host: "github.com", login: "alice", active: false },
        { host: "github.com", login: "bob", active: true },
      ],
    }));
    const user = userEvent.setup();
    renderSettings();

    const select = await screen.findByRole("combobox", {
      name: "Reviewing as account",
    });
    // Adoption saves the active account before the trigger can render it, so
    // the combobox first exists on the placeholder render.
    await waitFor(() => expect(select.textContent).toContain("bob"));

    await user.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText<HTMLInputElement>("GitHub account").value,
      ).toBe("bob"),
    );
    expect(screen.getByLabelText<HTMLInputElement>("GitHub host").value).toBe(
      "github.com",
    );

    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /alice/ }));
    expect(
      screen.getByRole("combobox", { name: "Reviewing as account" })
        .textContent,
    ).toContain("alice");
  });

  it("does not overwrite an already-configured account on adoption, for a single authenticated account", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [
        { host: "github.com", login: "patchdesk", active: true },
      ],
    }));
    const user = userEvent.setup();
    const configured = makeProfile({
      ghAccount: "carol",
      githubHost: "github.com",
    });
    renderSettings(configured);

    await screen.findByRole("button", { name: "Use a different account" });
    await user.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("GitHub account").value,
    ).toBe("carol");
    expect(screen.getByLabelText<HTMLInputElement>("GitHub host").value).toBe(
      "github.com",
    );
  });

  it("does not overwrite an already-configured account on adoption, for several authenticated accounts", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [
        { host: "github.com", login: "alice", active: false },
        { host: "github.com", login: "bob", active: true },
      ],
    }));
    const user = userEvent.setup();
    const configured = makeProfile({
      ghAccount: "carol",
      githubHost: "github.com",
    });
    renderSettings(configured);

    await screen.findByRole("combobox", { name: "Reviewing as account" });
    await user.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("GitHub account").value,
    ).toBe("carol");
    expect(screen.getByLabelText<HTMLInputElement>("GitHub host").value).toBe(
      "github.com",
    );
  });

  it("warns when the configured account diverges from the sole authenticated account", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [{ host: "github.com", login: "alice", active: true }],
    }));
    const configured = makeProfile({
      ghAccount: "bob",
      githubHost: "github.com",
    });
    renderSettings(configured);

    await screen.findByText("Configured account not authenticated");
    const description = document.querySelector(
      '[data-slot="alert-description"]',
    );
    expect(description).not.toBeNull();
    expect(description?.textContent).toContain("Not signed in as bob");
    expect(description?.textContent).toContain("github.com");
    expect(description?.textContent).toContain("Choose a signed-in account");
  });

  it("warns when the configured account diverges from every authenticated account", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [
        { host: "github.com", login: "alice", active: false },
        { host: "github.com", login: "bob", active: true },
      ],
    }));
    const configured = makeProfile({
      ghAccount: "carol",
      githubHost: "github.com",
    });
    renderSettings(configured);

    await screen.findByText("Configured account not authenticated");
    const description = document.querySelector(
      '[data-slot="alert-description"]',
    );
    expect(description).not.toBeNull();
    expect(description?.textContent).toContain("Not signed in as carol");
    expect(description?.textContent).toContain("github.com");
    expect(description?.textContent).toContain("Choose a signed-in account");

    expect(
      screen.getByRole("combobox", { name: "Reviewing as account" })
        .textContent,
    ).toContain("Select an account");
  });

  it("keeps manual account recovery visible when gh is missing", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "missing",
      githubAuth: "unavailable",
      githubAccounts: [],
    }));
    renderSettings();

    expect(await screen.findAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getByLabelText("GitHub account").hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByLabelText("GitHub host").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("keeps manual account recovery visible when gh has no authenticated account", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "authentication_required",
      githubAccounts: [],
    }));
    renderSettings();

    expect(await screen.findAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getByLabelText("GitHub account").hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByLabelText("GitHub host").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("falls back to manual account/host fields directly when the environment check does not parse", async () => {
    installDesktopApi(() => ({}));
    renderSettings();

    expect(await screen.findByLabelText("GitHub account")).toBeTruthy();
    expect(screen.getByLabelText("GitHub host")).toBeTruthy();
  });

  it("waits for the workspace to load before adopting, so a reload never creates or switches one (#649)", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [
        { host: "github.com", login: "patchdesk", active: true },
      ],
    }));
    // A reload with Settings open: `gh` answers while the workspace is still
    // loading, so nothing says which profile the account belongs to yet.
    const { rerender } = render(settingsFlow({ profiles: [] }));
    expect(await screen.findByText("patchdesk")).toBeTruthy();

    const personal = makeProfile({ ghAccount: "patchdesk" });
    rerender(
      settingsFlow({
        dashboard: { profile: personal, dashboard: { repos: [] } },
        profiles: [personal],
      }),
    );
    await screen.findByRole("button", { name: "Use a different account" });

    expect(profileWrites()).toEqual([]);
  });

  it("saves the adopted account onto the unsaved default workspace on a fresh install", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "ready",
      githubAccounts: [
        { host: "github.com", login: "patchdesk", active: true },
      ],
    }));
    // Main holds this profile in memory until an account is saved; no
    // workspace has loaded, so the listing carries the only copy.
    const unsavedDefault: Profile = {
      id: "default",
      label: "Default",
      githubHost: "github.com",
      ghAccount: "",
      rulePaths: [],
    };
    render(settingsFlow({ profiles: [unsavedDefault] }));

    await waitFor(() => expect(profileWrites()).toHaveLength(1));
    expect(profileWrites()).toEqual([
      [
        "/v1/profiles",
        "PUT",
        {
          id: "default",
          label: "Default",
          githubHost: "github.com",
          ghAccount: "patchdesk",
          rulePaths: [],
        },
      ],
    ]);
  });

  it("re-checks and reflects a newly authenticated account without restarting the app", async () => {
    let call = 0;
    installDesktopApi(() => {
      call += 1;
      return call === 1
        ? {
            git: "ready",
            gh: "ready",
            githubAuth: "authentication_required",
            githubAccounts: [],
          }
        : {
            git: "ready",
            gh: "ready",
            githubAuth: "ready",
            githubAccounts: [
              { host: "github.com", login: "patchdesk", active: true },
            ],
          };
    });
    const user = userEvent.setup();
    renderSettings();

    // Unauthenticated: no account is resolved, so manual entry is offered
    // directly rather than behind the disclosure.
    expect(await screen.findAllByRole("alert")).toHaveLength(1);
    expect(screen.getByLabelText("GitHub account")).toBeTruthy();
    expect(screen.queryByText("patchdesk")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Re-check" }));

    expect(await screen.findByText("patchdesk")).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Use a different account" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
  });
});

function renderSettings(
  activeProfile: ReturnType<typeof makeProfile> = profile,
): void {
  render(
    settingsFlow({
      dashboard: { profile: activeProfile, dashboard: { repos: [] } },
      profiles: [activeProfile],
    }),
  );
}

/** Settings → Workspace over the given workspace; `dashboard` is absent until one has loaded. */
function settingsFlow({
  dashboard,
  profiles,
}: {
  readonly dashboard?: Dashboard;
  readonly profiles: ReadonlyArray<Profile>;
}): React.JSX.Element {
  return (
    <SettingsFlow
      {...(dashboard === undefined ? {} : { dashboard })}
      appearance="system"
      onAppearanceChange={() => undefined}
      diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
      onDiffThemeChange={() => undefined}
      profiles={profiles}
      onWorkspaceReload={async () => undefined}
      section="workspace"
    />
  );
}

/** Every non-GET `/v1/profiles…` request sent: a create, a select, or a save. */
function profileWrites() {
  return (desktop?.request.mock.calls ?? []).flatMap(([input]) =>
    "path" in input &&
    input.path.startsWith("/v1/profiles") &&
    input.method !== undefined &&
    input.method !== "GET"
      ? [[input.path, input.method, input.body]]
      : [],
  );
}

function installDesktopApi(
  // The one test exercising the parse-failure fallback deliberately hands
  // back `{}`, so the mock's environment payload is a `Partial` of the real
  // parsed shape rather than the fully-populated response every other test
  // supplies.
  environment: () => Partial<EnvironmentCheckResponse>,
): void {
  desktop = installDesktopDouble({
    "/v1/environment": () => success(environment()),
    // Adopting the account `gh` reports saves the profile like any other
    // account choice, so the tests that start with an empty account send a
    // `PUT /v1/profiles` before anything else happens.
    "/v1/profiles": () => success({}),
    "/v1/profiles/select": () => success({}),
  });
}

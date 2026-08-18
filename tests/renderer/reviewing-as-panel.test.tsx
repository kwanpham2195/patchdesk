// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsFlow } from "../../src/renderer/src/flows/settings-flow";
import type { EnvironmentCheckResponse } from "../../src/renderer/src/renderer-contracts";
import type { Profile } from "../../src/renderer/src/renderer-models";
import type { DesktopResponse } from "../../src/main/ipc-contract";

function makeProfile(
  overrides: {
    readonly ghAccount?: string;
    readonly githubHost?: string;
  } = {},
) {
  return {
    id: "cfw",
    label: "CFW",
    githubHost: overrides.githubHost ?? "github.com",
    ghAccount: overrides.ghAccount ?? "",
    workspaceRoots: ["/workspace/cfw"],
    ownerFilters: [],
    rulePaths: [],
  } satisfies Profile;
}

const profile = makeProfile();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

    expect(
      await screen.findByText(
        (_, element) =>
          element?.textContent ===
          "Reviewing as patchdesk on github.com, from the GitHub CLI.",
      ),
    ).toBeTruthy();
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

    await screen.findByText(
      (_, element) =>
        element?.textContent ===
        "Reviewing as patchdesk on github.com, from the GitHub CLI.",
    );

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
    expect(select.textContent).toContain("bob");

    await user.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("GitHub account").value,
    ).toBe("bob");
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
    expect(description?.textContent).toContain("review as bob");
    expect(description?.textContent).toContain("github.com");
    expect(description?.textContent).toContain("does not report that account");
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
    expect(description?.textContent).toContain("review as carol");
    expect(description?.textContent).toContain("github.com");
    expect(description?.textContent).toContain("does not report that account");

    expect(
      screen.getByRole("combobox", { name: "Reviewing as account" })
        .textContent,
    ).toContain("Select an account");
  });

  it("shows gh-not-installed remediation, with no manual entry offered, when gh is missing", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "missing",
      githubAuth: "unavailable",
      githubAccounts: [],
    }));
    renderSettings();

    expect(
      await screen.findByText(
        "GitHub CLI (gh) is not installed. Install the GitHub CLI, then re-check.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use a different account" }),
    ).toBeNull();
  });

  it("shows not-authenticated remediation when gh is installed but has no authenticated accounts", async () => {
    installDesktopApi(() => ({
      git: "ready",
      gh: "ready",
      githubAuth: "authentication_required",
      githubAccounts: [],
    }));
    renderSettings();

    expect(
      await screen.findByText(
        (_, element) =>
          element?.textContent ===
          "Not authenticated. Run gh auth login, then re-check.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
  });

  it("falls back to manual account/host fields directly when the environment check does not parse", () => {
    installDesktopApi(() => ({}));
    renderSettings();

    expect(screen.getByLabelText("GitHub account")).toBeTruthy();
    expect(screen.getByLabelText("GitHub host")).toBeTruthy();
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

    expect(
      await screen.findByText(
        (_, element) =>
          element?.textContent ===
          "Not authenticated. Run gh auth login, then re-check.",
      ),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Re-check" }));

    expect(
      await screen.findByText(
        (_, element) =>
          element?.textContent ===
          "Reviewing as patchdesk on github.com, from the GitHub CLI.",
      ),
    ).toBeTruthy();
  });
});

function renderSettings(
  activeProfile: ReturnType<typeof makeProfile> = profile,
): void {
  render(
    <SettingsFlow
      dashboard={{ profile: activeProfile, dashboard: { rows: [], repos: [] } }}
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
  // The one test exercising the parse-failure fallback deliberately hands
  // back `{}`, so the mock's environment payload is a `Partial` of the real
  // parsed shape rather than the fully-populated response every other test
  // supplies.
  environment: () => Partial<EnvironmentCheckResponse>,
): void {
  const request = vi.fn(
    async (input: {
      readonly path?: string;
      readonly method?: string;
      readonly body?: unknown;
      readonly operation?: string;
    }) => {
      if (input.path === "/v1/environment") return success(environment());
      return success({});
    },
  );
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request, onNavigate: () => () => undefined },
  });
}

function success<T>(body: T): DesktopResponse {
  return { ok: true, status: 200, body, correlationId: "test" };
}

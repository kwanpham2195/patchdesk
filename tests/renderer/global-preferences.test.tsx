// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/src/app";
import type { AppearancePreference } from "../../src/renderer/src/appearance-preferences";
import {
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "../../src/renderer/src/diff-theme-preferences";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const dashboard = {
  profile: {
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "patchdesk",
  },
  dashboard: { repos: [] },
};

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("file-backed renderer preferences", () => {
  it("uses file-backed preferences ahead of renderer localStorage values", async () => {
    window.localStorage.setItem("patchdesk.appearance.v1", "light");
    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({ light: "github-light", dark: "github-dark" }),
    );
    const desktopApi = installDesktopApi({
      appearance: "dark",
      diffTheme: { light: "pierre-light", dark: "tokyo-night" },
    });
    const themeEvents: Array<DiffThemePreferences> = [];
    const onTheme = (event: Event): void => {
      // SAFETY: only a `patchdesk:diff-theme` CustomEvent reaches this
      // listener; its `detail` is still unknown to TS, and
      // `parseDiffThemePreferences` validates it before use.
      themeEvents.push(
        parseDiffThemePreferences((event as CustomEvent<unknown>).detail),
      );
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);

    render(<App />);

    await waitFor(() =>
      expect(document.documentElement.dataset.appearance).toBe("dark"),
    );
    await waitFor(() =>
      expect(themeEvents).toContainEqual({
        light: "pierre-light",
        dark: "tokyo-night",
      }),
    );
    window.removeEventListener("patchdesk:diff-theme", onTheme);
    expect(settingsPatches(desktopApi)).toHaveLength(0);
  });

  it("keeps renderer values until the missing settings write succeeds", async () => {
    window.localStorage.setItem("patchdesk.appearance.v1", "dark");
    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({ light: "github-light", dark: "github-dark" }),
    );
    const desktopApi = installDesktopApi({}, { patchSucceeds: false });

    render(<App />);

    await waitFor(() =>
      expect(settingsPatches(desktopApi).length).toBeGreaterThan(0),
    );
    expect(window.localStorage.getItem("patchdesk.appearance.v1")).toBe("dark");
    expect(
      window.localStorage.getItem("patchdesk.diff-theme.v2"),
    ).not.toBeNull();
  });

  it("removes renderer values after the missing settings write succeeds", async () => {
    window.localStorage.setItem("patchdesk.appearance.v1", "dark");
    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({ light: "github-light", dark: "github-dark" }),
    );
    const desktopApi = installDesktopApi({});

    render(<App />);

    await waitFor(() =>
      expect(settingsPatches(desktopApi).length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(window.localStorage.getItem("patchdesk.appearance.v1")).toBeNull(),
    );
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
  });

  it("replaces unavailable file-backed diff themes with installed defaults and persists the correction", async () => {
    const desktopApi = installDesktopApi({
      diffTheme: { light: "removed-light-theme", dark: "github-dark" },
    });

    render(<App />);

    await waitFor(() => {
      const corrections = settingsPatches(desktopApi);
      expect(corrections).toHaveLength(1);
      expect(corrections[0]).toEqual({
        appearance: "system",
        diffTheme: { light: "pierre-light", dark: "github-dark" },
      });
    });
  });

  it("keeps the Pierre defaults when the backend provides them explicitly", async () => {
    const desktopApi = installDesktopApi({
      diffTheme: { light: "pierre-light", dark: "pierre-dark" },
    });
    const themeEvents: Array<DiffThemePreferences> = [];
    const onTheme = (event: Event): void => {
      // SAFETY: only a `patchdesk:diff-theme` CustomEvent reaches this
      // listener; its `detail` is still unknown to TS, and
      // `parseDiffThemePreferences` validates it before use.
      themeEvents.push(
        parseDiffThemePreferences((event as CustomEvent<unknown>).detail),
      );
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);

    render(<App />);

    await waitFor(() =>
      expect(themeEvents).toContainEqual({
        light: "pierre-light",
        dark: "pierre-dark",
      }),
    );
    await waitFor(() => {
      const corrections = settingsPatches(desktopApi);
      // The appearance transfer sends one PATCH; the Pierre defaults must
      // not trigger a separate diff-theme correction.
      expect(
        corrections.filter((body) => body.diffTheme !== undefined),
      ).toHaveLength(0);
    });
    window.removeEventListener("patchdesk:diff-theme", onTheme);
  });

  it("surfaces a read failure instead of silently falling back to defaults", async () => {
    window.localStorage.setItem("patchdesk.appearance.v1", "dark");
    installDesktopApi({}, { getFails: true });

    render(<App initialState="empty" />);

    await screen.findByRole("heading", { name: "Maintainer inbox" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });

    expect(
      await screen.findByText(
        /Could not load saved preferences\. Appearance and diff theme are using defaults/,
      ),
    ).toBeTruthy();
    // The visible appearance still falls back to the renderer default rather
    // than blocking the app or showing an error screen.
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("stays silent for a genuine first run with no config file yet", async () => {
    installDesktopApi({});

    render(<App initialState="empty" />);

    await screen.findByRole("heading", { name: "Maintainer inbox" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });

    expect(screen.queryByText("Preference error")).toBeNull();
  });
});

/** The subset of the `/v1/settings` payload these tests read or patch. */
type SettingsPatchBody = {
  readonly appearance?: AppearancePreference;
  readonly diffTheme?: DiffThemePreferences;
};

function installDesktopApi(
  settings: SettingsPatchBody,
  options: {
    readonly patchSucceeds?: boolean;
    readonly getFails?: boolean;
  } = {},
): DesktopDouble {
  desktop = installDesktopDouble(
    {
      "/v1/settings": (input) => {
        if (input.method === "PATCH") {
          if (options.patchSucceeds === false)
            return failure({ error: "unavailable" });
          return success({ ...settings, ...patchBody(input.body) });
        }
        if (options.getFails === true) return failure({ error: "storage" });
        return success(settings);
      },
      "/v1/profiles": () => success([dashboard.profile]),
      "/v1/inbox": () =>
        success({
          profile: dashboard.profile,
          inbox: { rows: [], repositories: [], snapshot: {} },
        }),
      "/v1/environment": () => success({}),
      "/v1/logs": () => success(null),
      // Neither of these is what any test here asserts on; both keep the
      // `dashboard` body the file's previous catch-all returned, so the
      // screen boots exactly as it did before.
      "/v1/github/access": () => success(dashboard),
      "/v1/watchlist/suggestions": () => success(dashboard),
    },
    { operations: { setNavigationState: () => success({}) } },
  );
  return desktop;
}

/** Every `/v1/settings` PATCH the renderer sent, in call order. */
function settingsPatches(double: DesktopDouble): readonly SettingsPatchBody[] {
  return double.request.mock.calls.flatMap(([input]) =>
    "path" in input && input.path === "/v1/settings" && input.method === "PATCH"
      ? [patchBody(input.body)]
      : [],
  );
}

/** The settings patch a test sent, as the subset these tests read back. */
function patchBody(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the bridge hands every route the raw request body; this fixture only needs the two settings fields it echoes.
  body: unknown,
): SettingsPatchBody {
  return (body ?? {}) as SettingsPatchBody;
}

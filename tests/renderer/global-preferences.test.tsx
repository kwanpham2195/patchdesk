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
import { failure, success } from "./fake-desktop-response";

const dashboard = {
  profile: {
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "patchdesk",
  },
  dashboard: { repos: [] },
};

afterEach(() => {
  cleanup();
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
    const request = installDesktopApi({
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
    expect(
      request.mock.calls.some(
        ([input]) => input.path === "/v1/settings" && input.method === "PATCH",
      ),
    ).toBe(false);
  });

  it("keeps renderer values until the missing settings write succeeds", async () => {
    window.localStorage.setItem("patchdesk.appearance.v1", "dark");
    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({ light: "github-light", dark: "github-dark" }),
    );
    const request = installDesktopApi({}, { patchSucceeds: false });

    render(<App />);

    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.path === "/v1/settings" && input.method === "PATCH",
        ),
      ).toBe(true),
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
    const request = installDesktopApi({});

    render(<App />);

    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.path === "/v1/settings" && input.method === "PATCH",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(window.localStorage.getItem("patchdesk.appearance.v1")).toBeNull(),
    );
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
  });

  it("replaces unavailable file-backed diff themes with installed defaults and persists the correction", async () => {
    const request = installDesktopApi({
      diffTheme: { light: "removed-light-theme", dark: "github-dark" },
    });

    render(<App />);

    await waitFor(() => {
      const corrections = request.mock.calls.filter(
        ([input]) => input.path === "/v1/settings" && input.method === "PATCH",
      );
      expect(corrections).toHaveLength(1);
      expect(corrections[0]?.[0].body).toEqual({
        appearance: "system",
        diffTheme: { light: "pierre-light", dark: "github-dark" },
      });
    });
  });

  it("keeps the Pierre defaults when the backend provides them explicitly", async () => {
    const request = installDesktopApi({
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
      const corrections = request.mock.calls.filter(
        ([input]) => input.path === "/v1/settings" && input.method === "PATCH",
      );
      // The appearance transfer sends one PATCH; the Pierre defaults must
      // not trigger a separate diff-theme correction.
      expect(
        corrections.filter(([input]) => input.body?.diffTheme !== undefined),
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
): ReturnType<typeof vi.fn> {
  const request = vi.fn(
    async (input: {
      readonly path?: string;
      readonly method?: string;
      readonly body?: SettingsPatchBody;
      readonly operation?: string;
    }) => {
      if (input.operation === "setNavigationState") return success({});
      if (input.path === "/v1/settings" && input.method === "PATCH") {
        if (options.patchSucceeds === false)
          return failure({ error: "unavailable" });
        return success({ ...settings, ...input.body });
      }
      if (input.path === "/v1/settings") {
        if (options.getFails === true) return failure({ error: "storage" });
        return success(settings);
      }
      if (input.path === "/v1/profiles") return success([dashboard.profile]);
      if (input.path === "/v1/inbox")
        return success({
          profile: dashboard.profile,
          inbox: { rows: [], repositories: [], snapshot: {} },
        });
      if (input.path === "/v1/environment") return success({});
      return success(dashboard);
    },
  );
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request,
      onMenuAction: () => () => undefined,
      qaScrollDiagnosticsEnabled: false,
    },
  });
  return request;
}

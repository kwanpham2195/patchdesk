// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopResponse } from "../../src/main/ipc-contract";

import { App } from "../../src/renderer/src/app";
import type { AppearancePreference } from "../../src/renderer/src/appearance-preferences";
import {
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "../../src/renderer/src/diff-theme-preferences";
import { useGlobalPreferences } from "../../src/renderer/src/hooks/use-global-preferences";
import { record } from "../../src/renderer/src/json-guards";
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

    await screen.findByRole("heading", { name: "Pull requests" });
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

    await screen.findByRole("heading", { name: "Pull requests" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });

    expect(screen.queryByText("Preference error")).toBeNull();
  });
  it("ignores an obsolete initial-load failure after a newer preference succeeds", async () => {
    const load = deferredDesktopResponse();
    desktop = installDesktopDouble({
      "/v1/settings": (input) =>
        input.method === "PATCH"
          ? success({ appearance: "dark" })
          : load.promise,
      // The obsolete failure is logged, and the logger flushes on a timer
      // that races the end of the test; route the flush so the double
      // does not refuse it.
      "/v1/logs": () => success(null),
    });
    const { result } = renderHook(() => useGlobalPreferences(false));

    await act(async () => {
      await result.current.updateAppearance("dark");
    });
    await settlePatch(load, failure({ error: "storage" }));

    expect(result.current.appearance).toBe("dark");
    expect(result.current.preferenceError).toBeUndefined();
  });

  it.each(["success", "failure"] as const)(
    "ignores an obsolete appearance %s after a newer choice settles",
    async (obsoleteSettlement) => {
      const patches: Array<DeferredDesktopResponse> = [];
      const payloads: SettingsPatchBody[] = [];
      desktop = installPreferenceHookApi(payloads, patches);
      const { result } = renderHook(() => useGlobalPreferences(false));
      await waitFor(() => expect(result.current.appearance).toBe("system"));

      act(() => {
        void result.current.updateAppearance("light");
        void result.current.updateAppearance("dark");
      });

      expect(payloads).toEqual([
        { appearance: "light" },
        { appearance: "dark" },
      ]);
      expect(result.current.appearance).toBe("dark");
      expect(document.documentElement.dataset.appearance).toBe("dark");

      await settlePatch(patches[1], success({ appearance: "dark" }));
      await settlePatch(
        patches[0],
        obsoleteSettlement === "success"
          ? success({ appearance: "light" })
          : failure({ error: "storage" }),
      );

      expect(result.current.appearance).toBe("dark");
      expect(document.documentElement.dataset.appearance).toBe("dark");
      expect(result.current.preferenceError).toBeUndefined();
    },
  );

  it("keeps appearance and diff-theme settlement independent under reverse overlap", async () => {
    const patches: Array<DeferredDesktopResponse> = [];
    const payloads: SettingsPatchBody[] = [];
    desktop = installPreferenceHookApi(payloads, patches);
    const themeEvents: DiffThemePreferences[] = [];
    const onTheme = (event: Event): void => {
      // SAFETY: this listener is registered only for Patchdesk's diff-theme
      // event, and the boundary parser validates its unknown detail.
      themeEvents.push(
        parseDiffThemePreferences((event as CustomEvent<unknown>).detail),
      );
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);
    const { result } = renderHook(() => useGlobalPreferences(false));
    await waitFor(() => expect(result.current.appearance).toBe("system"));
    const nextTheme = { light: "github-light", dark: "github-dark" };

    act(() => {
      void result.current.updateAppearance("dark");
      void result.current.updateDiffTheme(nextTheme);
    });

    expect(payloads).toEqual([
      { appearance: "dark" },
      { diffTheme: nextTheme },
    ]);
    expect(result.current.appearance).toBe("dark");
    expect(result.current.diffThemePreferences).toEqual(nextTheme);
    expect(themeEvents).toContainEqual(nextTheme);

    await settlePatch(patches[1], success({ diffTheme: nextTheme }));
    await settlePatch(patches[0], failure({ error: "storage" }));

    expect(result.current.diffThemePreferences).toEqual(nextTheme);
    expect(result.current.preferenceError).toMatch(/save appearance/);
    window.removeEventListener("patchdesk:diff-theme", onTheme);
  });

  it.each(["success", "failure"] as const)(
    "ignores an obsolete diff-theme %s after a newer theme settles",
    async (obsoleteSettlement) => {
      const patches: Array<DeferredDesktopResponse> = [];
      const payloads: SettingsPatchBody[] = [];
      desktop = installPreferenceHookApi(payloads, patches);
      const { result } = renderHook(() => useGlobalPreferences(false));
      await waitFor(() =>
        expect(result.current.diffThemePreferences).toEqual({
          light: "pierre-light",
          dark: "pierre-dark",
        }),
      );
      const first = { light: "github-light", dark: "github-dark" };
      const second = { light: "min-light", dark: "min-dark" };

      act(() => {
        void result.current.updateDiffTheme(first);
        void result.current.updateDiffTheme(second);
      });
      await settlePatch(patches[1], success({ diffTheme: second }));
      await settlePatch(
        patches[0],
        obsoleteSettlement === "success"
          ? success({ diffTheme: first })
          : failure({ error: "storage" }),
      );

      expect(result.current.diffThemePreferences).toEqual(second);
      expect(result.current.preferenceError).toBeUndefined();
    },
  );

  it("retries only the latest failed value and ignores its settlement after newer intent", async () => {
    const patches: Array<DeferredDesktopResponse> = [];
    const payloads: SettingsPatchBody[] = [];
    desktop = installPreferenceHookApi(payloads, patches);
    const { result } = renderHook(() => useGlobalPreferences(false));
    await waitFor(() => expect(result.current.appearance).toBe("system"));

    act(() => {
      void result.current.updateAppearance("light");
    });
    await settlePatch(patches[0], failure({ error: "storage" }));
    act(() => {
      void result.current.updateAppearance("dark");
    });
    await settlePatch(patches[1], failure({ error: "storage" }));

    act(() => result.current.retryPreferences());
    expect(payloads[2]).toEqual({ appearance: "dark" });

    act(() => {
      void result.current.updateAppearance("system");
    });
    await settlePatch(patches[3], success({ appearance: "system" }));
    await settlePatch(patches[2], success({ appearance: "dark" }));

    expect(payloads).toEqual([
      { appearance: "light" },
      { appearance: "dark" },
      { appearance: "dark" },
      { appearance: "system" },
    ]);
    expect(result.current.appearance).toBe("system");
    expect(result.current.preferenceError).toBeUndefined();
  });
});

/** The subset of the `/v1/settings` payload these tests read or patch. */
type SettingsPatchBody = {
  readonly appearance?: AppearancePreference;
  readonly diffTheme?: DiffThemePreferences;
};

type DeferredDesktopResponse = {
  readonly promise: Promise<DesktopResponse>;
  readonly resolve: (value: DesktopResponse) => void;
};

function deferredDesktopResponse(): DeferredDesktopResponse {
  let resolve!: (value: DesktopResponse) => void;
  const promise = new Promise<DesktopResponse>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function installPreferenceHookApi(
  payloads: SettingsPatchBody[],
  patches: Array<DeferredDesktopResponse>,
): DesktopDouble {
  return installDesktopDouble({
    "/v1/logs": () => success(null),
    "/v1/settings": (input) => {
      if (input.method !== "PATCH")
        return success({
          appearance: "system",
          diffTheme: { light: "pierre-light", dark: "pierre-dark" },
        });
      payloads.push(patchBody(input.body));
      const response = deferredDesktopResponse();
      patches.push(response);
      return response.promise;
    },
  });
}

async function settlePatch(
  patch: DeferredDesktopResponse | undefined,
  response: DesktopResponse,
): Promise<void> {
  expect(patch).toBeDefined();
  await act(async () => {
    patch?.resolve(response);
    await patch?.promise;
  });
}

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
      "/v1/watchlist/suggestions": () => success([]),
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
  if (!record(body)) return {};
  const appearance: AppearancePreference | undefined =
    body.appearance === "system" ||
    body.appearance === "light" ||
    body.appearance === "dark"
      ? body.appearance
      : undefined;
  const appearanceField = appearance === undefined ? {} : { appearance };
  const diffThemeField = Object.hasOwn(body, "diffTheme")
    ? { diffTheme: parseDiffThemePreferences(body.diffTheme) }
    : {};
  return { ...appearanceField, ...diffThemeField };
}

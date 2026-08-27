// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DIFF_DARK_THEMES,
  DIFF_LIGHT_THEMES,
  loadDiffThemePreferences,
  parseDiffThemePreferences,
} from "../../src/renderer/src/diff-theme-preferences";

afterEach(() => window.localStorage.clear());

describe("diff theme preferences", () => {
  it("defaults to the Pierre light and dark themes", () => {
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
    expect(DIFF_LIGHT_THEMES.map((theme) => theme.id)).toContain(
      "pierre-light",
    );
    expect(DIFF_DARK_THEMES.map((theme) => theme.id)).toContain("pierre-dark");
  });

  it("accepts every bundled light and dark theme independently", () => {
    expect(DIFF_LIGHT_THEMES.map((theme) => theme.id)).toContain("one-light");
    expect(DIFF_DARK_THEMES.map((theme) => theme.id)).toContain("tokyo-night");
    expect(
      parseDiffThemePreferences({ light: "one-light", dark: "tokyo-night" }),
    ).toEqual({
      light: "one-light",
      dark: "tokyo-night",
    });
  });

  it("rejects unknown persisted theme names", () => {
    expect(
      parseDiffThemePreferences({
        light: "not-a-theme",
        dark: "also-not-a-theme",
      }),
    ).toEqual({ light: "pierre-light", dark: "pierre-dark" });
  });

  // Degradation pins (written before the valibot conversion, run against the
  // unconverted code first): a malformed persisted value must degrade to the
  // same defaults after conversion as it does today, never throw, and never
  // silently drop a field that today survives.
  it("degrades a non-object persisted value to the full default pair", () => {
    const DEFAULT = { light: "pierre-light", dark: "pierre-dark" };
    expect(parseDiffThemePreferences(null)).toEqual(DEFAULT);
    expect(parseDiffThemePreferences(undefined)).toEqual(DEFAULT);
    expect(parseDiffThemePreferences("pierre-light")).toEqual(DEFAULT);
    expect(parseDiffThemePreferences(42)).toEqual(DEFAULT);
    expect(parseDiffThemePreferences(true)).toEqual(DEFAULT);
    expect(parseDiffThemePreferences([])).toEqual(DEFAULT);
    expect(parseDiffThemePreferences(["pierre-light", "pierre-dark"])).toEqual(
      DEFAULT,
    );
  });

  it("defaults to the full pair when both fields are missing", () => {
    expect(parseDiffThemePreferences({})).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
  });

  it("defaults only the missing or wrong-typed field, keeping the sound one", () => {
    expect(parseDiffThemePreferences({ light: "one-light" })).toEqual({
      light: "one-light",
      dark: "pierre-dark",
    });
    expect(parseDiffThemePreferences({ dark: "tokyo-night" })).toEqual({
      light: "pierre-light",
      dark: "tokyo-night",
    });
    expect(
      parseDiffThemePreferences({ light: 42, dark: "tokyo-night" }),
    ).toEqual({ light: "pierre-light", dark: "tokyo-night" });
    expect(
      parseDiffThemePreferences({ light: "one-light", dark: true }),
    ).toEqual({ light: "one-light", dark: "pierre-dark" });
  });

  it("defaults to the full pair with no v1 or v2 value stored at all", () => {
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
  });

  it("degrades a malformed v1 payload to the v2 default rather than throwing", () => {
    const DEFAULT = { light: "pierre-light", dark: "pierre-dark" };
    const v1Key = "patchdesk.diff-theme.v1";

    window.localStorage.setItem(v1Key, JSON.stringify(42));
    expect(loadDiffThemePreferences()).toEqual(DEFAULT);

    window.localStorage.setItem(v1Key, JSON.stringify([]));
    expect(loadDiffThemePreferences()).toEqual(DEFAULT);

    window.localStorage.setItem(v1Key, JSON.stringify("not-a-known-family"));
    expect(loadDiffThemePreferences()).toEqual(DEFAULT);

    window.localStorage.setItem(v1Key, JSON.stringify({}));
    expect(loadDiffThemePreferences()).toEqual(DEFAULT);

    window.localStorage.setItem(v1Key, JSON.stringify({ family: 42 }));
    expect(loadDiffThemePreferences()).toEqual(DEFAULT);

    window.localStorage.setItem(
      v1Key,
      JSON.stringify({ family: "not-a-known-family" }),
    );
    expect(loadDiffThemePreferences()).toEqual(DEFAULT);

    window.localStorage.setItem(v1Key, "not-json");
    expect(loadDiffThemePreferences()).toEqual(DEFAULT);
  });

  // Precedence: the v2 key wins whenever it holds a usable pair, and the v1
  // key is consulted whenever it does not — an unreadable v2 value is the
  // same situation as an absent one, so the user's older explicit choice is
  // preferred over the hardcoded default.
  it("prefers a usable v2 pair over the v1 family", () => {
    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({ light: "one-light", dark: "tokyo-night" }),
    );
    window.localStorage.setItem(
      "patchdesk.diff-theme.v1",
      JSON.stringify("high_contrast"),
    );
    expect(loadDiffThemePreferences()).toEqual({
      light: "one-light",
      dark: "tokyo-night",
    });
  });

  it("falls through to the v1 family when the v2 value is unusable", () => {
    window.localStorage.setItem("patchdesk.diff-theme.v2", "{not json");
    window.localStorage.setItem(
      "patchdesk.diff-theme.v1",
      JSON.stringify("high_contrast"),
    );
    expect(loadDiffThemePreferences()).toEqual({
      light: "github-light-high-contrast",
      dark: "github-dark-high-contrast",
    });
  });

  it("still migrates a valid v1 family object shape", () => {
    window.localStorage.setItem(
      "patchdesk.diff-theme.v1",
      JSON.stringify({ family: "high_contrast" }),
    );
    expect(loadDiffThemePreferences()).toEqual({
      light: "github-light-high-contrast",
      dark: "github-dark-high-contrast",
    });
  });

  it("keeps explicit Pierre theme choices", () => {
    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({ light: "pierre-light", dark: "pierre-dark" }),
    );
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });

    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({ light: "pierre-light", dark: "tokyo-night" }),
    );
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "tokyo-night",
    });

    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({ light: "one-light", dark: "pierre-dark" }),
    );
    expect(loadDiffThemePreferences()).toEqual({
      light: "one-light",
      dark: "pierre-dark",
    });
  });

  it("reads a valid v1 family without mutating the stored value", () => {
    window.localStorage.setItem(
      "patchdesk.diff-theme.v1",
      JSON.stringify("github"),
    );
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
    expect(window.localStorage.getItem("patchdesk.diff-theme.v1")).toBe(
      JSON.stringify("github"),
    );
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();

    window.localStorage.clear();
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
  });

  // Uses a fresh module instance: this test's applyDiffThemePreferences()
  // call would otherwise write into the module-level cache shared by the
  // statically-imported module above, leaking into whichever test happens to
  // run afterward under shuffled order.
  it("announces saved config values and clears both renderer keys", async () => {
    vi.resetModules();
    const mod = await import("../../src/renderer/src/diff-theme-preferences");

    const events: Array<Event> = [];
    const onTheme = (event: Event): void => {
      events.push(event);
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);
    window.localStorage.setItem(
      "patchdesk.diff-theme.v2",
      JSON.stringify({
        light: "github-light",
        dark: "github-dark",
      }),
    );
    window.localStorage.setItem(
      "patchdesk.diff-theme.v1",
      JSON.stringify("github"),
    );
    mod.applyDiffThemePreferences({
      light: "pierre-light",
      dark: "pierre-dark",
    });
    mod.clearDiffThemePreferences();

    window.removeEventListener("patchdesk:diff-theme", onTheme);
    expect(events).toHaveLength(1);
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
    expect(window.localStorage.getItem("patchdesk.diff-theme.v1")).toBeNull();
  });

  // Regression: a lazily-mounted diff view calls loadDiffThemePreferences()
  // after config.json has already replaced localStorage as the source of
  // truth, so nothing writes the v2 key any more. The last applied value
  // must still be readable with storage empty.
  //
  // Uses a fresh module instance (vi.resetModules() + dynamic import) so the
  // module-level cache this test exercises is private to this test, rather
  // than polluting the statically-imported module shared by every other test
  // in this file.
  it("returns the last applied preferences even when localStorage is empty", async () => {
    vi.resetModules();
    const mod = await import("../../src/renderer/src/diff-theme-preferences");

    mod.applyDiffThemePreferences({
      light: "github-light",
      dark: "synthwave-84",
    });

    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
    expect(mod.loadDiffThemePreferences()).toEqual({
      light: "github-light",
      dark: "synthwave-84",
    });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  applyDiffThemePreferences,
  clearDiffThemePreferences,
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

  it("announces saved config values and clears both renderer keys", () => {
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
    applyDiffThemePreferences({ light: "pierre-light", dark: "pierre-dark" });
    clearDiffThemePreferences();

    window.removeEventListener("patchdesk:diff-theme", onTheme);
    expect(events).toHaveLength(1);
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
    expect(window.localStorage.getItem("patchdesk.diff-theme.v1")).toBeNull();
  });
});

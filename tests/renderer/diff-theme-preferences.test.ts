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
  it("defaults to the installed Pierre light and dark themes", () => {
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
  });

  it("accepts every bundled light and dark theme independently", () => {
    expect(DIFF_LIGHT_THEMES.map((theme) => theme.id)).toContain("github-light");
    expect(DIFF_DARK_THEMES.map((theme) => theme.id)).toContain("tokyo-night");
    expect(parseDiffThemePreferences({ light: "github-light", dark: "tokyo-night" })).toEqual({
      light: "github-light",
      dark: "tokyo-night",
    });
  });

  it("rejects unknown persisted theme names", () => {
    expect(
      parseDiffThemePreferences({ light: "not-a-theme", dark: "also-not-a-theme" }),
    ).toEqual({ light: "pierre-light", dark: "pierre-dark" });
  });

  it("reads a valid v1 family without mutating legacy storage", () => {
    window.localStorage.setItem("patchdesk.diff-theme.v1", JSON.stringify("github"));
    expect(loadDiffThemePreferences()).toEqual({
      light: "github-light",
      dark: "github-dark",
    });
    expect(window.localStorage.getItem("patchdesk.diff-theme.v1")).toBe(JSON.stringify("github"));
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();

    window.localStorage.clear();
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
  });

  it("announces saved config values and clears both legacy keys after migration", () => {
    const events: Array<Event> = [];
    const onTheme = (event: Event): void => {
      events.push(event);
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);
    window.localStorage.setItem("patchdesk.diff-theme.v2", JSON.stringify({
      light: "github-light",
      dark: "github-dark",
    }));
    window.localStorage.setItem("patchdesk.diff-theme.v1", JSON.stringify("github"));
    applyDiffThemePreferences({ light: "github-light", dark: "github-dark" });
    clearDiffThemePreferences();

    window.removeEventListener("patchdesk:diff-theme", onTheme);
    expect(events).toHaveLength(1);
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
    expect(window.localStorage.getItem("patchdesk.diff-theme.v1")).toBeNull();
  });
});

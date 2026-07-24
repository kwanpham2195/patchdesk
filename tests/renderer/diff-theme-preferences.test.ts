// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  DIFF_DARK_THEMES,
  DIFF_LIGHT_THEMES,
  loadDiffThemePreferences,
  parseDiffThemePreferences,
  saveDiffThemePreferences,
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
    saveDiffThemePreferences({ light: "github-light", dark: "tokyo-night" });
    expect(loadDiffThemePreferences()).toEqual({
      light: "github-light",
      dark: "tokyo-night",
    });
  });

  it("rejects unknown persisted theme names", () => {
    expect(
      parseDiffThemePreferences({ light: "not-a-theme", dark: "also-not-a-theme" }),
    ).toEqual({ light: "pierre-light", dark: "pierre-dark" });
  });

  it("migrates only valid v1 families and leaves first-use storage empty", () => {
    window.localStorage.setItem("patchdesk.diff-theme.v1", JSON.stringify("github"));
    expect(loadDiffThemePreferences()).toEqual({
      light: "github-light",
      dark: "github-dark",
    });
    expect(window.localStorage.getItem("patchdesk.diff-theme.v1")).toBeNull();
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toContain("github-light");

    window.localStorage.clear();
    expect(loadDiffThemePreferences()).toEqual({
      light: "pierre-light",
      dark: "pierre-dark",
    });
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBeNull();
  });

  it("keeps the last applied pair and skips the event when storage rejects a write", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const events: Array<Event> = [];
    const onTheme = (event: Event): void => {
      events.push(event);
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
        removeItem: () => undefined,
      },
    });

    const result = saveDiffThemePreferences({
      light: "github-light",
      dark: "github-dark",
    });

    window.removeEventListener("patchdesk:diff-theme", onTheme);
    if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
    expect(result.saved).toBe(false);
    expect(events).toHaveLength(0);
  });
});

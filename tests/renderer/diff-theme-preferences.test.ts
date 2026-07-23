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
});

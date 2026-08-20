// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_NAVIGATOR_WIDTH_REM,
  MAX_NAVIGATOR_WIDTH_REM,
  MIN_NAVIGATOR_WIDTH_REM,
  loadNavigatorWidthPreferences,
  parseNavigatorWidthPreferences,
  saveNavigatorWidthPreferences,
} from "../../src/renderer/src/navigator-width-preferences";

const storageKey = "patchdesk.review-navigator-width.v1";

afterEach(() => window.localStorage.clear());

describe("navigator width preferences", () => {
  it("defaults to 18rem with nothing stored", () => {
    expect(loadNavigatorWidthPreferences()).toEqual({
      width: DEFAULT_NAVIGATOR_WIDTH_REM,
    });
    expect(DEFAULT_NAVIGATOR_WIDTH_REM).toBe(18);
  });

  it("loads a valid stored width within [min, max]", () => {
    window.localStorage.setItem(storageKey, JSON.stringify({ width: 24 }));
    expect(loadNavigatorWidthPreferences()).toEqual({ width: 24 });
  });

  it("accepts the min and max bounds themselves", () => {
    expect(
      parseNavigatorWidthPreferences({ width: MIN_NAVIGATOR_WIDTH_REM }),
    ).toEqual({ width: MIN_NAVIGATOR_WIDTH_REM });
    expect(
      parseNavigatorWidthPreferences({ width: MAX_NAVIGATOR_WIDTH_REM }),
    ).toEqual({ width: MAX_NAVIGATOR_WIDTH_REM });
  });

  it("resets an out-of-range stored width to the default", () => {
    expect(
      parseNavigatorWidthPreferences({
        width: MIN_NAVIGATOR_WIDTH_REM - 1,
      }),
    ).toEqual({ width: DEFAULT_NAVIGATOR_WIDTH_REM });
    expect(
      parseNavigatorWidthPreferences({
        width: MAX_NAVIGATOR_WIDTH_REM + 1,
      }),
    ).toEqual({ width: DEFAULT_NAVIGATOR_WIDTH_REM });

    window.localStorage.setItem(storageKey, JSON.stringify({ width: 999 }));
    expect(loadNavigatorWidthPreferences()).toEqual({
      width: DEFAULT_NAVIGATOR_WIDTH_REM,
    });
  });

  it("rejects garbage stored values without throwing", () => {
    const DEFAULT = { width: DEFAULT_NAVIGATOR_WIDTH_REM };
    expect(parseNavigatorWidthPreferences(null)).toEqual(DEFAULT);
    expect(parseNavigatorWidthPreferences(undefined)).toEqual(DEFAULT);
    expect(parseNavigatorWidthPreferences("18rem")).toEqual(DEFAULT);
    expect(parseNavigatorWidthPreferences(42)).toEqual(DEFAULT);
    expect(parseNavigatorWidthPreferences([])).toEqual(DEFAULT);
    expect(parseNavigatorWidthPreferences({ width: "18" })).toEqual(DEFAULT);
    expect(parseNavigatorWidthPreferences({ width: Number.NaN })).toEqual(
      DEFAULT,
    );

    window.localStorage.setItem(storageKey, "not-json");
    expect(loadNavigatorWidthPreferences()).toEqual(DEFAULT);

    window.localStorage.setItem(storageKey, JSON.stringify(42));
    expect(loadNavigatorWidthPreferences()).toEqual(DEFAULT);
  });

  it("persists a saved width and restores it on the next load", () => {
    saveNavigatorWidthPreferences(28);
    expect(loadNavigatorWidthPreferences()).toEqual({ width: 28 });
    expect(window.localStorage.getItem(storageKey)).toBe(
      JSON.stringify({ width: 28 }),
    );
  });

  it("resets an out-of-range save to the default rather than trusting it", () => {
    saveNavigatorWidthPreferences(999);
    expect(loadNavigatorWidthPreferences()).toEqual({
      width: DEFAULT_NAVIGATOR_WIDTH_REM,
    });
  });
});

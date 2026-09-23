// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  loadNavigatorWidthPreferences,
  parseNavigatorWidthPreferences,
  saveNavigatorWidthPreferences,
} from "../../src/renderer/src/navigator-width-preferences";

const storageKey = "patchdesk.review-navigator-width.v1";
const defaults = { width: 18 };

afterEach(() => window.localStorage.clear());

describe("navigator width preferences", () => {
  it("defaults to 18rem with nothing stored", () => {
    expect(loadNavigatorWidthPreferences()).toEqual(defaults);
  });

  it("loads a valid stored width within the configured range", () => {
    window.localStorage.setItem(storageKey, JSON.stringify({ width: 24 }));
    expect(loadNavigatorWidthPreferences()).toEqual({ width: 24 });
  });

  it.each([
    ["minimum", 14, { width: 14 }],
    ["maximum", 34, { width: 34 }],
  ] as const)("accepts the %s bound", (_bound, width, expected) => {
    expect(parseNavigatorWidthPreferences({ width })).toEqual(expected);
  });

  it.each([
    ["below minimum", 13],
    ["above maximum", 35],
  ] as const)("defaults a width outside the range (%s)", (_bound, width) => {
    expect(parseNavigatorWidthPreferences({ width })).toEqual(defaults);
  });

  it("resets an out-of-range stored width to the default", () => {
    window.localStorage.setItem(storageKey, JSON.stringify({ width: 999 }));
    expect(loadNavigatorWidthPreferences()).toEqual(defaults);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "18rem"],
    ["number", 42],
    ["array", []],
    ["string width", { width: "18" }],
    ["non-finite width", { width: Number.NaN }],
  ] as const)("defaults a malformed parsed value (%s)", (_name, value) => {
    expect(parseNavigatorWidthPreferences(value)).toEqual(defaults);
  });

  it.each([
    ["unparsable JSON", "not-json"],
    ["JSON number", JSON.stringify(42)],
  ] as const)("defaults malformed stored data (%s)", (_name, value) => {
    window.localStorage.setItem(storageKey, value);
    expect(loadNavigatorWidthPreferences()).toEqual(defaults);
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
    expect(loadNavigatorWidthPreferences()).toEqual(defaults);
  });
});

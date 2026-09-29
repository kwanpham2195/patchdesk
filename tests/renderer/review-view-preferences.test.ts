// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
} from "../../src/renderer/src/review-view-preferences";

// The defaults are written out here rather than imported from the module under
// test, so the test pins what an absent or unreadable stored value must fall
// back to instead of restating whatever the implementation holds.
const DEFAULTS = {
  diffStyle: "unified",
  fileMode: "all",
  overflow: "wrap",
  lineNumbers: true,
  backgrounds: true,
};

const KEY = "patchdesk.review-view.v1";

type StoredValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<StoredValue>
  | { readonly [key: string]: StoredValue };

function store(
  preferences: Record<string, StoredValue>,
  key: string = KEY,
): void {
  window.localStorage.setItem(key, JSON.stringify({ version: 1, preferences }));
}

describe("review view preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns defaults, with wrapped lines, without a stored value", () => {
    expect(loadReviewViewPreferences()).toEqual(DEFAULTS);
  });

  it("ignores View options saved under a workspace profile's own key", () => {
    store(
      { diffStyle: "split", overflow: "scroll", lineNumbers: false },
      "patchdesk.review-view.v1.profile-1",
    );

    expect(loadReviewViewPreferences()).toEqual(DEFAULTS);
  });

  it("falls back each missing field on its own", () => {
    store({ diffStyle: "split", fileMode: "selected" });

    expect(loadReviewViewPreferences()).toEqual({
      diffStyle: "split",
      fileMode: "selected",
      overflow: "wrap",
      lineNumbers: true,
      backgrounds: true,
    });
  });

  it("round-trips line numbers off while leaving backgrounds on", () => {
    saveReviewViewPreferences({ lineNumbers: false });

    expect(loadReviewViewPreferences()).toMatchObject({
      lineNumbers: false,
      backgrounds: true,
    });
  });

  it("round-trips backgrounds off while leaving line numbers on", () => {
    saveReviewViewPreferences({ backgrounds: false });

    expect(loadReviewViewPreferences()).toMatchObject({
      lineNumbers: true,
      backgrounds: false,
    });
  });

  it.each([
    [
      "line numbers",
      { lineNumbers: "no", backgrounds: false },
      "lineNumbers",
      "backgrounds",
    ],
    [
      "backgrounds",
      { lineNumbers: false, backgrounds: 0 },
      "backgrounds",
      "lineNumbers",
    ],
  ] as const)(
    "falls back an invalid %s value while preserving its valid sibling",
    (_field, preferences, invalidField, validField) => {
      store({ diffStyle: "split", ...preferences });

      const loaded = loadReviewViewPreferences();
      expect(loaded[invalidField]).toBe(true);
      expect(loaded[validField]).toBe(false);
      expect(loaded.diffStyle).toBe("split");
    },
  );
});

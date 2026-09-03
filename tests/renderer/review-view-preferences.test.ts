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
  overflow: "scroll",
  lineNumbers: true,
  backgrounds: true,
};

const KEY = "patchdesk.review-view.v1.profile-1";

type StoredValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<StoredValue>
  | { readonly [key: string]: StoredValue };

function store(preferences: Record<string, StoredValue>): void {
  window.localStorage.setItem(KEY, JSON.stringify({ version: 1, preferences }));
}

describe("review view preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns defaults, including line numbers and backgrounds, without a stored value", () => {
    expect(loadReviewViewPreferences("profile-1")).toEqual(DEFAULTS);
  });

  it("reads a stored record written before the two view fields existed", () => {
    store({ diffStyle: "split", fileMode: "selected", overflow: "wrap" });

    expect(loadReviewViewPreferences("profile-1")).toEqual({
      diffStyle: "split",
      fileMode: "selected",
      overflow: "wrap",
      lineNumbers: true,
      backgrounds: true,
    });
  });

  it("round-trips line numbers off while leaving backgrounds on", () => {
    saveReviewViewPreferences("profile-1", { lineNumbers: false });

    expect(loadReviewViewPreferences("profile-1")).toMatchObject({
      lineNumbers: false,
      backgrounds: true,
    });
  });

  it("round-trips backgrounds off while leaving line numbers on", () => {
    saveReviewViewPreferences("profile-1", { backgrounds: false });

    expect(loadReviewViewPreferences("profile-1")).toMatchObject({
      lineNumbers: true,
      backgrounds: false,
    });
  });

  it("falls back a non-boolean stored value to on without dropping siblings", () => {
    store({ diffStyle: "split", lineNumbers: "no", backgrounds: 0 });

    expect(loadReviewViewPreferences("profile-1")).toMatchObject({
      diffStyle: "split",
      lineNumbers: true,
      backgrounds: true,
    });
  });
});

// @vitest-environment jsdom
import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import { loadAppearancePreference } from "../../src/renderer/src/appearance-preferences";
import {
  loadCodexModelCache,
  saveCodexModelCache,
} from "../../src/renderer/src/codex-model-cache";
import { loadDiffThemePreferences } from "../../src/renderer/src/diff-theme-preferences";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";
import {
  INSIGHT_PREFERENCE_TYPES,
  loadInsightRunPreference,
  saveInsightRunPreference,
} from "../../src/renderer/src/insight-run-preferences";
import { definePreference } from "../../src/renderer/src/lib/local-preference";
import {
  loadNavigatorWidthPreferences,
  saveNavigatorWidthPreferences,
} from "../../src/renderer/src/navigator-width-preferences";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
} from "../../src/renderer/src/review-view-preferences";

const realStorage = window.localStorage;

/**
 * Replaces `window.localStorage` with a getter that throws, the way a browser
 * configured to block site data does. The throw happens on the property
 * access itself, before any key is named.
 */
function blockSiteData(): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError: access to site data is denied");
    },
  });
}

function restoreSiteData(): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: realStorage,
    writable: false,
  });
}

afterEach(() => {
  restoreSiteData();
  window.localStorage.clear();
});

// Every renderer preference, with the key it stores under, a stored payload
// its schema rejects, and what a rejected or unreadable read must return.
const preferences = [
  {
    name: "appearance",
    key: "patchdesk.appearance.v1",
    rejected: "ultraviolet",
    accepted: "dark",
    load: () => loadAppearancePreference(),
    save: undefined,
    fallback: "system",
    acceptedValue: "dark",
  },
  {
    name: "codex model cache",
    key: "patchdesk.codex-models.v1.profile",
    rejected: JSON.stringify({ models: [] }),
    accepted: JSON.stringify([]),
    load: () => loadCodexModelCache("profile"),
    save: () => saveCodexModelCache("profile", []),
    fallback: undefined,
    acceptedValue: [],
  },
  {
    name: "diff theme",
    key: "patchdesk.diff-theme.v2",
    // A v1-era bare family literal under the v2 key. It has to be a shape
    // mismatch to reach the rejected-read branch at all: every field of the
    // v2 schema is a `v.fallback`, so an object with garbage fields parses
    // and resets only those fields, and never reaches it.
    rejected: JSON.stringify("high_contrast"),
    accepted: JSON.stringify({
      light: "github-light-high-contrast",
      dark: "github-dark-high-contrast",
    }),
    load: () => loadDiffThemePreferences(),
    save: undefined,
    fallback: { light: "pierre-light", dark: "pierre-dark" },
    acceptedValue: {
      light: "github-light-high-contrast",
      dark: "github-dark-high-contrast",
    },
  },
  {
    name: "inbox view",
    key: "patchdesk.inbox-view.v6.profile",
    rejected: JSON.stringify({ version: 2, preferences: {} }),
    accepted: JSON.stringify({
      version: 6,
      preferences: { state: "merged" },
    }),
    load: () => loadInboxViewPreferences("profile"),
    save: () => saveInboxViewPreferences("profile", { state: "merged" }),
    fallback: {
      state: "open",
      pageSize: 25,
      selectedLabels: [],
      awaitingMyReview: false,
      inspectorOpen: true,
    },
    acceptedValue: {
      state: "merged",
      pageSize: 25,
      selectedLabels: [],
      awaitingMyReview: false,
      inspectorOpen: true,
    },
  },
  {
    name: "insight run",
    key: "patchdesk.insight-run.v1.analysis.profile",
    rejected: JSON.stringify({
      provider: "anthropic",
      model: "opus",
      reasoning: "high",
    }),
    accepted: JSON.stringify({
      provider: "pi",
      model: "opus",
      reasoning: "high",
    }),
    load: () => loadInsightRunPreference("profile", "analysis"),
    save: () =>
      saveInsightRunPreference("profile", "analysis", {
        provider: "pi",
        model: "opus",
        reasoning: "high",
      }),
    fallback: undefined,
    acceptedValue: { provider: "pi", model: "opus", reasoning: "high" },
  },
  {
    name: "navigator width",
    key: "patchdesk.review-navigator-width.v1",
    // A bare number where the schema wants a record. Same reason as the diff
    // theme row above: `width` is a `v.fallback`, so `{ width: 999 }` parses
    // and resets that one field instead of rejecting the record.
    rejected: JSON.stringify(24),
    accepted: JSON.stringify({ width: 24 }),
    load: () => loadNavigatorWidthPreferences(),
    save: () => saveNavigatorWidthPreferences(24),
    fallback: { width: 18 },
    acceptedValue: { width: 24 },
  },
  {
    name: "review view",
    key: "patchdesk.review-view.v1.profile",
    rejected: JSON.stringify({ version: 99, preferences: {} }),
    accepted: JSON.stringify({
      version: 1,
      preferences: { diffStyle: "split", fileMode: "all", overflow: "scroll" },
    }),
    load: () => loadReviewViewPreferences("profile"),
    save: () => saveReviewViewPreferences("profile", { diffStyle: "split" }),
    fallback: { diffStyle: "unified", fileMode: "all", overflow: "scroll" },
    acceptedValue: {
      diffStyle: "split",
      fileMode: "all",
      overflow: "scroll",
    },
  },
] as const;

describe("every renderer preference", () => {
  // The control for the two rows below: the same fixtures, read from a
  // reachable store holding a value the schema accepts, must return the
  // stored value and not the fallback. Without it, "returns the fallback"
  // would pass for a load that always returned the fallback.
  it.each(preferences)("$name reads a stored value back", (preference) => {
    window.localStorage.setItem(preference.key, preference.accepted);
    expect(preference.load()).toEqual(preference.acceptedValue);
    expect(preference.load()).not.toEqual(preference.fallback);
  });

  it.each(preferences)(
    "$name falls back when the store is unreachable",
    (preference) => {
      blockSiteData();
      expect(() => preference.load()).not.toThrow();
      expect(preference.load()).toEqual(preference.fallback);
    },
  );

  it.each(preferences.filter((preference) => preference.save !== undefined))(
    "$name swallows a write to an unreachable store",
    (preference) => {
      blockSiteData();
      expect(() => preference.save?.()).not.toThrow();
    },
  );

  it.each(preferences)(
    "$name falls back on a stored value its schema rejects, and leaves it in place",
    (preference) => {
      window.localStorage.setItem(preference.key, preference.rejected);
      expect(preference.load()).toEqual(preference.fallback);
      // The rejected value stays: a read runs during render and must not
      // write, and a later build may still understand it.
      expect(window.localStorage.getItem(preference.key)).toBe(
        preference.rejected,
      );
      // Re-reading rejects it again rather than having consumed it.
      expect(preference.load()).toEqual(preference.fallback);
    },
  );

  // The diff theme row above reaches the rejected-read branch but cannot
  // show it: that preference's own default is `undefined`, so a rejected v2
  // value and an accepted one both end at the same pair. Seeding the v1 key
  // with a family the default pair does not share is what makes the branch
  // observable — the high-contrast pair can only arrive through it.
  it("diff theme reads the v1 key when the v2 value is one its schema rejects", () => {
    const rejected = JSON.stringify("high_contrast");
    window.localStorage.setItem("patchdesk.diff-theme.v2", rejected);
    window.localStorage.setItem(
      "patchdesk.diff-theme.v1",
      JSON.stringify("high_contrast"),
    );
    expect(loadDiffThemePreferences()).toEqual({
      light: "github-light-high-contrast",
      dark: "github-dark-high-contrast",
    });
    expect(window.localStorage.getItem("patchdesk.diff-theme.v2")).toBe(
      rejected,
    );
  });

  it("keeps one rejected key from costing another its value", () => {
    window.localStorage.setItem(
      "patchdesk.review-navigator-width.v1",
      "not-json",
    );
    window.localStorage.setItem(
      "patchdesk.review-view.v1.profile",
      JSON.stringify({
        version: 1,
        preferences: {
          diffStyle: "split",
          fileMode: "all",
          overflow: "scroll",
        },
      }),
    );
    expect(loadNavigatorWidthPreferences()).toEqual({ width: 18 });
    expect(loadReviewViewPreferences("profile").diffStyle).toBe("split");
  });

  it("gives every Insight type its own run preference key", () => {
    for (const type of INSIGHT_PREFERENCE_TYPES)
      saveInsightRunPreference("profile", type, {
        provider: "pi",
        model: `${type}-model`,
        reasoning: "high",
      });

    for (const type of INSIGHT_PREFERENCE_TYPES)
      expect(loadInsightRunPreference("profile", type)?.model).toBe(
        `${type}-model`,
      );
  });
});

describe("definePreference", () => {
  const colour = definePreference({
    key: "test.colour",
    schema: v.object({
      shade: v.fallback(v.picklist(["red", "blue"]), "red"),
    }),
    defaultValue: { shade: "red" as const },
  });

  it("round trips a value through storage", () => {
    colour.save(undefined, { shade: "blue" });
    expect(window.localStorage.getItem("test.colour")).toBe(
      JSON.stringify({ shade: "blue" }),
    );
    expect(colour.load(undefined)).toEqual({ shade: "blue" });
  });

  it("falls back on text that is not the stored format", () => {
    window.localStorage.setItem("test.colour", "{not json");
    expect(colour.load(undefined)).toEqual({ shade: "red" });
  });

  it("scopes a key by profile", () => {
    const scoped = definePreference({
      key: (profileId: string) => `test.scoped.${profileId}`,
      schema: v.number(),
      defaultValue: undefined,
    });
    scoped.save("a", 1);
    expect(scoped.load("a")).toBe(1);
    expect(scoped.load("b")).toBeUndefined();
  });

  it("stores through an envelope when one is given", () => {
    const enveloped = definePreference({
      key: "test.enveloped",
      schema: v.pipe(
        v.object({ version: v.literal(3), value: v.number() }),
        v.transform((stored) => stored.value),
      ),
      defaultValue: 0,
      encodeStored: (value: number) => ({ version: 3, value }),
    });
    enveloped.save(undefined, 7);
    expect(window.localStorage.getItem("test.enveloped")).toBe(
      JSON.stringify({ version: 3, value: 7 }),
    );
    expect(enveloped.load(undefined)).toBe(7);

    window.localStorage.setItem(
      "test.enveloped",
      JSON.stringify({ version: 2, value: 7 }),
    );
    expect(enveloped.load(undefined)).toBe(0);
  });

  it("reads text that is not JSON when told how to decode it", () => {
    const bare = definePreference({
      key: "test.bare",
      schema: v.picklist(["on", "off"]),
      defaultValue: "off" as const,
      decodeStored: (raw: string) => raw,
    });
    window.localStorage.setItem("test.bare", "on");
    expect(bare.load(undefined)).toBe("on");
    window.localStorage.setItem("test.bare", "sideways");
    expect(bare.load(undefined)).toBe("off");
  });

  it("parses an already-decoded value the same way a read does", () => {
    expect(colour.parse({ shade: "blue" })).toEqual({ shade: "blue" });
    expect(colour.parse(42)).toEqual({ shade: "red" });
  });

  it("clears a stored value", () => {
    colour.save(undefined, { shade: "blue" });
    colour.clear(undefined);
    expect(window.localStorage.getItem("test.colour")).toBeNull();
  });
});

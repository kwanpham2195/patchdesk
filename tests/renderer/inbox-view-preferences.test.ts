// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";

// The defaults are written out here rather than imported from the module
// under test, so the test pins what an absent or unreadable stored value
// must fall back to instead of restating whatever the implementation holds.
const DEFAULTS = {
  state: "open",
  pageSize: 25,
  selectedLabels: [],
  awaitingMyReview: false,
  inspectorOpen: true,
};

const KEY = "patchdesk.inbox-view.v6.profile-1";
const V2_KEY = "patchdesk.inbox-view.v2.profile-1";
const LEGACY_KEY = "patchdesk.inbox-view.v1.profile-1";

type StoredValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<StoredValue>
  | { readonly [key: string]: StoredValue };

function store(preferences: Record<string, StoredValue>): void {
  window.localStorage.setItem(KEY, JSON.stringify({ version: 6, preferences }));
}

function storeV2(preferences: Record<string, StoredValue>): void {
  window.localStorage.setItem(
    V2_KEY,
    JSON.stringify({ version: 2, preferences }),
  );
}

function storeLegacy(preferences: Record<string, StoredValue>): void {
  window.localStorage.setItem(
    LEGACY_KEY,
    JSON.stringify({ version: 1, preferences }),
  );
}

describe("inbox view preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns defaults without a stored value", () => {
    expect(loadInboxViewPreferences("profile-1")).toEqual(DEFAULTS);
  });

  it("keeps sound fields when a single stored field is malformed", () => {
    store({
      state: "merged",
      selectedLabels: ["bug"],
      inspectorOpen: "not-a-boolean",
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.state).toBe("merged");
    expect(loaded.selectedLabels).toEqual(["bug"]);
    expect(loaded.inspectorOpen).toBe(true);
  });

  it("round-trips the selected inbox state without persisting page cursors", () => {
    saveInboxViewPreferences("profile-1", { state: "merged" });
    expect(loadInboxViewPreferences("profile-1").state).toBe("merged");
    expect(window.localStorage.getItem(KEY)).not.toContain("pageToken");
  });

  it("defaults to a page size of 25 without a stored value", () => {
    expect(loadInboxViewPreferences("profile-1").pageSize).toBe(25);
  });

  it("round-trips every listed page size", () => {
    for (const pageSize of [10, 25, 50] as const) {
      saveInboxViewPreferences("profile-1", { pageSize });
      expect(loadInboxViewPreferences("profile-1").pageSize).toBe(pageSize);
    }
  });

  it("resets an unlisted or malformed page size to the default while keeping sound fields", () => {
    store({ state: "merged", pageSize: 100 });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.pageSize).toBe(25);
    expect(loaded.state).toBe("merged");
  });

  it("resets to defaults, including page size, when reading version 2 data", () => {
    storeV2({ state: "merged", pageSize: 50 });
    expect(loadInboxViewPreferences("profile-1")).toEqual(DEFAULTS);
  });

  it("migrates version 1 preferences with an open state", () => {
    storeLegacy({ state: "merged", selectedLabels: ["bug"] });
    expect(loadInboxViewPreferences("profile-1")).toMatchObject({
      state: "open",
      selectedLabels: ["bug"],
    });
  });

  it("degrades a stale string selectedLabel to an empty array without dropping siblings", () => {
    store({
      state: "merged",
      selectedLabel: "bug",
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.selectedLabels).toEqual([]);
    expect(loaded.state).toBe("merged");
  });

  it("round-trips a selectedLabels array", () => {
    saveInboxViewPreferences("profile-1", {
      selectedLabels: ["bug", "enhancement"],
    });
    expect(loadInboxViewPreferences("profile-1").selectedLabels).toEqual([
      "bug",
      "enhancement",
    ]);
  });

  it("caps selectedLabels at MAX_INBOX_FILTER_LABELS entries", () => {
    const labels = Array.from({ length: 10 }, (_, index) => `label-${index}`);
    store({ selectedLabels: labels });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.selectedLabels).toHaveLength(5);
    expect(loaded.selectedLabels).toEqual(labels.slice(0, 5));
  });

  it("resets on a version mismatch", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 99, preferences: { view: "ready_to_merge" } }),
    );
    expect(loadInboxViewPreferences("profile-1")).toEqual(DEFAULTS);
  });

  it("ignores unparsable stored text", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadInboxViewPreferences("profile-1")).toEqual(DEFAULTS);
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INBOX_VIEW_PREFERENCES,
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";

const KEY = "patchdesk.inbox-view.v4.profile-1";
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
  window.localStorage.setItem(KEY, JSON.stringify({ version: 4, preferences }));
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
    expect(loadInboxViewPreferences("profile-1")).toEqual(
      DEFAULT_INBOX_VIEW_PREFERENCES,
    );
  });

  it("keeps sound fields when a single stored field is malformed", () => {
    store({
      view: "ready_to_merge",
      search: "nanoid",
      queueRailOpen: false,
      inspectorOpen: "not-a-boolean",
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.view).toBe("ready_to_merge");
    expect(loaded.search).toBe("nanoid");
    expect(loaded.queueRailOpen).toBe(false);
    expect(loaded.inspectorOpen).toBe(true);
  });

  it("round-trips the selected inbox scope without persisting page cursors", () => {
    saveInboxViewPreferences("profile-1", { scope: "merged" });
    expect(loadInboxViewPreferences("profile-1").scope).toBe("merged");
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
    store({ view: "ready_to_merge", pageSize: 100 });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.pageSize).toBe(25);
    expect(loaded.view).toBe("ready_to_merge");
  });

  it("resets to defaults, including page size, when reading version 2 data", () => {
    storeV2({ view: "ready_to_merge", scope: "merged" });
    expect(loadInboxViewPreferences("profile-1")).toEqual(
      DEFAULT_INBOX_VIEW_PREFERENCES,
    );
  });

  it("migrates version 1 preferences with an open scope", () => {
    storeLegacy({ view: "ready_to_merge", search: "fixture" });
    expect(loadInboxViewPreferences("profile-1")).toMatchObject({
      scope: "open",
      view: "ready_to_merge",
      search: "fixture",
    });
  });

  it("degrades a stale string selectedLabel to an empty array without dropping siblings", () => {
    store({
      view: "ready_to_merge",
      search: "nanoid",
      selectedLabel: "bug",
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.selectedLabels).toEqual([]);
    expect(loaded.view).toBe("ready_to_merge");
    expect(loaded.search).toBe("nanoid");
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

  it("caps selectedLabels at 50 entries", () => {
    const labels = Array.from({ length: 60 }, (_, index) => `label-${index}`);
    store({ selectedLabels: labels });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.selectedLabels).toHaveLength(50);
    expect(loaded.selectedLabels).toEqual(labels.slice(0, 50));
  });

  it("resets on a version mismatch", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 99, preferences: { view: "ready_to_merge" } }),
    );
    expect(loadInboxViewPreferences("profile-1")).toEqual(
      DEFAULT_INBOX_VIEW_PREFERENCES,
    );
  });

  it("ignores unparsable stored text", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadInboxViewPreferences("profile-1")).toEqual(
      DEFAULT_INBOX_VIEW_PREFERENCES,
    );
  });
});

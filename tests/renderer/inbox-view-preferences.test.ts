// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INBOX_VIEW_PREFERENCES,
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";

const KEY = "patchdesk.inbox-view.v3.profile-1";
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
  window.localStorage.setItem(KEY, JSON.stringify({ version: 3, preferences }));
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
      sort: "not-a-sort",
      selectedRepos: ["owner/repo"],
      queueRailOpen: false,
      inspectorOpen: true,
      savedViews: [],
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.view).toBe("ready_to_merge");
    expect(loaded.search).toBe("nanoid");
    expect(loaded.sort).toBe("priority");
    expect(loaded.queueRailOpen).toBe(false);
  });

  it("round-trips every sort, including change size", () => {
    saveInboxViewPreferences("profile-1", { sort: "size" });
    expect(loadInboxViewPreferences("profile-1").sort).toBe("size");
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

  it("drops unusable saved views and de-duplicates the rest", () => {
    store({
      savedViews: [
        {
          id: "a",
          name: "Waiting",
          view: "ready_to_merge",
          search: "",
          sort: "size",
          selectedRepos: [],
        },
        { id: "a", name: "Duplicate", view: "ready_to_merge" },
        { id: "  ", name: "Blank id", view: "ready_to_merge" },
        { id: "b", name: "Bad view", view: "not-a-view" },
      ],
    });
    const { savedViews } = loadInboxViewPreferences("profile-1");
    expect(savedViews.map((view) => view.id)).toEqual(["a"]);
    expect(savedViews[0]?.sort).toBe("size");
  });

  it("lifts a legacy top-level selectedRepo string into selectedRepos, surviving the migration", () => {
    store({
      view: "ready_to_merge",
      search: "nanoid",
      selectedRepo: "acme/widgets",
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.selectedRepos).toEqual(["acme/widgets"]);
    expect(loaded.view).toBe("ready_to_merge");
    expect(loaded.search).toBe("nanoid");
  });

  it("lifts a legacy top-level selectedRepo of '' (all repositories) to an empty array", () => {
    store({
      view: "ready_to_merge",
      selectedRepo: "",
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.selectedRepos).toEqual([]);
  });

  it("lifts a legacy selectedRepo string inside a saved view into selectedRepos, surviving the migration", () => {
    store({
      savedViews: [
        {
          id: "a",
          name: "Acme only",
          view: "ready_to_merge",
          sort: "size",
          selectedRepo: "acme/widgets",
        },
      ],
    });
    const { savedViews } = loadInboxViewPreferences("profile-1");
    expect(savedViews.map((view) => view.id)).toEqual(["a"]);
    expect(savedViews[0]?.selectedRepos).toEqual(["acme/widgets"]);
    expect(savedViews[0]?.sort).toBe("size");
  });

  it("round-trips a selectedRepos array", () => {
    saveInboxViewPreferences("profile-1", {
      selectedRepos: ["acme/widgets", "acme/gizmos"],
    });
    expect(loadInboxViewPreferences("profile-1").selectedRepos).toEqual([
      "acme/widgets",
      "acme/gizmos",
    ]);
  });

  it("caps selectedRepos at 50 entries", () => {
    const repos = Array.from(
      { length: 60 },
      (_, index) => `owner/repo-${index}`,
    );
    store({ selectedRepos: repos });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.selectedRepos).toHaveLength(50);
    expect(loaded.selectedRepos).toEqual(repos.slice(0, 50));
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

  it("keeps a saved view with a stale string selectedLabel, defaulting selectedLabels to []", () => {
    store({
      savedViews: [
        {
          id: "a",
          name: "Waiting",
          view: "ready_to_merge",
          sort: "size",
          selectedLabel: "bug",
        },
      ],
    });
    const { savedViews } = loadInboxViewPreferences("profile-1");
    expect(savedViews.map((view) => view.id)).toEqual(["a"]);
    expect(savedViews[0]?.selectedLabels).toEqual([]);
    expect(savedViews[0]?.sort).toBe("size");
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

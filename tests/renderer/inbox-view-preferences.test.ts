// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INBOX_VIEW_PREFERENCES,
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";

const KEY = "patchdesk.inbox-view.v1.profile-1";

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

describe("inbox view preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns defaults without a stored value", () => {
    expect(loadInboxViewPreferences("profile-1")).toEqual(
      DEFAULT_INBOX_VIEW_PREFERENCES,
    );
  });

  it("keeps sound fields when a single stored field is malformed", () => {
    store({
      view: "checks_failing",
      search: "nanoid",
      sort: "not-a-sort",
      selectedRepo: "owner/repo",
      queueRailOpen: false,
      inspectorOpen: true,
      savedViews: [],
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.view).toBe("checks_failing");
    expect(loaded.search).toBe("nanoid");
    expect(loaded.sort).toBe("priority");
    expect(loaded.queueRailOpen).toBe(false);
  });

  it("round-trips every sort, including change size", () => {
    saveInboxViewPreferences("profile-1", { sort: "size" });
    expect(loadInboxViewPreferences("profile-1").sort).toBe("size");
  });

  it("drops unusable saved views and de-duplicates the rest", () => {
    store({
      savedViews: [
        {
          id: "a",
          name: "Waiting",
          view: "waiting",
          search: "",
          sort: "size",
          selectedRepo: "",
        },
        { id: "a", name: "Duplicate", view: "waiting" },
        { id: "  ", name: "Blank id", view: "waiting" },
        { id: "b", name: "Bad view", view: "not-a-view" },
      ],
    });
    const { savedViews } = loadInboxViewPreferences("profile-1");
    expect(savedViews.map((view) => view.id)).toEqual(["a"]);
    expect(savedViews[0]?.sort).toBe("size");
  });

  it("degrades a stale string selectedLabel to an empty array without dropping siblings", () => {
    store({
      view: "checks_failing",
      search: "nanoid",
      selectedLabel: "bug",
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded.selectedLabels).toEqual([]);
    expect(loaded.view).toBe("checks_failing");
    expect(loaded.search).toBe("nanoid");
  });

  it("keeps a saved view with a stale string selectedLabel, defaulting selectedLabels to []", () => {
    store({
      savedViews: [
        {
          id: "a",
          name: "Waiting",
          view: "waiting",
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
      JSON.stringify({ version: 99, preferences: { view: "waiting" } }),
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

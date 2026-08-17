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

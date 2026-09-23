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

  it.each([10, 25, 50] as const)("round-trips page size %s", (pageSize) => {
    saveInboxViewPreferences("profile-1", { pageSize });
    expect(loadInboxViewPreferences("profile-1").pageSize).toBe(pageSize);
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

  it("round-trips the chosen preset", () => {
    saveInboxViewPreferences("profile-1", { preset: "my_pull_requests" });
    expect(loadInboxViewPreferences("profile-1")).toMatchObject({
      preset: "my_pull_requests",
    });
  });

  it("clears the chosen preset when explicitly set to undefined", () => {
    saveInboxViewPreferences("profile-1", { preset: "my_pull_requests" });
    saveInboxViewPreferences("profile-1", { preset: undefined });
    expect(loadInboxViewPreferences("profile-1")).not.toHaveProperty("preset");
  });

  it("defaults the preset when a stored v6 blob has no preset field", () => {
    // A v6 blob written before the presets became a union carries no
    // `preset` key at all; the field falls back rather than failing the read.
    store({ state: "merged" });
    expect(loadInboxViewPreferences("profile-1")).toEqual({
      ...DEFAULTS,
      state: "merged",
    });
  });

  it("round-trips selected review state and check status", () => {
    saveInboxViewPreferences("profile-1", {
      reviewState: "approved",
      checkStatus: "failure",
    });
    expect(loadInboxViewPreferences("profile-1")).toMatchObject({
      reviewState: "approved",
      checkStatus: "failure",
    });
  });

  it.each([
    [
      "review state",
      {
        state: "merged",
        reviewState: "review_pending",
        checkStatus: "failure",
      },
      "reviewState",
      "checkStatus",
      "failure",
    ],
    [
      "check status",
      { state: "merged", reviewState: "approved", checkStatus: "skipped" },
      "checkStatus",
      "reviewState",
      "approved",
    ],
  ] as const)(
    "resets an invalid %s while keeping its valid sibling",
    (_field, preferences, invalidField, validField, validValue) => {
      store(preferences);
      const loaded = loadInboxViewPreferences("profile-1");
      expect(loaded.state).toBe("merged");
      expect(loaded).not.toHaveProperty(invalidField);
      expect(loaded).toHaveProperty(validField, validValue);
    },
  );

  it("round-trips the author and base branch filters", () => {
    saveInboxViewPreferences("profile-1", {
      author: "octocat",
      baseBranch: "release/2026-09",
    });
    expect(loadInboxViewPreferences("profile-1")).toMatchObject({
      author: "octocat",
      baseBranch: "release/2026-09",
    });
  });

  // A stored value the route would refuse falls back to absent rather than
  // being trimmed into a different filter, and each field resolves on its own
  // without taking its sibling or a sound field down with it.
  it.each([
    [
      "over-long author",
      { state: "merged", author: "a".repeat(60), baseBranch: "main" },
      "author",
      "baseBranch",
      "main",
    ],
    [
      "spaced base branch",
      { state: "merged", author: "octocat", baseBranch: "release 1.0" },
      "baseBranch",
      "author",
      "octocat",
    ],
  ] as const)(
    "resets an invalid %s while keeping its valid sibling",
    (_field, preferences, invalidField, validField, validValue) => {
      store(preferences);
      const loaded = loadInboxViewPreferences("profile-1");
      expect(loaded.state).toBe("merged");
      expect(loaded).not.toHaveProperty(invalidField);
      expect(loaded).toHaveProperty(validField, validValue);
    },
  );

  it("resets an author that is only whitespace while keeping the base branch", () => {
    store({ author: "   ", baseBranch: " main " });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded).not.toHaveProperty("author");
    expect(loaded.baseBranch).toBe("main");
  });

  it("does not restore a filter after it is explicitly cleared", () => {
    saveInboxViewPreferences("profile-1", {
      reviewState: "approved",
      checkStatus: "failure",
      author: "octocat",
      baseBranch: "main",
    });
    saveInboxViewPreferences("profile-1", {
      reviewState: undefined,
      checkStatus: undefined,
      author: undefined,
      baseBranch: undefined,
    });
    const loaded = loadInboxViewPreferences("profile-1");
    expect(loaded).not.toHaveProperty("reviewState");
    expect(loaded).not.toHaveProperty("checkStatus");
    expect(loaded).not.toHaveProperty("author");
    expect(loaded).not.toHaveProperty("baseBranch");
  });

  it("keeps a stored filter when an unrelated field is saved", () => {
    saveInboxViewPreferences("profile-1", {
      author: "octocat",
      baseBranch: "main",
    });
    saveInboxViewPreferences("profile-1", { state: "merged" });
    expect(loadInboxViewPreferences("profile-1")).toMatchObject({
      state: "merged",
      author: "octocat",
      baseBranch: "main",
    });
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

  // Precedence: the current key wins whenever it holds a usable record, and
  // the version 1 key is consulted whenever it does not — an unreadable
  // current value is the same situation as an absent one, so the maintainer's
  // older stored view is preferred over the hardcoded default.
  it("prefers a usable current value over version 1 data", () => {
    store({ state: "merged" });
    storeLegacy({ selectedLabels: ["bug"] });
    expect(loadInboxViewPreferences("profile-1")).toMatchObject({
      state: "merged",
      selectedLabels: [],
    });
  });

  it("falls through to version 1 data when the current value is unusable", () => {
    window.localStorage.setItem(KEY, "{not json");
    storeLegacy({ state: "merged", selectedLabels: ["bug"] });
    expect(loadInboxViewPreferences("profile-1")).toMatchObject({
      state: "open",
      selectedLabels: ["bug"],
    });
  });
});

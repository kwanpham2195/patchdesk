import { describe, expect, it } from "vitest";

import {
  diffWatchedSnapshot,
  parseWatchedPullRequests,
  unwatchPullRequest,
  watchPullRequest,
  WATCHED_PULL_REQUEST_LIMIT,
  type WatchedPullRequest,
  type WatchedPullRequestChange,
  type WatchedSnapshot,
} from "../../src/domain/watched-pull-request";

const baseSnapshot = {
  updatedAt: "2026-09-16T10:00:00.000Z",
  headSha: "a".repeat(40),
  reviewState: "review_pending",
  checks: "pending",
  state: "open",
} as const;

function watched(
  number: number,
  snapshot: Partial<Record<keyof WatchedSnapshot, string>> = {},
): WatchedPullRequest {
  const parsed = parseWatchedPullRequests([
    {
      ref: { host: "github.com", owner: "acme", repo: "widgets", number },
      snapshot: { ...baseSnapshot, ...snapshot },
      watchedAt: "2026-09-16T09:00:00.000Z",
    },
  ]);
  if (parsed._tag !== "ok" || parsed.value[0] === undefined)
    throw new Error("invalid fixture");
  return parsed.value[0];
}

const before: WatchedSnapshot = watched(1).snapshot;
const later = { updatedAt: "2026-09-16T10:05:00.000Z" };

const changeCases = {
  commented: { after: later, expected: ["commented"] },
  decision: {
    after: { ...later, reviewState: "changes_requested" },
    expected: ["decision"],
  },
  checks: { after: { ...later, checks: "failing" }, expected: ["checks"] },
  pushed: {
    after: { ...later, headSha: "b".repeat(40), checks: "passing" },
    expected: ["pushed"],
  },
  merged: {
    after: { ...later, state: "merged", reviewState: "approved" },
    expected: ["merged"],
  },
  closed: { after: { ...later, state: "closed" }, expected: ["closed"] },
} satisfies Record<
  WatchedPullRequestChange,
  {
    readonly after: Partial<Record<keyof WatchedSnapshot, string>>;
    readonly expected: ReadonlyArray<WatchedPullRequestChange>;
  }
>;

describe("diffWatchedSnapshot", () => {
  it.each(Object.entries(changeCases))(
    "reports %s",
    (_change, { after, expected }) => {
      expect(diffWatchedSnapshot(before, watched(1, after).snapshot)).toEqual(
        expected,
      );
    },
  );

  it("reports nothing when the snapshot did not change", () => {
    expect(diffWatchedSnapshot(before, before)).toEqual([]);
  });

  it("reports a decision and a checks change from one poll separately", () => {
    expect(
      diffWatchedSnapshot(
        before,
        watched(1, { ...later, reviewState: "approved", checks: "passing" })
          .snapshot,
      ),
    ).toEqual(["decision", "checks"]);
  });
});

describe("watchPullRequest", () => {
  const full = Array.from({ length: WATCHED_PULL_REQUEST_LIMIT }, (_, index) =>
    watched(index + 1),
  );

  it("refuses a pull request past the cap with the tag and limit", () => {
    expect(watchPullRequest(full, watched(99))).toEqual({
      _tag: "err",
      error: { _tag: "WatchLimitReached", limit: 20 },
    });
  });

  it("keeps a full list unchanged when the pull request is already watched", () => {
    expect(watchPullRequest(full, watched(3, later))).toEqual({
      _tag: "ok",
      value: full,
    });
  });

  it("unwatches only the named pull request", () => {
    expect(
      unwatchPullRequest([watched(1), watched(2)], watched(1).ref),
    ).toEqual([watched(2)]);
  });
});

describe("parseWatchedPullRequests", () => {
  it("refuses the whole list when one entry is invalid", () => {
    expect(
      parseWatchedPullRequests([
        watched(1),
        { ...watched(2), snapshot: { ...baseSnapshot, headSha: "nope" } },
      ])._tag,
    ).toBe("err");
  });
});

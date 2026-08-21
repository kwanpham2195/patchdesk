import { describe, expect, it } from "vitest";

import type {
  PullRequestReviewEntry,
  RequestedReviewer,
} from "../../src/domain/github-context";
import { parseGitSha, parseIsoTimestamp } from "../../src/domain/ids";
import { deriveReviewVerdicts } from "../../src/domain/review-verdicts";
import type { Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};

const headSha = must(parseGitSha("a".repeat(40)));
const staleSha = must(parseGitSha("b".repeat(40)));

function requested(
  login: string,
  overrides: Partial<Omit<RequestedReviewer, "login">> = {},
): RequestedReviewer {
  return { login, ...overrides };
}

function review(input: {
  readonly login: string;
  readonly state: PullRequestReviewEntry["state"];
  readonly submittedAt?: string;
  readonly commitOid?: string;
  readonly avatarUrl?: string;
}): PullRequestReviewEntry {
  let entry: PullRequestReviewEntry = {
    login: input.login,
    state: input.state,
  };
  if (input.submittedAt !== undefined)
    entry = {
      ...entry,
      submittedAt: must(parseIsoTimestamp(input.submittedAt)),
    };
  if (input.commitOid !== undefined)
    entry = { ...entry, commitOid: must(parseGitSha(input.commitOid)) };
  if (input.avatarUrl !== undefined)
    entry = { ...entry, avatarUrl: input.avatarUrl };
  return entry;
}

describe("deriveReviewVerdicts", () => {
  it("drops a PENDING entry entirely — an unfinished draft is never a verdict", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [],
        latestReviews: [review({ login: "alice", state: "PENDING" })],
        reviews: [],
      },
      headSha,
    );
    expect(rows).toEqual([]);
  });

  it("recovers a person's real verdict from `reviews` when `latestReviews` omits them for holding an open pending review", () => {
    // This is the ADR-documented common path: `latestReviews` elevates the
    // open PENDING draft and drops the person's actual last submitted
    // review, while `reviews` still carries the full history.
    const rows = deriveReviewVerdicts(
      {
        requested: [],
        latestReviews: [review({ login: "alice", state: "PENDING" })],
        reviews: [
          review({
            login: "alice",
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "a".repeat(40),
          }),
        ],
      },
      headSha,
    );
    expect(rows).toEqual([
      {
        login: "alice",
        verdict: "approved",
        outdated: false,
        submittedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("marks a verdict outdated when its commit differs from the represented revision's head", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [],
        latestReviews: [
          review({
            login: "bob",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "b".repeat(40),
          }),
        ],
        reviews: [],
      },
      headSha,
    );
    expect(rows).toEqual([
      {
        login: "bob",
        verdict: "changes_requested",
        outdated: true,
        submittedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("marks a verdict current when its commit matches the represented revision's head", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [],
        latestReviews: [
          review({
            login: "bob",
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "a".repeat(40),
          }),
        ],
        reviews: [],
      },
      headSha,
    );
    expect(rows[0]?.outdated).toBe(false);
  });

  it("treats a verdict with no reported commit as outdated rather than assumed current", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [],
        latestReviews: [
          review({
            login: "bob",
            state: "COMMENTED",
            submittedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
        reviews: [],
      },
      headSha,
    );
    expect(rows[0]?.outdated).toBe(true);
  });

  it("picks each person's most recent submitted entry by submittedAt across the union", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [],
        latestReviews: [
          review({
            login: "carol",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "b".repeat(40),
          }),
        ],
        reviews: [
          review({
            login: "carol",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "b".repeat(40),
          }),
          review({
            login: "carol",
            state: "APPROVED",
            submittedAt: "2026-01-02T00:00:00.000Z",
            commitOid: "a".repeat(40),
          }),
        ],
      },
      headSha,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe("approved");
    expect(rows[0]?.submittedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("shows a requested reviewer who has not submitted anything with no verdict at all", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [requested("dave", { name: "Dave Example" })],
        latestReviews: [],
        reviews: [],
      },
      headSha,
    );
    expect(rows).toEqual([
      { login: "dave", name: "Dave Example", outdated: false },
    ]);
    expect(rows[0]).not.toHaveProperty("verdict");
    expect(rows[0]).not.toHaveProperty("submittedAt");
  });

  it("keeps a person's prior verdict when they are also currently requested — a fresh request does not erase it", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [
          requested("erin", { avatarUrl: "https://avatars.example/erin.png" }),
        ],
        latestReviews: [
          review({
            login: "erin",
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "a".repeat(40),
          }),
        ],
        reviews: [],
      },
      headSha,
    );
    expect(rows).toEqual([
      {
        login: "erin",
        avatarUrl: "https://avatars.example/erin.png",
        verdict: "approved",
        outdated: false,
        submittedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("orders submitted verdicts most-recent-first, then requested-but-unreviewed alphabetically", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [requested("zack"), requested("amy")],
        latestReviews: [
          review({
            login: "older",
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "a".repeat(40),
          }),
          review({
            login: "newer",
            state: "COMMENTED",
            submittedAt: "2026-01-03T00:00:00.000Z",
            commitOid: "a".repeat(40),
          }),
        ],
        reviews: [],
      },
      headSha,
    );
    expect(rows.map((row) => row.login)).toEqual([
      "newer",
      "older",
      "amy",
      "zack",
    ]);
  });

  it("is a pure function: identical inputs produce an identical result", () => {
    const listing = {
      requested: [requested("frank")],
      latestReviews: [
        review({
          login: "grace",
          state: "DISMISSED",
          submittedAt: "2026-01-01T00:00:00.000Z",
          commitOid: "a".repeat(40),
        }),
      ],
      reviews: [],
    };
    expect(deriveReviewVerdicts(listing, headSha)).toEqual(
      deriveReviewVerdicts(listing, headSha),
    );
  });

  it("treats the represented revision's own head as the freshness line, independent of a different stale commit", () => {
    const rows = deriveReviewVerdicts(
      {
        requested: [],
        latestReviews: [
          review({
            login: "henry",
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00.000Z",
            commitOid: "a".repeat(40),
          }),
        ],
        reviews: [],
      },
      staleSha,
    );
    expect(rows[0]?.outdated).toBe(true);
  });
});

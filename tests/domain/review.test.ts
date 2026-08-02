import { describe, expect, it } from "vitest";

import {
  createReview,
  createReviewId,
  markDetectedUpdate,
  markReviewTerminal,
  moveReviewToSession,
  parseReview,
  type ReviewIdentity,
} from "../../src/domain/review";
import {
  createReviewSessionId,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const identity: ReviewIdentity = {
  profileId: must(parseWorkspaceProfileId("cfw")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
const firstSha = must(parseGitSha("1".repeat(40)));
const secondSha = must(parseGitSha("2".repeat(40)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const later = must(parseIsoTimestamp("2026-08-01T00:01:00.000Z"));
const firstSessionId = createReviewSessionId({ ...identity, headSha: firstSha });
const secondSessionId = createReviewSessionId({ ...identity, headSha: secondSha });
const snapshotHash = must(parseContentHash("a".repeat(64)));

function review() {
  return createReview({
    identity,
    currentSessionId: firstSessionId,
    headSha: firstSha,
    createdAt: now,
  });
}

describe("Review", () => {
  it("keeps one identity-derived ID across heads", () => {
    expect(createReviewId(identity)).toBe(createReviewId(identity));
    expect(review().id).toBe(createReviewId(identity));
    expect(
      createReview({
        identity,
        currentSessionId: secondSessionId,
        headSha: secondSha,
        createdAt: now,
      }).id,
    ).toBe(review().id);
  });

  it("moves an open review to a new immutable session", () => {
    const moved = moveReviewToSession(review(), {
      sessionId: secondSessionId,
      headSha: secondSha,
      representedRemote: {
        headSha: secondSha,
        pullRequestUpdatedAt: now,
        snapshotHash,
        refreshedAt: later,
      },
      updatedAt: later,
    });

    expect(moved).toMatchObject({
      _tag: "ok",
      value: {
        currentSessionId: secondSessionId,
        currentHeadSha: secondSha,
        representedRemote: { snapshotHash },
        updatedAt: later,
      },
    });
  });

  it("rejects identity mismatches in stored data", () => {
    expect(
      parseReview({
        ...review(),
        identity: { ...identity, owner: "other-owner" },
      }),
    ).toMatchObject({ _tag: "err" });
  });

  it("keeps terminal reviews immutable", () => {
    const terminal = markReviewTerminal(review(), "merged", later);
    expect(markReviewTerminal(terminal, "closed", later)).toEqual(terminal);
    expect(
      moveReviewToSession(terminal, {
        sessionId: secondSessionId,
        headSha: secondSha,
        representedRemote: {
          headSha: secondSha,
          pullRequestUpdatedAt: later,
          snapshotHash,
          refreshedAt: later,
        },
        updatedAt: later,
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "ReviewTerminal" } });
    expect(
      markDetectedUpdate(terminal, { detectedAt: later, reason: "head" }, later),
    ).toEqual(terminal);
  });

  it("records a bounded remote update without replacing represented state", () => {
    const updated = markDetectedUpdate(
      review(),
      { detectedAt: later, reason: "checks" },
      later,
    );
    expect(updated).toMatchObject({
      detectedUpdate: { detectedAt: later, reason: "checks" },
      currentSessionId: firstSessionId,
      currentHeadSha: firstSha,
      updatedAt: later,
    });
  });
});

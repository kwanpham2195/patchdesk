import { describe, expect, it } from "vitest";

import { createReview } from "../../src/domain/review";
import { parseRefreshOperation } from "../../src/domain/refresh-operation";
import {
  createReviewSessionId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

function must<Value>(result: Result<Value, unknown>): Value {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}

const identity = {
  profileId: must(parseWorkspaceProfileId("acme")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo")),
  repo: must(parseGitHubRepoName("widgets")),
  prNumber: must(parsePullRequestNumber(7)),
};
const headSha = must(parseGitSha("a".repeat(40)));
const review = createReview({
  identity,
  currentSessionId: createReviewSessionId({
    ...identity,
    headSha,
    baseSha: must(parseGitSha("b".repeat(40))),
  }),
  headSha,
  createdAt: must(parseIsoTimestamp("2026-09-17T09:00:00.000Z")),
});

const operation = {
  operationId: "refresh-7",
  profileId: "acme",
  reviewId: review.id,
  expectedUpdatedAt: "2026-09-17T09:00:00.000Z",
  startedAt: "2026-09-17T10:00:00.000Z",
};

describe("refresh operation", () => {
  it("parses a prepared operation with its complete validated next Review", () => {
    expect(
      parseRefreshOperation({
        ...operation,
        state: {
          _tag: "Prepared",
          nextReview: { ...review, updatedAt: "2026-09-17T10:00:00.000Z" },
          sessionId: review.currentSessionId,
          snapshotHash: "d".repeat(64),
        },
      }),
    ).toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Prepared" } },
    });
  });

  it("rejects a prepared operation without a valid complete Review", () => {
    expect(
      parseRefreshOperation({
        ...operation,
        state: {
          _tag: "Prepared",
          nextReview: { id: review.id },
          sessionId: review.currentSessionId,
          snapshotHash: "d".repeat(64),
        },
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidRefreshOperation" } });
  });
});

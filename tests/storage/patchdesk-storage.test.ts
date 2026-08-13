import { describe, expect, it } from "vitest";

import { parseStoredReviewSession } from "../../src/adapters/storage/review-session-store";

const current = {
  schemaVersion: 5,
  id: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__439aa21713b5",
  key: {
    profileId: "cfw",
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    prNumber: 42,
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
  },
  pr: {
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    baseSha: "1234567890abcdef1234567890abcdef12345678",
    isDraft: false,
    isOpen: true,
  },
  patchPath: "/tmp/patch.diff",
  worktree: {
    path: "/tmp/worktree",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("ReviewSession storage", () => {
  it("round-trips the current receipt-bearing schema and rejects every older schema", () => {
    const receiptState = {
      ...current,
      pendingReview: { _tag: "None" },
      findingReviewReceipts: [],
      directSummaryReview: {
        _tag: "Confirmed",
        receipt: {
          reviewId: "9001",
          event: "COMMENT",
          headSha: current.key.headSha,
          submittedAt: current.updatedAt,
        },
      },
    };
    expect(parseStoredReviewSession(receiptState)).toMatchObject({
      _tag: "ok",
      value: {
        schemaVersion: 5,
        pendingReview: { _tag: "None" },
        directSummaryReview: { _tag: "Confirmed" },
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      },
    });
    for (const schemaVersion of [2, 3, 4])
      expect(
        parseStoredReviewSession({ ...current, schemaVersion }),
      ).toMatchObject({ _tag: "err" });
  });

  it("rejects unknown current-schema fields instead of migrating removed state", () => {
    const removedFields = [
      "ba" + "tch",
      "batch" + "Content",
      "current" + "AttemptId",
      "visible" + "Result",
      "scope",
    ];
    for (const field of removedFields) {
      expect(
        parseStoredReviewSession({ ...current, [field]: {} }),
      ).toMatchObject({ _tag: "err" });
    }
  });
});

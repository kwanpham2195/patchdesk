import { describe, expect, it } from "vitest";

import { createReview, markReviewTerminal } from "../../src/domain/review";

const identity = { profileId: "cfw" as never, host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, prNumber: 42 as never };
const now = "2026-08-01T00:00:00.000Z" as never;

describe("Review lifecycle", () => {
  it("owns immutable session identity and terminal state", () => {
    const review = createReview({ identity, currentSessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__439aa21713b5" as never, headSha: "abcdef1234567890abcdef1234567890abcdef12" as never, createdAt: now });
    expect(markReviewTerminal(review, "merged", now)).toMatchObject({ status: { _tag: "Terminal", state: "merged" } });
  });
});

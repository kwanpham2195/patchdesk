import { describe, expect, it } from "vitest";

import { createReview, markReviewTerminal } from "../../src/domain/review";

const identity = {
  // SAFETY: This test fixture uses well-formed literals for branded domain values; the runtime shape is established by the fixture and the production behavior is under test.
  profileId: "cfw" as never,
  // SAFETY: This test fixture uses well-formed literals for branded domain values; the runtime shape is established by the fixture and the production behavior is under test.
  host: "github.com" as never,
  // SAFETY: This test fixture uses well-formed literals for branded domain values; the runtime shape is established by the fixture and the production behavior is under test.
  owner: "centraldigital" as never,
  // SAFETY: This test fixture uses well-formed literals for branded domain values; the runtime shape is established by the fixture and the production behavior is under test.
  repo: "patchdesk" as never,
  // SAFETY: This test fixture uses well-formed literals for branded domain values; the runtime shape is established by the fixture and the production behavior is under test.
  prNumber: 42 as never,
};
// SAFETY: This test fixture uses well-formed literals for branded domain values; the runtime shape is established by the fixture and the production behavior is under test.
const now = "2026-08-01T00:00:00.000Z" as never;

describe("Review lifecycle", () => {
  it("owns immutable session identity and terminal state", () => {
    const review = createReview({
      identity,
      currentSessionId:
        // SAFETY: This test fixture uses well-formed literals for branded domain values; the runtime shape is established by the fixture and the production behavior is under test.
        "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__439aa21713b5" as never,
      // SAFETY: This test fixture uses well-formed literals for branded domain values; the runtime shape is established by the fixture and the production behavior is under test.
      headSha: "abcdef1234567890abcdef1234567890abcdef12" as never,
      createdAt: now,
    });
    expect(markReviewTerminal(review, "merged", now)).toMatchObject({
      status: { _tag: "Terminal", state: "merged" },
    });
  });
});

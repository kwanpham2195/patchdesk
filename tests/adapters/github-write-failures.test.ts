import { describe, expect, it } from "vitest";

import { writeFailure } from "../../src/adapters/github/github-write-failures";
import type { ForbiddenReason } from "../../src/domain/github-forbidden-reason";

/**
 * A forbidden write must carry its specific ForbiddenReason and land in a
 * dedicated "forbidden" category — never collapse into the generic
 * "unavailable" category a transient network blip also produces (the
 * write-side counterpart to plan 009's read-side fix; see
 * docs/adr/0024-explain-forbidden-github-reads.md).
 */
describe("writeFailure — CommandForbidden", () => {
  const reasons: ReadonlyArray<ForbiddenReason> = [
    "ip_allow_list",
    "saml",
    "insufficient_scopes",
    "unknown",
  ];

  it.each(reasons)(
    "classifies a forbidden write with reason %s as category 'forbidden', not 'unavailable'",
    (reason) => {
      const failure = writeFailure({ _tag: "CommandForbidden", reason });
      expect(failure._tag).toBe("GitHubWriteFailure");
      expect(failure.category).toBe("forbidden");
      expect(failure.category).not.toBe("unavailable");
      expect(failure.reason).toBe(reason);
    },
  );

  it("gives each forbidden reason its own message, not one generic sentence reused for all four", () => {
    const messages = new Set(
      reasons.map((reason) => writeFailure({ _tag: "CommandForbidden", reason }).message),
    );
    expect(messages.size).toBe(reasons.length);
  });

  it("never repeats GitHub's raw stdout/stderr text in the message", () => {
    const failure = writeFailure({
      _tag: "CommandForbidden",
      reason: "ip_allow_list",
    });
    // The message is authored copy, not a passthrough of GitHub's own wording.
    expect(failure.message).not.toMatch(/authorization credentials/i);
  });

  it("still classifies every other CommandFailure tag exactly as before (no regression)", () => {
    expect(
      writeFailure({ _tag: "CommandAuthenticationRequired" }).category,
    ).toBe("auth");
    expect(writeFailure({ _tag: "CommandRateLimited" }).category).toBe(
      "rate_limited",
    );
    expect(writeFailure({ _tag: "CommandPendingReview" }).category).toBe(
      "pending_review",
    );
    expect(writeFailure({ _tag: "CommandFailed" }).category).toBe("rejected");
    expect(writeFailure({ _tag: "CommandTimedOut" }).category).toBe(
      "unavailable",
    );
  });
});

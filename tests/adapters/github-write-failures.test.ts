import { describe, expect, it } from "vitest";

import type { CommandFailure } from "../../src/adapters/github/command-runner";
import {
  optionalPolicyUnavailableReason,
  writeFailure,
} from "../../src/adapters/github/github-write-failures";
import type { ForbiddenReason } from "../../src/domain/github-forbidden-reason";

const forbiddenReasons: ReadonlyArray<ForbiddenReason> = [
  "ip_allow_list",
  "saml",
  "insufficient_scopes",
  "unknown",
];

const otherFailures = [
  {
    label: "authentication",
    failure: { _tag: "CommandAuthenticationRequired" },
    category: "auth",
  },
  {
    label: "an unfinished review",
    failure: { _tag: "CommandPendingReview" },
    category: "pending_review",
  },
  {
    label: "rate limiting",
    failure: { _tag: "CommandRateLimited" },
    category: "rate_limited",
  },
  {
    label: "a missing endpoint",
    failure: { _tag: "CommandNotFound" },
    category: "refused",
  },
  {
    label: "an unsupported endpoint",
    failure: { _tag: "CommandUnsupported" },
    category: "refused",
  },
  {
    label: "a method GitHub does not allow",
    failure: { _tag: "CommandMethodNotAllowed" },
    category: "refused",
  },
  {
    label: "a request GitHub could not process",
    failure: { _tag: "CommandUnprocessable" },
    category: "refused",
  },
  {
    label: "a conflicting request",
    failure: { _tag: "CommandConflict" },
    category: "refused",
  },
  {
    label: "an unavailable command runtime",
    failure: { _tag: "CommandRuntimeUnavailable" },
    category: "unavailable",
  },
  {
    label: "an unavailable request",
    failure: { _tag: "CommandUnavailable" },
    category: "unavailable",
  },
  {
    label: "a timed-out request",
    failure: { _tag: "CommandTimedOut" },
    category: "unavailable",
  },
  {
    label: "an invalid response body",
    failure: { _tag: "CommandInvalidJson" },
    category: "unavailable",
  },
  {
    label: "an unclassified command failure",
    failure: { _tag: "CommandFailed" },
    category: "unavailable",
  },
  {
    label: "an aborted request",
    failure: { _tag: "CommandAborted" },
    category: "unavailable",
  },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly failure: CommandFailure;
  readonly category: string;
}>;

describe("writeFailure — CommandForbidden", () => {
  it.each(forbiddenReasons)(
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
      forbiddenReasons.map(
        (reason) => writeFailure({ _tag: "CommandForbidden", reason }).message,
      ),
    );
    expect(messages.size).toBe(forbiddenReasons.length);
  });
});

describe("writeFailure for other command failures", () => {
  it.each(otherFailures)(
    "maps $label to the expected write category",
    ({ failure, category }) => {
      expect(writeFailure(failure).category).toBe(category);
    },
  );

  it("does not expose raw stderr from an unclassified command failure", () => {
    const rawStderr = "The request failed: authorization credentials expired.";
    const failure = writeFailure({ _tag: "CommandFailed", stderr: rawStderr });

    expect(failure.category).toBe("unavailable");
    expect(failure.message).not.toContain(rawStderr);
  });
});

describe("optionalPolicyUnavailableReason", () => {
  // Reads keep one "unsupported" answer for every status that used to share the tag.
  it.each([
    "CommandUnsupported",
    "CommandMethodNotAllowed",
    "CommandUnprocessable",
  ] as const)("reads %s as unsupported", (_tag) => {
    expect(optionalPolicyUnavailableReason({ _tag })).toBe("unsupported");
  });
});

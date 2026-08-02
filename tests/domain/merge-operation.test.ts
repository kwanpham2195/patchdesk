import { describe, expect, it } from "vitest";

import {
  confirmMergeOperation,
  markMergeOutcomeUnknown,
  parseMergeOperation,
  rejectMergeOperation,
  requestMergeOperation,
} from "../../src/domain/merge-operation";
import { parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseReviewSessionId, parseWorkspaceProfileId } from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const requested = () => requestMergeOperation({
  operationId: "merge-001",
  profileId: value(parseWorkspaceProfileId("cfw")),
  sessionId: value(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab")),
  pr: { host: value(parseGitHubHost("github.com")), owner: value(parseGitHubOwner("centraldigital")), repo: value(parseGitHubRepoName("patchdesk")), number: value(parsePullRequestNumber(42)) },
  expectedHeadSha: value(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  method: "squash",
  acknowledgedWarningCodes: ["checks_pending"],
  startedAt: value(parseIsoTimestamp("2026-08-01T00:00:00.000Z")),
});

describe("merge operation", () => {
  it("moves a sanitized requested operation through unknown to confirmed", () => {
    const operation = value(requested());
    const unknown = value(markMergeOutcomeUnknown(operation));
    const confirmed = confirmMergeOperation(unknown, value(parseIsoTimestamp("2026-08-01T00:01:00.000Z")), value(parseGitSha("1234567890abcdef1234567890abcdef12345678")));

    expect(confirmed).toMatchObject({ _tag: "ok", value: { state: { _tag: "Confirmed", mergedAt: "2026-08-01T00:01:00.000Z" } } });
    expect(JSON.stringify(confirmed)).not.toContain("token");
  });

  it("allows only finite rejection codes and prevents terminal transitions", () => {
    const operation = value(requested());
    expect(rejectMergeOperation(operation, "stale_head")).toMatchObject({ _tag: "ok", value: { state: { _tag: "Rejected", reason: "stale_head" } } });
    expect(rejectMergeOperation(operation, "raw GitHub error")).toMatchObject({ _tag: "err" });
    expect(markMergeOutcomeUnknown(value(rejectMergeOperation(operation, "stale_head")))).toMatchObject({ _tag: "err" });
  });

  it("rejects malformed persisted operations and unbounded warning evidence", () => {
    expect(parseMergeOperation({ ...value(requested()), state: { _tag: "Confirmed", mergedAt: "not-a-date" } })).toMatchObject({ _tag: "err" });
    expect(requestMergeOperation({ ...value(requested()), acknowledgedWarningCodes: Array.from({ length: 33 }, () => "warning") })).toMatchObject({ _tag: "err" });
  });
});

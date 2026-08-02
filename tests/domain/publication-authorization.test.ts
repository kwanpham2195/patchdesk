import { describe, expect, it } from "vitest";

import { createPublicationAuthorization, consumePublicationAuthorization, revokePublicationAuthorization, authorizationMatches } from "../../src/domain/publication-authorization";
import { parseContentHash, parseGitSha, parseInsightRunId, parseIsoTimestamp, parsePublicationAuthorizationId, parseReviewId, parseReviewSessionId, parseWorkspaceProfileId } from "../../src/domain/ids";
import { type Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => { if (result._tag === "ok") return result.value; throw new Error("fixture"); };
const profileId = must(parseWorkspaceProfileId("cfw"));
const reviewId = must(parseReviewId("github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa"));
const sessionId = must(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__aaaaaaaaaaaa"));
const headSha = must(parseGitSha("a".repeat(40)));
const patchHash = must(parseContentHash("b".repeat(64)));
const runId = must(parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-review"));
const createdAt = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));

function fixtureAuthorization() {
  return createPublicationAuthorization({ id: must(parsePublicationAuthorizationId("publication-analysis-1")), profileId, reviewId, sessionId, headSha, patchHash, analysisRunId: runId, expectedDraftRevision: createdAt, event: "COMMENT", createdAt });
}

describe("publication authorization", () => {
  it("is bound to one immutable Analysis and draft identity", () => {
    const value = fixtureAuthorization();
    expect(authorizationMatches(value, { profileId, reviewId, sessionId, headSha, patchHash, analysisRunId: runId, expectedDraftRevision: createdAt, event: "COMMENT" })).toBe(true);
    expect(authorizationMatches(value, { profileId, reviewId, sessionId, headSha, patchHash, analysisRunId: runId, expectedDraftRevision: createdAt, event: "APPROVE" })).toBe(false);
  });

  it("cannot be consumed or revoked twice into a new state", () => {
    const value = fixtureAuthorization();
    const consumed = consumePublicationAuthorization(value, createdAt);
    expect(consumed._tag).toBe("ok");
    if (consumed._tag === "ok") expect(consumePublicationAuthorization(consumed.value, createdAt)).toEqual({ _tag: "err", error: "not_armed" });
    expect(revokePublicationAuthorization(value, "draft_changed").state).toEqual({ _tag: "Revoked", reason: "draft_changed" });
  });
});

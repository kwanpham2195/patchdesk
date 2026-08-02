import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { PublicationAuthorizationStore } from "../../src/adapters/storage/publication-authorization-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { createPublicationAuthorization } from "../../src/domain/publication-authorization";
import { parseContentHash, parseGitSha, parseInsightRunId, parseIsoTimestamp, parsePublicationAuthorizationId, parseReviewId, parseReviewSessionId, parseWorkspaceProfileId } from "../../src/domain/ids";
import { AnalysisCompletionService } from "../../src/services/analysis-completion-service";
import { type Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => { if (result._tag === "ok") return result.value; throw new Error("fixture"); };
const profileId = must(parseWorkspaceProfileId("cfw"));
const reviewId = must(parseReviewId("github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa"));
const sessionId = must(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__aaaaaaaaaaaa"));
const headSha = must(parseGitSha("a".repeat(40)));
const patchHash = must(parseContentHash("b".repeat(64)));
const analysisRunId = must(parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-review"));
const authorizationId = must(parsePublicationAuthorizationId("publication-analysis-1"));
const at = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));

it("revokes an armed authorization and refuses a mismatched consume", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-completion-service-"));
  try {
    const store = new PublicationAuthorizationStore(PatchdeskPaths.forTest(root));
    await store.save(createPublicationAuthorization({ id: authorizationId, profileId, reviewId, sessionId, headSha, patchHash, analysisRunId, expectedDraftRevision: at, event: "COMMENT", createdAt: at }));
    const service = new AnalysisCompletionService(store);
    expect(await service.revoke({ profileId, reviewId, authorizationId, reason: "draft_changed" })).toEqual({ _tag: "ok", value: undefined });
    expect(await service.consume({ profileId, reviewId, authorizationId, sessionId, headSha, patchHash, analysisRunId, expectedDraftRevision: at, event: "COMMENT", consumedAt: at })).toEqual({ _tag: "err", error: "authorization_mismatch" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { PublicationAuthorizationStore } from "../../src/adapters/storage/publication-authorization-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { createPublicationAuthorization } from "../../src/domain/publication-authorization";
import { parseContentHash, parseGitSha, parseInsightRunId, parseIsoTimestamp, parsePublicationAuthorizationId, parseReviewId, parseReviewSessionId, parseWorkspaceProfileId } from "../../src/domain/ids";
import { type Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => { if (result._tag === "ok") return result.value; throw new Error("fixture"); };
const profileId = must(parseWorkspaceProfileId("cfw"));
const reviewId = must(parseReviewId("github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa"));
const createdAt = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));

it("round-trips one publication authorization beside the Analysis record", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-publication-auth-"));
  try {
    const store = new PublicationAuthorizationStore(PatchdeskPaths.forTest(root));
    const value = createPublicationAuthorization({ id: must(parsePublicationAuthorizationId("publication-analysis-1")), profileId, reviewId, sessionId: must(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__aaaaaaaaaaaa")), headSha: must(parseGitSha("a".repeat(40))), patchHash: must(parseContentHash("b".repeat(64))), analysisRunId: must(parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-review")), expectedDraftRevision: createdAt, event: "APPROVE", createdAt });
    expect(await store.save(value)).toEqual({ _tag: "ok", value: undefined });
    expect(await store.load(profileId, reviewId)).toEqual({ _tag: "ok", value });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

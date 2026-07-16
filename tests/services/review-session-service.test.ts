import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseWorkspaceProfileId } from "../../src/domain/ids";
import { ReviewSessionService } from "../../src/services/review-session-service";

function must<T>(r: { _tag: "ok"; value: T } | { _tag: "err" }): T { if (r._tag === "err") throw new Error("parse"); return r.value; }
describe("ReviewSessionService", () => {
  it("starts a persistent exact-head session in degraded metadata-only mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-session-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const service = new ReviewSessionService(paths, () => must(parseIsoTimestamp("2026-07-16T00:00:00.000Z")));
      const result = await service.startReview({ profileId: must(parseWorkspaceProfileId("cfw")), host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), number: must(parsePullRequestNumber(42)), headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")), isDraft: false, isOpen: true });
      expect(result).toMatchObject({ _tag: "ok", value: { session: { state: { _tag: "Created" }, key: { headSha: "abcdef1234567890abcdef1234567890abcdef12" } }, outcome: { mode: "metadata_only", warning: "missing_local_path" } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  createReviewSessionId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ReviewPreparationJournal } from "../../src/services/review-preparation-journal";
import type { Result } from "../../src/domain/result";

const roots: string[] = [];

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReviewPreparationJournal", () => {
  it("exposes an active operation without exposing journal paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-preparation-journal-"));
    roots.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const profileId = parseWorkspaceProfileId("cfw");
    const host = parseGitHubHost("github.com");
    const owner = parseGitHubOwner("centraldigital");
    const repo = parseGitHubRepoName("patchdesk");
    const prNumber = parsePullRequestNumber(42);
    const headSha = parseGitSha("abcdef1234567890abcdef1234567890abcdef12");
    const sessionId = createReviewSessionId({
      profileId: must(profileId),
      host: must(host),
      owner: must(owner),
      repo: must(repo),
      prNumber: must(prNumber),
      headSha: must(headSha),
    });
    const profile = must(profileId);
    const journal = await ReviewPreparationJournal.begin(paths, profile, sessionId);
    expect(journal).toMatchObject({ _tag: "ok" });
    await expect(ReviewPreparationJournal.activeFor(paths, profile, sessionId)).resolves.toEqual({
      _tag: "ok",
      value: { profileId: profile, sessionId, phase: "preparing" },
    });
    if (journal._tag === "ok") await journal.value.complete();
    await expect(ReviewPreparationJournal.activeFor(paths, profile, sessionId)).resolves.toEqual({ _tag: "ok", value: undefined });
  });
});

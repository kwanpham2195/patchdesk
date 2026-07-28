import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewArtifactStorage } from "../../src/adapters/storage/review-artifact-storage";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { createReviewSessionId, parseAbsolutePath, parseGitSha, parseIsoTimestamp, parseWorkspaceProfileId } from "../../src/domain/ids";
import { createReviewSession } from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewRecoveryService } from "../../src/services/review-recovery-service";

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("2222222222222222222222222222222222222222"));
const timestamp = must(parseIsoTimestamp("2026-07-18T00:00:00.000Z"));

it("quarantines malformed entries, records diagnostics, and continues scanning valid sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-recovery-service-"));
  try {
    const paths = PatchdeskPaths.forTest(root);
    const profile = parseWorkspaceProfileConfig({
      id: "cfw",
      label: "CFW",
      githubHost: "github.com",
      ghAccount: "fixture",
      ownerFilters: [],
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    });
    if (profile._tag === "err") throw new Error("fixture");
    const profiles = new ProfileStore(paths);
    expect((await profiles.save(profile.value))._tag).toBe("ok");
    const sessions = new ReviewSessionStore(paths);
    const sessionId = createReviewSessionId({ profileId, host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, prNumber: 42 as never, headSha });
    const session = createReviewSession({
      key: { profileId, host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, prNumber: 42 as never, headSha },
      pr: { headSha, isDraft: false, isOpen: true },
      patchPath: must(parseAbsolutePath(paths.patchFile(profileId, sessionId))),
      worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, sessionId))), headSha },
      createdAt: timestamp,
    });
    expect((await sessions.save(session))._tag).toBe("ok");
    await mkdir(join(paths.profileReviewsDirectory(profileId), "broken-entry"), { recursive: true });
    const artifacts = new ReviewArtifactStorage(paths, () => timestamp);
    const service = new ReviewRecoveryService(profiles, sessions, () => timestamp, { paths, artifacts });

    const result = await service.reconcile();

    expect(result.failed).toBe(0);
    const diagnosticText = await readFile(join(paths.profileReviewsDirectory(profileId), "diagnostics.jsonl"), "utf8");
    expect(diagnosticText).toContain('"entryName":"broken-entry"');
    expect(await artifacts.listQuarantined(profileId)).toMatchObject({ _tag: "ok", value: [{ entryName: expect.stringMatching(/^invalid-/) }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

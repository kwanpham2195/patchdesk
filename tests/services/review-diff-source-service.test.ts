import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { createReviewSession } from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewDiffSourceService } from "../../src/services/review-diff-source-service";

function must<T>(
  value: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" },
): T {
  if (value._tag === "err") throw new Error("fixture parse failed");
  return value.value;
}

describe("ReviewDiffSourceService", () => {
  it("hydrates a selected patch file from exact base and head text without exposing a checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diff-source-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const profile = must(
        parseWorkspaceProfileConfig({
          id: "cfw",
          label: "CFW",
          githubHost: "github.com",
          ghAccount: "fixture",
          ownerFilters: [],
          workspaceRoots: [],
          rulePaths: [],
          repos: [],
        }),
      );
      const profileStore = new ProfileStore(paths);
      await profileStore.save(profile);
      const key = {
        profileId: must(parseWorkspaceProfileId("cfw")),
        host: must(parseGitHubHost("github.com")),
        owner: must(parseGitHubOwner("centraldigital")),
        repo: must(parseGitHubRepoName("patchdesk")),
        prNumber: must(parsePullRequestNumber(42)),
        headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
      };
      const storageId = "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never;
      const patchPath = must(parseAbsolutePath(paths.patchFile(key.profileId, storageId)));
      const worktreePath = must(parseAbsolutePath(paths.worktreeDirectory(key.profileId, storageId)));
      const createdAt = must(parseIsoTimestamp("2026-07-24T00:00:00.000Z"));
      const session = createReviewSession({
          key,
          pr: {
            headSha: key.headSha,
            baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
            isDraft: false,
            isOpen: true,
          },
          patchPath,
          worktree: { path: worktreePath, headSha: key.headSha },
          createdAt,
        });
      const sessionId = session.id;
      await mkdir(join(paths.sessionDirectory(key.profileId, storageId)), {
        recursive: true,
      });
      await writeFile(
        patchPath,
        [
          "diff --git a/src/example.ts b/src/example.ts",
          "index 1111111..2222222 100644",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1,2 +1,2 @@",
          " old line",
          "-before",
          "+after",
          " trailing line",
          "",
        ].join("\n"),
      );
      await new ReviewSessionStore(paths).save(session);

      const service = new ReviewDiffSourceService(
        profileStore,
        new ReviewSessionStore(paths),
        new FakeGitHubAdapter({
          fileContents: { state: "available", contents: "old line\nbefore\ntrailing line\n" },
        }),
      );
      const loaded = await service.load({
        profileId: "cfw",
        sessionId,
        path: "src/example.ts",
      });

      expect(loaded).toEqual({
        _tag: "ok",
        value: {
          state: "ready",
          oldFile: {
            name: "src/example.ts",
            contents: "old line\nbefore\ntrailing line\n",
          },
          newFile: {
            name: "src/example.ts",
            contents: "old line\nbefore\ntrailing line\n",
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses binary source content without passing it to the renderer", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diff-source-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const profile = must(parseWorkspaceProfileConfig({ id: "cfw", label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
      const profiles = new ProfileStore(paths);
      await profiles.save(profile);
      const key = { profileId: profile.id, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")) };
      const storageId = "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never;
      const patchPath = must(parseAbsolutePath(paths.patchFile(key.profileId, storageId)));
      const worktreePath = must(parseAbsolutePath(paths.worktreeDirectory(key.profileId, storageId)));
      const createdAt = must(parseIsoTimestamp("2026-07-24T00:00:00.000Z"));
      const session = createReviewSession({ key, pr: { headSha: key.headSha, baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")), isDraft: false, isOpen: true }, patchPath, worktree: { path: worktreePath, headSha: key.headSha }, createdAt });
      const sessionId = session.id;
      await mkdir(paths.sessionDirectory(key.profileId, storageId), { recursive: true });
      await writeFile(patchPath, ["diff --git a/src/example.ts b/src/example.ts", "--- a/src/example.ts", "+++ b/src/example.ts", "@@ -1 +1 @@", "-before", "+after", ""].join("\n"));
      await new ReviewSessionStore(paths).save(session);

      const loaded = await new ReviewDiffSourceService(
        profiles,
        new ReviewSessionStore(paths),
        new FakeGitHubAdapter({ fileContents: { state: "binary" } }),
      ).load({ profileId: "cfw", sessionId, path: "src/example.ts" });

      expect(loaded).toEqual({
        _tag: "ok",
        value: { state: "unavailable", reason: "binary" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

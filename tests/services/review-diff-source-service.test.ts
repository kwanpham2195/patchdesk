import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
  type WorkspaceProfileId,
} from "../../src/domain/ids";
import { createReviewSession } from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewDiffSourceService } from "../../src/services/review-diff-source-service";
import type { GitReadExecutor } from "../../src/services/review-worktree-service";

function must<T>(
  value: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" },
): T {
  if (value._tag === "err") throw new Error("fixture parse failed");
  return value.value;
}

const fixtureMergeBaseSha = "0123456789abcdef0123456789abcdef01234567";

class SourceGit implements GitReadExecutor {
  readonly calls: Array<ReadonlyArray<string>> = [];

  constructor(
    private readonly blobs: {
      readonly base: string;
      readonly head: string;
      readonly mergeBase?: string;
      readonly rejectDirectBase?: boolean;
    },
  ) {}

  async run(argv: ReadonlyArray<string>) {
    this.calls.push(argv);
    if (argv.includes("merge-base")) {
      return {
        _tag: "ok" as const,
        value: { stdout: `${fixtureMergeBaseSha}\n` },
      };
    }
    const target = argv.at(-1) ?? "";
    if (target.includes("/base:")) {
      if (this.blobs.rejectDirectBase) {
        return {
          _tag: "err" as const,
          error: { _tag: "GitReadFailed" as const },
        };
      }
      return { _tag: "ok" as const, value: { stdout: this.blobs.base } };
    }
    if (target.startsWith(`${fixtureMergeBaseSha}:`)) {
      return {
        _tag: "ok" as const,
        value: { stdout: this.blobs.mergeBase ?? this.blobs.base },
      };
    }
    if (target.includes("/head:")) {
      return { _tag: "ok" as const, value: { stdout: this.blobs.head } };
    }
    return { _tag: "err" as const, error: { _tag: "GitReadFailed" as const } };
  }
}

async function saveSession(input: {
  readonly paths: PatchdeskPaths;
  readonly sessions: ReviewSessionStore;
  readonly profileId: WorkspaceProfileId;
  readonly number: number;
  readonly patch: string;
}) {
  const key = {
    profileId: input.profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("centraldigital")),
    repo: must(parseGitHubRepoName("patchdesk")),
    prNumber: must(parsePullRequestNumber(input.number)),
    baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
    headSha: must(
      parseGitSha(
        `${input.number.toString(16).padStart(2, "0")}${"a".repeat(38)}`,
      ),
    ),
  };
  const storageId =
    // SAFETY: This deterministic session ID is a well-formed fixture for the storage seam.
    `github.com__centraldigital__patchdesk__pr-${input.number}__sha-${input.number.toString(16).padStart(8, "0")}__0123456789ab` as never;
  const patchPath = must(
    parseAbsolutePath(input.paths.patchFile(key.profileId, storageId)),
  );
  const worktreePath = must(
    parseAbsolutePath(input.paths.worktreeDirectory(key.profileId, storageId)),
  );
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
    createdAt: must(parseIsoTimestamp("2026-07-24T00:00:00.000Z")),
  });
  await mkdir(input.paths.sessionDirectory(key.profileId, storageId), {
    recursive: true,
  });
  await writeFile(patchPath, input.patch);
  await input.sessions.save(session);
  return session;
}

describe("ReviewDiffSourceService", () => {
  it("evicts least-recently-used and oversized prepared-patch indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diff-cache-"));
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
      const profiles = new ProfileStore(paths);
      const sessions = new ReviewSessionStore(paths);
      await profiles.save(profile);
      const patch =
        "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-before\n+after\n";
      const prepared = await Promise.all(
        Array.from(
          { length: 9 },
          async (_, index) =>
            await saveSession({
              paths,
              sessions,
              profileId: profile.id,
              number: index + 1,
              patch,
            }),
        ),
      );
      let reads = 0;
      const service = new ReviewDiffSourceService(
        profiles,
        sessions,
        new SourceGit({ base: "before\n", head: "after\n" }),
        {
          stat: async (path) => await stat(path),
          read: async (path) => {
            reads += 1;
            return await readFile(path, "utf8");
          },
        },
      );
      for (const session of prepared)
        await service.load({
          profileId: "cfw",
          sessionId: session.id,
          path: "src/example.ts",
        });
      expect(reads).toBe(9);
      await service.load({
        profileId: "cfw",
        sessionId: prepared[0]?.id,
        path: "src/example.ts",
      });
      expect(reads).toBe(10);

      const oversized = await saveSession({
        paths,
        sessions,
        profileId: profile.id,
        number: 10,
        patch: `${patch}#${"x".repeat(32 * 1024 * 1024)}`,
      });
      await service.load({
        profileId: "cfw",
        sessionId: oversized.id,
        path: "src/example.ts",
      });
      await service.load({
        profileId: "cfw",
        sessionId: oversized.id,
        path: "src/example.ts",
      });
      expect(reads).toBe(12);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hydrates a selected patch file from merge-base and head text without exposing a checkout", async () => {
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
        baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
      };
      const storageId =
        // SAFETY: This deterministic session ID is a well-formed fixture for the storage seam.
        "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab" as never;
      const patchPath = must(
        parseAbsolutePath(paths.patchFile(key.profileId, storageId)),
      );
      const worktreePath = must(
        parseAbsolutePath(paths.worktreeDirectory(key.profileId, storageId)),
      );
      const createdAt = must(parseIsoTimestamp("2026-07-24T00:00:00.000Z"));
      const session = createReviewSession({
        key,
        pr: {
          headSha: key.headSha,
          baseSha: must(
            parseGitSha("fedcba9876543210fedcba9876543210fedcba98"),
          ),
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

      const git = new SourceGit({
        base: "base branch tip must not be read\n",
        mergeBase: "old line\nbefore\ntrailing line\n",
        head: "old line\nafter\ntrailing line\n",
        rejectDirectBase: true,
      });
      let patchReads = 0;
      const service = new ReviewDiffSourceService(
        profileStore,
        new ReviewSessionStore(paths),
        git,
        {
          stat: async (path) => await stat(path),
          read: async (path) => {
            patchReads += 1;
            return await readFile(path, "utf8");
          },
        },
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
            contents: "old line\nafter\ntrailing line\n",
          },
        },
      });
      expect(git.calls).toEqual([
        [
          "git",
          "-C",
          worktreePath,
          "merge-base",
          "--end-of-options",
          `refs/patchdesk/reviews/cfw/${sessionId}/base`,
          `refs/patchdesk/reviews/cfw/${sessionId}/head`,
        ],
        [
          "git",
          "-C",
          worktreePath,
          "show",
          "--no-textconv",
          "--end-of-options",
          `${fixtureMergeBaseSha}:src/example.ts`,
        ],
        [
          "git",
          "-C",
          worktreePath,
          "show",
          "--no-textconv",
          "--end-of-options",
          `refs/patchdesk/reviews/cfw/${sessionId}/head:src/example.ts`,
        ],
      ]);
      expect(git.calls.flat()).not.toContain("gh");
      await service.load({
        profileId: "cfw",
        sessionId,
        path: "src/example.ts",
      });
      expect(patchReads).toBe(1);
      await writeFile(
        patchPath,
        [
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1,2 +1,2 @@",
          " old line",
          "-before",
          "+after",
          "",
          "# changed prepared patch",
          "",
        ].join("\n"),
      );
      await service.load({
        profileId: "cfw",
        sessionId,
        path: "src/example.ts",
      });
      expect(patchReads).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses binary source content without passing it to the renderer", async () => {
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
      const profiles = new ProfileStore(paths);
      await profiles.save(profile);
      const key = {
        profileId: profile.id,
        host: must(parseGitHubHost("github.com")),
        owner: must(parseGitHubOwner("centraldigital")),
        repo: must(parseGitHubRepoName("patchdesk")),
        prNumber: must(parsePullRequestNumber(42)),
        headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
        baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
      };
      const storageId =
        // SAFETY: This deterministic session ID is a well-formed fixture for the storage seam.
        "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab" as never;
      const patchPath = must(
        parseAbsolutePath(paths.patchFile(key.profileId, storageId)),
      );
      const worktreePath = must(
        parseAbsolutePath(paths.worktreeDirectory(key.profileId, storageId)),
      );
      const createdAt = must(parseIsoTimestamp("2026-07-24T00:00:00.000Z"));
      const session = createReviewSession({
        key,
        pr: {
          headSha: key.headSha,
          baseSha: must(
            parseGitSha("fedcba9876543210fedcba9876543210fedcba98"),
          ),
          isDraft: false,
          isOpen: true,
        },
        patchPath,
        worktree: { path: worktreePath, headSha: key.headSha },
        createdAt,
      });
      const sessionId = session.id;
      await mkdir(paths.sessionDirectory(key.profileId, storageId), {
        recursive: true,
      });
      await writeFile(
        patchPath,
        [
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
      );
      await new ReviewSessionStore(paths).save(session);

      const loaded = await new ReviewDiffSourceService(
        profiles,
        new ReviewSessionStore(paths),
        new SourceGit({ base: "\0", head: "\0" }),
      ).load({ profileId: "cfw", sessionId, path: "src/example.ts" });

      expect(loaded).toEqual({
        _tag: "ok",
        value: { state: "unavailable", reason: "binary" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects blobs whose text does not match the saved immutable patch", async () => {
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
      await new ProfileStore(paths).save(profile);
      const key = {
        profileId: profile.id,
        host: must(parseGitHubHost("github.com")),
        owner: must(parseGitHubOwner("centraldigital")),
        repo: must(parseGitHubRepoName("patchdesk")),
        prNumber: must(parsePullRequestNumber(42)),
        headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
        baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
      };
      const sessionId =
        // SAFETY: This deterministic session ID is a well-formed fixture for the storage seam.
        "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab" as never;
      const patchPath = must(
        parseAbsolutePath(paths.patchFile(key.profileId, sessionId)),
      );
      const worktreePath = must(
        parseAbsolutePath(paths.worktreeDirectory(key.profileId, sessionId)),
      );
      const session = createReviewSession({
        key,
        pr: {
          headSha: key.headSha,
          baseSha: must(
            parseGitSha("fedcba9876543210fedcba9876543210fedcba98"),
          ),
          isDraft: false,
          isOpen: true,
        },
        patchPath,
        worktree: { path: worktreePath, headSha: key.headSha },
        createdAt: must(parseIsoTimestamp("2026-07-24T00:00:00.000Z")),
      });
      await mkdir(paths.sessionDirectory(key.profileId, sessionId), {
        recursive: true,
      });
      await writeFile(
        patchPath,
        [
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
      );
      await new ReviewSessionStore(paths).save(session);

      const loaded = await new ReviewDiffSourceService(
        new ProfileStore(paths),
        new ReviewSessionStore(paths),
        new SourceGit({ base: "before\n", head: "different\n" }),
      ).load({
        profileId: "cfw",
        sessionId: session.id,
        path: "src/example.ts",
      });

      expect(loaded).toEqual({
        _tag: "ok",
        value: { state: "unavailable", reason: "patch_unavailable" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects blobs with mismatched trailing unchanged context", async () => {
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
      const profiles = new ProfileStore(paths);
      const sessions = new ReviewSessionStore(paths);
      await profiles.save(profile);
      const session = await saveSession({
        paths,
        sessions,
        profileId: profile.id,
        number: 43,
        patch: [
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -2,1 +2,2 @@",
          " unchanged",
          "+added",
          "",
        ].join("\n"),
      });

      for (const source of [
        {
          base: "first\nunchanged\nold tail one\nold tail two\n",
          head: "first\nunchanged\nadded\nnew tail\n",
        },
        {
          base: "first\nunchanged\nold tail\n",
          head: "first\nunchanged\nadded\nnew tail\n",
        },
      ]) {
        const loaded = await new ReviewDiffSourceService(
          profiles,
          sessions,
          new SourceGit(source),
        ).load({
          profileId: "cfw",
          sessionId: session.id,
          path: "src/example.ts",
        });

        expect(loaded).toEqual({
          _tag: "ok",
          value: { state: "unavailable", reason: "patch_unavailable" },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("hydrates new and deleted files without reading an absent source side", async () => {
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
      const profiles = new ProfileStore(paths);
      const sessions = new ReviewSessionStore(paths);
      await profiles.save(profile);
      const newSession = await saveSession({
        paths,
        sessions,
        profileId: profile.id,
        number: 44,
        patch: [
          "diff --git a/src/new.ts b/src/new.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/new.ts",
          "@@ -0,0 +1 @@",
          "+new file",
          "",
        ].join("\n"),
      });
      const newGit = new SourceGit({
        base: "must not read base\n",
        head: "new file\n",
      });
      const newLoaded = await new ReviewDiffSourceService(
        profiles,
        sessions,
        newGit,
      ).load({
        profileId: "cfw",
        sessionId: newSession.id,
        path: "src/new.ts",
      });
      expect(newLoaded).toEqual({
        _tag: "ok",
        value: {
          state: "ready",
          newFile: { name: "src/new.ts", contents: "new file\n" },
        },
      });
      expect(newGit.calls).toHaveLength(1);
      expect(newGit.calls.flat()).not.toContain("merge-base");

      const deletedSession = await saveSession({
        paths,
        sessions,
        profileId: profile.id,
        number: 45,
        patch: [
          "diff --git a/src/deleted.ts b/src/deleted.ts",
          "deleted file mode 100644",
          "--- a/src/deleted.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-deleted file",
          "",
        ].join("\n"),
      });
      const deletedGit = new SourceGit({
        base: "deleted file\n",
        head: "must not read head\n",
      });
      const deletedLoaded = await new ReviewDiffSourceService(
        profiles,
        sessions,
        deletedGit,
      ).load({
        profileId: "cfw",
        sessionId: deletedSession.id,
        path: "src/deleted.ts",
      });
      expect(deletedLoaded).toEqual({
        _tag: "ok",
        value: {
          state: "ready",
          oldFile: { name: "src/deleted.ts", contents: "deleted file\n" },
        },
      });
      expect(deletedGit.calls).toHaveLength(2);
      expect(deletedGit.calls.flat()).toContain("merge-base");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

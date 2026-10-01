import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  createReviewSessionId,
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
import { CommandRunner } from "../../src/adapters/github/command-runner";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import { ReviewDiffSourceService } from "../../src/services/review-diff-source-service";
import {
  ReviewWorktreeService,
  type GitReadExecutor,
} from "../../src/services/review-worktree-service";
import { ok } from "../../src/domain/result";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  profileId as localProfileId,
} from "./local-apply-fixture";

function must<T>(
  value: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" },
): T {
  if (value._tag === "err") throw new Error("fixture parse failed");
  return value.value;
}

function fixtureProfile() {
  return must(
    parseWorkspaceProfileConfig({
      id: "acme",
      label: "ACME",
      githubHost: "github.com",
      ghAccount: "fixture",
      rulePaths: [],
      repos: [],
    }),
  );
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

/** Stands in for the worktree owner in tests whose fake git never needs a checkout on disk. */
const restoredWorktrees = {
  restoreMissingWorktree: async () => ok(undefined),
};

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
    owner: must(parseGitHubOwner("octo-org")),
    repo: must(parseGitHubRepoName("patchdesk")),
    source: {
      kind: "pull_request" as const,
      prNumber: must(parsePullRequestNumber(input.number)),
    },
    baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
    headSha: must(
      parseGitSha(
        `${input.number.toString(16).padStart(2, "0")}${"a".repeat(38)}`,
      ),
    ),
  };
  const storageId =
    // SAFETY: This deterministic session ID is a well-formed fixture for the storage seam.
    `github.com__octo-org__patchdesk__pr-${input.number}__sha-${input.number.toString(16).padStart(8, "0")}__0123456789ab` as never;
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
      const profile = fixtureProfile();
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
        restoredWorktrees,
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
          profileId: "acme",
          sessionId: session.id,
          path: "src/example.ts",
        });
      expect(reads).toBe(9);
      await service.load({
        profileId: "acme",
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
        profileId: "acme",
        sessionId: oversized.id,
        path: "src/example.ts",
      });
      await service.load({
        profileId: "acme",
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
      const profile = fixtureProfile();
      const profileStore = new ProfileStore(paths);
      await profileStore.save(profile);
      const key = {
        profileId: must(parseWorkspaceProfileId("acme")),
        host: must(parseGitHubHost("github.com")),
        owner: must(parseGitHubOwner("octo-org")),
        repo: must(parseGitHubRepoName("patchdesk")),
        source: {
          kind: "pull_request" as const,
          prNumber: must(parsePullRequestNumber(42)),
        },
        headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
        baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
      };
      const storageId =
        // SAFETY: This deterministic session ID is a well-formed fixture for the storage seam.
        "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab" as never;
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
        restoredWorktrees,
        {
          stat: async (path) => await stat(path),
          read: async (path) => {
            patchReads += 1;
            return await readFile(path, "utf8");
          },
        },
      );
      const loaded = await service.load({
        profileId: "acme",
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
          `refs/patchdesk/reviews/acme/${sessionId}/base`,
          `refs/patchdesk/reviews/acme/${sessionId}/head`,
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
          `refs/patchdesk/reviews/acme/${sessionId}/head:src/example.ts`,
        ],
      ]);
      expect(git.calls.flat()).not.toContain("gh");
      await service.load({
        profileId: "acme",
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
        profileId: "acme",
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
      const profile = fixtureProfile();
      const profiles = new ProfileStore(paths);
      await profiles.save(profile);
      const key = {
        profileId: profile.id,
        host: must(parseGitHubHost("github.com")),
        owner: must(parseGitHubOwner("octo-org")),
        repo: must(parseGitHubRepoName("patchdesk")),
        source: {
          kind: "pull_request" as const,
          prNumber: must(parsePullRequestNumber(42)),
        },
        headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
        baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
      };
      const storageId =
        // SAFETY: This deterministic session ID is a well-formed fixture for the storage seam.
        "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab" as never;
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
        restoredWorktrees,
      ).load({ profileId: "acme", sessionId, path: "src/example.ts" });

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
      const profile = fixtureProfile();
      await new ProfileStore(paths).save(profile);
      const key = {
        profileId: profile.id,
        host: must(parseGitHubHost("github.com")),
        owner: must(parseGitHubOwner("octo-org")),
        repo: must(parseGitHubRepoName("patchdesk")),
        source: {
          kind: "pull_request" as const,
          prNumber: must(parsePullRequestNumber(42)),
        },
        headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
        baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
      };
      const sessionId =
        // SAFETY: This deterministic session ID is a well-formed fixture for the storage seam.
        "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab" as never;
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
        restoredWorktrees,
      ).load({
        profileId: "acme",
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
      const profile = fixtureProfile();
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
          restoredWorktrees,
        ).load({
          profileId: "acme",
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
      const profile = fixtureProfile();
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
        restoredWorktrees,
      ).load({
        profileId: "acme",
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
        restoredWorktrees,
      ).load({
        profileId: "acme",
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

describe("ReviewDiffSourceService on a shared local Review's patch views (#556)", () => {
  afterEach(cleanupLocalApplyRoots);

  it.each([
    {
      view: "committed",
      oldContents: "one\n",
      newContents: "one\ncommitted\n",
    },
    {
      view: "uncommitted",
      oldContents: "one\ncommitted\n",
      newContents: "one\ncommitted\nuncommitted\n",
    },
  ])(
    "hydrates $view from its own two trees in the Patchdesk worktree, never the checkout",
    async ({ view, oldContents, newContents }) => {
      const harness = await localApplyHarness();
      const { repositoryPath } = harness;
      git(repositoryPath, "checkout", "-q", "-b", "feature");
      await writeFile(join(repositoryPath, "tracked.txt"), "one\ncommitted\n");
      git(repositoryPath, "commit", "-q", "-am", "feature");
      await writeFile(
        join(repositoryPath, "tracked.txt"),
        "one\ncommitted\nuncommitted\n",
      );
      const opened = await harness.open();
      await writeFile(join(repositoryPath, "tracked.txt"), "edited later\n");
      const realGit = createReadOnlyGitExecutor(new CommandRunner());
      const calls: Array<ReadonlyArray<string>> = [];
      const sessions = new ReviewSessionStore(harness.paths);
      const service = new ReviewDiffSourceService(
        new ProfileStore(harness.paths),
        sessions,
        {
          run: (argv, environment) => {
            calls.push(argv);
            return realGit.run(argv, environment);
          },
        },
        restoredWorktrees,
      );

      const loaded = await service.load({
        profileId: localProfileId,
        sessionId: opened.session.id,
        path: "tracked.txt",
        view,
      });

      expect(loaded).toEqual({
        _tag: "ok",
        value: {
          state: "ready",
          oldFile: { name: "tracked.txt", contents: oldContents },
          newFile: { name: "tracked.txt", contents: newContents },
        },
      });
      const session = must(
        await sessions.load(localProfileId, opened.session.id),
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const argv of calls) {
        expect(argv.slice(0, 3)).toEqual(["git", "-C", session.worktree.path]);
      }
      expect(session.worktree.path).not.toBe(repositoryPath);
    },
  );

  it("re-creates a deleted local Review worktree before reading from it (#616)", async () => {
    const harness = await localApplyHarness();
    await writeFile(join(harness.repositoryPath, "tracked.txt"), "one\ntwo\n");
    const opened = await harness.open();
    const sessions = new ReviewSessionStore(harness.paths);
    const realGit = createReadOnlyGitExecutor(new CommandRunner());
    const service = new ReviewDiffSourceService(
      new ProfileStore(harness.paths),
      sessions,
      realGit,
      new ReviewWorktreeService(
        harness.paths,
        realGit,
        { environmentFor: async () => ok({}) },
        async () => undefined,
      ),
    );
    const session = must(
      await sessions.load(localProfileId, opened.session.id),
    );
    await rm(session.worktree.path, { recursive: true, force: true });

    const loaded = await service.load({
      profileId: localProfileId,
      sessionId: opened.session.id,
      path: "tracked.txt",
    });

    expect(loaded).toEqual({
      _tag: "ok",
      value: {
        state: "ready",
        oldFile: { name: "tracked.txt", contents: "one\n" },
        newFile: { name: "tracked.txt", contents: "one\ntwo\n" },
      },
    });
    expect((await stat(session.worktree.path)).isDirectory()).toBe(true);
  });
});

describe("ReviewDiffSourceService when the Review worktree is missing (#616)", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  /** A real repository with base and head commits pinned under the session's managed refs, and a worktree on disk. */
  async function reviewWithWorktree() {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-missing-worktree-"));
    roots.push(root);
    const repositoryPath = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repositoryPath]);
    await writeFile(join(repositoryPath, "example.txt"), "before\n");
    git(repositoryPath, "add", "example.txt");
    git(repositoryPath, "commit", "-q", "-m", "base");
    const baseSha = must(
      parseGitSha(git(repositoryPath, "rev-parse", "HEAD").trim()),
    );
    await writeFile(join(repositoryPath, "example.txt"), "after\n");
    git(repositoryPath, "commit", "-q", "-am", "head");
    const headSha = must(
      parseGitSha(git(repositoryPath, "rev-parse", "HEAD").trim()),
    );
    const paths = PatchdeskPaths.forTest(join(root, "app"));
    const profileId = must(parseWorkspaceProfileId("acme"));
    const profiles = new ProfileStore(paths);
    await profiles.save(
      must(
        parseWorkspaceProfileConfig({
          id: "acme",
          label: "ACME",
          githubHost: "github.com",
          ghAccount: "fixture",
          rulePaths: [],
          repos: [
            {
              host: "github.com",
              owner: "octo-org",
              repo: "patchdesk",
              localPath: repositoryPath,
            },
          ],
        }),
      ),
    );
    const key = {
      profileId,
      host: must(parseGitHubHost("github.com")),
      owner: must(parseGitHubOwner("octo-org")),
      repo: must(parseGitHubRepoName("patchdesk")),
      source: {
        kind: "pull_request" as const,
        prNumber: must(parsePullRequestNumber(7)),
      },
      headSha,
      baseSha,
    };
    const sessionId = createReviewSessionId(key);
    const baseRef = `refs/patchdesk/reviews/acme/${sessionId}/base`;
    const headRef = `refs/patchdesk/reviews/acme/${sessionId}/head`;
    git(repositoryPath, "update-ref", baseRef, baseSha);
    git(repositoryPath, "update-ref", headRef, headSha);
    const worktreePath = paths.worktreeDirectory(profileId, sessionId);
    await mkdir(join(worktreePath, ".."), { recursive: true });
    git(repositoryPath, "worktree", "add", "--detach", worktreePath, headRef);
    const patchPath = must(
      parseAbsolutePath(paths.patchFile(profileId, sessionId)),
    );
    const session = createReviewSession({
      key,
      pr: { headSha, baseSha, isDraft: false, isOpen: true },
      patchPath,
      worktree: { path: must(parseAbsolutePath(worktreePath)), headSha },
      createdAt: must(parseIsoTimestamp("2026-07-24T00:00:00.000Z")),
    });
    await mkdir(paths.sessionDirectory(profileId, sessionId), {
      recursive: true,
    });
    await writeFile(
      patchPath,
      "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n",
    );
    const sessions = new ReviewSessionStore(paths);
    await sessions.save(session);
    const realGit = createReadOnlyGitExecutor(new CommandRunner());
    const service = new ReviewDiffSourceService(
      profiles,
      sessions,
      realGit,
      new ReviewWorktreeService(
        paths,
        realGit,
        { environmentFor: async () => ok({}) },
        async () => undefined,
      ),
    );
    return {
      service,
      repositoryPath,
      worktreePath,
      baseRef,
      headRef,
      load: () =>
        service.load({
          profileId: "acme",
          sessionId,
          path: "example.txt",
        }),
    };
  }

  const readyContents = {
    _tag: "ok",
    value: {
      state: "ready",
      oldFile: { name: "example.txt", contents: "before\n" },
      newFile: { name: "example.txt", contents: "after\n" },
    },
  };

  it("re-creates a deleted worktree from the session refs and reads Context from it", async () => {
    const review = await reviewWithWorktree();
    // Clear cache removes the directory without `git worktree remove`.
    await rm(review.worktreePath, { recursive: true, force: true });

    expect(await review.load()).toEqual(readyContents);

    expect((await stat(review.worktreePath)).isDirectory()).toBe(true);
    expect(
      await readFile(join(review.worktreePath, "example.txt"), "utf8"),
    ).toBe("after\n");
    const listed = git(
      review.repositoryPath,
      "worktree",
      "list",
      "--porcelain",
    );
    expect(listed.match(/^worktree /gm)).toHaveLength(2);
  });

  it("reads the same after the rebuild has already happened", async () => {
    const review = await reviewWithWorktree();
    await rm(review.worktreePath, { recursive: true, force: true });
    await review.load();

    expect(await review.load()).toEqual(readyContents);
  });

  it("names the missing worktree, not GitHub, when the session refs are gone too", async () => {
    const review = await reviewWithWorktree();
    await rm(review.worktreePath, { recursive: true, force: true });
    git(review.repositoryPath, "update-ref", "-d", review.baseRef);
    git(review.repositoryPath, "update-ref", "-d", review.headRef);

    expect(await review.load()).toEqual({
      _tag: "ok",
      value: { state: "unavailable", reason: "worktree_missing" },
    });
  });
});

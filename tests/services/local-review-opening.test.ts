import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { InsightStore } from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewArtifactStorage } from "../../src/adapters/storage/review-artifact-storage";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewWriteOperationStore } from "../../src/adapters/storage/review-write-operation-store";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitShaPrefix,
  parseIsoTimestamp,
  parseLocalBranchName,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";
import type { LocalReviewSourceRequest } from "../../src/domain/review-source";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import { LocalReviewOpening } from "../../src/services/local-review-opening";
import { LocalReviewRevisionService } from "../../src/services/local-review-revision-service";
import { LocalReviewSessionPreparation } from "../../src/services/local-review-session-preparation";
import { ReviewLifecycleGate } from "../../src/services/review-lifecycle-gate";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ReviewWorkbenchProjectionService } from "../../src/services/review-workbench-projection";
import { ReviewWorktreeService } from "../../src/services/review-worktree-service";

const roots: string[] = [];
const now = value(parseIsoTimestamp("2026-09-25T00:00:00.000Z"));
const profileId = value(parseWorkspaceProfileId("acme"));
const repository = {
  host: value(parseGitHubHost("github.com")),
  owner: value(parseGitHubOwner("octo-org")),
  repo: value(parseGitHubRepoName("patchdesk")),
};
const workingTree: LocalReviewSourceRequest = { kind: "working_tree" };

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

/** Runs git for fixture setup only; the code under test runs git through the production executor. */
function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

async function checkout(): Promise<{
  readonly root: string;
  readonly repositoryPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-local-review-"));
  roots.push(root);
  const repositoryPath = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "tracked.txt"), "one\n");
  git(repositoryPath, "add", "tracked.txt");
  git(repositoryPath, "commit", "-q", "-m", "root");
  return { root, repositoryPath };
}

async function opening(
  root: string,
  localPath: string | undefined,
  seams: {
    readonly coordinator?: ReviewOperationCoordinator;
    readonly onResolved?: () => void;
  } = {},
): Promise<LocalReviewOpening> {
  const paths = PatchdeskPaths.forTest(join(root, "app"));
  const profiles = new ProfileStore(paths);
  await profiles.save(
    value(
      parseWorkspaceProfileConfig({
        id: profileId,
        label: "ACME",
        githubHost: "github.com",
        ghAccount: "fixture",
        workspaceRoots: [],
        rulePaths: [],
        repos: localPath === undefined ? [] : [{ ...repository, localPath }],
      }),
    ),
  );
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const artifacts = new ReviewArtifactStorage(paths, () => now);
  const readOnlyGit = createReadOnlyGitExecutor(new CommandRunner());
  const preparation = new LocalReviewSessionPreparation({
    profiles,
    sessions,
    revisions: new LocalReviewRevisionService(readOnlyGit, paths),
    worktrees: new ReviewWorktreeService(
      paths,
      readOnlyGit,
      { environmentFor: async () => ok({}) },
      async () => undefined,
    ),
    artifacts,
    paths,
    lifecycleGate: new ReviewLifecycleGate(),
    now: () => now,
  });
  const projection = new ReviewWorkbenchProjectionService(
    profiles,
    sessions,
    reviews,
    new InsightStore(paths),
    paths,
    new ReviewWriteOperationStore(paths),
    new ViewedFilesStore(paths, { write: () => undefined }),
  );
  return new LocalReviewOpening(
    {
      resolve: async (request) => {
        const resolved = await preparation.resolve(request);
        seams.onResolved?.();
        return resolved;
      },
      prepare: (resolved) => preparation.prepare(resolved),
    },
    projection,
    {
      reviews,
      artifacts,
      coordinator: seams.coordinator ?? new ReviewOperationCoordinator(),
    },
    () => now,
  );
}

function indexBytes(repositoryPath: string): Promise<Buffer> {
  return readFile(join(repositoryPath, ".git", "index"));
}

describe("LocalReviewOpening", () => {
  it("shows an untracked file in the working-tree patch without writing the maintainer's index", async () => {
    const { root, repositoryPath } = await checkout();
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");
    await writeFile(join(repositoryPath, "untracked.txt"), "new file\n");
    // `git status` refreshes the index, so it runs before the bytes are read.
    const statusBefore = git(repositoryPath, "status", "--porcelain");
    const indexBefore = await indexBytes(repositoryPath);

    const opened = await (
      await opening(root, repositoryPath)
    ).open({ profileId, repository, request: workingTree });

    const projection = value(opened);
    expect(projection.session.key.source).toEqual({
      kind: "working_tree",
      branch: "main",
    });
    expect(projection.fullPatch).toContain("+++ b/untracked.txt");
    expect(projection.fullPatch).toContain("+two");
    expect(projection.revision.freshness).toBe("fresh");
    expect(projection.pendingReview).toBeUndefined();
    expect(projection.analysisReviewActions).toBeUndefined();
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
    expect(git(repositoryPath, "status", "--porcelain")).toBe(statusBefore);
    // The head the session pins is reachable from its managed ref, not from any branch.
    expect(
      git(
        repositoryPath,
        "rev-parse",
        `refs/patchdesk/local/acme/${projection.session.id}/head`,
      ),
    ).toBe(projection.session.key.headSha);
    expect(git(repositoryPath, "branch", "--list")).toBe("* main");
  });

  it("lands unchanged content on the same session and an edit on a new one", async () => {
    const { root, repositoryPath } = await checkout();
    await writeFile(join(repositoryPath, "untracked.txt"), "first\n");
    const service = await opening(root, repositoryPath);
    const open = async () =>
      value(
        await service.open({ profileId, repository, request: workingTree }),
      );

    const first = await open();
    const unchanged = await open();
    await writeFile(join(repositoryPath, "untracked.txt"), "second\n");
    const edited = await open();

    expect(unchanged.session.id).toBe(first.session.id);
    expect(unchanged.review.id).toBe(first.review.id);
    expect(edited.session.id).not.toBe(first.session.id);
    expect(edited.review.id).toBe(first.review.id);
    expect(edited.fullPatch).toContain("+second");
  });

  it("moves the Review to the checkout as it is once the Review lock is free", async () => {
    const { root, repositoryPath } = await checkout();
    await writeFile(join(repositoryPath, "untracked.txt"), "first\n");
    const coordinator = new ReviewOperationCoordinator();
    let resolvedOnce: () => void = () => undefined;
    const service = await opening(root, repositoryPath, {
      coordinator,
      onResolved: () => resolvedOnce(),
    });
    const reviewId = value(
      await service.open({ profileId, repository, request: workingTree }),
    ).review.id;
    let releaseLock: () => void = () => undefined;
    const held = coordinator.withReviewLock(
      profileId,
      reviewId,
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve;
        }),
    );
    const unlockedReadDone = new Promise<void>((resolve) => {
      resolvedOnce = resolve;
    });

    const waiting = service.open({
      profileId,
      repository,
      request: workingTree,
    });
    await unlockedReadDone;
    // The checkout changes after the unlocked read, while this open waits for the lock.
    await writeFile(join(repositoryPath, "untracked.txt"), "second\n");
    releaseLock();
    await held;
    const opened = value(await waiting);

    expect(opened.fullPatch).toContain("+second");
    expect(opened.fullPatch).not.toContain("+first");
  });

  it("writes a/ and b/ paths with no colour whatever the maintainer's diff config says", async () => {
    const { root, repositoryPath } = await checkout();
    git(repositoryPath, "config", "diff.noprefix", "true");
    git(repositoryPath, "config", "color.diff", "always");
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");

    const patch = value(
      await (
        await opening(root, repositoryPath)
      ).open({ profileId, repository, request: workingTree }),
    ).fullPatch;

    expect(patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(patch).toContain("+++ b/tracked.txt");
    expect(patch).not.toContain("\u001b");
  });

  it("records a same-size edit that git can only detect by content", async () => {
    const { root, repositoryPath } = await checkout();
    // With ctime ignored, an edit that keeps a file's size and mtime is found only by
    // git's racy-entry check, which trusts the index file's own mtime.
    git(repositoryPath, "config", "core.trustctime", "false");
    const tracked = join(repositoryPath, "tracked.txt");
    const indexed = await stat(tracked);
    await writeFile(tracked, "two\n");
    await utimes(tracked, indexed.atime, indexed.mtime);
    await utimes(
      join(repositoryPath, ".git", "index"),
      indexed.atime,
      indexed.mtime,
    );

    const patch = value(
      await (
        await opening(root, repositoryPath)
      ).open({ profileId, repository, request: workingTree }),
    ).fullPatch;

    expect(patch).toContain("+two");
  });

  it("refuses a working tree whose index holds a merge conflict", async () => {
    const { root, repositoryPath } = await checkout();
    git(repositoryPath, "checkout", "-q", "-b", "other");
    await writeFile(join(repositoryPath, "tracked.txt"), "other\n");
    git(repositoryPath, "commit", "-q", "-am", "other");
    git(repositoryPath, "checkout", "-q", "main");
    await writeFile(join(repositoryPath, "tracked.txt"), "main\n");
    git(repositoryPath, "commit", "-q", "-am", "main");
    expect(() => git(repositoryPath, "merge", "-q", "other")).toThrow();
    const indexBefore = await indexBytes(repositoryPath);

    const opened = await (
      await opening(root, repositoryPath)
    ).open({ profileId, repository, request: workingTree });

    expect(opened).toEqual({
      _tag: "err",
      error: { reason: "unmerged_index" },
    });
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
  });

  it("compares a root commit with the empty tree", async () => {
    const { root, repositoryPath } = await checkout();
    const rootSha = git(repositoryPath, "rev-parse", "HEAD");

    const opened = await (
      await opening(root, repositoryPath)
    ).open({
      profileId,
      repository,
      request: {
        kind: "commit",
        commit: value(parseGitShaPrefix(rootSha.slice(0, 7))),
      },
    });

    const projection = value(opened);
    expect(projection.session.key.source).toEqual({
      kind: "commit",
      commitSha: rootSha,
    });
    expect(projection.fullPatch).toContain("new file mode");
    expect(projection.fullPatch).toContain("+one");
  });

  it("refuses a commit prefix that git resolves to a branch of the same name", async () => {
    const { root, repositoryPath } = await checkout();
    const rootSha = git(repositoryPath, "rev-parse", "HEAD");
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");
    git(repositoryPath, "commit", "-q", "-am", "second");
    const prefix = rootSha.slice(0, 7);
    git(repositoryPath, "branch", prefix, "HEAD");

    const opened = await (
      await opening(root, repositoryPath)
    ).open({
      profileId,
      repository,
      request: { kind: "commit", commit: value(parseGitShaPrefix(prefix)) },
    });

    expect(opened).toEqual({
      _tag: "err",
      error: { reason: "revision_not_found" },
    });
  });

  it("compares a branch with its merge base, not with the base branch tip", async () => {
    const { root, repositoryPath } = await checkout();
    git(repositoryPath, "checkout", "-q", "-b", "feature/local");
    await writeFile(join(repositoryPath, "feature.txt"), "feature\n");
    git(repositoryPath, "add", "feature.txt");
    git(repositoryPath, "commit", "-q", "-m", "feature");
    git(repositoryPath, "checkout", "-q", "main");
    await writeFile(join(repositoryPath, "main-only.txt"), "main\n");
    git(repositoryPath, "add", "main-only.txt");
    git(repositoryPath, "commit", "-q", "-m", "main moves on");

    const opened = await (
      await opening(root, repositoryPath)
    ).open({
      profileId,
      repository,
      request: {
        kind: "branch",
        branch: value(parseLocalBranchName("feature/local")),
        baseBranch: value(parseLocalBranchName("main")),
      },
    });

    const patch = value(opened).fullPatch;
    expect(patch).toContain("+++ b/feature.txt");
    expect(patch).not.toContain("main-only.txt");
  });

  it("refuses a repository that is not in the profile", async () => {
    const { root, repositoryPath } = await checkout();
    await writeFile(join(repositoryPath, "untracked.txt"), "new\n");

    const opened = await (
      await opening(root, undefined)
    ).open({ profileId, repository, request: workingTree });

    expect(opened).toEqual({
      _tag: "err",
      error: { reason: "repository_not_local" },
    });
  });
});

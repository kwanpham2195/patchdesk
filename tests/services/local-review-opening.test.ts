import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { InsightStore } from "../../src/adapters/storage/insight-store";
import { LocalApplyOperationStore } from "../../src/adapters/storage/local-apply-operation-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewArtifactStorage } from "../../src/adapters/storage/review-artifact-storage";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewWriteOperationStore } from "../../src/adapters/storage/review-write-operation-store";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitShaPrefix,
  parseIsoTimestamp,
  parseLocalBranchName,
  parseReviewId,
  parseReviewSessionId,
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
import type {
  UntrackedFileSize,
  UntrackedLimits,
} from "../../src/services/local-untracked-size";
import {
  ReviewWorktreeService,
  type GitReadExecutor,
} from "../../src/services/review-worktree-service";

const roots: string[] = [];
const now = value(parseIsoTimestamp("2026-09-25T00:00:00.000Z"));
const profileId = value(parseWorkspaceProfileId("acme"));
const repository = {
  host: value(parseGitHubHost("github.com")),
  owner: value(parseGitHubOwner("octo-org")),
  repo: value(parseGitHubRepoName("patchdesk")),
};
/** The shared Review against `main`; on `main` it shows the checkout's changes against `HEAD`. */
const sharedAgainstMain: LocalReviewSourceRequest = {
  kind: "local_branch",
  baseBranch: value(parseLocalBranchName("main")),
};

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
    readonly untrackedLimits?: UntrackedLimits;
    readonly untrackedFileSize?: UntrackedFileSize;
    /** Stands in for git answers the fixture cannot produce cheaply, such as output over the cap. */
    readonly git?: (git: GitReadExecutor) => GitReadExecutor;
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
  const productionGit = createReadOnlyGitExecutor(new CommandRunner());
  const readOnlyGit = seams.git?.(productionGit) ?? productionGit;
  const preparation = new LocalReviewSessionPreparation({
    profiles,
    sessions,
    revisions: new LocalReviewRevisionService(
      readOnlyGit,
      paths,
      seams.untrackedLimits,
      seams.untrackedFileSize,
    ),
    worktrees: new ReviewWorktreeService(
      paths,
      readOnlyGit,
      { environmentFor: async () => ok({}) },
      async () => undefined,
    ),
    artifacts,
    paths,
    git: readOnlyGit,
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
    new LocalApplyOperationStore(paths),
  );
  return new LocalReviewOpening(
    {
      resolve: async (request) => {
        const resolved = await preparation.resolve(request);
        seams.onResolved?.();
        return resolved;
      },
      prepare: (resolved) => preparation.prepare(resolved),
      listCheckouts: (id, target) => preparation.listCheckouts(id, target),
      listBranches: (id, target, checkout) =>
        preparation.listBranches(id, target, checkout),
      findCheckout: (id, directory) => preparation.findCheckout(id, directory),
      readCommitFiles: (session, commitSha, paths) =>
        preparation.readCommitFiles(session, commitSha, paths),
    },
    projection,
    {
      reviews,
      artifacts,
      coordinator: seams.coordinator ?? new ReviewOperationCoordinator(),
      // Retention has its own suite; these scenarios open one session each.
      retention: { pruneSuperseded: async () => ok(undefined) },
      applySettlement: { settleEarlierSession: async () => undefined },
    },
    () => now,
  );
}

function indexBytes(repositoryPath: string): Promise<Buffer> {
  return readFile(join(repositoryPath, ".git", "index"));
}

/** A file size reader that records every path it is asked about and answers 1 byte. */
function recordingFileSize() {
  const paths: string[] = [];
  const read: UntrackedFileSize = async (path) => {
    paths.push(path);
    return 1;
  };
  return { read, paths };
}

/** Untracked files in `node_modules/` (four), `generated/` (two), and `notes.txt`, none ignored. */
async function writeUntrackedTree(repositoryPath: string): Promise<void> {
  await mkdir(join(repositoryPath, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(repositoryPath, "generated"));
  for (const name of ["a.js", "b.js", "c.js", "d.js"])
    await writeFile(join(repositoryPath, "node_modules", "pkg", name), name);
  await writeFile(join(repositoryPath, "generated", "app.js"), "bundle\n");
  await writeFile(join(repositoryPath, "generated", "app.css"), "styles\n");
  await writeFile(join(repositoryPath, "notes.txt"), "notes\n");
}

describe("LocalReviewOpening", () => {
  it("shows an untracked file in the shared Review's patch without writing the maintainer's index", async () => {
    const { root, repositoryPath } = await checkout();
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");
    await writeFile(join(repositoryPath, "untracked.txt"), "new file\n");
    // `git status` refreshes the index, so it runs before the bytes are read.
    const statusBefore = git(repositoryPath, "status", "--porcelain");
    const indexBefore = await indexBytes(repositoryPath);

    const opened = await (
      await opening(root, repositoryPath)
    ).open({ profileId, repository, request: sharedAgainstMain });

    const projection = value(opened);
    expect(projection.session.key.source).toEqual({
      kind: "local_branch",
      branch: "main",
      baseBranch: "main",
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
        await service.open({
          profileId,
          repository,
          request: sharedAgainstMain,
        }),
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

  it("records the open on the Review so the sidebar can order and date it", async () => {
    const { root, repositoryPath } = await checkout();
    const service = await opening(root, repositoryPath);

    const opened = value(
      await service.open({ profileId, repository, request: sharedAgainstMain }),
    );

    const stored = value(
      await new ReviewStore(PatchdeskPaths.forTest(join(root, "app"))).load(
        profileId,
        value(parseReviewId(opened.review.id)),
      ),
    );
    expect(stored.lastOpenedAt).toBe(now);
  });

  it("refuses to reopen a shared Review after a branch switch, creating nothing", async () => {
    const { root, repositoryPath } = await checkout();
    const service = await opening(root, repositoryPath);
    value(
      await service.open({ profileId, repository, request: sharedAgainstMain }),
    );
    const reviews = new ReviewStore(PatchdeskPaths.forTest(join(root, "app")));
    const refsBefore = git(repositoryPath, "for-each-ref", "refs/patchdesk");
    git(repositoryPath, "checkout", "-q", "-b", "other");

    const reopened = await service.open({
      profileId,
      repository,
      request: {
        ...sharedAgainstMain,
        expectedHead: {
          kind: "branch",
          branch: value(parseLocalBranchName("main")),
        },
      },
    });

    expect(reopened).toEqual({
      _tag: "err",
      error: { reason: "branch_mismatch", currentBranch: "other" },
    });
    expect(value(await reviews.list(profileId)).reviews).toHaveLength(1);
    expect(git(repositoryPath, "for-each-ref", "refs/patchdesk")).toBe(
      refsBefore,
    );
  });

  it("reopens the first branch's shared Review on switching back after opening another branch's", async () => {
    const { root, repositoryPath } = await checkout();
    const service = await opening(root, repositoryPath);
    const onMain = value(
      await service.open({ profileId, repository, request: sharedAgainstMain }),
    );
    git(repositoryPath, "checkout", "-q", "-b", "other");
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");
    const onOther = value(
      await service.open({ profileId, repository, request: sharedAgainstMain }),
    );
    git(repositoryPath, "checkout", "-q", "main");

    // The sidebar row's open names no branch (#479), so the checkout decides which Review opens.
    const back = value(
      await service.open({ profileId, repository, request: sharedAgainstMain }),
    );

    expect(onOther.review.id).not.toBe(onMain.review.id);
    expect(back.review.id).toBe(onMain.review.id);
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
      await service.open({ profileId, repository, request: sharedAgainstMain }),
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
      request: sharedAgainstMain,
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
      ).open({ profileId, repository, request: sharedAgainstMain }),
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
      ).open({ profileId, repository, request: sharedAgainstMain }),
    ).fullPatch;

    expect(patch).toContain("+two");
  });

  it("refuses a shared Review whose checkout index holds a merge conflict", async () => {
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
    ).open({ profileId, repository, request: sharedAgainstMain });

    expect(opened).toEqual({
      _tag: "err",
      error: { reason: "unmerged_index" },
    });
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
  });

  it("refuses untracked files over the file limit before hashing any, naming the largest untracked paths without reading a file size", async () => {
    const { root, repositoryPath } = await checkout();
    await writeUntrackedTree(repositoryPath);
    const objectsBefore = git(repositoryPath, "count-objects", "-v");
    const indexBefore = await indexBytes(repositoryPath);
    const fileSize = recordingFileSize();

    const opened = await (
      await opening(root, repositoryPath, {
        untrackedLimits: { files: 6, bytes: 1024 * 1024 },
        untrackedFileSize: fileSize.read,
      })
    ).open({ profileId, repository, request: sharedAgainstMain });

    expect(opened).toEqual({
      _tag: "err",
      error: {
        reason: "untracked_too_large",
        exceededLimit: "files",
        largestPaths: ["node_modules/", "generated/", "notes.txt"],
      },
    });
    expect(fileSize.paths).toEqual([]);
    expect(git(repositoryPath, "count-objects", "-v")).toBe(objectsBefore);
    expect(await indexBytes(repositoryPath)).toEqual(indexBefore);
  });

  it("refuses untracked files over the size limit, ranking the largest untracked paths by bytes", async () => {
    const { root, repositoryPath } = await checkout();
    await writeUntrackedTree(repositoryPath);
    // 100 bytes outweigh the four files of node_modules/ (16 bytes) and the two of generated/ (13).
    await writeFile(join(repositoryPath, "notes.txt"), "n".repeat(100));
    const objectsBefore = git(repositoryPath, "count-objects", "-v");

    const opened = await (
      await opening(root, repositoryPath, {
        untrackedLimits: { files: 100, bytes: 64 },
      })
    ).open({ profileId, repository, request: sharedAgainstMain });

    expect(opened).toEqual({
      _tag: "err",
      error: {
        reason: "untracked_too_large",
        exceededLimit: "bytes",
        largestPaths: ["notes.txt", "node_modules/", "generated/"],
      },
    });
    expect(git(repositoryPath, "count-objects", "-v")).toBe(objectsBefore);
  });

  it("refuses a listing of untracked files over git's output cap, ranking that directory first", async () => {
    const { root, repositoryPath } = await checkout();
    await writeUntrackedTree(repositoryPath);
    const objectsBefore = git(repositoryPath, "count-objects", "-v");
    const overCap = (argv: ReadonlyArray<string>) =>
      argv.includes("--others") &&
      !argv.includes("--directory") &&
      !argv.includes(":(literal)generated/");
    const fileSize = recordingFileSize();

    const opened = await (
      await opening(root, repositoryPath, {
        untrackedFileSize: fileSize.read,
        git: (real) => ({
          run: async (argv, environment) =>
            overCap(argv)
              ? { _tag: "err", error: { _tag: "GitReadOutputExceeded" } }
              : real.run(argv, environment),
        }),
      })
    ).open({ profileId, repository, request: sharedAgainstMain });

    expect(opened).toEqual({
      _tag: "err",
      error: {
        reason: "untracked_too_large",
        exceededLimit: "files",
        largestPaths: ["node_modules/", "generated/"],
      },
    });
    expect(fileSize.paths).toEqual([]);
    expect(git(repositoryPath, "count-objects", "-v")).toBe(objectsBefore);
  });

  it("refuses a patch over git's output cap, naming the largest changed files and leaving no session, ref, or worktree", async () => {
    const { root, repositoryPath } = await checkout();
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");
    await mkdir(join(repositoryPath, "generated"));
    // Three MiB of short lines: over the 2 MiB cap, under the untracked limits.
    await writeFile(
      join(repositoryPath, "generated", "bundle.js"),
      "export const line = 0;\n".repeat(140_000),
    );

    const opened = await (
      await opening(root, repositoryPath)
    ).open({ profileId, repository, request: sharedAgainstMain });

    expect(opened).toEqual({
      _tag: "err",
      error: {
        reason: "patch_too_large",
        largestFiles: ["generated/bundle.js", "tracked.txt"],
      },
    });
    const paths = PatchdeskPaths.forTest(join(root, "app"));
    const sessions = await readdir(paths.profileReviewsDirectory(profileId), {
      recursive: true,
    }).catch(() => []);
    expect(sessions.filter((path) => path.endsWith("session.json"))).toEqual(
      [],
    );
    await expect(
      readdir(paths.profileWorkbenchesDirectory(profileId)),
    ).rejects.toThrow();
    expect(git(repositoryPath, "for-each-ref", "refs/patchdesk")).toBe("");
    const worktrees = git(repositoryPath, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(worktrees).toHaveLength(1);
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

  it("refuses a repository that is not in the profile", async () => {
    const { root, repositoryPath } = await checkout();
    await writeFile(join(repositoryPath, "untracked.txt"), "new\n");

    const opened = await (
      await opening(root, undefined)
    ).open({ profileId, repository, request: sharedAgainstMain });

    expect(opened).toEqual({
      _tag: "err",
      error: { reason: "repository_not_local" },
    });
  });
});

describe("LocalReviewOpening in a linked worktree (#489)", () => {
  async function linkedCheckout() {
    const fixture = await checkout();
    const linkedPath = join(fixture.root, "linked");
    git(
      fixture.repositoryPath,
      "worktree",
      "add",
      "-q",
      linkedPath,
      "-b",
      "feat",
    );
    return { ...fixture, linkedPath: await realpath(linkedPath) };
  }
  const sharedIn = (path: string): LocalReviewSourceRequest => ({
    ...sharedAgainstMain,
    checkout: value(parseAbsolutePath(path)),
  });

  it("opens the shared Review of each checkout as its own Review with its own session and ref", async () => {
    const { root, repositoryPath, linkedPath } = await linkedCheckout();
    await writeFile(join(repositoryPath, "main-change.txt"), "main\n");
    await writeFile(join(linkedPath, "linked-change.txt"), "linked\n");
    const service = await opening(root, repositoryPath);

    const configured = value(
      await service.open({ profileId, repository, request: sharedAgainstMain }),
    );
    const linked = value(
      await service.open({
        profileId,
        repository,
        request: sharedIn(linkedPath),
      }),
    );

    expect(linked.review.id).not.toBe(configured.review.id);
    expect(linked.session.key.source).toEqual({
      kind: "local_branch",
      branch: "feat",
      baseBranch: "main",
      checkout: linkedPath,
    });
    expect(configured.fullPatch).toContain("+++ b/main-change.txt");
    expect(configured.fullPatch).not.toContain("linked-change.txt");
    expect(linked.fullPatch).toContain("+++ b/linked-change.txt");
    expect(linked.fullPatch).not.toContain("main-change.txt");
    expect(
      git(
        repositoryPath,
        "for-each-ref",
        "--format=%(refname)",
        "refs/patchdesk/local",
      )
        .split("\n")
        .sort(),
    ).toEqual(
      [configured.session.id, linked.session.id]
        .map((id) => `refs/patchdesk/local/acme/${id}/head`)
        .sort(),
    );
    const paths = PatchdeskPaths.forTest(join(root, "app"));
    for (const opened of [configured, linked])
      expect(
        (
          await stat(
            paths.worktreeDirectory(
              profileId,
              value(parseReviewSessionId(opened.session.id)),
            ),
          )
        ).isDirectory(),
      ).toBe(true);
  });

  it("keys a subdirectory and a symlink of a checkout to that checkout's Review", async () => {
    const { root, repositoryPath, linkedPath } = await linkedCheckout();
    await mkdir(join(linkedPath, "nested"));
    await symlink(linkedPath, join(root, "alias"));
    const service = await opening(root, repositoryPath);
    const reviewIdIn = async (request: LocalReviewSourceRequest) =>
      value(await service.open({ profileId, repository, request })).review.id;

    const linked = await reviewIdIn(sharedIn(linkedPath));

    expect(await reviewIdIn(sharedIn(join(linkedPath, "nested")))).toBe(linked);
    expect(await reviewIdIn(sharedIn(join(root, "alias")))).toBe(linked);
  });

  it("keys the configured checkout named by path to the Review that names no checkout", async () => {
    const { root, repositoryPath } = await linkedCheckout();
    const service = await opening(root, repositoryPath);
    const reviewIdIn = async (request: LocalReviewSourceRequest) =>
      value(await service.open({ profileId, repository, request })).review.id;

    expect(await reviewIdIn(sharedIn(repositoryPath))).toBe(
      await reviewIdIn(sharedAgainstMain),
    );
  });

  it("refuses a directory outside the repository, a second clone, and a Patchdesk worktree", async () => {
    const { root, repositoryPath } = await linkedCheckout();
    const outside = join(root, "outside");
    await mkdir(outside);
    execFileSync("git", ["clone", "-q", repositoryPath, join(root, "clone")]);
    const service = await opening(root, repositoryPath);
    const cacheWorktree = PatchdeskPaths.forTest(
      join(root, "app"),
    ).worktreeDirectory(
      profileId,
      value(
        parseReviewSessionId(
          value(
            await service.open({
              profileId,
              repository,
              request: sharedAgainstMain,
            }),
          ).session.id,
        ),
      ),
    );

    for (const path of [outside, join(root, "clone"), cacheWorktree])
      expect(
        await service.open({
          profileId,
          repository,
          request: sharedIn(path),
        }),
      ).toEqual({ _tag: "err", error: { reason: "checkout_not_found" } });
  });

  it("lists the configured checkout and live linked worktrees, leaving out Patchdesk's worktrees and removed ones", async () => {
    const { root, repositoryPath, linkedPath } = await linkedCheckout();
    const detached = join(root, "detached");
    const removed = join(root, "removed");
    git(repositoryPath, "worktree", "add", "-q", "--detach", detached);
    git(repositoryPath, "worktree", "add", "-q", removed, "-b", "gone");
    await rm(removed, { recursive: true, force: true });
    const service = await opening(root, repositoryPath);
    value(
      await service.open({ profileId, repository, request: sharedAgainstMain }),
    );

    const listed = value(await service.listCheckouts(profileId, repository));

    expect(listed).toEqual([
      {
        path: await realpath(repositoryPath),
        head: { kind: "branch", branch: "main" },
        configured: true,
      },
      {
        path: await realpath(detached),
        head: { kind: "detached" },
        configured: false,
      },
      {
        path: linkedPath,
        head: { kind: "branch", branch: "feat" },
        configured: false,
      },
    ]);
  });
});

describe("LocalReviewOpening after the repository moved on disk (#488)", () => {
  async function movedCheckout() {
    const { root, repositoryPath } = await checkout();
    await writeFile(join(repositoryPath, "tracked.txt"), "two\n");
    const first = value(
      await (
        await opening(root, repositoryPath)
      ).open({ profileId, repository, request: sharedAgainstMain }),
    );
    const movedPath = join(root, "moved");
    await rename(repositoryPath, movedPath);
    return { root, repositoryPath, movedPath, first };
  }

  it("refuses open, Refresh, and the checkout listing with checkout_missing naming the configured path", async () => {
    const { root, repositoryPath, first } = await movedCheckout();
    const service = await opening(root, repositoryPath);
    const missing = {
      _tag: "err",
      error: { reason: "checkout_missing", localPath: repositoryPath },
    };

    const reopened = await service.open({
      profileId,
      repository,
      request: sharedAgainstMain,
    });
    const refreshed = await service.refresh(
      profileId,
      value(parseReviewId(first.review.id)),
    );
    const listed = await service.listCheckouts(profileId, repository);

    expect(reopened).toEqual(missing);
    expect(refreshed).toEqual(missing);
    expect(listed).toEqual(missing);
  });

  it("reopens the same Review and session once the path is updated, with its worktree readable by git again", async () => {
    const { root, movedPath, first } = await movedCheckout();

    const reopened = value(
      await (
        await opening(root, movedPath)
      ).open({ profileId, repository, request: sharedAgainstMain }),
    );

    expect(reopened.review.id).toBe(first.review.id);
    expect(reopened.session.id).toBe(first.session.id);
    const worktree = PatchdeskPaths.forTest(
      join(root, "app"),
    ).worktreeDirectory(
      profileId,
      value(parseReviewSessionId(reopened.session.id)),
    );
    expect(git(worktree, "rev-parse", "--git-common-dir")).toBe(
      join(await realpath(movedPath), ".git"),
    );
  });
});

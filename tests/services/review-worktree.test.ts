import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import type { GitHubCredentials } from "../../src/adapters/github/github-credentials";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import {
  ReviewWorktreeService,
  type GitReadExecutor,
} from "../../src/services/review-worktree-service";
import { err, ok } from "../../src/domain/result";

function must<T>(
  value: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" },
): T {
  if (value._tag === "err") throw new Error("fixture parse failed");
  return value.value;
}

class RecordingGit implements GitReadExecutor {
  readonly calls: Array<ReadonlyArray<string>> = [];
  readonly environments: Array<Readonly<Record<string, string>> | undefined> =
    [];
  fetchCount = 0;
  failFetchNumber?: number;
  failWorktreeAdd = false;
  async run(
    argv: ReadonlyArray<string>,
    environment?: Readonly<Record<string, string>>,
  ) {
    this.calls.push(argv);
    this.environments.push(environment);
    if (argv.includes("status"))
      return {
        _tag: "ok" as const,
        value: { stdout: " M dirty.ts\n?? untracked.ts\n" },
      };
    if (argv.includes("fetch")) {
      this.fetchCount += 1;
      if (this.fetchCount === this.failFetchNumber)
        return err({ _tag: "GitReadFailed" as const });
    }
    if (this.failWorktreeAdd && argv.includes("add"))
      return err({ _tag: "GitReadFailed" as const });
    return { _tag: "ok" as const, value: { stdout: "" } };
  }
}

const credentials: GitHubCredentials = {
  async environmentFor() {
    return ok({ GH_TOKEN: "profile-token" });
  },
  forget() {},
};

// Deliberately contains a space: Git runs the credential helper through
// `/bin/sh`, which splits an unquoted path and would resolve the wrong
// command. A realistic install directory proves the quoting holds.
const ghPath = "/opt/my tools/bin/gh";
const resolveGh = async (): Promise<string | undefined> => ghPath;

const ids = {
  profileId: must(parseWorkspaceProfileId("cfw")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  number: must(parsePullRequestNumber(42)),
  baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
  sha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
};

const profile: WorkspaceProfileConfig = {
  id: ids.profileId,
  label: "CFW",
  githubHost: ids.host,
  ghAccount: "profile-account",
  workspaceRoots: [],
  rulePaths: [],
  repos: [],
};

const sessionId = must(
  parseReviewSessionId(
    "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab",
  ),
);

describe("ReviewWorktreeService", () => {
  it("records a dirty primary checkout, fetches immutable managed refs, and never changes that checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const git = new RecordingGit();
      const service = new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        credentials,
        resolveGh,
      );
      const prepared = await service.prepare({
        ...ids,
        profile,
        sessionId,
        localPath: local,
      });

      expect(prepared).toMatchObject({
        _tag: "ok",
        value: { mode: "worktree", dirty: { tracked: true, untracked: true } },
      });
      const fetches = git.calls.filter((argv) => argv.includes("fetch"));
      expect(fetches).toHaveLength(2);
      // The helper string must carry `resolveGitHubCli`'s absolute path, not
      // a bare `gh`: Git spawns it via `/bin/sh` with the inherited PATH,
      // which a Finder-launched Electron app does not extend with Homebrew's
      // `bin`, so a bare `gh` is not reliably discoverable there.
      expect(fetches[0]).toEqual(
        expect.arrayContaining([
          `url.https://${ids.host}/.insteadOf=git@${ids.host}:`,
          `url.https://${ids.host}/.insteadOf=ssh://git@${ids.host}/`,
          `credential.https://${ids.host}.helper=`,
          `credential.https://${ids.host}.helper=!'${ghPath}' auth git-credential`,
          `${ids.baseSha}:refs/patchdesk/reviews/cfw/github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab/base`,
          "--no-tags",
        ]),
      );
      expect(fetches[1]).toEqual(
        expect.arrayContaining([
          `${ids.sha}:refs/patchdesk/reviews/cfw/github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab/head`,
        ]),
      );
      expect(
        git.environments.filter((environment) => environment !== undefined),
      ).toEqual([
        { GH_TOKEN: "profile-token", GIT_TERMINAL_PROMPT: "0" },
        { GH_TOKEN: "profile-token", GIT_TERMINAL_PROMPT: "0" },
      ]);
      expect(git.calls.flat()).not.toContain("profile-token");
      expect(git.calls.flat()).not.toContain("pull");
      expect(git.calls.flat()).not.toContain("checkout");
      expect(git.calls.flat()).not.toContain("clean");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a visible metadata-only outcome without a configured checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const prepared = await new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        new RecordingGit(),
        credentials,
        resolveGh,
      ).prepare({
        ...ids,
        profile,
        sessionId,
      });
      expect(prepared).toEqual({
        _tag: "ok",
        value: { mode: "metadata_only", warning: "missing_local_path" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to metadata-only when the base fetch fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const git = new RecordingGit();
      git.failFetchNumber = 1;
      const prepared = await new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        credentials,
        resolveGh,
      ).prepare({
        ...ids,
        profile,
        sessionId,
        localPath: local,
      });

      expect(prepared).toEqual({
        _tag: "ok",
        value: { mode: "metadata_only", warning: "local_checkout_unavailable" },
      });
      expect(git.calls.filter((argv) => argv.includes("update-ref"))).toEqual(
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes the partial base ref when the head fetch fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const git = new RecordingGit();
      git.failFetchNumber = 2;
      const prepared = await new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        credentials,
        resolveGh,
      ).prepare({
        ...ids,
        profile,
        sessionId,
        localPath: local,
      });

      expect(prepared).toMatchObject({
        _tag: "ok",
        value: { mode: "metadata_only", warning: "local_checkout_unavailable" },
      });
      expect(
        git.calls.some(
          (argv) =>
            argv.includes("update-ref") &&
            argv.at(-1) ===
              "refs/patchdesk/reviews/cfw/github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab/base",
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes both managed refs when worktree creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const git = new RecordingGit();
      git.failWorktreeAdd = true;
      const prepared = await new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        credentials,
        resolveGh,
      ).prepare({
        ...ids,
        profile,
        sessionId,
        localPath: local,
      });

      expect(prepared).toMatchObject({
        _tag: "ok",
        value: { mode: "metadata_only", warning: "local_checkout_unavailable" },
      });
      expect(
        git.calls.filter((argv) => argv.includes("update-ref")),
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not use the machine-wide account when the profile credential is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const requestedProfiles: string[] = [];
      const unavailable: GitHubCredentials = {
        async environmentFor(requested) {
          requestedProfiles.push(requested.ghAccount);
          return err({ _tag: "CommandAuthenticationRequired" });
        },
        forget() {},
      };
      const git = new RecordingGit();
      const prepared = await new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        unavailable,
        resolveGh,
      ).prepare({
        ...ids,
        profile,
        sessionId,
        localPath: local,
      });

      // An unavailable profile credential is an authentication failure, not
      // a reason to fall back to metadata-only (which would silently invite
      // a fetch under the machine-wide active account instead).
      expect(prepared).toMatchObject({
        _tag: "err",
        error: { _tag: "GitHubAuthenticationFailed" },
      });
      expect(requestedProfiles).toEqual(["profile-account"]);
      expect(git.calls.some((argv) => argv.includes("fetch"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses cleanup outside the cache root or through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const service = new ReviewWorktreeService(
        paths,
        new RecordingGit(),
        credentials,
        resolveGh,
      );
      const outside = join(root, "outside");
      await mkdir(outside);
      expect(
        await service.cleanup({
          ...ids,
          sessionId,
          localPath: outside,
          targetPath: outside,
        }),
      ).toMatchObject({
        _tag: "err",
        error: { _tag: "UnsafeWorktreeCleanup" },
      });
      const target = paths.worktreeDirectory(ids.profileId, sessionId);
      await mkdir(join(target, ".."), { recursive: true });
      await symlink(outside, target);
      expect(
        await service.cleanup({
          ...ids,
          sessionId,
          localPath: outside,
          targetPath: target,
        }),
      ).toMatchObject({
        _tag: "err",
        error: { _tag: "UnsafeWorktreeCleanup" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses cleanup when a resolved target's relative form reads as a Windows-absolute path", async () => {
    // What this proves: `cleanup` rejects a resolved target whose path,
    // relative to the cache root, reads as a Windows-absolute path — the
    // `win32.isAbsolute` check inside the shared `isPathContained`
    // predicate. This is NOT an escape test. The target built below is a
    // real directory placed directly inside the cache root, so its
    // relative form never carries a leading "..". The sanity assertion
    // near the end of this test proves that directly.
    //
    // An escape case (a target genuinely outside the cache root) cannot be
    // built on this platform. On POSIX, `path.relative` between any two
    // different absolute paths always returns a string that starts with
    // "..": confirmed over 300,000 random path pairs, plus targeted
    // cross-mount shapes. So the old
    // `relative(root, target).startsWith("..")` check was already correct
    // for a realpath'd target on POSIX. What that old check missed is the
    // case covered here: a target genuinely inside the cache root whose
    // name happens to read as a Windows drive path, reached through an
    // attacker-controlled ancestor symlink. This regression must fail
    // against the old `relative(root, target).startsWith("..")` check and
    // pass once `cleanup` uses the shared predicate.
    //
    // This fixture is POSIX-only: it needs a real directory literally
    // named `C:\evil`. Windows filesystems do not allow `:` or `\` in a
    // file name, so this directory cannot be created on a Windows runner.
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const local = join(root, "repo");
      await mkdir(local);
      const cacheDir = paths.cacheDirectory();
      await mkdir(cacheDir, { recursive: true });
      // A real directory, directly inside the cache root, whose name happens
      // to read as a Windows drive path. `relative(cacheDir, target)` for
      // anything inside it starts with this literal string, no ".." needed.
      const driveNamed = join(cacheDir, "C:\\evil");
      const realTarget = join(
        driveNamed,
        ids.profileId,
        "review-worktrees",
        sessionId,
      );
      await mkdir(realTarget, { recursive: true });
      await writeFile(
        join(realTarget, "worktree.json"),
        JSON.stringify({ profileId: ids.profileId, sessionId }),
        "utf8",
      );
      // Redirect the ordinary, expected "profiles" ancestor to the
      // drive-named directory. The final path component Patchdesk asks to
      // remove is never itself a symlink, so the existing symlink guard
      // (`lstat(...).isSymbolicLink()`) does not fire; only the containment
      // check below stands between this and `git worktree remove` + `rm`.
      await symlink(driveNamed, join(cacheDir, "profiles"));
      const target = paths.worktreeDirectory(ids.profileId, sessionId);

      // Sanity: prove the resolved target really is inside the cache root
      // (its relative form does not start with ".."), and that the
      // relative form is exactly the Windows-drive-shaped string this test
      // is about.
      const resolvedRoot = await realpath(cacheDir);
      const resolvedTarget = await realpath(target);
      const relation = relative(resolvedRoot, resolvedTarget);
      expect(relation.startsWith("..")).toBe(false);
      expect(relation).toBe(
        ["C:\\evil", ids.profileId, "review-worktrees", sessionId].join(sep),
      );

      const cleaned = await new ReviewWorktreeService(
        paths,
        new RecordingGit(),
        credentials,
        resolveGh,
      ).cleanup({
        profileId: ids.profileId,
        sessionId,
        localPath: local,
        targetPath: target,
      });

      expect(cleaned).toMatchObject({
        _tag: "err",
        error: { _tag: "UnsafeWorktreeCleanup" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes a stale registration before adding a fresh worktree for a missing target", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const git = new RecordingGit();
      const service = new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        credentials,
        resolveGh,
      );
      const prepared = await service.prepare({
        ...ids,
        profile,
        sessionId,
        localPath: local,
      });
      expect(prepared._tag).toBe("ok");

      const pruneIndex = git.calls.findIndex((argv) => argv.includes("prune"));
      const addIndex = git.calls.findIndex(
        (argv) => argv.includes("add") && argv.includes("worktree"),
      );
      expect(pruneIndex).toBeGreaterThan(-1);
      expect(addIndex).toBeGreaterThan(-1);
      expect(pruneIndex).toBeLessThan(addIndex);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes Patchdesk's worktree marker before asking Git to remove the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const local = join(root, "repo");
      const targetSessionId = sessionId;
      const target = paths.worktreeDirectory(ids.profileId, targetSessionId);
      await mkdir(local);
      await mkdir(target, { recursive: true });
      await writeFile(
        join(target, "worktree.json"),
        JSON.stringify({
          profileId: ids.profileId,
          sessionId: targetSessionId,
        }),
        "utf8",
      );

      const cleaned = await new ReviewWorktreeService(
        paths,
        new RecordingGit(),
        credentials,
        resolveGh,
      ).cleanup({
        profileId: ids.profileId,
        sessionId,
        localPath: local,
        targetPath: target,
      });

      expect(cleaned).toEqual({ _tag: "ok", value: undefined });
      await expect(access(join(target, "worktree.json"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when gh cannot be resolved, and never falls back to metadata-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const git = new RecordingGit();
      const prepared = await new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        credentials,
        async () => undefined,
      ).prepare({
        ...ids,
        profile,
        sessionId,
        localPath: local,
      });

      expect(prepared).toEqual({
        _tag: "err",
        error: { _tag: "GitHubAuthenticationFailed" },
      });
      expect(git.calls.some((argv) => argv.includes("fetch"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed and removes the worktree it created when the ownership marker cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const paths = PatchdeskPaths.forTest(root);
      const target = paths.worktreeDirectory(ids.profileId, sessionId);
      // A regular file already sitting at the worktree path makes the
      // in-branch `mkdir(path, { recursive: true })` throw exactly like a
      // real storage failure would, without depending on filesystem
      // permissions (which root ignores in CI).
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "not a directory", "utf8");
      const git = new RecordingGit();
      const service = new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        credentials,
        resolveGh,
      );

      const prepared = await service.prepare({
        ...ids,
        profile,
        sessionId,
        localPath: local,
      });

      expect(prepared).toEqual({
        _tag: "err",
        error: { _tag: "WorktreeStorageUnavailable" },
      });
      // The worktree registration this call created must not survive the
      // failure: a leaked `worktree.json`-less registration can never be
      // cleaned up later, since `cleanup` proves ownership through that marker.
      expect(
        git.calls.some(
          (argv) => argv.includes("worktree") && argv.includes("remove"),
        ),
      ).toBe(true);
      expect(
        git.calls.filter((argv) => argv.includes("update-ref")),
      ).toHaveLength(2);
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes an enterprise host's GH_ENTERPRISE_TOKEN environment straight through the managed fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const enterpriseHost = must(parseGitHubHost("ghe.example.com"));
      const enterpriseCredentials: GitHubCredentials = {
        async environmentFor() {
          return ok({ GH_ENTERPRISE_TOKEN: "enterprise-token" });
        },
        forget() {},
      };
      const git = new RecordingGit();
      const prepared = await new ReviewWorktreeService(
        PatchdeskPaths.forTest(root),
        git,
        enterpriseCredentials,
        resolveGh,
      ).prepare({
        ...ids,
        host: enterpriseHost,
        profile,
        sessionId,
        localPath: local,
      });

      expect(prepared).toMatchObject({
        _tag: "ok",
        value: { mode: "worktree" },
      });
      const fetches = git.calls.filter((argv) => argv.includes("fetch"));
      expect(fetches).toHaveLength(2);
      expect(fetches[0]).toEqual(
        expect.arrayContaining([
          `url.https://${enterpriseHost}/.insteadOf=git@${enterpriseHost}:`,
          `credential.https://${enterpriseHost}.helper=!'${ghPath}' auth git-credential`,
        ]),
      );
      expect(
        git.environments.filter((environment) => environment !== undefined),
      ).toEqual([
        { GH_ENTERPRISE_TOKEN: "enterprise-token", GIT_TERMINAL_PROMPT: "0" },
        { GH_ENTERPRISE_TOKEN: "enterprise-token", GIT_TERMINAL_PROMPT: "0" },
      ]);
      expect(git.calls.flat()).not.toContain("enterprise-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

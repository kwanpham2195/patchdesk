import { execFileSync } from "node:child_process";
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

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import type { GitHubCredentials } from "../../src/adapters/github/github-credentials";

/** All `ReviewWorktreeService` asks of a credential source. */
type WorktreeCredentials = Pick<GitHubCredentials, "environmentFor">;
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
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";

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
  failFetch = false;
  failWorktreeAdd = false;
  async run(
    argv: ReadonlyArray<string>,
    environment?: Readonly<Record<string, string>>,
  ) {
    this.calls.push(argv);
    this.environments.push(environment);
    if (this.failFetch && argv.includes("fetch"))
      return err({ _tag: "GitReadFailed" as const });
    if (this.failWorktreeAdd && argv.includes("add"))
      return err({ _tag: "GitReadFailed" as const });
    return { _tag: "ok" as const, value: { stdout: "" } };
  }
}

const credentials: WorktreeCredentials = {
  async environmentFor() {
    return ok({ GH_TOKEN: "profile-token" });
  },
};

// Deliberately contains a space: Git runs the credential helper through
// `/bin/sh`, which splits an unquoted path and would resolve the wrong
// command. A realistic install directory proves the quoting holds.
const ghPath = "/opt/my tools/bin/gh";
const resolveGh = async (): Promise<string | undefined> => ghPath;

const ids = {
  profileId: must(parseWorkspaceProfileId("acme")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo-org")),
  repo: must(parseGitHubRepoName("patchdesk")),
  number: must(parsePullRequestNumber(42)),
  baseSha: must(parseGitSha("fedcba9876543210fedcba9876543210fedcba98")),
  sha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
};

const profile: WorkspaceProfileConfig = {
  id: ids.profileId,
  label: "ACME",
  githubHost: ids.host,
  ghAccount: "profile-account",
  workspaceRoots: [],
  rulePaths: [],
  repos: [],
};

const sessionId = must(
  parseReviewSessionId(
    "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab",
  ),
);

describe("ReviewWorktreeService", () => {
  it("fetches immutable managed refs and never changes the primary checkout", async () => {
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
        value: { mode: "worktree" },
      });
      const fetches = git.calls.filter((argv) => argv.includes("fetch"));
      // Both refspecs ride one invocation: a second `git fetch` would spawn a
      // second `gh auth git-credential` helper for no extra work.
      expect(fetches).toHaveLength(1);
      // The helper string must carry `resolveGitHubCli`'s absolute path, not
      // a bare `gh`: Git spawns it via `/bin/sh` with the inherited PATH,
      // which a Finder-launched Electron app does not extend with Homebrew's
      // `bin`, so a bare `gh` is not reliably discoverable there.
      expect(fetches[0]).toEqual([
        "git",
        "-c",
        `url.https://${ids.host}/.insteadOf=git@${ids.host}:`,
        "-c",
        `url.https://${ids.host}/.insteadOf=ssh://git@${ids.host}/`,
        "-c",
        `credential.https://${ids.host}.helper=`,
        "-c",
        `credential.https://${ids.host}.helper=!'${ghPath}' auth git-credential`,
        "-C",
        await realpath(local),
        "fetch",
        "origin",
        `${ids.baseSha}:refs/patchdesk/reviews/acme/github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab/base`,
        `${ids.sha}:refs/patchdesk/reviews/acme/github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab/head`,
        "--no-tags",
      ]);
      expect(
        git.environments.filter((environment) => environment !== undefined),
      ).toEqual([{ GH_TOKEN: "profile-token", GIT_TERMINAL_PROMPT: "0" }]);
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

  it("deletes both managed refs when the combined fetch fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const git = new RecordingGit();
      git.failFetch = true;
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
      // One fetch carrying both refspecs can write one ref and still exit
      // nonzero on the other, and the exit status does not say which. Neither
      // ref may be left behind on the user's checkout.
      const managedRefs =
        "refs/patchdesk/reviews/acme/github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab";
      expect(
        git.calls
          .filter((argv) => argv.includes("update-ref"))
          .map((argv) => argv.at(-1)),
      ).toEqual([`${managedRefs}/base`, `${managedRefs}/head`]);
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
      const unavailable: WorktreeCredentials = {
        async environmentFor(requested) {
          requestedProfiles.push(requested.ghAccount);
          return err({ _tag: "CommandAuthenticationRequired" });
        },
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
      const enterpriseCredentials: WorktreeCredentials = {
        async environmentFor() {
          return ok({ GH_ENTERPRISE_TOKEN: "enterprise-token" });
        },
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
      expect(fetches).toHaveLength(1);
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
      ]);
      expect(git.calls.flat()).not.toContain("enterprise-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("cleanup with real git", () => {
    /** A one-commit repository and a local session worktree prepared from it by the production executor. */
    async function preparedLocalSession(root: string) {
      const local = join(root, "repo");
      execFileSync("git", ["init", "-q", "-b", "main", local]);
      await writeFile(join(local, "tracked.txt"), "one\n");
      fixtureGit(local, "add", "tracked.txt");
      fixtureGit(local, "commit", "-q", "-m", "root");
      const headSha = must(parseGitSha(fixtureGit(local, "rev-parse", "HEAD")));
      const paths = PatchdeskPaths.forTest(join(root, "app"));
      const service = new ReviewWorktreeService(
        paths,
        createReadOnlyGitExecutor(new CommandRunner()),
        credentials,
        resolveGh,
      );
      const prepared = await service.prepareLocal({
        profileId: ids.profileId,
        sessionId,
        localPath: local,
        headSha,
      });
      if (prepared._tag === "err") throw new Error("fixture prepare failed");
      return { local, service, target: prepared.value.path };
    }

    it("deletes the session's managed ref and Git's worktree record", async () => {
      const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
      try {
        const { local, service, target } = await preparedLocalSession(root);
        expect(managedRefs(local)).toHaveLength(1);

        const cleaned = await service.cleanup({
          profileId: ids.profileId,
          sessionId,
          localPath: local,
          targetPath: target,
        });

        expect(cleaned).toEqual({ _tag: "ok", value: undefined });
        expect(managedRefs(local)).toEqual([]);
        expect(worktreeCount(local)).toBe(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("keeps a listed managed ref that moved before it was deleted", async () => {
      const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
      try {
        const { local, service } = await preparedLocalSession(root);
        const listed = await service.listManagedRefs(ids.profileId, local);
        fixtureGit(local, "commit", "-q", "--allow-empty", "-m", "moved");
        const [ref] = managedRefs(local);
        if (ref === undefined) throw new Error("fixture ref missing");
        fixtureGit(local, "update-ref", ref, "HEAD");

        await service.deleteManagedRefs(local, listed ?? []);

        expect(listed).toHaveLength(1);
        expect(managedRefs(local)).toEqual([ref]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("never deletes a ref the marker names outside the session's own refs", async () => {
      const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
      try {
        const { local, service, target } = await preparedLocalSession(root);
        await writeFile(
          join(target, "worktree.json"),
          JSON.stringify({
            profileId: ids.profileId,
            sessionId,
            headRef: "refs/heads/main",
          }),
          "utf8",
        );

        const cleaned = await service.cleanup({
          profileId: ids.profileId,
          sessionId,
          localPath: local,
          targetPath: target,
        });

        expect(cleaned).toEqual({ _tag: "ok", value: undefined });
        expect(
          fixtureGit(local, "rev-parse", "--verify", "refs/heads/main"),
        ).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("worktree add with real git (#483)", () => {
    /** A one-commit repository whose post-checkout hook leaves `sentinel` beside it and fails. */
    async function repositoryWithCheckoutHook(root: string) {
      const local = join(root, "repo");
      execFileSync("git", ["init", "-q", "-b", "main", local]);
      await writeFile(join(local, "tracked.txt"), "one\n");
      fixtureGit(local, "add", "tracked.txt");
      fixtureGit(local, "commit", "-q", "-m", "root");
      const sentinel = join(root, "sentinel");
      await writeFile(
        join(local, ".git", "hooks", "post-checkout"),
        `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`,
        { mode: 0o755 },
      );
      const headSha = must(parseGitSha(fixtureGit(local, "rev-parse", "HEAD")));
      return { local, sentinel, headSha };
    }

    it("checks out a session without running the repository's hooks", async () => {
      const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
      try {
        const { local, sentinel, headSha } =
          await repositoryWithCheckoutHook(root);
        const service = new ReviewWorktreeService(
          PatchdeskPaths.forTest(join(root, "app")),
          createReadOnlyGitExecutor(new CommandRunner()),
          credentials,
          resolveGh,
        );

        const prepared = await service.prepareLocal({
          profileId: ids.profileId,
          sessionId,
          localPath: local,
          headSha,
        });

        expect(prepared._tag).toBe("ok");
        await expect(access(sentinel)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("removes the worktree an add left behind when it failed after checkout, so the next prepare succeeds", async () => {
      const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
      try {
        const { local, headSha } = await repositoryWithCheckoutHook(root);
        const realGit = createReadOnlyGitExecutor(new CommandRunner());
        let failAdd = true;
        // Git exits nonzero once the checkout exists, as a timed-out add does.
        const git: GitReadExecutor = {
          async run(argv, environment) {
            const ran = await realGit.run(argv, environment);
            return failAdd && argv.includes("worktree") && argv.includes("add")
              ? err({ _tag: "GitReadFailed" as const })
              : ran;
          },
        };
        const paths = PatchdeskPaths.forTest(join(root, "app"));
        const service = new ReviewWorktreeService(
          paths,
          git,
          credentials,
          resolveGh,
        );
        const input = {
          profileId: ids.profileId,
          sessionId,
          localPath: local,
          headSha,
        };

        const failed = await service.prepareLocal(input);

        expect(failed).toEqual({
          _tag: "err",
          error: { _tag: "GitWorktreeFailed" },
        });
        await expect(
          access(paths.worktreeDirectory(ids.profileId, sessionId)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(worktreeCount(local)).toBe(1);
        expect(managedRefs(local)).toEqual([]);

        failAdd = false;
        const retried = await service.prepareLocal(input);

        expect(retried).toEqual({
          _tag: "ok",
          value: { path: paths.worktreeDirectory(ids.profileId, sessionId) },
        });
        expect(worktreeCount(local)).toBe(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

/** Runs git for fixture setup and evidence only; the code under test runs git through the production executor. */
function fixtureGit(cwd: string, ...args: ReadonlyArray<string>): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

function managedRefs(local: string): ReadonlyArray<string> {
  const listed = fixtureGit(
    local,
    "for-each-ref",
    "--format=%(refname)",
    "refs/patchdesk/",
  );
  return listed === "" ? [] : listed.split("\n");
}

function worktreeCount(local: string): number {
  return fixtureGit(local, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

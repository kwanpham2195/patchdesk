import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parsePullRequestNumber, parseWorkspaceProfileId } from "../../src/domain/ids";
import { ReviewWorktreeService, type GitReadExecutor } from "../../src/services/review-worktree-service";

function must<T>(value: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (value._tag === "err") throw new Error("fixture parse failed");
  return value.value;
}

class RecordingGit implements GitReadExecutor {
  readonly calls: Array<ReadonlyArray<string>> = [];
  async run(argv: ReadonlyArray<string>) {
    this.calls.push(argv);
    if (argv.includes("status")) return { _tag: "ok" as const, value: { stdout: " M dirty.ts\n?? untracked.ts\n" } };
    return { _tag: "ok" as const, value: { stdout: "" } };
  }
}

const ids = {
  profileId: must(parseWorkspaceProfileId("cfw")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  number: must(parsePullRequestNumber(42)),
  sha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
};

describe("ReviewWorktreeService", () => {
  it("records a dirty primary checkout, fetches a managed ref, and never changes that checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const local = join(root, "repo");
      await mkdir(local);
      const git = new RecordingGit();
      const service = new ReviewWorktreeService(PatchdeskPaths.forTest(root), git);
      const prepared = await service.prepare({ ...ids, sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never, localPath: local });

      expect(prepared).toMatchObject({ _tag: "ok", value: { mode: "worktree", dirty: { tracked: true, untracked: true } } });
      expect(git.calls.some((argv) => argv.slice(3).join(" ") === `fetch origin ${ids.sha}:refs/patchdesk/reviews/cfw/github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab/head --no-tags`)).toBe(true);
      expect(git.calls.flat()).not.toContain("pull");
      expect(git.calls.flat()).not.toContain("checkout");
      expect(git.calls.flat()).not.toContain("clean");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns a visible metadata-only outcome without a configured checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const prepared = await new ReviewWorktreeService(PatchdeskPaths.forTest(root), new RecordingGit()).prepare({ ...ids, sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never });
      expect(prepared).toEqual({ _tag: "ok", value: { mode: "metadata_only", warning: "missing_local_path" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses cleanup outside the cache root or through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-worktree-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const service = new ReviewWorktreeService(paths, new RecordingGit());
      const outside = join(root, "outside");
      await mkdir(outside);
      expect(await service.cleanup({ ...ids, sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never, localPath: outside, targetPath: outside })).toMatchObject({ _tag: "err", error: { _tag: "UnsafeWorktreeCleanup" } });
      const target = paths.worktreeDirectory(ids.profileId, "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never);
      await mkdir(join(target, ".."), { recursive: true });
      await symlink(outside, target);
      expect(await service.cleanup({ ...ids, sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never, localPath: outside, targetPath: target })).toMatchObject({ _tag: "err", error: { _tag: "UnsafeWorktreeCleanup" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

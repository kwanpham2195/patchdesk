import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseWorkspaceProfileId } from "../../src/domain/ids";
import { ReviewSessionService } from "../../src/services/review-session-service";
import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { ReviewWorktreeService, type GitReadExecutor } from "../../src/services/review-worktree-service";
import { ReviewContextService } from "../../src/services/review-context-service";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";

function must<T>(r: { _tag: "ok"; value: T } | { _tag: "err" }): T { if (r._tag === "err") throw new Error("parse"); return r.value; }
describe("ReviewSessionService", () => {
  it("starts a persistent exact-head session in degraded metadata-only mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-session-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const service = new ReviewSessionService(paths, () => must(parseIsoTimestamp("2026-07-16T00:00:00.000Z")));
      const result = await service.startReview({ profileId: must(parseWorkspaceProfileId("cfw")), host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), number: must(parsePullRequestNumber(42)), headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")), isDraft: false, isOpen: true });
      expect(result).toMatchObject({ _tag: "ok", value: { session: { state: { _tag: "Created" }, key: { headSha: "abcdef1234567890abcdef1234567890abcdef12" } }, outcome: { mode: "metadata_only", warning: "missing_local_path" } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("prepares an exact-head worktree, patch, and context through read-only fakes", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-session-"));
    try {
      const paths = PatchdeskPaths.forTest(root); const local = join(root, "repo"); await mkdir(local);
      const profile = must(parseWorkspaceProfileConfig({ id: "cfw", label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
      const host = must(parseGitHubHost("github.com")); const owner = must(parseGitHubOwner("centraldigital")); const repo = must(parseGitHubRepoName("patchdesk")); const number = must(parsePullRequestNumber(42)); const sha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")); const updatedAt = must(parseIsoTimestamp("2026-07-16T00:00:00.000Z"));
      const summary = { ref: { host, owner, repo, number }, title: "fixture", author: "author", headBranch: "feature", baseBranch: "sit", headSha: sha, isDraft: false, isOpen: true, reviewState: "none" as const, mergeability: "unknown" as const, labels: [], updatedAt };
      const git: GitReadExecutor = { async run() { return { _tag: "ok", value: { stdout: "" } }; } };
      const service = new ReviewSessionService(paths, () => updatedAt, { github: new FakeGitHubAdapter({ pullRequest: summary, comments: { threads: [] }, checks: { overall: "passing", checks: [] }, diff: "+++ b/src/a.ts\n+line\n" }), worktrees: new ReviewWorktreeService(paths, git), context: new ReviewContextService() });
      const result = await service.startReview({ profileId: profile.id, host, owner, repo, number, headSha: sha, isDraft: false, isOpen: true, profile, localPath: local });
      expect(result).toMatchObject({ _tag: "ok", value: { outcome: { mode: "worktree" } } }); if (result._tag === "err") return;
      expect(result.value.session).toMatchObject({ state: { _tag: "Running", attemptId: "001" }, currentAttemptId: "001" });
      expect(await readFile(result.value.session.patchPath, "utf8")).toContain("src/a.ts");
      expect(await readFile(paths.attemptFile(profile.id, result.value.session.id, "001" as never), "utf8")).toContain("\"id\":\"001\"");
      expect(await readFile(paths.attemptContextFile(profile.id, result.value.session.id, "001" as never), "utf8")).toContain("src/a.ts");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a patch artifact for a missing-local-path diff-only review", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-session-"));
    try {
      const paths = PatchdeskPaths.forTest(root); const profile = must(parseWorkspaceProfileConfig({ id: "cfw", label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
      const host = must(parseGitHubHost("github.com")); const owner = must(parseGitHubOwner("centraldigital")); const repo = must(parseGitHubRepoName("patchdesk")); const number = must(parsePullRequestNumber(42)); const sha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")); const updatedAt = must(parseIsoTimestamp("2026-07-16T00:00:00.000Z")); const summary = { ref: { host, owner, repo, number }, title: "fixture", author: "author", headBranch: "feature", baseBranch: "sit", headSha: sha, isDraft: false, isOpen: true, reviewState: "none" as const, mergeability: "unknown" as const, labels: [], updatedAt };
      const service = new ReviewSessionService(paths, () => updatedAt, { github: new FakeGitHubAdapter({ pullRequest: summary, comments: { threads: [] }, checks: { overall: "passing", checks: [] }, diff: "+++ b/src/a.ts\n+line\n" }), worktrees: new ReviewWorktreeService(paths, { async run() { return { _tag: "ok", value: { stdout: "" } }; } }), context: new ReviewContextService() });
      const result = await service.startReview({ profileId: profile.id, host, owner, repo, number, headSha: sha, isDraft: false, isOpen: true, profile });
      expect(result).toMatchObject({ _tag: "ok", value: { outcome: { mode: "metadata_only" } } }); if (result._tag === "err") return;
      expect(await readFile(result.value.session.patchPath, "utf8")).toContain("src/a.ts");
      expect(await readFile(paths.attemptContextFile(profile.id, result.value.session.id, "001" as never), "utf8")).toContain("missing");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

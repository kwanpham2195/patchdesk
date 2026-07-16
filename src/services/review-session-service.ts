import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseAbsolutePath, type GitHubHost, type GitHubOwner, type GitHubRepoName, type GitSha, type IsoTimestamp, type PullRequestNumber, type WorkspaceProfileId } from "../domain/ids";
import { createReviewSession, type ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { GitHubReader } from "../adapters/github/github-adapter";
import type { PullRequestRef } from "../domain/pull-request";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewContextService } from "./review-context-service";
import type { ManagedWorktree, MetadataOnlyReview, ReviewWorktreeService } from "./review-worktree-service";

export type StartReviewFailure = { readonly _tag: "StartReviewFailed" };
type StartReviewInput = { readonly profileId: WorkspaceProfileId; readonly host: GitHubHost; readonly owner: GitHubOwner; readonly repo: GitHubRepoName; readonly number: PullRequestNumber; readonly headSha: GitSha; readonly isDraft: boolean; readonly isOpen: boolean; readonly profile?: WorkspaceProfileConfig; readonly localPath?: string };
type StartDependencies = { readonly github: GitHubReader; readonly worktrees: ReviewWorktreeService; readonly context: ReviewContextService };

/** Creates the durable, exact-head session record before any workflow is allowed to inspect it. */
export class ReviewSessionService {
  constructor(private readonly paths: PatchdeskPaths, private readonly now: () => IsoTimestamp, private readonly dependencies?: StartDependencies) {}

  async startReview(input: StartReviewInput): Promise<Result<{ readonly session: ReviewSession; readonly outcome: ManagedWorktree | MetadataOnlyReview }, StartReviewFailure>> {
    const key = { profileId: input.profileId, host: input.host, owner: input.owner, repo: input.repo, prNumber: input.number, headSha: input.headSha };
    const provisionalId = `${input.host}__${input.owner}__${input.repo}__pr-${input.number}__sha-${input.headSha.slice(0, 8)}__000000000000`;
    const patchPath = parseAbsolutePath(this.paths.patchFile(input.profileId, provisionalId as never));
    const worktreePath = parseAbsolutePath(this.paths.worktreeDirectory(input.profileId, provisionalId as never));
    if (patchPath._tag === "err" || worktreePath._tag === "err") return err({ _tag: "StartReviewFailed" });
    const session = createReviewSession({ key, pr: { headSha: input.headSha, isDraft: input.isDraft, isOpen: input.isOpen }, patchPath: patchPath.value, worktree: { path: worktreePath.value, headSha: input.headSha }, createdAt: this.now() });
    const exactPatchPath = parseAbsolutePath(this.paths.patchFile(input.profileId, session.id));
    const exactWorktreePath = parseAbsolutePath(this.paths.worktreeDirectory(input.profileId, session.id));
    if (exactPatchPath._tag === "err" || exactWorktreePath._tag === "err") return err({ _tag: "StartReviewFailed" });
    const exact = { ...session, patchPath: exactPatchPath.value, worktree: { path: exactWorktreePath.value, headSha: input.headSha } };
    const prepared = await this.prepareReadOnlyInput(input, exact.id);
    if (prepared._tag === "err") return prepared;
    if (prepared.value.mode === "worktree") {
      const patchWritten = await this.writePatchAndContext(input, exact, prepared.value);
      if (patchWritten._tag === "err") return patchWritten;
    } else {
      const patchWritten = await this.writeDiffOnlyPatch(input, exact);
      if (patchWritten._tag === "err") return patchWritten;
    }
    const stored = await new ReviewSessionStore(this.paths).save(exact);
    return stored._tag === "ok" ? ok({ session: exact, outcome: prepared.value }) : err({ _tag: "StartReviewFailed" });
  }

  private async prepareReadOnlyInput(input: StartReviewInput, sessionId: ReviewSession["id"]): Promise<Result<ManagedWorktree | MetadataOnlyReview, StartReviewFailure>> {
    if (this.dependencies === undefined || input.profile === undefined) return ok({ mode: "metadata_only", warning: "missing_local_path" });
    const pr: PullRequestRef = { host: input.host, owner: input.owner, repo: input.repo, number: input.number };
    const snapshot = await this.dependencies.github.getPullRequest({ profile: input.profile, pr });
    if (snapshot._tag === "err" || snapshot.value.headSha !== input.headSha) return err({ _tag: "StartReviewFailed" });
    const prepared = await this.dependencies.worktrees.prepare({ profileId: input.profileId, host: input.host, owner: input.owner, repo: input.repo, number: input.number, sha: input.headSha, sessionId, ...(input.localPath === undefined ? {} : { localPath: input.localPath }) });
    return prepared._tag === "ok" ? prepared : err({ _tag: "StartReviewFailed" });
  }

  private async writePatchAndContext(input: StartReviewInput, session: ReviewSession, worktree: ManagedWorktree): Promise<Result<void, StartReviewFailure>> {
    if (this.dependencies === undefined || input.profile === undefined) return err({ _tag: "StartReviewFailed" });
    const pr: PullRequestRef = { host: input.host, owner: input.owner, repo: input.repo, number: input.number };
    const [comments, checks, diff] = await Promise.all([
      this.dependencies.github.getPullRequestComments({ profile: input.profile, pr }),
      this.dependencies.github.getPullRequestChecks({ profile: input.profile, pr, headSha: input.headSha }),
      this.dependencies.github.getPullRequestDiff({ profile: input.profile, pr }),
    ]);
    if (comments._tag === "err" || checks._tag === "err" || diff._tag === "err") return err({ _tag: "StartReviewFailed" });
    try { await mkdir(dirname(session.patchPath), { recursive: true }); await writeFile(session.patchPath, diff.value, "utf8"); } catch { return err({ _tag: "StartReviewFailed" }); }
    const context = await this.dependencies.context.prepare({ worktreePath: worktree.path, attemptDirectory: this.paths.attemptDirectory(input.profileId, session.id, "001" as never), pr: { title: `${input.owner}/${input.repo}#${input.number}`, headSha: input.headSha }, comments: comments.value, checks: checks.value, changedFiles: parseChangedFiles(diff.value), patch: { path: session.patchPath, sha256: "0".repeat(64) }, rulePaths: input.profile.rulePaths });
    return context._tag === "ok" ? ok(undefined) : err({ _tag: "StartReviewFailed" });
  }

  private async writeDiffOnlyPatch(input: StartReviewInput, session: ReviewSession): Promise<Result<void, StartReviewFailure>> {
    if (this.dependencies === undefined || input.profile === undefined) return ok(undefined);
    const pr: PullRequestRef = { host: input.host, owner: input.owner, repo: input.repo, number: input.number };
    const diff = await this.dependencies.github.getPullRequestDiff({ profile: input.profile, pr });
    if (diff._tag === "err") return err({ _tag: "StartReviewFailed" });
    try { await mkdir(dirname(session.patchPath), { recursive: true }); await writeFile(session.patchPath, diff.value, "utf8"); return ok(undefined); } catch { return err({ _tag: "StartReviewFailed" }); }
  }
}

function parseChangedFiles(diff: string): ReadonlyArray<string> { return diff.split("\n").flatMap((line) => line.startsWith("+++ b/") ? [line.slice(6)] : []); }

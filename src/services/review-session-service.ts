import { parseAbsolutePath, type GitHubHost, type GitHubOwner, type GitHubRepoName, type GitSha, type IsoTimestamp, type PullRequestNumber, type WorkspaceProfileId } from "../domain/ids";
import { createReviewSession, type ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";

export type StartReviewFailure = { readonly _tag: "StartReviewFailed" };
type StartReviewInput = { readonly profileId: WorkspaceProfileId; readonly host: GitHubHost; readonly owner: GitHubOwner; readonly repo: GitHubRepoName; readonly number: PullRequestNumber; readonly headSha: GitSha; readonly isDraft: boolean; readonly isOpen: boolean };

/** Creates the durable, exact-head session record before any workflow is allowed to inspect it. */
export class ReviewSessionService {
  constructor(private readonly paths: PatchdeskPaths, private readonly now: () => IsoTimestamp) {}

  async startReview(input: StartReviewInput): Promise<Result<{ readonly session: ReviewSession; readonly outcome: { readonly mode: "metadata_only"; readonly warning: "missing_local_path" } }, StartReviewFailure>> {
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
    const stored = await new ReviewSessionStore(this.paths).save(exact);
    return stored._tag === "ok" ? ok({ session: exact, outcome: { mode: "metadata_only", warning: "missing_local_path" } }) : err({ _tag: "StartReviewFailed" });
  }
}

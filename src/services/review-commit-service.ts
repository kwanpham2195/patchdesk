import type { ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { GitSha, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestCommit } from "../domain/github-context";
import { err, ok, type Result } from "../domain/result";
import type { GitReadExecutor } from "./review-worktree-service";

const maxCommitPatchBytes = 1_500_000;

export type CommitDiffProjection = {
  readonly commit: PullRequestCommit;
  readonly position: number;
  readonly total: number;
  readonly patch: string;
};

export type ReviewCommitFailure =
  | { readonly reason: "not_found" }
  | { readonly reason: "stale_head" }
  | { readonly reason: "foreign_commit" }
  | { readonly reason: "storage" }
  | { readonly reason: "git_unavailable" }
  | { readonly reason: "binary_only" }
  | { readonly reason: "too_large" };

export class ReviewCommitService {
  constructor(
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly remote: Pick<ReviewRemoteStore, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly git: GitReadExecutor,
  ) {}

  async diff(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly commitSha: GitSha;
  }): Promise<Result<CommitDiffProjection, ReviewCommitFailure>> {
    const review = await this.reviews.load(input.profileId, input.reviewId);
    if (review._tag === "err") return err({ reason: review.error.reason === "not_found" ? "not_found" : "storage" });
    if (review.value.currentHeadSha !== review.value.representedRemote?.headSha || review.value.representedRemote === undefined) return err({ reason: "stale_head" });
    const snapshot = await this.remote.load({
      profileId: input.profileId,
      reviewId: input.reviewId,
      snapshotHash: review.value.representedRemote.snapshotHash,
    });
    if (snapshot._tag === "err") return err({ reason: "storage" });
    const snapshotIdentity = snapshot.value.pullRequest.ref;
    if (snapshot.value.pullRequest.headSha !== review.value.currentHeadSha || snapshotIdentity.host !== review.value.identity.host || snapshotIdentity.owner !== review.value.identity.owner || snapshotIdentity.repo !== review.value.identity.repo || snapshotIdentity.number !== review.value.identity.prNumber) return err({ reason: "stale_head" });
    const position = snapshot.value.commits.findIndex((commit) => commit.sha === input.commitSha);
    if (position < 0) return err({ reason: "foreign_commit" });
    const commit = snapshot.value.commits[position];
    if (commit === undefined) return err({ reason: "foreign_commit" });
    const session = await this.sessions.load(input.profileId, review.value.currentSessionId);
    if (session._tag === "err") return err({ reason: session.error.reason === "not_found" ? "not_found" : "storage" });
    if (session.value.id !== review.value.currentSessionId || session.value.key.headSha !== review.value.currentHeadSha || session.value.key.profileId !== review.value.identity.profileId || session.value.key.host !== review.value.identity.host || session.value.key.owner !== review.value.identity.owner || session.value.key.repo !== review.value.identity.repo || session.value.key.prNumber !== review.value.identity.prNumber) return err({ reason: "stale_head" });

    const managedHeadRef = `refs/patchdesk/reviews/${input.profileId}/${session.value.id}/head`;
    const resolved = await this.git.run([
      "git", "-C", session.value.worktree.path, "rev-parse", "--verify", "--quiet", "--end-of-options", `${managedHeadRef}^{commit}`,
    ]);
    if (resolved._tag === "err" || resolved.value.stdout.trim() !== session.value.key.headSha) return err({ reason: "git_unavailable" });
    const reachable = await this.git.run([
      "git", "-C", session.value.worktree.path, "merge-base", "--is-ancestor", input.commitSha, managedHeadRef,
    ]);
    if (reachable._tag === "err") return err({ reason: "git_unavailable" });
    const patch = await this.git.run([
      "git", "-C", session.value.worktree.path, "diff", "--no-ext-diff", "--patch", "--binary", `${input.commitSha}^`, input.commitSha,
    ]);
    if (patch._tag === "err") return err({ reason: "git_unavailable" });
    if (patch.value.stdout.length === 0 || (patch.value.stdout.includes("GIT binary patch") && !patch.value.stdout.includes("\n@@"))) return err({ reason: "binary_only" });
    if (Buffer.byteLength(patch.value.stdout, "utf8") > maxCommitPatchBytes) return err({ reason: "too_large" });
    return ok({ commit, position: position + 1, total: snapshot.value.commits.length, patch: patch.value.stdout });
  }
}

export function commitDiffFailureReason(failure: ReviewCommitFailure): "not_found" | "head_changed" | "storage" {
  switch (failure.reason) {
    case "not_found":
      return "not_found";
    case "stale_head":
    case "foreign_commit":
      return "head_changed";
    case "storage":
    case "git_unavailable":
    case "binary_only":
    case "too_large":
      return "storage";
  }
}

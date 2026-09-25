import { parseUnifiedPatch } from "../domain/patch";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type {
  ReviewRemoteSnapshot,
  ReviewRemoteStore,
} from "../adapters/storage/review-remote-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { GitSha, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestCommit } from "../domain/github-context";
import { err, ok, type Result } from "../domain/result";
import { isPullRequestReview, sessionRepresentsReview } from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import { selectSinceReviewBaseline } from "../domain/since-review-baseline";
import type { GitReadExecutor } from "./review-worktree-service";

const maxCommitPatchBytes = 1_500_000;

export type CommitDiffProjection = {
  readonly commit: PullRequestCommit;
  readonly position: number;
  readonly total: number;
  readonly patch: string;
  /** Statistics are derived from this immutable patch, never from mutable PR metadata. */
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
};

/** The diff from the viewer's last reviewed commit to the represented head. */
export type SinceReviewDiffProjection = {
  readonly baseSha: GitSha;
  readonly headSha: GitSha;
  readonly patch: string;
};

export type ReviewCommitFailure =
  | { readonly reason: "not_found" }
  | { readonly reason: "stale_head" }
  | { readonly reason: "foreign_commit" }
  | { readonly reason: "storage" }
  | { readonly reason: "git_unavailable" }
  | { readonly reason: "binary_only" }
  | { readonly reason: "too_large" }
  | { readonly reason: "no_review" }
  | { readonly reason: "unreachable_review" };

type RepresentedWorktree = {
  readonly snapshot: ReviewRemoteSnapshot;
  readonly session: ReviewSession;
  readonly managedHeadRef: string;
};

export class ReviewCommitService {
  constructor(
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly remote: Pick<ReviewRemoteStore, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly git: GitReadExecutor,
    private readonly profiles: Pick<ProfileStore, "load">,
  ) {}

  async diff(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly commitSha: GitSha;
  }): Promise<Result<CommitDiffProjection, ReviewCommitFailure>> {
    const represented = await this.loadRepresented(input);
    if (represented._tag === "err") return represented;
    const { snapshot, session } = represented.value;
    const position = snapshot.commits.findIndex(
      (commit) => commit.sha === input.commitSha,
    );
    const commit = snapshot.commits[position];
    if (commit === undefined) return err({ reason: "foreign_commit" });
    const reachable = await this.reachableFromManagedHead(
      represented.value,
      input.commitSha,
      { reason: "git_unavailable" },
    );
    if (reachable._tag === "err") return reachable;
    const patch = await this.gitDiff(
      session,
      `${input.commitSha}^`,
      input.commitSha,
    );
    if (patch._tag === "err") return patch;
    if (patch.value.length === 0) return err({ reason: "binary_only" });
    const files = parseUnifiedPatch(patch.value);
    return ok({
      commit,
      position: position + 1,
      total: snapshot.commits.length,
      patch: patch.value,
      fileCount: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    });
  }

  /** Diffs the represented head against the head commit of the viewer's last submitted review. */
  async diffSinceReview(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<SinceReviewDiffProjection, ReviewCommitFailure>> {
    const profile = await this.profiles.load(input.profileId);
    if (profile._tag === "err")
      return err({
        reason: profile.error.reason === "not_found" ? "not_found" : "storage",
      });
    const represented = await this.loadRepresented(input);
    if (represented._tag === "err") return represented;
    const { snapshot, session, managedHeadRef } = represented.value;
    const baseline = selectSinceReviewBaseline({
      reviews: snapshot.conversation.entries.flatMap((entry) =>
        entry._tag === "ReviewSummary" ? [entry.review] : [],
      ),
      viewerLogin: profile.value.ghAccount,
      headSha: session.key.headSha,
      commits: snapshot.commits,
    });
    if (baseline._tag === "NoReview" || baseline._tag === "CurrentHead")
      return err({ reason: "no_review" });
    if (baseline._tag === "Unreachable")
      return err({ reason: "unreachable_review" });
    const reachable = await this.reachableFromManagedHead(
      represented.value,
      baseline.commitSha,
      { reason: "unreachable_review" },
    );
    if (reachable._tag === "err") return reachable;
    const patch = await this.gitDiff(
      session,
      baseline.commitSha,
      managedHeadRef,
    );
    if (patch._tag === "err") return patch;
    return ok({
      baseSha: baseline.commitSha,
      headSha: session.key.headSha,
      patch: patch.value,
    });
  }

  /** Loads the Review's represented snapshot and Session, and proves the worktree's managed head ref still names that head. */
  private async loadRepresented(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<RepresentedWorktree, ReviewCommitFailure>> {
    const review = await this.reviews.load(input.profileId, input.reviewId);
    if (review._tag === "err")
      return err({
        reason: review.error.reason === "not_found" ? "not_found" : "storage",
      });
    if (
      review.value.currentHeadSha !== review.value.representedRemote?.headSha ||
      review.value.representedRemote === undefined
    )
      return err({ reason: "stale_head" });
    const snapshot = await this.remote.load({
      profileId: input.profileId,
      reviewId: input.reviewId,
      snapshotHash: review.value.representedRemote.snapshotHash,
    });
    if (snapshot._tag === "err") return err({ reason: "storage" });
    const snapshotIdentity = snapshot.value.pullRequest.ref;
    if (
      snapshot.value.pullRequest.headSha !== review.value.currentHeadSha ||
      snapshotIdentity.host !== review.value.identity.host ||
      snapshotIdentity.owner !== review.value.identity.owner ||
      snapshotIdentity.repo !== review.value.identity.repo ||
      !isPullRequestReview(review.value) ||
      snapshotIdentity.number !== review.value.identity.source.prNumber
    )
      return err({ reason: "stale_head" });
    const session = await this.sessions.load(
      input.profileId,
      review.value.currentSessionId,
    );
    if (session._tag === "err")
      return err({
        reason: session.error.reason === "not_found" ? "not_found" : "storage",
      });
    if (
      session.value.id !== review.value.currentSessionId ||
      !sessionRepresentsReview(review.value, session.value)
    )
      return err({ reason: "stale_head" });

    const managedHeadRef = `refs/patchdesk/reviews/${input.profileId}/${session.value.id}/head`;
    return ok({
      snapshot: snapshot.value,
      session: session.value,
      managedHeadRef,
    });
  }

  /** Proves the managed head ref still names the Session head, then that `commitSha` is one of its ancestors. */
  private async reachableFromManagedHead(
    { session, managedHeadRef }: RepresentedWorktree,
    commitSha: GitSha,
    unreachable: ReviewCommitFailure,
  ): Promise<Result<void, ReviewCommitFailure>> {
    const resolved = await this.git.run([
      "git",
      "-C",
      session.worktree.path,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${managedHeadRef}^{commit}`,
    ]);
    if (
      resolved._tag === "err" ||
      resolved.value.stdout.trim() !== session.key.headSha
    )
      return err({ reason: "git_unavailable" });
    const reachable = await this.git.run([
      "git",
      "-C",
      session.worktree.path,
      "merge-base",
      "--is-ancestor",
      commitSha,
      managedHeadRef,
    ]);
    return reachable._tag === "ok" ? ok(undefined) : err(unreachable);
  }

  /** Returns the bounded text patch between two revisions; an empty string means no file changed. */
  private async gitDiff(
    session: ReviewSession,
    from: string,
    to: string,
  ): Promise<Result<string, ReviewCommitFailure>> {
    const patch = await this.git.run([
      "git",
      "-C",
      session.worktree.path,
      "diff",
      "--no-ext-diff",
      "--patch",
      "--binary",
      from,
      to,
    ]);
    if (patch._tag === "err") return err({ reason: "git_unavailable" });
    if (
      patch.value.stdout.includes("GIT binary patch") &&
      !patch.value.stdout.includes("\n@@")
    )
      return err({ reason: "binary_only" });
    if (Buffer.byteLength(patch.value.stdout, "utf8") > maxCommitPatchBytes)
      return err({ reason: "too_large" });
    return ok(patch.value.stdout);
  }
}

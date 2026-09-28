import { parseUnifiedPatch } from "../domain/patch";
import { canonicalPatchFlags } from "../adapters/process/git-patch-flags";
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
import {
  isPullRequestReview,
  sessionRepresentsReview,
  type Review,
} from "../domain/review";
import {
  isPullRequestReviewSession,
  type ReviewSession,
} from "../domain/review-session";
import { selectSinceReviewBaseline } from "../domain/since-review-baseline";
import {
  asPullRequestCommit,
  readFirstParentOrEmptyTree,
} from "./local-commit-listing";
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
    const review = await this.loadReview(input);
    if (review._tag === "err") return review;
    if (!isPullRequestReview(review.value))
      return this.diffLocalCommit(review.value, input.commitSha);
    const represented = await this.loadRepresented(input, review.value);
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
    return commitDiffProjection(
      commit,
      position + 1,
      snapshot.commits.length,
      patch.value,
      "pull_request",
    );
  }

  /**
   * A commit of a shared Review's stored list against its first parent, or a
   * root commit against the empty tree (#557 D2), read in the session's
   * worktree so the maintainer's checkout is never touched.
   */
  private async diffLocalCommit(
    review: Review,
    commitSha: GitSha,
  ): Promise<Result<CommitDiffProjection, ReviewCommitFailure>> {
    const session = await this.loadCurrentSession(review);
    if (session._tag === "err") return session;
    if (isPullRequestReviewSession(session.value))
      return err({ reason: "stale_head" });
    const { commits, checkoutHeadSha, worktree } = session.value;
    const position =
      commits?.newest.findIndex((commit) => commit.sha === commitSha) ?? -1;
    const commit = commits?.newest[position];
    if (commits === undefined || commit === undefined)
      return err({ reason: "foreign_commit" });
    const parent = await readFirstParentOrEmptyTree(
      this.git,
      worktree.path,
      commitSha,
    );
    if (parent === undefined) return err({ reason: "git_unavailable" });
    const patch = await this.gitDiff(session.value, parent, commitSha);
    if (patch._tag === "err") return patch;
    return commitDiffProjection(
      asPullRequestCommit(commit, checkoutHeadSha),
      position + 1,
      commits.total,
      patch.value,
      "local",
    );
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
    const review = await this.loadReview(input);
    if (review._tag === "err") return review;
    const represented = await this.loadRepresented(input, review.value);
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

  private async loadReview(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<Review, ReviewCommitFailure>> {
    const review = await this.reviews.load(input.profileId, input.reviewId);
    return review._tag === "ok"
      ? review
      : err({
          reason: review.error.reason === "not_found" ? "not_found" : "storage",
        });
  }

  /** Loads the Review's represented snapshot and Session, and proves the worktree's managed head ref still names that head. */
  private async loadRepresented(
    input: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
    review: Review,
  ): Promise<Result<RepresentedWorktree, ReviewCommitFailure>> {
    if (
      review.currentHeadSha !== review.representedRemote?.headSha ||
      review.representedRemote === undefined
    )
      return err({ reason: "stale_head" });
    const snapshot = await this.remote.load({
      profileId: input.profileId,
      reviewId: input.reviewId,
      snapshotHash: review.representedRemote.snapshotHash,
    });
    if (snapshot._tag === "err") return err({ reason: "storage" });
    const snapshotIdentity = snapshot.value.pullRequest.ref;
    if (
      snapshot.value.pullRequest.headSha !== review.currentHeadSha ||
      snapshotIdentity.host !== review.identity.host ||
      snapshotIdentity.owner !== review.identity.owner ||
      snapshotIdentity.repo !== review.identity.repo ||
      !isPullRequestReview(review) ||
      snapshotIdentity.number !== review.identity.source.prNumber
    )
      return err({ reason: "stale_head" });
    const session = await this.loadCurrentSession(review);
    if (session._tag === "err") return session;
    const managedHeadRef = `refs/patchdesk/reviews/${input.profileId}/${session.value.id}/head`;
    return ok({
      snapshot: snapshot.value,
      session: session.value,
      managedHeadRef,
    });
  }

  /** The Review's current Session, refused as `stale_head` when it no longer represents the Review. */
  private async loadCurrentSession(
    review: Review,
  ): Promise<Result<ReviewSession, ReviewCommitFailure>> {
    const session = await this.sessions.load(
      review.identity.profileId,
      review.currentSessionId,
    );
    if (session._tag === "err")
      return err({
        reason: session.error.reason === "not_found" ? "not_found" : "storage",
      });
    return session.value.id === review.currentSessionId &&
      sessionRepresentsReview(review, session.value)
      ? session
      : err({ reason: "stale_head" });
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
      ...canonicalPatchFlags,
      "--patch",
      "--binary",
      "--end-of-options",
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

function commitDiffProjection(
  commit: PullRequestCommit,
  position: number,
  total: number,
  patch: string,
  source: "local" | "pull_request",
): Result<CommitDiffProjection, ReviewCommitFailure> {
  if (patch.length === 0 && source === "pull_request")
    return err({ reason: "binary_only" });
  const files = parseUnifiedPatch(patch);
  if (patch.length > 0 && source === "local" && files.length === 0)
    return err({ reason: "git_unavailable" });
  return ok({
    commit,
    position,
    total,
    patch,
    fileCount: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  });
}

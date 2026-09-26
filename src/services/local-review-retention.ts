import type { InsightStore } from "../adapters/storage/insight-store";
import type { LocalApplyOperationStore } from "../adapters/storage/local-apply-operation-store";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import { definedProps } from "../domain/defined-props";
import {
  createReviewId,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { mapConcurrent } from "../domain/map-concurrent";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import { err, ok, type Result } from "../domain/result";
import { isLocalReview } from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import { exists } from "./review-preparation-journal";
import type { ReviewWorktreeService } from "./review-worktree-service";
import {
  readSessionRunningState,
  type SessionRunningStateDependencies,
} from "./session-running-state";

export type LocalRetentionFailure = { readonly _tag: "StorageUnavailable" };

type Dependencies = SessionRunningStateDependencies & {
  readonly profiles: Pick<ProfileStore, "load">;
  readonly reviews: Pick<ReviewStore, "load" | "list">;
  readonly sessions: Pick<ReviewSessionStore, "listSessions">;
  readonly insights: Pick<InsightStore, "load">;
  readonly localApplyOperations: Pick<LocalApplyOperationStore, "load">;
  readonly worktrees: Pick<ReviewWorktreeService, "cleanup">;
  readonly artifacts: Pick<ReviewArtifactStorage, "removeSession">;
  readonly lifecycleGate: ReviewLifecycleGate;
  readonly coordinator: Pick<ReviewOperationCoordinator, "withReviewLock">;
};

/**
 * Removes the sessions a local Review has moved past (#474). A local Review
 * is never Terminal, so ADR 0020's sweep would keep every session it ever
 * had, each with a worktree and a managed ref in the maintainer's repository.
 */
export class LocalReviewRetention {
  constructor(private readonly dependencies: Dependencies) {}

  /**
   * Removes every superseded session of one local Review: its worktree, its
   * managed ref, and its session directory. A session a retained Insight names
   * keeps its directory, which holds everything that Insight reads, and loses
   * only its worktree and ref. The caller holds the Review lock; the profile
   * lock is taken here, inside it. A failure is recorded as a diagnostic.
   */
  async pruneSuperseded(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<undefined, LocalRetentionFailure>> {
    const pruned = await this.dependencies.lifecycleGate
      .withProfileLock(profileId, () =>
        this.pruneUnderProfileLock(profileId, reviewId),
      )
      .catch(() => err({ _tag: "StorageUnavailable" as const }));
    if (pruned._tag === "err")
      await this.record(
        profileId,
        undefined,
        `prune failed: ${reviewId}`,
        true,
      );
    return pruned;
  }

  /** Prunes every local Review of the profile, each under its own Review lock. */
  async sweepProfile(
    profileId: WorkspaceProfileId,
  ): Promise<Result<undefined, LocalRetentionFailure>> {
    const listed = await this.dependencies.reviews.list(profileId);
    if (listed._tag === "err") return err({ _tag: "StorageUnavailable" });
    // One Review at a time: each one's Git work queues on the profile lock anyway.
    const pruned = await mapConcurrent(
      listed.value.reviews.filter(isLocalReview),
      1,
      (review) =>
        this.dependencies.coordinator.withReviewLock(profileId, review.id, () =>
          this.pruneSuperseded(profileId, review.id),
        ),
    );
    return pruned.some((result) => result._tag === "err")
      ? err({ _tag: "StorageUnavailable" })
      : ok(undefined);
  }

  private async pruneUnderProfileLock(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<undefined, LocalRetentionFailure>> {
    // Apply recovery decides an unsettled Apply from the sessions it names.
    const apply = await this.dependencies.localApplyOperations.load(
      profileId,
      reviewId,
    );
    if (apply._tag === "err") return err({ _tag: "StorageUnavailable" });
    if (apply.value !== undefined) return ok(undefined);
    const [review, profile, sessions, insightSessions] = await Promise.all([
      this.dependencies.reviews.load(profileId, reviewId),
      this.dependencies.profiles.load(profileId),
      this.dependencies.sessions.listSessions(profileId),
      this.retainedInsightSessions(profileId, reviewId),
    ]);
    if (review._tag === "err")
      return review.error.reason === "not_found"
        ? ok(undefined)
        : err({ _tag: "StorageUnavailable" });
    if (!isLocalReview(review.value)) return ok(undefined);
    if (
      profile._tag === "err" ||
      sessions._tag === "err" ||
      insightSessions === undefined
    )
      return err({ _tag: "StorageUnavailable" });
    const localPath = profile.value.repos.find((repository) =>
      sameRepositoryIdentity(repository, review.value.identity),
    )?.localPath;
    // Without the checkout, the worktree and its ref cannot be removed through Git.
    if (localPath === undefined) return ok(undefined);
    // One session at a time: `git update-ref` and `git worktree` contend on the repository's locks.
    const outcomes = await mapConcurrent(
      sessions.value.filter(
        (session) => createReviewId(session.key) === reviewId,
      ),
      1,
      (session) =>
        this.pruneSession(
          profileId,
          session,
          localPath,
          insightSessions.has(session.id),
        ),
    );
    const removed = outcomes.filter((outcome) => outcome === "removed").length;
    const trimmed = outcomes.filter((outcome) => outcome === "trimmed").length;
    if (removed + trimmed > 0)
      await this.record(
        profileId,
        undefined,
        `removed ${String(removed)} superseded local sessions and the worktrees of ${String(trimmed)} kept for retained Insights`,
      );
    return ok(undefined);
  }

  /**
   * Removes one session unless it is running: its worktree and ref, then its
   * directory unless a retained Insight reads it.
   */
  private async pruneSession(
    profileId: WorkspaceProfileId,
    session: ReviewSession,
    localPath: string,
    namedByInsight: boolean,
  ): Promise<"removed" | "trimmed" | "kept"> {
    const running = await readSessionRunningState(
      this.dependencies,
      profileId,
      session,
    );
    if (running._tag === "err") {
      await this.record(
        profileId,
        session.id,
        "running-state check failed",
        true,
      );
      return "kept";
    }
    if (running.value.running) return "kept";
    const worktree = await this.removeWorktree(
      profileId,
      session.id,
      localPath,
    );
    if (worktree === "kept") return "kept";
    if (namedByInsight) return worktree === "removed" ? "trimmed" : "kept";
    const removed = await this.dependencies.artifacts.removeSession(
      profileId,
      session.id,
    );
    if (removed._tag === "ok") return "removed";
    await this.record(profileId, session.id, "session removal failed", true);
    return "kept";
  }

  /** The sessions a retained Analysis, Walkthrough or Brief of the Review was generated from. */
  private async retainedInsightSessions(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<ReadonlySet<ReviewSessionId> | undefined> {
    const records = await Promise.all(
      (["analysis", "walkthrough", "brief"] as const).map((type) =>
        this.dependencies.insights.load(profileId, reviewId, type),
      ),
    );
    const sessionIds = new Set<ReviewSessionId>();
    for (const record of records) {
      if (record._tag === "err") {
        if (record.error.reason !== "not_found") return undefined;
        continue;
      }
      const retained = record.value.retained?.revision.sessionId;
      if (retained !== undefined) sessionIds.add(retained);
    }
    return sessionIds;
  }

  /** Removes the session's worktree and managed ref; "kept" when Git or the ownership check refused. */
  private async removeWorktree(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    localPath: string,
  ): Promise<"absent" | "removed" | "kept"> {
    const targetPath = this.dependencies.paths.worktreeDirectory(
      profileId,
      sessionId,
    );
    if (!(await exists(targetPath))) return "absent";
    const cleaned = await this.dependencies.worktrees.cleanup({
      profileId,
      sessionId,
      localPath,
      targetPath,
    });
    if (cleaned._tag === "ok") return "removed";
    await this.record(
      profileId,
      sessionId,
      `worktree removal failed: ${cleaned.error._tag}`,
      true,
    );
    return "kept";
  }

  private async record(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId | undefined,
    detail: string,
    retryable = false,
  ): Promise<void> {
    await this.dependencies.diagnostics?.record({
      profileId,
      category: "cleanup",
      phase: "local_retention",
      ...definedProps({ sessionId }),
      retryable,
      detail,
    });
  }
}

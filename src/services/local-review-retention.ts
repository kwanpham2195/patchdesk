import type { InsightStore } from "../adapters/storage/insight-store";
import type { LocalApplyOperationStore } from "../adapters/storage/local-apply-operation-store";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import { definedProps } from "../domain/defined-props";
import {
  createReviewId,
  type IsoTimestamp,
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
import { isLocalSourceGone } from "./local-source-presence";
import { exists, ReviewPreparationJournal } from "./review-preparation-journal";
import type {
  GitReadExecutor,
  ReviewWorktreeService,
} from "./review-worktree-service";
import {
  readSessionRunningState,
  type SessionRunningStateDependencies,
} from "./session-running-state";

export type LocalRetentionFailure = { readonly _tag: "StorageUnavailable" };

type Dependencies = SessionRunningStateDependencies & {
  readonly profiles: Pick<ProfileStore, "load">;
  readonly reviews: Pick<ReviewStore, "load" | "list" | "delete">;
  readonly sessions: Pick<ReviewSessionStore, "load" | "listSessions">;
  readonly insights: Pick<InsightStore, "load">;
  readonly localApplyOperations: Pick<LocalApplyOperationStore, "load">;
  readonly worktrees: Pick<
    ReviewWorktreeService,
    "cleanup" | "listManagedRefs" | "deleteManagedRefs"
  >;
  readonly artifacts: Pick<ReviewArtifactStorage, "removeSession">;
  readonly git: GitReadExecutor;
  readonly lifecycleGate: ReviewLifecycleGate;
  readonly coordinator: Pick<ReviewOperationCoordinator, "withReviewLock">;
  readonly now: () => IsoTimestamp;
};

/** How long a local Review whose source is gone stays after it was last opened. */
const RETAIN_ABANDONED_LOCAL_REVIEW_MS = 14 * 24 * 60 * 60 * 1000;

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

  /**
   * The scheduled pass (ADR 0020): prunes every local Review of the profile,
   * or removes it whole when its source is gone, each under its own Review
   * lock. Then deletes the profile's managed refs no kept session names,
   * under the profile lock only.
   */
  async sweepProfile(
    profileId: WorkspaceProfileId,
  ): Promise<Result<undefined, LocalRetentionFailure>> {
    const listed = await this.dependencies.reviews.list(profileId);
    if (listed._tag === "err") return err({ _tag: "StorageUnavailable" });
    // One Review at a time: each one's Git work queues on the profile lock anyway.
    const swept = await mapConcurrent(
      listed.value.reviews.filter(isLocalReview),
      1,
      (review) =>
        this.dependencies.coordinator.withReviewLock(profileId, review.id, () =>
          this.sweepReview(profileId, review.id),
        ),
    );
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the ordering is the point: the orphan-ref pass collects the refs the Review pass above left behind
    const orphaned = await this.dependencies.lifecycleGate.withProfileLock(
      profileId,
      () => this.deleteOrphanedRefs(profileId),
    );
    const removedReviews = swept.filter((result) => result === "removed");
    await this.record(
      profileId,
      undefined,
      `local sweep complete: ${String(removedReviews.length)} Reviews with a gone source removed, ${String(orphaned ?? 0)} orphaned managed refs deleted`,
    );
    return orphaned === undefined || swept.includes("failed")
      ? err({ _tag: "StorageUnavailable" })
      : ok(undefined);
  }

  /** Under the Review lock: removes the Review when its source is gone and it was left alone, else prunes it. */
  private async sweepReview(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<"removed" | "kept" | "failed"> {
    const [review, profile] = await Promise.all([
      this.dependencies.reviews.load(profileId, reviewId),
      this.dependencies.profiles.load(profileId),
    ]);
    if (review._tag === "err")
      return review.error.reason === "not_found" ? "kept" : "failed";
    if (profile._tag === "err") return "failed";
    if (!isLocalReview(review.value)) return "kept";
    const localPath = profile.value.repos.find((repository) =>
      sameRepositoryIdentity(repository, review.value.identity),
    )?.localPath;
    const lastUsed = review.value.lastOpenedAt ?? review.value.updatedAt;
    const abandoned =
      localPath !== undefined &&
      (review.value.localDrafts ?? []).length === 0 &&
      Date.parse(lastUsed) <
        Date.parse(this.dependencies.now()) -
          RETAIN_ABANDONED_LOCAL_REVIEW_MS &&
      (await isLocalSourceGone(
        this.dependencies.git,
        localPath,
        review.value.identity.source,
      ));
    if (abandoned)
      return this.dependencies.lifecycleGate.withProfileLock(profileId, () =>
        this.removeReview(profileId, reviewId, localPath),
      );
    const pruned = await this.pruneSuperseded(profileId, reviewId);
    return pruned._tag === "ok" ? "kept" : "failed";
  }

  /**
   * Removes a local Review whose source is gone: every session's worktree,
   * ref and directory, then the Review record with its Insights. Anything in
   * motion keeps the whole Review for the next pass.
   */
  private async removeReview(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    localPath: string,
  ): Promise<"removed" | "kept" | "failed"> {
    const [apply, sessions, insights] = await Promise.all([
      this.dependencies.localApplyOperations.load(profileId, reviewId),
      this.dependencies.sessions.listSessions(profileId),
      Promise.all(
        (["analysis", "walkthrough", "brief"] as const).map((type) =>
          this.dependencies.insights.load(profileId, reviewId, type),
        ),
      ),
    ]);
    if (apply._tag === "err" || sessions._tag === "err") return "failed";
    const insightRunning = insights.some((record) =>
      record._tag === "ok"
        ? record.value.activeRun !== undefined
        : record.error.reason !== "not_found",
    );
    if (apply.value !== undefined || insightRunning) return "kept";
    const owned = sessions.value.filter(
      (session) => createReviewId(session.key) === reviewId,
    );
    const preparing = await mapConcurrent(owned, 8, (session) =>
      this.isPreparing(profileId, session.id),
    );
    if (preparing.includes(true)) return "kept";
    const removed = await mapConcurrent(owned, 1, async (session) => {
      const worktree = await this.removeWorktree(
        profileId,
        session.id,
        localPath,
      );
      if (worktree === "kept") return false;
      const artifacts = await this.dependencies.artifacts.removeSession(
        profileId,
        session.id,
      );
      return artifacts._tag === "ok";
    });
    if (removed.includes(false)) return "failed";
    const deleted = await this.dependencies.reviews.delete(profileId, reviewId);
    if (deleted._tag === "err") return "failed";
    await this.record(
      profileId,
      undefined,
      `removed local Review ${reviewId}: its source is gone`,
    );
    return "removed";
  }

  /**
   * Deletes the profile's managed refs whose session has neither a stored
   * record, a worktree, nor a preparation in progress. The caller holds the
   * profile lock, which every preparation holds while it writes a ref. The
   * count deleted, or undefined when the profile could not be read.
   */
  private async deleteOrphanedRefs(
    profileId: WorkspaceProfileId,
  ): Promise<number | undefined> {
    const profile = await this.dependencies.profiles.load(profileId);
    if (profile._tag === "err") return undefined;
    const localPaths = [
      ...new Set(
        profile.value.repos.flatMap((repository) =>
          repository.localPath === undefined ? [] : [repository.localPath],
        ),
      ),
    ];
    const deleted = await mapConcurrent(localPaths, 1, async (localPath) => {
      const refs = await this.dependencies.worktrees.listManagedRefs(
        profileId,
        localPath,
      );
      if (refs === undefined) return 0;
      const kept = await mapConcurrent(refs, 8, (ref) =>
        this.isSessionKept(profileId, ref.sessionId),
      );
      const orphaned = refs.filter((_ref, index) => kept[index] === false);
      if (orphaned.length > 0)
        await this.dependencies.worktrees.deleteManagedRefs(
          localPath,
          orphaned,
        );
      return orphaned.length;
    });
    return deleted.reduce((total, count) => total + count, 0);
  }

  /** True unless the session is certainly gone; an unreadable record keeps it. */
  private async isSessionKept(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<boolean> {
    const stored = await this.dependencies.sessions.load(profileId, sessionId);
    if (stored._tag === "ok" || stored.error.reason !== "not_found")
      return true;
    if (
      await exists(
        this.dependencies.paths.worktreeDirectory(profileId, sessionId),
      )
    )
      return true;
    return this.isPreparing(profileId, sessionId);
  }

  /** True while a preparation journal holds the session, or when it cannot be read. */
  private async isPreparing(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<boolean> {
    const journal = await ReviewPreparationJournal.activeFor(
      this.dependencies.paths,
      profileId,
      sessionId,
      this.dependencies.diagnostics,
    );
    return journal._tag === "err" || journal.value !== undefined;
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

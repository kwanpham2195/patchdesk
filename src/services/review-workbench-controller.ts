import type { Review, ReviewIdentity } from "../domain/review";
import type { ReviewId, WorkspaceProfileId } from "../domain/ids";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseReviewId,
  createReviewId,
  parseWorkspaceProfileId,
} from "../domain/ids";
import { createReview } from "../domain/review";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import type { ReviewObservationJournalStore } from "../adapters/storage/review-observation-journal-store";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { ReviewRefreshService } from "./review-refresh-service";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import type { ReviewObservationService } from "./review-observation-service";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { ReviewCommitService } from "./review-commit-service";
import { err, ok, type Result } from "../domain/result";
import type {
  PrepareReviewSessionFailure,
  ReviewSessionPreparation,
} from "./review-session-preparation";
import type {
  ReviewWorkbenchProjection,
  ReviewWorkbenchProjectionService,
  WorkbenchProjectionFailure,
} from "./review-workbench-projection";
import { readObjectField } from "./read-object-field";
import type { AppLogService } from "./app-log-service";

export type ReviewWorkbenchFailure = {
  readonly reason:
    | "invalid_input"
    | "not_found"
    | "github_read"
    | "github_auth"
    | "head_changed"
    | "storage"
    | "terminal"
    | "revision_conflict"
    | "not_fresh";
};
export type { ReviewWorkbenchProjection };

/**
 * Temporary local-API application facade. It retains the current unknown-input
 * parser and maps precise preparation/projection failures onto the existing
 * route vocabulary. Opening a new Review performs its one initial GitHub
 * snapshot fetch; later remote changes still require explicit refresh.
 */
export class ReviewWorkbenchController {
  private readonly openLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly preparation: ReviewSessionPreparation,
    private readonly projection: ReviewWorkbenchProjectionService,
    private readonly lifecycle: {
      readonly reviews: Pick<ReviewStore, "load" | "save">;
      readonly sessions: Pick<ReviewSessionStore, "load">;
      readonly artifacts: Pick<
        ReviewArtifactStorage,
        "quarantineIfPresent" | "quarantineReview"
      >;
      readonly remote: Pick<ReviewRemoteStore, "load">;
      readonly journals: Pick<ReviewObservationJournalStore, "load">;
      readonly recentWrites: Pick<RecentWriteJournalStore, "load">;
      readonly refresh: ReviewRefreshService;
      readonly observation: Pick<
        ReviewObservationService,
        "observe" | "recover"
      >;
      readonly coordinator: Pick<ReviewOperationCoordinator, "withReviewLock">;
      readonly commits: ReviewCommitService;
      /** Local diagnostic log stream; best effort, never gates a request. Wire-visible failures stay collapsed to their existing reason — this only makes the underlying cause observable in `patchdesk.jsonl`. */
      readonly logs?: Pick<AppLogService, "write">;
    },
  ) {}

  async open(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this controller I/O boundary parses the strict Review identity before delegating to typed code.
    input: unknown,
  ): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const identity = parseReviewIdentity(input);
    if (identity === undefined) return err({ reason: "invalid_input" });
    const reviewId = createReviewId(identity);
    return this.serializedOpen(identity.profileId, reviewId, async () => {
      return this.openUnlocked(identity);
    });
  }

  /** Opens only a currently merged pull request and never returns a writable Review. */
  async openMerged(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this controller I/O boundary parses the strict Review identity before terminal-only preparation.
    input: unknown,
  ): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const identity = parseReviewIdentity(input);
    if (identity === undefined) return err({ reason: "invalid_input" });
    const reviewId = createReviewId(identity);
    return this.serializedOpen(identity.profileId, reviewId, async () =>
      this.openUnlocked(identity, "merged"),
    );
  }

  private async openUnlocked(
    identity: ReviewIdentity,
    expectedTerminalState?: "merged",
  ): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const reviewId = createReviewId(identity);
    const recovered = await this.recoverObservation(
      identity.profileId,
      reviewId,
    );
    if (recovered._tag === "err") return recovered;
    const existing = await this.lifecycle.reviews.load(
      identity.profileId,
      reviewId,
    );
    if (existing._tag === "err") {
      if (existing.error.reason === "invalid_stored_value") {
        // A corrupt Review record is moved aside and the Review is rebuilt
        // from the pull request; corrupt local data never blocks opening.
        const quarantined = await this.lifecycle.artifacts.quarantineReview(
          identity.profileId,
          reviewId,
        );
        if (quarantined._tag === "err") return err({ reason: "storage" });
      } else if (existing.error.reason !== "not_found") {
        return err({ reason: "storage" });
      }
    }
    if (existing._tag === "ok") {
      const currentSession = await this.lifecycle.sessions.load(
        identity.profileId,
        existing.value.currentSessionId,
      );
      if (currentSession._tag === "err") {
        if (!isRestartableStorageFailure(currentSession.error))
          return err({ reason: "storage" });
        return this.restartUnusableReview(identity, expectedTerminalState);
      }
      if (existing.value.representedRemote !== undefined) {
        const represented = await this.lifecycle.remote.load({
          profileId: identity.profileId,
          reviewId,
          snapshotHash: existing.value.representedRemote.snapshotHash,
        });
        if (represented._tag === "err") {
          if (!isRestartableStorageFailure(represented.error))
            return err({ reason: "storage" });
          return this.restartUnusableReview(identity, expectedTerminalState);
        }
        if (expectedTerminalState === undefined)
          return this.projectStable(existing.value);
        if (existing.value.status._tag === "Terminal")
          return existing.value.status.state === "merged"
            ? this.projectStable(existing.value)
            : err({ reason: "terminal" });
        const initialized = await this.initializeSnapshot(
          identity.profileId,
          reviewId,
          expectedTerminalState,
        );
        return initialized._tag === "err"
          ? initialized
          : this.projectStable(initialized.value);
      }
      const initialized = await this.initializeSnapshot(
        identity.profileId,
        reviewId,
        expectedTerminalState,
      );
      if (initialized._tag === "err") return initialized;
      return this.projectStable(initialized.value);
    }
    return this.openFresh(identity, expectedTerminalState);
  }

  private async openFresh(
    identity: ReviewIdentity,
    expectedTerminalState?: "merged",
  ): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const created = await this.createFreshReview(
      identity,
      expectedTerminalState,
    );
    if (created._tag === "err") return created;
    const reviewId = createReviewId(identity);
    const initialized = await this.initializeSnapshot(
      identity.profileId,
      reviewId,
      expectedTerminalState,
    );
    return initialized._tag === "err"
      ? initialized
      : this.projectStable(initialized.value);
  }

  private async createFreshReview(
    identity: ReviewIdentity,
    expectedTerminalState?: "merged",
  ): Promise<Result<Review, ReviewWorkbenchFailure>> {
    const preparationInput = {
      profileId: identity.profileId,
      pullRequest: {
        host: identity.host,
        owner: identity.owner,
        repo: identity.repo,
        number: identity.prNumber,
      },
    };
    const prepared = await this.preparation.prepare(
      expectedTerminalState === undefined
        ? preparationInput
        : { ...preparationInput, expectedPullRequestState: "non_open" },
    );
    if (prepared._tag === "err")
      return err(mapPreparationFailure(prepared.error, this.lifecycle.logs));
    const created = createReview({
      identity,
      currentSessionId: prepared.value.session.id,
      headSha: prepared.value.session.key.headSha,
      createdAt: prepared.value.session.createdAt,
    });
    const saved = await this.lifecycle.reviews.save(created);
    return saved._tag === "ok" ? ok(created) : err({ reason: "storage" });
  }

  private async restartUnusableReview(
    identity: ReviewIdentity,
    expectedTerminalState?: "merged",
  ): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const reviewId = createReviewId(identity);
    const reset = await this.lifecycle.coordinator.withReviewLock(
      identity.profileId,
      reviewId,
      async (): Promise<
        Result<
          { readonly review: Review; readonly restarted: boolean },
          ReviewWorkbenchFailure
        >
      > => {
        const journal = await this.lifecycle.journals.load(
          identity.profileId,
          reviewId,
        );
        if (journal._tag === "err" || journal.value !== undefined)
          return err({ reason: "storage" });
        const current = await this.lifecycle.reviews.load(
          identity.profileId,
          reviewId,
        );
        if (current._tag === "err") {
          if (current.error.reason !== "not_found")
            return err({ reason: "storage" });
          const created = await this.createFreshReview(
            identity,
            expectedTerminalState,
          );
          return created._tag === "err"
            ? created
            : ok({ review: created.value, restarted: true });
        }
        const session = await this.lifecycle.sessions.load(
          identity.profileId,
          current.value.currentSessionId,
        );
        if (
          session._tag === "err" &&
          !isRestartableStorageFailure(session.error)
        )
          return err({ reason: "storage" });
        let restart = session._tag === "err";
        if (!restart && current.value.representedRemote !== undefined) {
          const represented = await this.lifecycle.remote.load({
            profileId: identity.profileId,
            reviewId,
            snapshotHash: current.value.representedRemote.snapshotHash,
          });
          if (
            represented._tag === "err" &&
            !isRestartableStorageFailure(represented.error)
          )
            return err({ reason: "storage" });
          restart = represented._tag === "err";
        }
        if (!restart) return ok({ review: current.value, restarted: false });
        const quarantinedSession =
          await this.lifecycle.artifacts.quarantineIfPresent(
            identity.profileId,
            current.value.currentSessionId,
          );
        if (quarantinedSession._tag === "err")
          return err({ reason: "storage" });
        const quarantinedReview =
          await this.lifecycle.artifacts.quarantineReview(
            identity.profileId,
            reviewId,
          );
        if (quarantinedReview._tag === "err") {
          this.lifecycle.logs?.write({
            process: "main",
            level: "error",
            topic: "review-workbench",
            message:
              "quarantining the unusable review failed; reported to caller as storage",
            profileId: identity.profileId,
            meta: {
              reviewId,
              ...(quarantinedReview.error._tag === "StorageFailure"
                ? {
                    operation: quarantinedReview.error.operation,
                    reason: quarantinedReview.error.reason,
                  }
                : { tag: quarantinedReview.error._tag }),
            },
          });
          return err({ reason: "storage" });
        }
        const created = await this.createFreshReview(
          identity,
          expectedTerminalState,
        );
        return created._tag === "err"
          ? created
          : ok({ review: created.value, restarted: true });
      },
    );
    if (reset._tag === "err") return reset;
    if (!reset.value.restarted) {
      if (reset.value.review.representedRemote !== undefined)
        return this.projectStable(reset.value.review);
      const initialized = await this.initializeSnapshot(
        identity.profileId,
        reviewId,
        expectedTerminalState,
      );
      return initialized._tag === "err"
        ? initialized
        : this.projectStable(initialized.value);
    }
    const initialized = await this.initializeSnapshot(
      identity.profileId,
      reviewId,
      expectedTerminalState,
    );
    return initialized._tag === "err"
      ? initialized
      : this.projectStable(initialized.value);
  }

  private async initializeSnapshot(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    expectedTerminalState?: "merged",
  ): Promise<Result<Review, ReviewWorkbenchFailure>> {
    const initialRefresh = await this.lifecycle.refresh.refresh(
      expectedTerminalState === undefined
        ? { profileId, reviewId }
        : { profileId, reviewId, expectedTerminalState },
    );
    if (initialRefresh._tag === "err")
      return err({ reason: initialRefresh.error.reason });
    const refreshedReview = await this.lifecycle.reviews.load(
      profileId,
      reviewId,
    );
    if (refreshedReview._tag === "err")
      return err({
        reason:
          refreshedReview.error.reason === "not_found"
            ? "not_found"
            : "storage",
      });
    if (refreshedReview._tag === "ok") return ok(refreshedReview.value);
    return err({ reason: "storage" });
  }

  private async projectStable(
    review: Review,
  ): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    return this.lifecycle.coordinator.withReviewLock(
      review.identity.profileId,
      review.id,
      async () => {
        const current = await this.lifecycle.reviews.load(
          review.identity.profileId,
          review.id,
        );
        return current._tag === "ok"
          ? this.projectStableUnlocked(current.value)
          : err({
              reason:
                current.error.reason === "not_found" ? "not_found" : "storage",
            });
      },
    );
  }

  private async projectStableUnlocked(
    review: Review,
  ): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const journal = await this.lifecycle.journals.load(
      review.identity.profileId,
      review.id,
    );
    if (journal._tag === "err" || journal.value !== undefined)
      return err({ reason: "storage" });
    if (
      review.representedRemote === undefined ||
      review.representedRemote.headSha !== review.currentHeadSha
    )
      return err({ reason: "storage" });
    const snapshot = await this.lifecycle.remote.load({
      profileId: review.identity.profileId,
      reviewId: review.id,
      snapshotHash: review.representedRemote.snapshotHash,
    });
    if (snapshot._tag === "err") return err({ reason: "storage" });
    const projected = await this.projection.loadRepresented({
      profileId: review.identity.profileId,
      sessionId: review.currentSessionId,
      snapshot: snapshot.value,
      refreshedAt: review.representedRemote.refreshedAt,
      freshness: review.freshness,
    });
    return projected._tag === "err"
      ? err(mapProjectionFailure(projected.error))
      : projected;
  }

  async load(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this method is the controller's own I/O boundary parser (see class doc): the route only schema-validates shape, `load` re-parses every domain value itself.
    input: unknown,
  ): Promise<Result<ReviewWorkbenchProjection, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(
      readObjectField(input, "profileId"),
    );
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return err({ reason: "invalid_input" });
    const recovered = await this.recoverObservation(
      profileId.value,
      reviewId.value,
    );
    if (recovered._tag === "err") return recovered;
    const review = await this.lifecycle.reviews.load(
      profileId.value,
      reviewId.value,
    );
    if (review._tag === "err")
      return err({
        reason: review.error.reason === "not_found" ? "not_found" : "storage",
      });
    return this.projectStable(review.value);
  }

  private async recoverObservation(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, ReviewWorkbenchFailure>> {
    const journal = await this.lifecycle.journals.load(profileId, reviewId);
    if (journal._tag === "err") return err({ reason: "storage" });
    if (journal.value === undefined) return ok(undefined);
    const recovered = await this.lifecycle.observation.recover({
      profileId,
      reviewId,
    });
    return recovered._tag === "ok" ? ok(undefined) : err({ reason: "storage" });
  }

  async commitDiff(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this method is the controller's own I/O boundary parser (see class doc): the route only schema-validates shape, `commitDiff` re-parses every domain value itself.
    input: unknown,
  ): Promise<Result<unknown, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(
      readObjectField(input, "profileId"),
    );
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    const commitSha = parseGitSha(readObjectField(input, "commitSha"));
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      commitSha._tag === "err"
    )
      return err({ reason: "invalid_input" });
    const result = await this.lifecycle.commits.diff({
      profileId: profileId.value,
      reviewId: reviewId.value,
      commitSha: commitSha.value,
    });
    return result._tag === "err"
      ? err({
          reason:
            result.error.reason === "not_found"
              ? "not_found"
              : result.error.reason === "stale_head" ||
                  result.error.reason === "foreign_commit"
                ? "head_changed"
                : "storage",
        })
      : result;
  }

  async detectUpdates(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly recentWrites?: ReadonlyArray<RecentReviewWrite>;
  }): Promise<Result<unknown, ReviewWorkbenchFailure>> {
    // A renderer reload or app restart starts with an empty in-memory
    // journal; the durable journal survives that and is unioned in so the
    // maintainer's own just-made write is never read as absent. A durable
    // load failure fails open onto the request-supplied array alone.
    const durable = await this.lifecycle.recentWrites.load(
      input.profileId,
      input.reviewId,
    );
    const recentWrites = unionRecentWrites(
      durable._tag === "ok" ? durable.value : [],
      input.recentWrites ?? [],
    );
    return recentWrites.length === 0
      ? this.lifecycle.observation.observe({
          profileId: input.profileId,
          reviewId: input.reviewId,
        })
      : this.lifecycle.observation.observe({
          profileId: input.profileId,
          reviewId: input.reviewId,
          recentWrites,
        });
  }

  async refresh(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this method is the controller's own I/O boundary parser (see class doc): the route only schema-validates shape, `refresh` re-parses every domain value itself.
    input: unknown,
  ): Promise<Result<unknown, ReviewWorkbenchFailure>> {
    const profileId = parseWorkspaceProfileId(
      readObjectField(input, "profileId"),
    );
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return err({ reason: "invalid_input" });
    const refreshed = await this.lifecycle.refresh.refresh({
      profileId: profileId.value,
      reviewId: reviewId.value,
    });
    return refreshed._tag === "err"
      ? err({ reason: refreshed.error.reason })
      : refreshed;
  }

  private async serializedOpen<T>(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    operation: () => Promise<Result<T, ReviewWorkbenchFailure>>,
  ): Promise<Result<T, ReviewWorkbenchFailure>> {
    const key = `${profileId}:${reviewId}`;
    const predecessor = this.openLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.openLocks.set(key, current);
    if (predecessor !== undefined) await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.openLocks.get(key) === current) this.openLocks.delete(key);
    }
  }
}

/** Parses the strict review identity once at the controller I/O boundary. */
function parseReviewIdentity(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the parser that converts its raw local-API input to the typed ReviewIdentity.
  input: unknown,
): ReviewIdentity | undefined {
  const profileId = parseWorkspaceProfileId(
    readObjectField(input, "profileId"),
  );
  const host = parseGitHubHost(readObjectField(input, "host"));
  const owner = parseGitHubOwner(readObjectField(input, "owner"));
  const repo = parseGitHubRepoName(readObjectField(input, "repo"));
  const number = parsePullRequestNumber(readObjectField(input, "number"));
  if (
    profileId._tag === "err" ||
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err"
  )
    return undefined;
  return {
    profileId: profileId.value,
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    prNumber: number.value,
  };
}

function mapPreparationFailure(
  failure: PrepareReviewSessionFailure,
  logs?: Pick<AppLogService, "write">,
): ReviewWorkbenchFailure {
  const mapped: ReviewWorkbenchFailure = (() => {
    switch (failure._tag) {
      case "ProfileNotFound":
        return { reason: "not_found" };
      case "GitHubReadUnavailable":
        return { reason: "github_read" };
      case "GitHubAuthenticationFailed":
        return { reason: "github_auth" };
      case "HeadChanged":
        return { reason: "head_changed" };
      case "PullRequestStateChanged":
        return { reason: "terminal" };
      case "ProfileUnavailable":
      case "SessionStorageUnavailable":
      case "PreparationUnavailable":
      case "PreparationCleanupUnavailable":
        return { reason: "storage" };
    }
  })();
  // ProfileUnavailable, SessionStorageUnavailable, PreparationUnavailable,
  // and PreparationCleanupUnavailable all collapse to "storage"; logging the
  // source tag before mapping keeps that distinction visible in the log.
  logs?.write({
    process: "main",
    level: mapped.reason === "storage" ? "warn" : "debug",
    topic: "review-workbench",
    message: "preparation failure classified while opening a review",
    meta: { tag: failure._tag, reason: mapped.reason },
  });
  return mapped;
}

function mapProjectionFailure(
  failure: WorkbenchProjectionFailure,
): ReviewWorkbenchFailure {
  switch (failure._tag) {
    case "ProfileNotFound":
    case "SessionNotFound":
    case "ReviewNotFound":
      return { reason: "not_found" };
    case "SessionStorageUnavailable":
      return { reason: "storage" };
  }
}

function isRestartableStorageFailure(failure: StorageFailure): boolean {
  return (
    failure.reason === "not_found" ||
    failure.reason === "invalid_json" ||
    failure.reason === "invalid_stored_value"
  );
}

/**
 * Combine the durable own-write journal with the renderer's optimistic
 * in-memory array. Duplicates are harmless to `containsRecentWrites`'s
 * set-based logic, but de-duplicating keeps the union from growing needlessly.
 */
function unionRecentWrites(
  durable: ReadonlyArray<RecentReviewWrite>,
  requested: ReadonlyArray<RecentReviewWrite>,
): ReadonlyArray<RecentReviewWrite> {
  const seen = new Set<string>();
  const union: Array<RecentReviewWrite> = [];
  for (const entry of [...durable, ...requested]) {
    const key = recentWriteDedupeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(entry);
  }
  return union;
}

function recentWriteDedupeKey(entry: RecentReviewWrite): string {
  switch (entry._tag) {
    case "Comment":
      return `Comment:${entry.commentId}`;
    case "ThreadState":
      return `ThreadState:${entry.threadId}:${entry.state}`;
    case "PendingThread":
      return `PendingThread:${entry.threadId}`;
    case "DirectSummaryReview":
      return `DirectSummaryReview:${entry.reviewId}`;
    case "LabelChange":
      // Two label writes are the same write only if they touched the exact
      // same label names; sort so key order doesn't depend on call order.
      return `LabelChange:${[...entry.added].sort().join(",")}:${[...entry.removed].sort().join(",")}`;
    case "AssigneeChange":
      // Mirrors LabelChange: two assignee writes are the same write only if
      // they touched the exact same logins.
      return `AssigneeChange:${[...entry.added].sort().join(",")}:${[...entry.removed].sort().join(",")}`;
    case "ReviewerChange":
      // Mirrors AssigneeChange: two reviewer writes are the same write only
      // if they touched the exact same logins.
      return `ReviewerChange:${[...entry.requested].sort().join(",")}:${[...entry.removed].sort().join(",")}`;
  }
}

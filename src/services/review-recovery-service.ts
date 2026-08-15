import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import { markReviewTerminal } from "../domain/review";
import type { MergeOperation } from "../domain/merge-operation";
import type { GitHubReader } from "../adapters/github/github-adapter";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

export type RecoveryDiagnostic = {
  readonly profileId: WorkspaceProfileId;
  readonly entryName: string;
  readonly reason: "invalid_session";
};

/** Recovers only current preparation, invalid-record, and durable merge evidence. */
export class ReviewRecoveryService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly now: () => IsoTimestamp,
    private readonly options: {
      readonly paths?: PatchdeskPaths;
      readonly artifacts?: ReviewArtifactStorage;
      readonly recordDiagnostic?: (event: RecoveryDiagnostic) => Promise<void>;
      readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
      readonly lifecycleGate?: ReviewLifecycleGate;
      readonly reviews: Pick<ReviewStore, "load" | "save">;
      readonly mergeOperations: Pick<
        MergeOperationStore,
        "listPending" | "removeAfterSessionReceipt"
      >;
      readonly operationCoordinator: ReviewOperationCoordinator;
      readonly github: Pick<GitHubReader, "getMergeOutcome">;
    },
  ) {}

  async reconcile(): Promise<{
    readonly recovered: number;
    readonly failed: number;
  }> {
    const profiles = await this.profiles.list();
    if (profiles._tag === "err") return { recovered: 0, failed: 1 };
    const results = await mapConcurrent(profiles.value, 4, async (profile) =>
      this.options.lifecycleGate === undefined
        ? this.reconcileProfile(profile.id)
        : this.options.lifecycleGate.withProfileLock(profile.id, () =>
            this.reconcileProfile(profile.id),
          ),
    );
    return results.reduce(
      (total, result) => ({
        recovered: total.recovered + result.recovered,
        failed: total.failed + result.failed,
      }),
      { recovered: 0, failed: 0 },
    );
  }

  async reconcileReview(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const work = () =>
      this.reconcileMergeOperations(profileId, reviewId, false);
    return this.options.operationCoordinator.withReviewLock(
      profileId,
      reviewId,
      work,
    );
  }

  private async reconcileProfile(
    profileId: WorkspaceProfileId,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const [merge, scan] = await Promise.all([
      this.reconcileMergeOperations(profileId),
      this.sessions.scanSessionEntries(profileId),
    ]);
    if (scan._tag === "err")
      return { recovered: merge.recovered, failed: merge.failed + 1 };
    const quarantined = await mapConcurrent(
      scan.value.invalidEntries,
      4,
      async (invalid) => {
        const result =
          this.options.artifacts === undefined
            ? undefined
            : invalid.sessionId === undefined
              ? await this.options.artifacts.quarantineInvalidEntry(
                  profileId,
                  invalid.entryName,
                )
              : await this.options.artifacts.quarantine(
                  profileId,
                  invalid.sessionId,
                );
        if (result?._tag === "ok") {
          await this.recordDiagnostic({
            profileId,
            entryName: invalid.entryName,
            reason: "invalid_session",
          });
          return { recovered: 1, failed: 0 };
        }
        return { recovered: 0, failed: 1 };
      },
    );
    return quarantined.reduce(
      (total, result) => ({
        recovered: total.recovered + result.recovered,
        failed: total.failed + result.failed,
      }),
      merge,
    );
  }

  private async reconcileMergeOperations(
    profileId: WorkspaceProfileId,
    onlyReviewId?: ReviewId,
    acquireReviewLock = true,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const profile = await this.profiles.load(profileId);
    if (profile._tag === "err") return { recovered: 0, failed: 1 };
    const operations =
      await this.options.mergeOperations.listPending(profileId);
    if (operations._tag === "err") return { recovered: 0, failed: 1 };
    const selected = operations.value.filter(
      (operation) =>
        onlyReviewId === undefined || operation.reviewId === onlyReviewId,
    );
    const results = await mapConcurrent(selected, 4, (operation) =>
      acquireReviewLock
        ? this.options.operationCoordinator.withReviewLock(
            profileId,
            operation.reviewId,
            () => this.reconcileMergeOperation(profile.value, operation),
          )
        : this.reconcileMergeOperation(profile.value, operation),
    );
    return results.reduce(
      (total, result) => ({
        recovered: total.recovered + result.recovered,
        failed: total.failed + result.failed,
      }),
      { recovered: 0, failed: 0 },
    );
  }

  private async reconcileMergeOperation(
    profile: WorkspaceProfileConfig,
    operation: MergeOperation,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const outcome = await this.options.github.getMergeOutcome({
      profile,
      pr: operation.pr,
    });
    if (outcome._tag === "err") return { recovered: 0, failed: 1 };
    // An open pull request does not prove that an uncertain write was
    // rejected. Keep the durable operation locked and require a later check;
    // recovery must never turn absence of merge evidence into retry authority.
    if (outcome.value.state === "open") return { recovered: 0, failed: 1 };
    const review = await this.options.reviews.load(
      operation.profileId,
      operation.reviewId,
    );
    if (review._tag === "err") return { recovered: 0, failed: 1 };
    const terminal = markReviewTerminal(
      review.value,
      outcome.value.state === "merged" ? "merged" : "closed",
      outcome.value.state === "merged" ? outcome.value.mergedAt : this.now(),
    );
    const saved = await this.options.reviews.save(
      terminal,
      review.value.updatedAt,
    );
    if (saved._tag === "err") return { recovered: 0, failed: 1 };
    const removed =
      await this.options.mergeOperations.removeAfterSessionReceipt(
        operation.profileId,
        operation.sessionId,
      );
    return removed._tag === "ok"
      ? { recovered: 1, failed: 0 }
      : { recovered: 0, failed: 1 };
  }

  private async recordDiagnostic(event: RecoveryDiagnostic): Promise<void> {
    if (this.options.diagnostics !== undefined) {
      await this.options.diagnostics.record({
        profileId: event.profileId,
        category: "recovery",
        phase: event.reason,
        retryable: true,
        detail: event.entryName,
      });
      return;
    }
    if (this.options.recordDiagnostic !== undefined) {
      await this.options.recordDiagnostic(event);
      return;
    }
    if (this.options.paths === undefined) return;
    try {
      await mkdir(this.options.paths.profileReviewsDirectory(event.profileId), {
        recursive: true,
      });
      await appendFile(
        join(
          this.options.paths.profileReviewsDirectory(event.profileId),
          "diagnostics.jsonl",
        ),
        `${JSON.stringify({ at: this.now(), kind: event.reason, entryName: event.entryName.slice(0, 160) })}\n`,
        "utf8",
      );
    } catch {
      /* Quarantine is durable even when diagnostics fail. */
    }
  }
}

async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const values: Array<R> = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const item = items[index];
    if (item === undefined) return;
    values[index] = await map(item);
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return values;
}

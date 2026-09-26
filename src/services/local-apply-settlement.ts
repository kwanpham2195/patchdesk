import type { LocalApplyOperationStore } from "../adapters/storage/local-apply-operation-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import { definedProps } from "../domain/defined-props";
import type {
  ContentHash,
  IsoTimestamp,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import {
  decideLocalApplyRecovery,
  type LocalApplyFile,
  type LocalApplyOperation,
} from "../domain/local-apply-operation";
import { isLocalReview, markLocalDraftsApplied } from "../domain/review";
import type { AppLogService } from "./app-log-service";
import {
  hashFileBytes,
  readCheckoutFile,
  resolveCheckoutRoot,
} from "./local-apply-checkout";
import type { GitReadExecutor } from "./review-worktree-service";

/** Each file's current sha256 in `files` order, undefined when it cannot be read. */
export async function observeLocalApplyFiles(
  root: string,
  files: ReadonlyArray<LocalApplyFile>,
): Promise<ReadonlyArray<ContentHash | undefined>> {
  return Promise.all(
    files.map(async (file) => {
      const bytes = await readCheckoutFile(root, file.path);
      return bytes === undefined ? undefined : hashFileBytes(bytes);
    }),
  );
}

/** Marks the drafted Findings an Apply wrote as applied; false when the Review could not be read or saved. */
export async function markLocalApplyDraftsApplied(
  reviews: Pick<ReviewStore, "load" | "save">,
  operation: LocalApplyOperation,
  appliedAt: IsoTimestamp,
): Promise<boolean> {
  const loaded = await reviews.load(operation.profileId, operation.reviewId);
  if (loaded._tag === "err" || !isLocalReview(loaded.value)) return false;
  const marked = markLocalDraftsApplied(loaded.value, {
    runId: operation.analysisRunId,
    findingIds: operation.findingIds,
    appliedAt,
  });
  if (marked === loaded.value) return true;
  const saved = await reviews.save(marked, loaded.value.updatedAt);
  return saved._tag === "ok";
}

type LocalApplySettlementDependencies = {
  readonly operations: Pick<LocalApplyOperationStore, "load" | "remove">;
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly git: GitReadExecutor;
  readonly logs: Pick<AppLogService, "write">;
  readonly now: () => IsoTimestamp;
};

/**
 * Ends the lock of an Apply left unsettled on a session the Review has moved
 * past (#484, ADR 0050 "Operations and recovery"). The Apply's Findings are
 * bound to that session, so the freshness gate refuses them on any later
 * one and no second write of them can happen; the new session's diff shows
 * the files as they are.
 */
export class LocalApplySettlement {
  constructor(
    private readonly dependencies: LocalApplySettlementDependencies,
  ) {}

  /**
   * Called under the Review lock when the Review moves to `sessionId`, before
   * the Review is read, so a confirmed Apply's drafts are marked applied
   * before they are carried. An Apply on `sessionId` itself is left to
   * Check files: the checkout still holds the bytes it started from.
   */
  async settleEarlierSession(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly sessionId: ReviewSessionId;
    readonly localPath: string;
  }): Promise<void> {
    const stored = await this.dependencies.operations.load(
      input.profileId,
      input.reviewId,
    );
    if (stored._tag === "err" || stored.value === undefined) return;
    const operation = stored.value;
    // `Requested` never reached `git apply`; `Confirmed` is removed by its own confirmation.
    if (
      operation.sessionId === input.sessionId ||
      (operation.state !== "OutcomeUnknown" &&
        operation.state !== "CheckRequired")
    )
      return;
    const root = await resolveCheckoutRoot(
      this.dependencies.git,
      input.localPath,
    );
    const decision = decideLocalApplyRecovery(
      operation.files,
      root === undefined
        ? operation.files.map(() => undefined)
        : await observeLocalApplyFiles(root, operation.files),
    );
    // Bookkeeping, as in a confirmation: a failed mark does not keep the lock.
    const draftsMarked =
      decision === "confirmed"
        ? await markLocalApplyDraftsApplied(
            this.dependencies.reviews,
            operation,
            this.dependencies.now(),
          )
        : undefined;
    const removed = await this.dependencies.operations.remove(
      input.profileId,
      input.reviewId,
    );
    if (removed._tag === "err") return;
    this.dependencies.logs.write({
      process: "main",
      level: decision === "check_required" ? "warn" : "info",
      topic: "local-apply",
      message: "Local apply settled by a move to another session",
      profileId: operation.profileId,
      sessionId: operation.sessionId,
      meta: {
        reviewId: operation.reviewId,
        state: operation.state,
        decision,
        movedTo: input.sessionId,
        ...definedProps({ draftsMarked }),
      },
    });
  }
}

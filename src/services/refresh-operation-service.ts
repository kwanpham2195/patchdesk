import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";

import type { RefreshOperationStore } from "../adapters/storage/refresh-operation-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import type { RefreshOperation } from "../domain/refresh-operation";
import { err, ok, type Result } from "../domain/result";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type {
  ReviewRefreshFailure,
  ReviewRefreshService,
} from "./review-refresh-service";

export type RefreshOperationFailure = {
  readonly reason:
    | "invalid_input"
    | "not_found"
    | "storage"
    | "operation_active"
    | "operation_expired";
};

export type RefreshOperationStatus = {
  readonly operationId: string;
  readonly state:
    | "requested"
    | "prepared"
    | "completed"
    | "interrupted"
    | "failed";
  readonly reason?:
    | "github_read"
    | "github_auth"
    | "not_found"
    | "storage"
    | "head_changed"
    | "terminal";
};

type Dependencies = {
  readonly operations: Pick<
    RefreshOperationStore,
    "acknowledge" | "begin" | "listReviewIds" | "load" | "save"
  >;
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly refresh: Pick<
    ReviewRefreshService,
    | "prepareUnlocked"
    | "reconcilePendingReviewUnlocked"
    | "savePreparedReviewUnlocked"
  >;
  readonly coordinator: Pick<ReviewOperationCoordinator, "withReviewLock">;
  readonly now: () => IsoTimestamp;
  readonly createOperationId?: () => string;
  readonly launch?: (run: () => Promise<void>) => void;
};

/** Owns the durable accepted-then-polled lifecycle for explicit Review refreshes. */
export class RefreshOperationService {
  private readonly volatileTerminalStates = new Map<
    string,
    Extract<
      RefreshOperation["state"],
      { readonly _tag: "Completed" | "Interrupted" | "Failed" }
    >
  >();
  constructor(private readonly dependencies: Dependencies) {}

  async begin(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  }): Promise<Result<RefreshOperationStatus, RefreshOperationFailure>> {
    const accepted = await this.dependencies.coordinator.withReviewLock(
      input.profileId,
      input.reviewId,
      async (): Promise<
        Result<
          { readonly operation: RefreshOperation; readonly launch: boolean },
          RefreshOperationFailure
        >
      > => {
        const review = await this.dependencies.reviews.load(
          input.profileId,
          input.reviewId,
        );
        if (review._tag === "err")
          return err({
            reason:
              review.error.reason === "not_found" ? "not_found" : "storage",
          });
        const operation: RefreshOperation = {
          operationId: this.dependencies.createOperationId?.() ?? randomUUID(),
          profileId: input.profileId,
          reviewId: input.reviewId,
          expectedUpdatedAt: review.value.updatedAt,
          startedAt: this.dependencies.now(),
          state: { _tag: "Requested" },
        };
        const begun = await this.dependencies.operations.begin(operation);
        if (begun._tag === "ok") return ok({ operation, launch: true });
        if (begun.error._tag !== "RefreshOperationExists")
          return err({ reason: "storage" });
        const existing = await this.dependencies.operations.load(
          input.profileId,
          input.reviewId,
        );
        return existing._tag === "ok"
          ? ok({ operation: existing.value, launch: false })
          : err({ reason: "storage" });
      },
    );
    if (accepted._tag === "err") return accepted;
    const { operation, launch: shouldLaunch } = accepted.value;
    if (!shouldLaunch) return ok(statusOf(operation));
    const run = (): Promise<void> =>
      this.dependencies.coordinator.withReviewLock(
        input.profileId,
        input.reviewId,
        () => this.executeUnlocked(operation),
      );
    const launch = this.dependencies.launch ?? ((work) => void work());
    launch(async () => {
      try {
        await run();
      } catch {
        await this.saveTerminal(operation, {
          _tag: "Failed",
          reason: "storage",
        });
      }
    });
    return ok(statusOf(operation));
  }

  async poll(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly operationId: string;
  }): Promise<Result<RefreshOperationStatus, RefreshOperationFailure>> {
    const operation = await this.dependencies.operations.load(
      input.profileId,
      input.reviewId,
    );
    if (operation._tag === "err")
      return err({
        reason:
          operation.error.reason === "not_found"
            ? "operation_expired"
            : "storage",
      });
    if (operation.value.operationId !== input.operationId)
      return err({ reason: "operation_expired" });
    const volatileState = this.volatileTerminalStates.get(input.operationId);
    return ok(
      statusOf(
        volatileState === undefined
          ? operation.value
          : { ...operation.value, state: volatileState },
      ),
    );
  }

  async acknowledge(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly operationId: string;
  }): Promise<Result<void, RefreshOperationFailure>> {
    return this.dependencies.coordinator.withReviewLock(
      input.profileId,
      input.reviewId,
      async () => {
        const operation = await this.dependencies.operations.load(
          input.profileId,
          input.reviewId,
        );
        if (
          operation._tag === "err" ||
          operation.value.operationId !== input.operationId
        )
          return err({ reason: "operation_expired" });
        const volatileState = this.volatileTerminalStates.get(
          input.operationId,
        );
        if (
          volatileState === undefined &&
          (operation.value.state._tag === "Requested" ||
            operation.value.state._tag === "Prepared")
        )
          return err({ reason: "operation_active" });
        const acknowledged = await this.dependencies.operations.acknowledge(
          input.profileId,
          input.reviewId,
        );
        if (acknowledged._tag === "ok")
          this.volatileTerminalStates.delete(input.operationId);
        return acknowledged._tag === "ok"
          ? acknowledged
          : err({ reason: "storage" });
      },
    );
  }

  /** Reconciles every operation in one profile without repeating remote work. */
  async reconcileProfile(
    profileId: WorkspaceProfileId,
  ): Promise<Result<void, RefreshOperationFailure>> {
    const reviewIds =
      await this.dependencies.operations.listReviewIds(profileId);
    if (reviewIds._tag === "err") return err({ reason: "storage" });
    for (const reviewId of reviewIds.value) {
      const reconciled = await this.dependencies.coordinator.withReviewLock(
        profileId,
        reviewId,
        () => this.reconcileUnlocked(profileId, reviewId),
      );
      if (reconciled._tag === "err") return reconciled;
    }
    return ok(undefined);
  }

  private async executeUnlocked(operation: RefreshOperation): Promise<void> {
    const prepared = await this.dependencies.refresh.prepareUnlocked({
      profileId: operation.profileId,
      reviewId: operation.reviewId,
    });
    if (prepared._tag === "err") {
      await this.saveTerminal(operation, failureState(prepared.error));
      return;
    }
    const durablePrepared: RefreshOperation = {
      ...operation,
      expectedUpdatedAt: prepared.value.expectedUpdatedAt,
      state: {
        _tag: "Prepared",
        nextReview: prepared.value.nextReview,
        sessionId: prepared.value.sessionId,
        snapshotHash: prepared.value.snapshotHash,
      },
    };
    await this.dependencies.refresh.reconcilePendingReviewUnlocked(
      prepared.value,
    );
    const savedPrepared =
      await this.dependencies.operations.save(durablePrepared);
    if (savedPrepared._tag === "err") {
      await this.saveTerminal(operation, {
        _tag: "Failed",
        reason: "storage",
      });
      return;
    }
    const committed =
      await this.dependencies.refresh.savePreparedReviewUnlocked(
        prepared.value,
      );
    if (committed._tag === "err") {
      await this.saveTerminal(
        operation,
        committed.error.reason === "conflict"
          ? { _tag: "Interrupted" }
          : { _tag: "Failed", reason: "storage" },
      );
      return;
    }
    await this.saveTerminal(operation, { _tag: "Completed" });
  }

  private async reconcileUnlocked(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, RefreshOperationFailure>> {
    const operation = await this.dependencies.operations.load(
      profileId,
      reviewId,
    );
    if (operation._tag === "err")
      return operation.error.reason === "not_found"
        ? ok(undefined)
        : err({ reason: "storage" });
    if (operation.value.state._tag === "Requested")
      return this.saveTerminalResult(operation.value, { _tag: "Interrupted" });
    if (operation.value.state._tag !== "Prepared") return ok(undefined);
    const review = await this.dependencies.reviews.load(profileId, reviewId);
    if (review._tag === "err")
      return this.saveTerminalResult(operation.value, {
        _tag: "Failed",
        reason: "storage",
      });
    if (isDeepStrictEqual(review.value, operation.value.state.nextReview))
      return this.saveTerminalResult(operation.value, { _tag: "Completed" });
    if (review.value.updatedAt !== operation.value.expectedUpdatedAt)
      return this.saveTerminalResult(operation.value, { _tag: "Interrupted" });
    const saved = await this.dependencies.reviews.save(
      operation.value.state.nextReview,
      operation.value.expectedUpdatedAt,
    );
    if (saved._tag === "ok")
      return this.saveTerminalResult(operation.value, { _tag: "Completed" });
    return this.saveTerminalResult(
      operation.value,
      saved.error._tag === "ReviewConflict"
        ? { _tag: "Interrupted" }
        : { _tag: "Failed", reason: "storage" },
    );
  }

  private async saveTerminal(
    operation: RefreshOperation,
    state: Extract<
      RefreshOperation["state"],
      { readonly _tag: "Completed" | "Interrupted" | "Failed" }
    >,
  ): Promise<void> {
    const saved = await this.dependencies.operations.save({
      ...operation,
      state,
    });
    if (saved._tag === "err")
      this.volatileTerminalStates.set(operation.operationId, state);
  }

  private async saveTerminalResult(
    operation: RefreshOperation,
    state: Extract<
      RefreshOperation["state"],
      { readonly _tag: "Completed" | "Interrupted" | "Failed" }
    >,
  ): Promise<Result<void, RefreshOperationFailure>> {
    const saved = await this.dependencies.operations.save({
      ...operation,
      state,
    });
    if (saved._tag === "err")
      this.volatileTerminalStates.set(operation.operationId, state);
    return saved._tag === "ok" ? saved : err({ reason: "storage" });
  }
}

function failureState(
  failure: ReviewRefreshFailure,
): Extract<RefreshOperation["state"], { readonly _tag: "Failed" }> {
  const reason =
    failure.reason === "invalid_input" ? "storage" : failure.reason;
  return { _tag: "Failed", reason };
}

function statusOf(operation: RefreshOperation): RefreshOperationStatus {
  switch (operation.state._tag) {
    case "Requested":
      return { operationId: operation.operationId, state: "requested" };
    case "Prepared":
      return { operationId: operation.operationId, state: "prepared" };
    case "Completed":
      return { operationId: operation.operationId, state: "completed" };
    case "Interrupted":
      return { operationId: operation.operationId, state: "interrupted" };
    case "Failed":
      return {
        operationId: operation.operationId,
        state: "failed",
        reason: operation.state.reason,
      };
  }
}

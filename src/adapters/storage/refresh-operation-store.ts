import { readdir, rm } from "node:fs/promises";

import type { ReviewId, WorkspaceProfileId } from "../../domain/ids";
import { parseReviewId } from "../../domain/ids";
import {
  parseRefreshOperation,
  type RefreshOperation,
} from "../../domain/refresh-operation";
import { err, ok, type Result } from "../../domain/result";
import {
  isNotFound,
  readJsonFile,
  writeAtomicJson,
  type StorageFailure,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Owns the one durable refresh operation for each Review. */
export class RefreshOperationStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async begin(
    operation: RefreshOperation,
  ): Promise<
    Result<void, StorageFailure | { readonly _tag: "RefreshOperationExists" }>
  > {
    const existing = await this.load(operation.profileId, operation.reviewId);
    if (
      existing._tag === "ok" &&
      (existing.value.state._tag === "Requested" ||
        existing.value.state._tag === "Prepared")
    )
      return err({ _tag: "RefreshOperationExists" });
    if (existing._tag === "err" && existing.error.reason !== "not_found")
      return existing;
    return writeAtomicJson(
      this.paths.refreshOperationFile(operation.profileId, operation.reviewId),
      operation,
    );
  }

  async save(
    operation: RefreshOperation,
  ): Promise<Result<void, StorageFailure>> {
    return writeAtomicJson(
      this.paths.refreshOperationFile(operation.profileId, operation.reviewId),
      operation,
    );
  }

  async load(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<RefreshOperation, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.refreshOperationFile(profileId, reviewId),
    );
    if (stored._tag === "err") return stored;
    const operation = parseRefreshOperation(stored.value);
    return operation._tag === "ok"
      ? operation
      : err({
          _tag: "StorageFailure",
          operation: "read",
          reason: "invalid_stored_value",
        });
  }

  async listReviewIds(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReadonlyArray<ReviewId>, StorageFailure>> {
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(
        this.paths.profileWorkbenchesDirectory(profileId),
      );
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok([]);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
    const reviewIds: ReviewId[] = [];
    for (const entry of entries) {
      const reviewId = parseReviewId(entry);
      if (reviewId._tag === "err") continue;
      const operation = await this.load(profileId, reviewId.value);
      if (operation._tag === "ok") reviewIds.push(reviewId.value);
      else if (operation.error.reason !== "not_found") return operation;
    }
    return ok(reviewIds);
  }

  async acknowledge(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, StorageFailure>> {
    try {
      await rm(this.paths.refreshOperationFile(profileId, reviewId), {
        force: true,
      });
      return ok(undefined);
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
  }
}

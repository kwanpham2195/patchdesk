import { rm } from "node:fs/promises";

import type { ReviewId, WorkspaceProfileId } from "../../domain/ids";
import {
  parseReviewWriteOperation,
  type ReviewWriteOperation,
} from "../../domain/review-write-operation";
import { err, ok, type Result } from "../../domain/result";
import {
  isNotFound,
  readJsonFile,
  type StorageFailure,
  writeAtomicJson,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Refusal to replace an operation whose remote outcome has not been reconciled. */
export type ReviewWriteOperationExists = {
  readonly _tag: "ReviewWriteOperationExists";
};

/** Atomic persistence for the one active GitHub write associated with a Review. */
export class ReviewWriteOperationStore {
  private readonly beginning = new Set<string>();

  constructor(private readonly paths: PatchdeskPaths) {}

  /** Absent storage is no active operation; malformed storage fails closed. */
  async load(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<ReviewWriteOperation | undefined, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.reviewWriteOperationFile(profileId, reviewId),
    );
    if (stored._tag === "err")
      return stored.error.reason === "not_found" ? ok(undefined) : stored;
    const parsed = parseReviewWriteOperation(stored.value);
    if (
      parsed._tag === "err" ||
      parsed.value.profileId !== profileId ||
      parsed.value.reviewId !== reviewId
    )
      return err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      });
    return parsed;
  }

  /** Begin only when no prior operation can still represent a GitHub write. */
  async begin(
    operation: ReviewWriteOperation,
  ): Promise<Result<void, StorageFailure | ReviewWriteOperationExists>> {
    const key = `${operation.profileId}:${operation.reviewId}`;
    if (this.beginning.has(key))
      return err({ _tag: "ReviewWriteOperationExists" });
    this.beginning.add(key);
    try {
      const existing = await this.load(operation.profileId, operation.reviewId);
      if (existing._tag === "err") return existing;
      if (existing.value !== undefined)
        return err({ _tag: "ReviewWriteOperationExists" });
      return await this.write(operation);
    } finally {
      this.beginning.delete(key);
    }
  }

  /** Persist the pre-network outcome-unknown transition. */
  async markOutcomeUnknown(
    operation: ReviewWriteOperation,
  ): Promise<Result<void, StorageFailure>> {
    return this.write(operation);
  }

  /** Persist confirmation before any receipt journal append or API success. */
  async confirm(
    operation: ReviewWriteOperation,
  ): Promise<Result<void, StorageFailure>> {
    return this.write(operation);
  }

  /** A proven rejection clears the intent so a corrected command may retry. */
  async reject(
    operation: ReviewWriteOperation,
  ): Promise<Result<void, StorageFailure>> {
    return this.remove(operation.profileId, operation.reviewId);
  }

  /** Remove only after all confirmation evidence is durable. */
  async remove(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, StorageFailure>> {
    try {
      await rm(this.paths.reviewWriteOperationFile(profileId, reviewId), {
        force: true,
      });
      return ok(undefined);
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok(undefined);
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "io",
      });
    }
  }

  private write(
    operation: ReviewWriteOperation,
  ): Promise<Result<void, StorageFailure>> {
    return writeAtomicJson(
      this.paths.reviewWriteOperationFile(
        operation.profileId,
        operation.reviewId,
      ),
      operation,
    );
  }
}

import { readdir, rm } from "node:fs/promises";

import {
  parseReviewId,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import {
  parseLocalApplyOperation,
  type LocalApplyOperation,
} from "../../domain/local-apply-operation";
import { err, ok, type Result } from "../../domain/result";
import {
  isNotFound,
  readJsonFile,
  writeAtomicJson,
  type StorageFailure,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Refusal to begin while an earlier Apply on the Review is unsettled. */
export type LocalApplyOperationExists = {
  readonly _tag: "LocalApplyOperationExists";
};

/** Atomic persistence for the one Apply suggestion operation of a local Review. */
export class LocalApplyOperationStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  /** Absent storage is no operation; malformed storage fails closed. */
  async load(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<LocalApplyOperation | undefined, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.localApplyOperationFile(profileId, reviewId),
    );
    if (stored._tag === "err")
      return stored.error.reason === "not_found" ? ok(undefined) : stored;
    const parsed = parseLocalApplyOperation(stored.value);
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
    return ok(parsed.value);
  }

  /** A Confirmed record is finished work, so only an unsettled one refuses a new intent. */
  async begin(
    operation: LocalApplyOperation,
  ): Promise<Result<void, StorageFailure | LocalApplyOperationExists>> {
    const existing = await this.load(operation.profileId, operation.reviewId);
    if (existing._tag === "err") return existing;
    if (existing.value !== undefined && existing.value.state !== "Confirmed")
      return err({ _tag: "LocalApplyOperationExists" });
    return this.save(operation);
  }

  /** Persist a state transition of the operation already begun. */
  async save(
    operation: LocalApplyOperation,
  ): Promise<Result<void, StorageFailure>> {
    return writeAtomicJson(
      this.paths.localApplyOperationFile(
        operation.profileId,
        operation.reviewId,
      ),
      operation,
    );
  }

  async remove(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, StorageFailure>> {
    try {
      await rm(this.paths.localApplyOperationFile(profileId, reviewId), {
        force: true,
      });
      return ok(undefined);
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
  }

  /** The Reviews of one profile that hold an Apply operation, for startup recovery. */
  async listReviews(
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
    const candidates = entries.flatMap((entry) => {
      const reviewId = parseReviewId(entry);
      return reviewId._tag === "ok" ? [reviewId.value] : [];
    });
    const held = await Promise.all(
      candidates.map(async (reviewId) => {
        const stored = await readJsonFile(
          this.paths.localApplyOperationFile(profileId, reviewId),
        );
        return stored._tag === "ok" || stored.error.reason !== "not_found";
      }),
    );
    const reviewIds = candidates.filter((_, index) => held[index] === true);
    return ok(reviewIds);
  }
}

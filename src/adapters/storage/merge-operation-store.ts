import { readdir, rm } from "node:fs/promises";

import type { WorkspaceProfileId, ReviewSessionId } from "../../domain/ids";
import { parseReviewSessionId } from "../../domain/ids";
import { parseMergeOperation, type MergeOperation } from "../../domain/merge-operation";
import { err, ok, type Result } from "../../domain/result";
import { readJsonFile, writeAtomicJson, type StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Owns the one current, safe-to-reconcile merge operation for each review session. */
export class MergeOperationStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async begin(operation: MergeOperation): Promise<Result<void, StorageFailure>> {
    return writeAtomicJson(this.paths.mergeOperationFile(operation.profileId, operation.sessionId), operation);
  }

  async markOutcomeUnknown(operation: MergeOperation): Promise<Result<void, StorageFailure>> {
    return this.begin(operation);
  }

  async confirm(operation: MergeOperation): Promise<Result<void, StorageFailure>> {
    return this.begin(operation);
  }

  async reject(operation: MergeOperation): Promise<Result<void, StorageFailure>> {
    return this.begin(operation);
  }

  async load(profileId: WorkspaceProfileId, sessionId: ReviewSessionId): Promise<Result<MergeOperation, StorageFailure>> {
    const stored = await readJsonFile(this.paths.mergeOperationFile(profileId, sessionId));
    if (stored._tag === "err") return stored;
    const operation = parseMergeOperation(stored.value);
    return operation._tag === "ok"
      ? operation
      : err({ _tag: "StorageFailure", operation: "read", reason: "invalid_stored_value" });
  }

  async listPending(profileId: WorkspaceProfileId): Promise<Result<ReadonlyArray<MergeOperation>, StorageFailure>> {
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(this.paths.profileReviewsDirectory(profileId));
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok([]);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
    const pending: MergeOperation[] = [];
    for (const entry of entries) {
      const sessionId = parseReviewSessionId(entry);
      if (sessionId._tag === "err") continue;
      const operation = await this.load(profileId, sessionId.value);
      if (operation._tag === "err") {
        if (operation.error.reason === "not_found") continue;
        return operation;
      }
      if (operation.value.state._tag === "Requested" || operation.value.state._tag === "OutcomeUnknown" || operation.value.state._tag === "Confirmed") pending.push(operation.value);
    }
    return ok(pending);
  }

  async removeAfterSessionReceipt(profileId: WorkspaceProfileId, sessionId: ReviewSessionId): Promise<Result<void, StorageFailure>> {
    try {
      await rm(this.paths.mergeOperationFile(profileId, sessionId), { force: true });
      return ok(undefined);
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
  }
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

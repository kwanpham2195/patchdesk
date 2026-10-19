import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type { InsightType } from "#src/domain/insight-record";
import {
  parseInsightSlotPointer,
  type InsightSlotRecord3,
} from "#src/domain/insight-slot-contract";
import { err, ok, type Result } from "#src/domain/result";
import type { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import { InsightArtifactStore } from "./insight-artifact-store";
import type { StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** One verified slot and the pointer bytes it was read from. */
export type InsightSlotSnapshot = {
  readonly record: InsightSlotRecord3;
  readonly pointerBytes: Uint8Array;
};

/** Stateless pointer resolution for conservative protection, not result/publication authority. */
export class InsightSlotStore {
  private readonly artifacts: InsightArtifactStore;

  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly insightArtifactReader: typeof readBoundedInsightArtifactFile,
  ) {
    this.artifacts = new InsightArtifactStore(paths, insightArtifactReader);
  }

  /** Only definite pointer absence returns undefined; referenced-record/identity failures remain errors, and the identity's profileId and reviewId text must equal the IDs read under. */
  async read(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
  ): Promise<Result<InsightSlotRecord3 | undefined, StorageFailure>> {
    const current = await this.readCurrent(profileId, reviewId, type);
    return current._tag === "err" ? current : ok(current.value?.record);
  }

  /** As `read`, plus the pointer's exact bytes, which a compare-and-replace of the pointer needs as its expected prior. */
  async readCurrent(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
  ): Promise<Result<InsightSlotSnapshot | undefined, StorageFailure>> {
    const bytes = await this.insightArtifactReader(
      this.paths.dataDirectory(),
      this.paths.insightSlotPointerFile(profileId, reviewId, type),
    );
    if (bytes._tag === "err")
      return bytes.error.reason === "not_found" ? ok(undefined) : bytes;
    const pointer = parseInsightSlotPointer(bytes.value);
    if (pointer._tag === "err") return invalidSlotRead();
    const record = await this.artifacts.readSlotRecord3(
      profileId,
      reviewId,
      pointer.value.record,
    );
    if (record._tag === "err") return record;
    if (
      record.value.slotId !== pointer.value.slotId ||
      record.value.version !== pointer.value.version ||
      record.value.type !== type
    )
      return invalidSlotRead();
    const identity = await this.artifacts.readSlotIdentityDescriptor(
      profileId,
      reviewId,
      record.value.identity,
    );
    if (identity._tag === "err") return identity;
    if (identity.value.type !== record.value.type) return invalidSlotRead();
    for (const [root, expected] of [
      [identity.value.profileId, profileId],
      [identity.value.reviewId, reviewId],
    ] as const) {
      const verified = await this.artifacts.verifyTextRootEquals(
        profileId,
        reviewId,
        root,
        expected,
      );
      if (verified._tag === "err") return verified;
    }
    return ok({ record: record.value, pointerBytes: bytes.value });
  }
}

function invalidSlotRead(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}

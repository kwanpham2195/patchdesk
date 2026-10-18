import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type { InsightType } from "#src/domain/insight-record";
import {
  parseInsightSlotPointer,
  type InsightSlotRecord3,
} from "#src/domain/insight-slot-contract";
import { err, ok, type Result } from "#src/domain/result";
import {
  InsightArtifactStore,
  readBoundedInsightArtifactFile,
} from "./insight-artifact-store";
import type { StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Stateless pointer resolution for conservative protection, not result/publication authority. */
export class InsightSlotStore {
  private readonly artifacts: InsightArtifactStore;

  constructor(private readonly paths: PatchdeskPaths) {
    this.artifacts = new InsightArtifactStore(paths);
  }

  /** Only definite pointer absence returns undefined; referenced-record failures remain errors. */
  async read(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
  ): Promise<Result<InsightSlotRecord3 | undefined, StorageFailure>> {
    const bytes = await readBoundedInsightArtifactFile(
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
    return record;
  }
}

function invalidSlotRead(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}

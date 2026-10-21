import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import {
  guideProgressPointerSchema,
  guideReadingStateCodec,
  type GuideProgressPointer,
  type GuideReadingState,
} from "#src/domain/guide-progress";
import * as v from "valibot";

import { encodeInsightArtifactDirect } from "#src/domain/insight-artifact-index";
import {
  insightArtifactHashSchema,
  parseInsightArtifactCanonicalJson,
  type InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import type { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import { commitInsightPointerFile } from "./insight-artifact-pointer-files";
import type { InsightArtifactStore } from "./insight-artifact-store";
import type { StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** The stored progress for one result digest, or none yet; `pointerBytes` is the exact prior a replacement compares. */
export type GuideProgressSnapshot = {
  readonly pointer: GuideProgressPointer;
  readonly pointerBytes: Uint8Array;
  readonly state: GuideReadingState;
};

/**
 * Persistence for new-format reading progress: a canonical pointer per exact result digest, naming an immutable
 * GuideReadingState1 root. It never touches an InsightRecord. An absent pointer is an empty state; a pointer or root
 * that is present but malformed or names another digest is a storage failure and is never reset.
 */
export class GuideProgressStore {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly artifacts: InsightArtifactStore,
    private readonly reader: typeof readBoundedInsightArtifactFile,
  ) {}

  async read(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    digest: string,
  ): Promise<Result<GuideProgressSnapshot | undefined, StorageFailure>> {
    const bytes = await this.reader(
      this.paths.dataDirectory(),
      this.paths.guideProgressPointerFile(profileId, reviewId, digest),
    );
    if (bytes._tag === "err")
      return bytes.error.reason === "not_found" ? ok(undefined) : bytes;
    const pointer = parseInsightArtifactCanonicalJson(
      bytes.value,
      guideProgressPointerSchema,
    );
    if (pointer._tag === "err" || pointer.value.result !== digest)
      return invalid();
    const state = await this.artifacts.readObject(
      profileId,
      reviewId,
      guideReadingStateCodec,
      pointer.value.state,
    );
    if (state._tag === "err") return state;
    if (
      state.value.result !== digest ||
      state.value.version !== pointer.value.version
    )
      return invalid();
    return ok({
      pointer: pointer.value,
      pointerBytes: bytes.value,
      state: state.value,
    });
  }

  /** Replaces the pointer only if it still holds `prior`; false means another save won. */
  async commit(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    digest: string,
    prior: Uint8Array | null,
    version: number,
    state: InsightArtifactReference,
  ): Promise<Result<boolean, StorageFailure>> {
    const encoded = encodeInsightArtifactDirect(guideProgressPointerSchema, {
      format: 2,
      result: v.parse(insightArtifactHashSchema, digest),
      version,
      state,
    });
    if (encoded._tag === "err") return invalid();
    const committed = await commitInsightPointerFile(
      this.paths.dataDirectory(),
      this.paths.guideProgressPointerFile(profileId, reviewId, digest),
      prior,
      encoded.value,
    );
    if (committed._tag === "err") return committed;
    if (committed.value._tag === "committed") return ok(true);
    // An uncertain replacement is not reported as saved or as a conflict.
    return committed.value._tag === "conflict" ? ok(false) : invalid();
  }
}

function invalid(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}

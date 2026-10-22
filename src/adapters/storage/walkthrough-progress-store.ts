import * as v from "valibot";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import {
  walkthroughProgressPointerSchema,
  walkthroughReadingStateCodec,
  type WalkthroughReadingState,
} from "#src/domain/walkthrough-progress";
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

/** Exact prior bytes are the CAS evidence; absent progress is empty, never a repair of malformed progress. */
export type WalkthroughProgressSnapshot = {
  readonly pointerBytes: Uint8Array;
  readonly state: WalkthroughReadingState;
};

/** Digest-keyed immutable progress and its guarded pointer. */
export class WalkthroughProgressStore {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly artifacts: InsightArtifactStore,
    private readonly reader: typeof readBoundedInsightArtifactFile,
  ) {}

  /** Reads only this digest's current pointer and state. */
  async read(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    digest: string,
  ): Promise<Result<WalkthroughProgressSnapshot | undefined, StorageFailure>> {
    const bytes = await this.reader(
      this.paths.dataDirectory(),
      this.paths.walkthroughProgressPointerFile(profileId, reviewId, digest),
    );
    if (bytes._tag === "err")
      return bytes.error.reason === "not_found" ? ok(undefined) : bytes;
    const pointer = parseInsightArtifactCanonicalJson(
      bytes.value,
      walkthroughProgressPointerSchema,
    );
    if (pointer._tag === "err" || pointer.value.result !== digest)
      return invalid();
    const state = await this.artifacts.readObject(
      profileId,
      reviewId,
      walkthroughReadingStateCodec,
      pointer.value.state,
    );
    if (state._tag === "err") return state;
    if (
      state.value.result !== digest ||
      state.value.version !== pointer.value.version
    )
      return invalid();
    return ok({ pointerBytes: bytes.value, state: state.value });
  }

  /** An uncertain replacement is a storage failure, not a conflict or a successful save. */
  async commit(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    digest: string,
    prior: Uint8Array | null,
    version: number,
    state: InsightArtifactReference,
  ): Promise<Result<boolean, StorageFailure>> {
    const hash = v.safeParse(insightArtifactHashSchema, digest);
    if (!hash.success) return invalid();
    const encoded = encodeInsightArtifactDirect(
      walkthroughProgressPointerSchema,
      { format: 2, result: hash.output, version, state },
    );
    if (encoded._tag === "err") return invalid();
    const committed = await commitInsightPointerFile(
      this.paths.dataDirectory(),
      this.paths.walkthroughProgressPointerFile(profileId, reviewId, digest),
      prior,
      encoded.value,
    );
    if (committed._tag === "err") return committed;
    return committed.value._tag === "committed"
      ? ok(true)
      : committed.value._tag === "conflict"
        ? ok(false)
        : invalid();
  }
}

function invalid(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}

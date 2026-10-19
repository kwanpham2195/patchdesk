import { createHash } from "node:crypto";
import * as v from "valibot";

import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import {
  insightArtifactReferenceSchema,
  type InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import {
  encodeWrappedInsightSlotRecord3,
  parseWrappedInsightSlotRecord3,
  type InsightSlotRecord3,
} from "#src/domain/insight-slot-contract";
import {
  parseWrappedInsightSlotIdentityDescriptor,
  type InsightSlotIdentityDescriptor,
  type InsightTextRootDescriptor,
} from "#src/domain/insight-slot-identity-contract";
import { err, ok, type Result } from "#src/domain/result";
import {
  installImmutableInsightArtifactFile,
  MAX_INSIGHT_OBJECT_BYTES,
  type readBoundedInsightArtifactFile,
} from "./insight-artifact-files";
import { containsSensitiveData, type StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";
import { verifyTextRootEquals } from "./insight-text-root-reader";

/** Stateless current-format object storage, without slot or publication authority. */
export class InsightArtifactStore {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly insightArtifactReader: typeof readBoundedInsightArtifactFile,
  ) {}

  /** Verifies the complete SlotRecord3 wrapper, not its transitive referenced graph. */
  async readSlotRecord3(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    reference: InsightArtifactReference,
  ): Promise<Result<InsightSlotRecord3, StorageFailure>> {
    const bytes = await this.readVerifiedObject(profileId, reviewId, reference);
    if (bytes._tag === "err") return bytes;
    const parsed = parseWrappedInsightSlotRecord3(bytes.value);
    return parsed._tag === "err"
      ? artifactReadFailure("invalid_stored_value")
      : parsed;
  }

  /** Verifies the SlotIdentity wrapper and descriptors, not referenced text contents. */
  async readSlotIdentityDescriptor(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    reference: InsightArtifactReference,
  ): Promise<Result<InsightSlotIdentityDescriptor, StorageFailure>> {
    const bytes = await this.readVerifiedObject(profileId, reviewId, reference);
    if (bytes._tag === "err") return bytes;
    const parsed = parseWrappedInsightSlotIdentityDescriptor(bytes.value);
    return parsed._tag === "err"
      ? artifactReadFailure("invalid_stored_value")
      : parsed;
  }

  /** Verifies the TextRoot's index, blocks, digest and counts, and that its UTF-8 bytes equal `expected`. */
  async verifyTextRootEquals(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    root: InsightTextRootDescriptor,
    expected: string,
  ): Promise<Result<void, StorageFailure>> {
    return verifyTextRootEquals(
      (reference) => this.readVerifiedObject(profileId, reviewId, reference),
      root,
      expected,
    );
  }

  private async readVerifiedObject(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    reference: InsightArtifactReference,
  ): Promise<Result<Uint8Array, StorageFailure>> {
    const path = this.paths.insightArtifactObjectFile(
      profileId,
      reviewId,
      reference.hash,
    );
    if (path._tag === "err") return artifactReadFailure("invalid_stored_value");
    const bytes = await this.insightArtifactReader(
      this.paths.dataDirectory(),
      path.value,
    );
    if (bytes._tag === "err")
      return bytes.error.reason === "not_found"
        ? artifactReadFailure("invalid_stored_value")
        : bytes;
    if (
      bytes.value.length !== reference.bytes ||
      createHash("sha256").update(bytes.value).digest("hex") !== reference.hash
    )
      return artifactReadFailure("invalid_stored_value");
    return bytes;
  }

  /** Stages one durable immutable object, not a published slot or validated graph; I/O failure may leave it installed. */
  async writeSlotRecord3(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    value: InsightSlotRecord3,
  ): Promise<Result<InsightArtifactReference, StorageFailure>> {
    const encoded = encodeWrappedInsightSlotRecord3(value);
    if (
      encoded._tag === "err" ||
      encoded.value.length > MAX_INSIGHT_OBJECT_BYTES
    )
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      });
    if (containsSensitiveData(value))
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "sensitive_value",
      });
    const reference = v.safeParse(insightArtifactReferenceSchema, {
      hash: createHash("sha256").update(encoded.value).digest("hex"),
      bytes: encoded.value.length,
    });
    if (!reference.success)
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      });
    const path = this.paths.insightArtifactObjectFile(
      profileId,
      reviewId,
      reference.output.hash,
    );
    if (path._tag === "err")
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      });
    const installed = await installImmutableInsightArtifactFile(
      this.paths.dataDirectory(),
      this.paths.reviewDirectory(profileId, reviewId),
      path.value,
      encoded.value,
    );
    return installed._tag === "err" ? installed : ok(reference.output);
  }
}

function artifactReadFailure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason });
}

import { createHash } from "node:crypto";
import * as v from "valibot";

import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import {
  encodeWrappedInsightArtifact,
  parseWrappedInsightArtifact,
  type InsightArtifactCodec,
} from "#src/domain/insight-artifact-index";
import {
  insightArtifactReferenceSchema,
  type InsightArtifactReference,
  type InsightCanonicalValue,
  type InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import {
  insightSlotRecord3Codec,
  parseWrappedInsightSlotRecord3,
  type InsightSlotRecord3,
} from "#src/domain/insight-slot-contract";
import {
  parseWrappedInsightSlotIdentityDescriptor,
  type InsightSlotIdentityDescriptor,
} from "#src/domain/insight-slot-identity-contract";
import { err, ok, type Result } from "#src/domain/result";
import {
  installImmutableInsightArtifactFile,
  MAX_INSIGHT_OBJECT_BYTES,
  type readBoundedInsightArtifactFile,
} from "./insight-artifact-files";
import { containsSensitiveValue, type StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";
import {
  compareTextRoot,
  verifyTextRootEquals,
} from "./insight-text-root-reader";
import {
  writeInsightTextRoot,
  writeInsightSnapshotTextRoot,
} from "./insight-stream-root-writer";
import type { InsightCaptureSourceFile } from "./insight-capture-source-file";

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

  /** As `verifyTextRootEquals`, but a fully verified TextRoot with other text is `false`; every read or structural failure is an error. */
  async textRootEquals(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    root: InsightTextRootDescriptor,
    expected: string,
  ): Promise<Result<boolean, StorageFailure>> {
    return compareTextRoot(
      (reference) => this.readVerifiedObject(profileId, reviewId, reference),
      root,
      expected,
    );
  }

  /** Verifies the object's bytes against `reference`, then parses the exact wrapper registered under `codec`. */
  async readObject<
    TSchema extends v.GenericSchema<unknown, InsightCanonicalValue>,
  >(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    codec: InsightArtifactCodec<TSchema>,
    reference: InsightArtifactReference,
  ): Promise<Result<v.InferOutput<TSchema>, StorageFailure>> {
    const bytes = await this.readVerifiedObject(profileId, reviewId, reference);
    if (bytes._tag === "err") return bytes;
    const parsed = parseWrappedInsightArtifact(codec, bytes.value);
    return parsed._tag === "err"
      ? artifactReadFailure("invalid_stored_value")
      : parsed;
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

  /** Stages one durable immutable SlotRecord3, not a published slot or validated graph; I/O failure may leave it installed. */
  async writeSlotRecord3(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    value: InsightSlotRecord3,
  ): Promise<Result<InsightArtifactReference, StorageFailure>> {
    return this.writeObject(
      profileId,
      reviewId,
      insightSlotRecord3Codec,
      value,
    );
  }

  /** Stages one wrapped canonical object after parsing `value` against the codec's closed schema; I/O failure may leave it installed. */
  async writeObject<
    TSchema extends v.GenericSchema<unknown, InsightCanonicalValue>,
  >(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    codec: InsightArtifactCodec<TSchema>,
    value: v.InferInput<TSchema>,
  ): Promise<Result<InsightArtifactReference, StorageFailure>> {
    const encoded = encodeWrappedInsightArtifact(codec, value);
    if (
      encoded._tag === "err" ||
      encoded.value.length > MAX_INSIGHT_OBJECT_BYTES
    )
      return artifactWriteFailure("invalid_stored_value");
    // Contract-fixed field names such as `authorization` are not secrets, so only values are scanned.
    if (containsSensitiveValue(value))
      return artifactWriteFailure("sensitive_value");
    return this.installBytes(profileId, reviewId, encoded.value);
  }

  /** Stages one raw blob of at most 16 KiB, named R<Blob>. */
  async writeBlob(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    bytes: Uint8Array,
  ): Promise<Result<InsightArtifactReference, StorageFailure>> {
    if (bytes.length > MAX_INSIGHT_OBJECT_BYTES)
      return artifactWriteFailure("invalid_stored_value");
    // Credential patterns are ASCII, so a lossy decode of arbitrary bytes still exposes them.
    if (containsSensitiveValue(Buffer.from(bytes).toString("utf8")))
      return artifactWriteFailure("sensitive_value");
    return this.installBytes(profileId, reviewId, bytes);
  }

  /** Fully scans immutable metadata, then stages bounded text blocks and their multi-level index; an abort stops before the next block. */
  async writeTextRoot(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    text: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<InsightTextRootDescriptor, StorageFailure>> {
    return writeInsightTextRoot(
      this,
      profileId,
      reviewId,
      text,
      (bytes) => this.installBytes(profileId, reviewId, bytes),
      options,
    );
  }

  /** Only a privately constructed, completely scanned snapshot can reach the text blob installation sink. */
  async writeSnapshotTextRoot(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    snapshot: InsightCaptureSourceFile,
    options: { readonly signal?: AbortSignal },
  ): Promise<Result<InsightTextRootDescriptor, StorageFailure>> {
    return writeInsightSnapshotTextRoot(
      this,
      profileId,
      reviewId,
      snapshot,
      (bytes) => this.installBytes(profileId, reviewId, bytes),
      options,
    );
  }

  private async installBytes(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    bytes: Uint8Array,
  ): Promise<Result<InsightArtifactReference, StorageFailure>> {
    const reference = v.safeParse(insightArtifactReferenceSchema, {
      hash: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    if (!reference.success) return artifactWriteFailure("invalid_stored_value");
    const path = this.paths.insightArtifactObjectFile(
      profileId,
      reviewId,
      reference.output.hash,
    );
    if (path._tag === "err")
      return artifactWriteFailure("invalid_stored_value");
    const installed = await installImmutableInsightArtifactFile(
      this.paths.dataDirectory(),
      this.paths.reviewDirectory(profileId, reviewId),
      path.value,
      bytes,
    );
    return installed._tag === "err" ? installed : ok(reference.output);
  }
}

function artifactWriteFailure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "write", reason });
}

function artifactReadFailure(
  reason: StorageFailure["reason"],
): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason });
}

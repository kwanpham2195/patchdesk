import type { GuideInventoryEntry } from "#src/domain/guide";
import {
  encodeInsightArtifactCanonicalJson,
  type InsightArtifactIndexDescriptor,
} from "#src/domain/insight-artifact-scalars";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type { NarrativePatch } from "#src/domain/narrative-patch";
import { walkthroughHunkCodec } from "#src/domain/walkthrough-preparation";
import type { InsightArtifactStore } from "./insight-artifact-store";
import { InsightResultStore } from "./insight-result-store";
import { err, ok, type Result } from "#src/domain/result";

type HunkCaptureFailure =
  | "aborted"
  | "invalid_source"
  | "sensitive_value"
  | "io";

/** Stores and reads back every exact hunk before its prepared root can be installed. */
export async function captureWalkthroughHunks(
  artifacts: InsightArtifactStore,
  scope: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  },
  patch: NarrativePatch,
  inventory: ReadonlyArray<GuideInventoryEntry>,
  options: { readonly signal?: AbortSignal },
): Promise<Result<InsightArtifactIndexDescriptor, HunkCaptureFailure>> {
  const { profileId, reviewId } = scope;
  const store = new InsightResultStore(artifacts, profileId, reviewId);
  let index = await store.emptyIndex("WalkthroughHunk1");
  if (index._tag === "err") return err("io");
  let ordinal = 0;
  for (const file of patch.files) {
    const entry = inventory[file.ordinal];
    if (entry === undefined) return err("invalid_source");
    for (const hunk of file.hunks) {
      if (options.signal?.aborted) return err("aborted");
      if (hunk.path !== entry.newPath) return err("invalid_source");
      const [path, header, filePrefix, raw] = await Promise.all([
        artifacts.writeTextRoot(profileId, reviewId, hunk.path, options),
        artifacts.writeTextRoot(profileId, reviewId, hunk.header, options),
        artifacts.writeTextRoot(profileId, reviewId, hunk.filePrefix, options),
        artifacts.writeTextRoot(profileId, reviewId, hunk.raw, options),
      ]);
      if (
        path._tag === "err" ||
        header._tag === "err" ||
        filePrefix._tag === "err" ||
        raw._tag === "err"
      ) {
        const sensitive = [path, header, filePrefix, raw].some(
          (result) =>
            result._tag === "err" && result.error.reason === "sensitive_value",
        );
        return err(sensitive ? "sensitive_value" : "io");
      }
      const value = {
        id: hunk.id,
        fileId: entry.id,
        path: path.value,
        header: header.value,
        filePrefix: filePrefix.value,
        raw: raw.value,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
      };
      const written = await artifacts.writeObject(
        profileId,
        reviewId,
        walkthroughHunkCodec,
        value,
      );
      if (written._tag === "err") return err("io");
      const read = await artifacts.readObject(
        profileId,
        reviewId,
        walkthroughHunkCodec,
        written.value,
      );
      if (
        read._tag === "err" ||
        encodeInsightArtifactCanonicalJson(read.value) !==
          encodeInsightArtifactCanonicalJson(value)
      )
        return err("io");
      for (const [root, expected] of [
        [read.value.path, hunk.path],
        [read.value.header, hunk.header],
        [read.value.filePrefix, hunk.filePrefix],
        [read.value.raw, hunk.raw],
      ] as const) {
        if (
          (
            await artifacts.verifyTextRootEquals(
              profileId,
              reviewId,
              root,
              expected,
            )
          )._tag === "err"
        )
          return err("io");
      }
      index = await store.appendIndex(
        "WalkthroughHunk1",
        index.value,
        ordinal,
        written.value,
      );
      if (index._tag === "err") return err("io");
      const readIndex = await store.readIndex(
        "WalkthroughHunk1",
        index.value,
        ordinal,
        1,
      );
      if (
        readIndex._tag === "err" ||
        readIndex.value.length !== 1 ||
        readIndex.value[0]?.value.hash !== written.value.hash ||
        readIndex.value[0].value.bytes !== written.value.bytes
      )
        return err("io");
      ordinal += 1;
    }
  }
  return ordinal === patch.hunks.length && index.value.count === ordinal
    ? ok(index.value)
    : err("io");
}

import type { GuideInventoryEntry } from "#src/domain/guide";
import {
  encodeInsightArtifactCanonicalJson,
  type InsightArtifactIndexDescriptor,
  type InsightArtifactReference,
  type InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type { NarrativePatch } from "#src/domain/narrative-patch";
import { walkthroughHunkCodec } from "#src/domain/walkthrough-preparation";
import type { InsightArtifactStore } from "./insight-artifact-store";
import { InsightResultStore } from "./insight-result-store";
import { InsightIndexBuilder } from "./insight-index-builder";
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
  const builder = new InsightIndexBuilder(
    artifacts,
    profileId,
    reviewId,
    "WalkthroughHunk1",
  );
  let ordinal = 0;
  // Reuse only durably installed and verified text within this capture, capped at 256 KiB of keys.
  const texts = new Map<
    string,
    Promise<Result<InsightTextRootDescriptor, HunkCaptureFailure>>
  >();
  const text = (
    value: string,
  ): Promise<Result<InsightTextRootDescriptor, HunkCaptureFailure>> => {
    const cached = texts.get(value);
    if (cached !== undefined) {
      texts.delete(value);
      texts.set(value, cached);
      return cached;
    }
    const pending = (async () => {
      const root = await artifacts.writeTextRoot(
        profileId,
        reviewId,
        value,
        options,
      );
      if (root._tag === "err")
        return err(
          root.error.reason === "sensitive_value"
            ? ("sensitive_value" as const)
            : ("io" as const),
        );
      const verified = await artifacts.verifyTextRootEquals(
        profileId,
        reviewId,
        root.value,
        value,
      );
      return verified._tag === "err" ? err("io" as const) : root;
    })();
    if (Buffer.byteLength(value) <= 16 * 1024) {
      const oldest = texts.keys().next().value;
      if (texts.size >= 16 && oldest !== undefined) texts.delete(oldest);
      texts.set(value, pending);
    }
    return pending;
  };
  for (const file of patch.files) {
    const entry = inventory[file.ordinal];
    if (entry === undefined) return err("invalid_source");
    for (let at = 0; at < file.hunks.length; at += 8) {
      const captured = await Promise.all(
        file.hunks
          .slice(at, at + 8)
          .map(
            async (
              hunk,
            ): Promise<
              Result<InsightArtifactReference, HunkCaptureFailure>
            > => {
              if (options.signal?.aborted) return err("aborted");
              if (hunk.path !== entry.newPath) return err("invalid_source");
              const [path, header, filePrefix, raw] = await Promise.all([
                text(hunk.path),
                text(hunk.header),
                text(hunk.filePrefix),
                text(hunk.raw),
              ]);
              if (
                path._tag === "err" ||
                header._tag === "err" ||
                filePrefix._tag === "err" ||
                raw._tag === "err"
              ) {
                const sensitive = [path, header, filePrefix, raw].some(
                  (result) =>
                    result._tag === "err" && result.error === "sensitive_value",
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
              return ok(written.value);
            },
          ),
      );
      for (const hunk of captured) {
        if (hunk._tag === "err") return hunk;
        if ((await builder.append(hunk.value))._tag === "err") return err("io");
        ordinal += 1;
      }
    }
  }
  const index = await builder.finish();
  if (index._tag === "err") return err("io");
  let fileAt = 0;
  let fileEnd = patch.files[0]?.hunks.length ?? 0;
  for (let at = 0; at < ordinal; at += 16) {
    if (options.signal?.aborted) return err("aborted");
    const window = await store.readIndex(
      "WalkthroughHunk1",
      index.value,
      at,
      16,
    );
    if (window._tag === "err") return err("io");
    for (const [offset, entry] of window.value.entries()) {
      const hunk = await artifacts.readObject(
        profileId,
        reviewId,
        walkthroughHunkCodec,
        entry.value,
      );
      const expected = patch.hunks[at + offset];
      while (at + offset >= fileEnd && fileAt < patch.files.length) {
        fileAt += 1;
        fileEnd += patch.files[fileAt]?.hunks.length ?? 0;
      }
      if (
        entry.key !== String(at + offset).padStart(16, "0") ||
        hunk._tag === "err" ||
        expected === undefined ||
        hunk.value.id !== expected.id ||
        hunk.value.fileId !==
          inventory[patch.files[fileAt]?.ordinal ?? -1]?.id ||
        hunk.value.oldStart !== expected.oldStart ||
        hunk.value.oldLines !== expected.oldLines ||
        hunk.value.newStart !== expected.newStart ||
        hunk.value.newLines !== expected.newLines
      )
        return err("io");
      for (const field of ["path", "header", "filePrefix", "raw"] as const) {
        if (
          (
            await artifacts.verifyTextRootEquals(
              profileId,
              reviewId,
              hunk.value[field],
              expected[field],
            )
          )._tag === "err"
        )
          return err("io");
      }
    }
  }
  return ordinal === patch.hunks.length && index.value.count === ordinal
    ? ok(index.value)
    : err("io");
}

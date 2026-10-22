import * as v from "valibot";
import {
  guideInventoryEntrySchema,
  buildGuideInventory,
} from "#src/domain/guide";
import { encodeInsightArtifactCanonicalJson } from "#src/domain/insight-artifact-scalars";
import { parseNarrativePatch } from "#src/domain/narrative-patch";
import {
  walkthroughHunkCodec,
  type WalkthroughPreparedInput,
} from "#src/domain/walkthrough-preparation";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightArtifactStore } from "./insight-artifact-store";
import { InsightResultStore } from "./insight-result-store";

/** Verifies every prepared hunk against captured patch and inventory, including uncited text. */
export async function validateWalkthroughPreparedHunks(
  artifacts: InsightArtifactStore,
  scope: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  },
  prepared: WalkthroughPreparedInput,
  options: { readonly signal?: AbortSignal },
): Promise<Result<ReadonlySet<string>, "rejected">> {
  const { profileId, reviewId } = scope;
  const store = new InsightResultStore(artifacts, profileId, reviewId);
  const [patch, inventory] = await Promise.all([
    store.readText(prepared.patch, 64 * 1024 * 1024),
    store.readText(prepared.inventory, 64 * 1024 * 1024),
  ]);
  if (patch._tag === "err" || inventory._tag === "err") return err("rejected");
  const parsed = parseNarrativePatch(patch.value);
  const expectedInventory = buildGuideInventory(patch.value);
  let entries;
  try {
    entries = v.safeParse(
      v.array(guideInventoryEntrySchema),
      JSON.parse(inventory.value),
    );
  } catch {
    return err("rejected");
  }
  if (
    parsed._tag === "err" ||
    expectedInventory._tag === "err" ||
    !entries.success ||
    parsed.value.hunks.length === 0 ||
    prepared.hunks.count !== parsed.value.hunks.length ||
    !entries.output.every((e, at) => e.id === `f${at + 1}`)
  )
    return err("rejected");
  if (
    encodeInsightArtifactCanonicalJson(entries.output) !==
    encodeInsightArtifactCanonicalJson(expectedInventory.value)
  )
    return err("rejected");
  const ids = new Set<string>();
  let ordinal = 0;
  for (const file of parsed.value.files) {
    const inventoryEntry = entries.output[file.ordinal];
    if (inventoryEntry === undefined) return err("rejected");
    for (const expected of file.hunks) {
      if (options.signal?.aborted) return err("rejected");
      const window = await store.readIndex(
        "WalkthroughHunk1",
        prepared.hunks,
        ordinal,
        1,
      );
      const entry = window._tag === "ok" ? window.value[0] : undefined;
      if (
        entry === undefined ||
        entry.key !== String(ordinal).padStart(16, "0")
      )
        return err("rejected");
      const hunk = await artifacts.readObject(
        profileId,
        reviewId,
        walkthroughHunkCodec,
        entry.value,
      );
      if (
        hunk._tag === "err" ||
        hunk.value.id !== expected.id ||
        hunk.value.fileId !== inventoryEntry.id ||
        expected.path !== inventoryEntry.newPath ||
        hunk.value.oldStart !== expected.oldStart ||
        hunk.value.oldLines !== expected.oldLines ||
        hunk.value.newStart !== expected.newStart ||
        hunk.value.newLines !== expected.newLines
      )
        return err("rejected");
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
          return err("rejected");
      }
      ids.add(expected.id);
      ordinal += 1;
    }
  }
  return ok(ids);
}

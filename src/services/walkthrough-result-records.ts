import type * as v from "valibot";
import type {
  InsightArtifactCodec,
  InsightIndexElement,
} from "#src/domain/insight-artifact-index";
import type {
  InsightArtifactIndexDescriptor,
  InsightCanonicalValue,
} from "#src/domain/insight-artifact-scalars";
import {
  walkthroughSectionCodec,
  walkthroughChapterCodec,
  walkthroughCitationCodec,
} from "#src/domain/walkthrough-result";
import { walkthroughHunkCodec } from "#src/domain/walkthrough-preparation";
import type { WalkthroughReadFailure } from "#src/domain/walkthrough-progress";
import { err, ok, type Result } from "#src/domain/result";
import {
  walkthroughReadFailure,
  type WalkthroughResultView,
} from "./walkthrough-result-reader";

/** Reads exactly one typed index record, preserving storage failures. */
export async function walkthroughRecordAt<
  S extends v.GenericSchema<unknown, InsightCanonicalValue>,
>(
  view: WalkthroughResultView,
  element: InsightIndexElement,
  codec: InsightArtifactCodec<S>,
  index: InsightArtifactIndexDescriptor,
  ordinal: number,
): Promise<Result<v.InferOutput<S>, WalkthroughReadFailure>> {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= index.count)
    return err("invalid_cursor");
  const found = await view.store.readIndex(element, index, ordinal, 1);
  if (found._tag === "err") return err(walkthroughReadFailure(found.error));
  const entry = found.value[0];
  if (entry === undefined) return err("invalid_result");
  const record = await view.artifacts.readObject(
    view.profileId,
    view.reviewId,
    codec,
    entry.value,
  );
  return record._tag === "err"
    ? err(walkthroughReadFailure(record.error))
    : record;
}

/** Decimal section identities address their global ordinal and are checked after dereferencing. */
export async function walkthroughSection(
  view: WalkthroughResultView,
  sectionId: string,
): Promise<
  Result<
    v.InferOutput<typeof walkthroughSectionCodec.schema>,
    WalkthroughReadFailure
  >
> {
  const section = await walkthroughRecordAt(
    view,
    "WalkthroughSection1",
    walkthroughSectionCodec,
    view.root.sections,
    Number(sectionId.slice(1)) - 1,
  );
  return section._tag === "err"
    ? section
    : section.value.id === sectionId
      ? section
      : err("invalid_result");
}

/** Chapter spans must contain the requesting section. */
export async function walkthroughChapter(
  view: WalkthroughResultView,
  chapterId: string,
  ordinal: number,
): Promise<
  Result<
    { readonly id: string; readonly title: string },
    WalkthroughReadFailure
  >
> {
  const chapter = await walkthroughRecordAt(
    view,
    "WalkthroughChapter1",
    walkthroughChapterCodec,
    view.root.chapters,
    Number(chapterId.slice(1)) - 1,
  );
  if (chapter._tag === "err") return chapter;
  if (
    chapter.value.id !== chapterId ||
    ordinal < chapter.value.firstSection ||
    ordinal >= chapter.value.firstSection + chapter.value.sectionCount
  )
    return err("invalid_result");
  const title = await view.store.readText(chapter.value.title, 320);
  if (
    title._tag === "ok" &&
    (title.value.length > 80 ||
      title.value.trim() !== title.value ||
      title.value.length === 0)
  )
    return err("invalid_result");
  return title._tag === "err"
    ? err(walkthroughReadFailure(title.error))
    : ok({ id: chapterId, title: title.value });
}

/** A text selector grants access only to a hunk cited by this section, or to the stored uncited complement. */
export async function walkthroughSelectedHunk(
  view: WalkthroughResultView,
  sectionId: string | null,
  hunkId: string,
): Promise<
  Result<
    v.InferOutput<typeof walkthroughHunkCodec.schema>,
    WalkthroughReadFailure
  >
> {
  const hunk = await walkthroughRecordAt(
    view,
    "WalkthroughHunk1",
    walkthroughHunkCodec,
    view.root.hunks,
    Number(hunkId.slice(1)) - 1,
  );
  if (hunk._tag === "err") return hunk;
  if (hunk.value.id !== hunkId) return err("invalid_result");
  const canonical = await view.store.readIndex(
    "WalkthroughHunk1",
    view.root.hunks,
    Number(hunkId.slice(1)) - 1,
    1,
  );
  if (canonical._tag === "err")
    return err(walkthroughReadFailure(canonical.error));
  const reference = canonical.value[0]?.value;
  if (reference === undefined) return err("invalid_result");
  const section =
    sectionId === null ? null : await walkthroughSection(view, sectionId);
  if (section?._tag === "err") return section;
  const index = section === null ? view.root.uncited : section.value.citations;
  for (let offset = 0; offset < index.count; offset += 10) {
    const entries = await view.store.readIndex(
      section === null ? "WalkthroughHunk1" : "WalkthroughCitation1",
      index,
      offset,
      10,
    );
    if (entries._tag === "err")
      return err(walkthroughReadFailure(entries.error));
    for (const entry of entries.value) {
      if (section === null) {
        if (
          entry.value.hash === reference.hash &&
          entry.value.bytes === reference.bytes
        )
          return hunk;
      } else {
        const record = await view.artifacts.readObject(
          view.profileId,
          view.reviewId,
          walkthroughCitationCodec,
          entry.value,
        );
        if (record._tag === "err")
          return err(walkthroughReadFailure(record.error));
        if (record.value.hunkId === hunkId) {
          return reference.hash === record.value.hunk.hash &&
            reference.bytes === record.value.hunk.bytes
            ? hunk
            : err("invalid_result");
        }
      }
    }
  }
  return err("invalid_cursor");
}

import * as v from "valibot";

import { guideInventoryEntrySchema, type GuideFileId } from "#src/domain/guide";
import type { GuideFileSummary } from "#src/domain/guide-progress";
import { guideInventoryEntryCodec } from "#src/domain/guide-result";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import type { GuideResultView } from "./guide-result-reader";

/** A page's items are added until this many encoded bytes; the hard reply bound is 32 KiB. */
export const GUIDE_PAGE_BUDGET_BYTES = 24 * 1024;
export const GUIDE_PAGE_MAX_ITEMS = 10;
/** The first part of a long text rides in the list page; continuation pages carry more. */
export const GUIDE_FIRST_PART_UNITS = 1_200;
export const GUIDE_TEXT_PART_UNITS = 2_048;
/** An inventory entry whose metadata is larger than this has no summary; its identity still navigates. */
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_PATH_UNITS = 1_024;

/** Position inside a bounded read: an item ordinal, or a block and unit inside a TextRoot. */
export type GuideCursorBody = {
  readonly d: string;
  readonly k: string;
  readonly s: string;
  readonly p: number;
  readonly u?: number;
};

const cursorSchema = v.strictObject({
  d: v.string(),
  k: v.string(),
  s: v.string(),
  p: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  u: v.exactOptional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
});

/** Cursors name no object or path; they bind the result digest, page kind, scope and position, and nothing else. */
export function encodeCursor(body: GuideCursorBody): string {
  return Buffer.from(JSON.stringify(body)).toString("base64url");
}

/** The fields of a cursor without checking its scope; callers that pin state read the scope first. */
export function cursorBody(cursor: string): GuideCursorBody | undefined {
  try {
    const parsed = v.safeParse(
      cursorSchema,
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** Actual UTF-8 bytes of a value's JSON, which is what a reply is bounded by. */
export function encodedBytes<T extends object>(value: T): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Absent means the start; a cursor for another digest, kind or scope is invalid, never remapped. */
export function decodeCursor(
  cursor: string | null,
  expected: {
    readonly digest: string;
    readonly kind: string;
    readonly scope: string;
  },
): { readonly p: number; readonly u: number } | undefined {
  if (cursor === null) return { p: 0, u: 0 };
  try {
    const parsed = v.safeParse(
      cursorSchema,
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    return parsed.success &&
      parsed.output.d === expected.digest &&
      parsed.output.k === expected.kind &&
      parsed.output.s === expected.scope
      ? { p: parsed.output.p, u: parsed.output.u ?? 0 }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The short facts a list row shows; null when the entry is unreadable or too large to summarize within bounds. */
export async function fileSummaryOf(
  view: GuideResultView,
  record: InsightArtifactReference,
): Promise<
  | { readonly fileId: GuideFileId; readonly summary: GuideFileSummary | null }
  | undefined
> {
  const stored = await view.artifacts.readObject(
    view.profileId,
    view.reviewId,
    guideInventoryEntryCodec,
    record,
  );
  if (stored._tag === "err") return undefined;
  const text = await view.store.readText(stored.value.entry, MAX_ENTRY_BYTES);
  if (text._tag === "err")
    return { fileId: stored.value.fileId, summary: null };
  try {
    const entry = v.safeParse(
      guideInventoryEntrySchema,
      JSON.parse(text.value),
    );
    if (!entry.success || entry.output.id !== stored.value.fileId)
      return { fileId: stored.value.fileId, summary: null };
    const { oldPath, newPath, status, additions, deletions, evidence } =
      entry.output;
    return {
      fileId: stored.value.fileId,
      summary:
        oldPath.length > MAX_PATH_UNITS || newPath.length > MAX_PATH_UNITS
          ? null
          : { oldPath, newPath, status, additions, deletions, evidence },
    };
  } catch {
    return { fileId: stored.value.fileId, summary: null };
  }
}

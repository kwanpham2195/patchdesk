import type { GuideInventoryEntry, RetainedGuide } from "#src/domain/guide";
import { tokenizeUnifiedPatchLines } from "#src/domain/unified-patch";
import { parseReviewDiff, type ParsedReviewDiff } from "@/review-diff-data";

/** One complete file block from the retained result, shared by its appearances. */
export type GuideFileEvidence = {
  readonly patch: string;
  readonly diff: ParsedReviewDiff | undefined;
};

/** Decompose the snapshot once; repeated appearances reuse the same parsed evidence. */
export function decomposeGuidePatch(
  guide: RetainedGuide,
): ReadonlyMap<GuideInventoryEntry["id"], GuideFileEvidence> {
  const lines = guide.patchText.split("\n");
  const headers = tokenizeUnifiedPatchLines(lines).filter(
    (token) => token.kind === "file_header",
  );
  return new Map(
    guide.inventory.map((file, index) => {
      const start = headers[index]?.index;
      if (start === undefined)
        throw new Error("Retained Guide inventory has no file block");
      const patch = lines
        .slice(start, headers[index + 1]?.index ?? lines.length)
        .join("\n");
      return [
        file.id,
        {
          patch,
          diff: file.evidence === "text" ? parseReviewDiff(patch) : undefined,
        },
      ];
    }),
  );
}

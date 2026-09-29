import type { SelectedLineRange } from "@pierre/diffs";

import { fingerprintPatchAnchor } from "../../domain/diff-anchor";
import { parseRepoRelativePath } from "../../domain/ids";
import { parseUnifiedPatch } from "../../domain/patch";
import type { LocalCommentLocation } from "./components/review-diff-view";

/** Why a gutter range cannot hold one note or comment: GitHub anchors a range on one side of one hunk. */
type DiffLineRangeRefusal = "crosses_sides" | "crosses_hunks";

export type DiffLineRangeResult =
  | { readonly _tag: "ok"; readonly location: LocalCommentLocation }
  | {
      readonly _tag: "refused";
      readonly reason: DiffLineRangeRefusal;
      readonly startLine: number;
      readonly line: number;
    };

/**
 * The note or comment location a gutter click or drag on `path` selects in
 * the shown `patch` (#552). Pierre reports a drag in pointer order, so an
 * upward drag arrives with `start` after `end`.
 */
export function diffLineRangeLocation(
  patch: string,
  path: string,
  range: SelectedLineRange,
): DiffLineRangeResult {
  const startLine = Math.min(range.start, range.end);
  const line = Math.max(range.start, range.end);
  if (
    (range.side !== "additions" && range.side !== "deletions") ||
    (range.endSide !== undefined && range.endSide !== range.side)
  )
    return { _tag: "refused", reason: "crosses_sides", startLine, line };
  const location: LocalCommentLocation = {
    path,
    startLine,
    line,
    side: range.side === "additions" ? "new" : "old",
  };
  if (startLine === line) return { _tag: "ok", location };
  // The diff names a renamed file by its new path, while its old-side lines sit under the old one.
  const sidePath =
    location.side === "old"
      ? (parseUnifiedPatch(patch).find((file) => file.newPath === path)
          ?.oldPath ?? path)
      : path;
  const parsedPath = parseRepoRelativePath(sidePath);
  const inOneHunk =
    parsedPath._tag === "ok" &&
    fingerprintPatchAnchor(patch, { ...location, path: parsedPath.value }) !==
      undefined;
  return inOneHunk
    ? { _tag: "ok", location }
    : { _tag: "refused", reason: "crosses_hunks", startLine, line };
}

/** "Line 12" or "Lines 12–18", the range a composer or saved note names. */
export function diffLineRangeLabel(startLine: number, line: number): string {
  return startLine === line
    ? `Line ${String(line)}`
    : `Lines ${String(startLine)}–${String(line)}`;
}

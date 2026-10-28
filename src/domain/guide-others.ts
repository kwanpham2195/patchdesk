import type { GuideFileSummary } from "./guide-progress";

/** Unknown summaries stay visible with changed code rather than disappearing from Others. */
export function guideOtherSection(
  file: GuideFileSummary | null,
): "changed" | "renamed" | "deleted" {
  if (file?.status === "renamed") return "renamed";
  if (file?.status === "removed") return "deleted";
  return "changed";
}

/** Status order and descending line churn are applied before paging, with patch order breaking ties. */
export function compareGuideOthers(
  left: GuideFileSummary | null,
  right: GuideFileSummary | null,
): number {
  const order = { changed: 0, renamed: 1, deleted: 2 };
  const section =
    order[guideOtherSection(left)] - order[guideOtherSection(right)];
  if (section !== 0) return section;
  return guideOtherSection(left) === "changed"
    ? (right === null ? 0 : right.additions + right.deletions) -
        (left === null ? 0 : left.additions + left.deletions)
    : 0;
}

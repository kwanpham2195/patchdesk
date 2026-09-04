import type { CodeViewLineSelection } from "@pierre/diffs";

import type { LocalCommentAuthoring } from "./review-diff-view";
/**
 * The gutter affordance that opens the inline composer on the hovered line.
 * Hover writes the line onto the button itself so one shared button serves
 * every row Pierre renders.
 */
export function renderReviewDiffGutterUtility(
  getHoveredLine: () =>
    | {
        readonly lineNumber: number;
        readonly side: "additions" | "deletions";
      }
    | undefined,
  item: { readonly id: string; readonly type: "diff" | "file" },
  localCommentAuthoring: LocalCommentAuthoring | undefined,
  beginAuthoring: (selection: CodeViewLineSelection | null) => void,
): React.JSX.Element | null {
  if (localCommentAuthoring?.enabled !== true || item.type !== "diff")
    return null;
  const baseTitle = `Add comment on ${item.id}`;
  return (
    <button
      type="button"
      className="inline-flex size-5 items-center justify-center rounded border border-border/60 bg-card text-sm font-medium leading-none text-muted-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={baseTitle}
      title={baseTitle}
      onPointerEnter={(event) => {
        const hovered = getHoveredLine();
        if (hovered === undefined) return;
        event.currentTarget.dataset.lineNumber = String(hovered.lineNumber);
        event.currentTarget.dataset.lineSide = hovered.side;
        event.currentTarget.title = `${baseTitle} line ${hovered.lineNumber}`;
        event.currentTarget.setAttribute(
          "aria-label",
          `${baseTitle} line ${hovered.lineNumber}`,
        );
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        const lineNumber = Number(event.currentTarget.dataset.lineNumber);
        const side = event.currentTarget.dataset.lineSide;
        if (
          !Number.isInteger(lineNumber) ||
          lineNumber < 1 ||
          (side !== "additions" && side !== "deletions")
        )
          return;
        const locationSide = side === "additions" ? "new" : "old";
        if (
          localCommentAuthoring.canAuthor?.({
            path: item.id,
            startLine: lineNumber,
            line: lineNumber,
            side: locationSide,
          }) === false
        )
          return;
        beginAuthoring({
          id: item.id,
          range: { start: lineNumber, end: lineNumber, side },
        });
      }}
    >
      +
    </button>
  );
}

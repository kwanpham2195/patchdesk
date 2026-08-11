import { useMemo } from "react";

import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import { extractFindingEvidenceHunk } from "../../../domain/patch";
import { ReviewDiffView } from "./review-diff-view";

/** Read-only, exact diff evidence for a Finding; it exposes no authoring or GitHub capability. */
export function FindingEvidenceHunk({
  patch,
  anchor,
}: {
  readonly patch: string;
  readonly anchor: {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
  };
}): React.JSX.Element | null {
  const evidence = useMemo(
    () => extractFindingEvidenceHunk(patch, anchor),
    [anchor, patch],
  );
  const parsed = useMemo(
    () => evidence === undefined ? undefined : parseReviewDiff(evidence.patch),
    [evidence],
  );
  if (evidence === undefined || parsed === undefined) return null;
  const preferences: ReviewViewPreferences = {
    ...DEFAULT_REVIEW_VIEW_PREFERENCES,
    fileMode: "all",
  };
  return (
    <section aria-label={`Finding evidence ${evidence.path}`} className="mt-3 overflow-hidden rounded-md border">
      <p className="border-b bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
        {evidence.path}:{evidence.selectedRange.start}
        {evidence.selectedRange.end === evidence.selectedRange.start ? "" : `–${evidence.selectedRange.end}`}
      </p>
      <div className="max-h-80 overflow-auto">
        <ReviewDiffView
          patch={evidence.patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath={evidence.path}
          selectedRange={evidence.selectedRange}
          preferences={preferences}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          virtualized={false}
        />
      </div>
    </section>
  );
}

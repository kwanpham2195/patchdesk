import { useId, useMemo } from "react";

import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import {
  buildSuggestionPreviewPatch,
  type SuggestionTarget,
} from "../../../domain/finding-suggestion";
import { ReviewDiffView } from "./review-diff-view";

const suggestionPreviewPreferences: ReviewViewPreferences = {
  ...DEFAULT_REVIEW_VIEW_PREFERENCES,
  fileMode: "all",
};

/** The caller resolves the target, so this preview and the Finding's add action share one gate. */
export function FindingSuggestionPreview({
  target,
  code,
}: {
  readonly target: SuggestionTarget;
  readonly code: string;
}): React.JSX.Element {
  const headingId = useId();
  const preview = useMemo(
    () => buildSuggestionPreviewPatch(target, code),
    [code, target],
  );
  const parsed = useMemo(() => parseReviewDiff(preview), [preview]);
  const range = `${target.path}:${target.startLine}${
    target.line === target.startLine ? "" : `–${target.line}`
  }`;
  return (
    <section
      aria-labelledby={headingId}
      className="mt-3 overflow-hidden rounded-md border"
    >
      <p
        id={headingId}
        className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      >
        Suggested change
        <span className="ml-2 font-mono">{range}</span>
      </p>
      <div className="max-h-[75vh] resize-y overflow-auto">
        <ReviewDiffView
          patch={preview}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath={target.path}
          preferences={suggestionPreviewPreferences}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          virtualized={false}
          showToolbar={false}
        />
      </div>
    </section>
  );
}

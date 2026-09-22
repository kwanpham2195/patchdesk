import { useMemo } from "react";

import {
  DEFAULT_REVIEW_VIEW_PREFERENCES,
  type ReviewViewPreferences,
} from "@/review-view-preferences";
import { parseReviewDiff } from "@/review-diff-data";
import { definedProps } from "../../../domain/defined-props";
import {
  buildSuggestionPreviewPatch,
  resolveSuggestionTarget,
} from "../../../domain/finding-suggestion";
import type { AnalysisResult } from "../analysis-headline";
import { ReviewDiffView } from "./review-diff-view";

const suggestionPreviewPreferences: ReviewViewPreferences = {
  ...DEFAULT_REVIEW_VIEW_PREFERENCES,
  fileMode: "all",
};

/**
 * Read-only preview of the exact replacement a Finding carries, rendered as a
 * diff against the represented patch's own lines. It mounts no editor and
 * exposes no GitHub capability: the maintainer reads it, then authorizes the
 * write from the Finding's action row. It owns its own precondition and
 * renders nothing for a Finding without a replacement, without a represented
 * patch, or whose cited range no single hunk holds.
 */
export function FindingSuggestionPreview({
  patch,
  finding,
}: {
  readonly patch: string | undefined;
  readonly finding: AnalysisResult["findings"][number];
}): React.JSX.Element | null {
  const code = finding.suggestedReplacement?.code;
  const target = useMemo(
    () =>
      patch === undefined
        ? undefined
        : resolveSuggestionTarget(
            patch,
            definedProps({
              file: finding.file,
              lineStart: finding.lineStart,
              lineEnd: finding.lineEnd,
              diffSide: finding.diffSide,
            }),
          ),
    [finding.diffSide, finding.file, finding.lineEnd, finding.lineStart, patch],
  );
  const preview = useMemo(
    () =>
      target === undefined || code === undefined
        ? undefined
        : buildSuggestionPreviewPatch(target, code),
    [code, target],
  );
  const parsed = useMemo(
    () => (preview === undefined ? undefined : parseReviewDiff(preview)),
    [preview],
  );
  if (target === undefined || preview === undefined || parsed === undefined)
    return null;
  const range = `${target.path}:${target.startLine}${
    target.line === target.startLine ? "" : `–${target.line}`
  }`;
  return (
    <section
      aria-label={`Suggested change ${range}`}
      className="mt-3 overflow-hidden rounded-md border"
    >
      <p className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Suggested change
        <span className="ml-2 font-mono">{range}</span>
      </p>
      <div
        aria-label="Resizable suggested change"
        className="max-h-[75vh] resize-y overflow-auto"
      >
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
        />
      </div>
    </section>
  );
}

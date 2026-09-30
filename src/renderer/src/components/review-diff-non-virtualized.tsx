import { useCallback } from "react";
import { type DiffLineAnnotation, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, PatchDiff } from "@pierre/diffs/react";

import { AccessiblePatch } from "./review-diff-accessible-patch";
import { FileChangeCounts, FileHeaderRow } from "./review-diff-file-header";
import { renderReviewDiffAnnotation } from "./review-diff-finding-card";
import type {
  ReviewDiffRenderSiteProps,
  ReviewInlineAnnotation,
} from "./review-diff-view";
import { pierreDiffColorsCss } from "@/diff-colors";
import { diffThemeFor } from "@/diff-theme-preferences";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  DEFAULT_LINE_DIFF_TYPE,
  DIFF_CODE_METRICS,
  gutterAuthoringOptions,
} from "./review-diff-render-options";

type NonVirtualizedReviewDiffProps = Pick<
  ReviewDiffRenderSiteProps,
  | "patch"
  | "selectedPatch"
  | "selectedPath"
  | "selectedRange"
  | "preferences"
  | "syntaxHighlightingStatus"
  | "localCommentAuthoring"
  | "beginAccessibleAuthoring"
  | "selectedFile"
  | "themePreferences"
  | "appearance"
  | "expandUnchanged"
  | "expandSelectedRange"
  | "selectedAnnotations"
  | "selectedLines"
  | "fileStatsByPath"
  | "findingCountsByPath"
  | "decorateConversationThread"
  | "bodyContext"
  | "onOpenFindingInAnalysis"
  | "beginRangeAuthoring"
>;

export function NonVirtualizedReviewDiff({
  patch,
  selectedPatch,
  selectedPath,
  selectedRange,
  preferences,
  syntaxHighlightingStatus,
  localCommentAuthoring,
  beginAccessibleAuthoring,
  selectedFile,
  themePreferences,
  appearance,
  expandUnchanged,
  expandSelectedRange,
  selectedAnnotations,
  selectedLines,
  fileStatsByPath,
  findingCountsByPath,
  decorateConversationThread,
  bodyContext,
  onOpenFindingInAnalysis,
  beginRangeAuthoring,
}: NonVirtualizedReviewDiffProps): React.JSX.Element {
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewInlineAnnotation | undefined>) =>
      renderReviewDiffAnnotation(
        annotation,
        decorateConversationThread,
        onOpenFindingInAnalysis,
        bodyContext,
      ),
    [bodyContext, decorateConversationThread, onOpenFindingInAnalysis],
  );
  const renderPatchHeader = useCallback(
    (file: FileDiffMetadata) => {
      const stats = fileStatsByPath.get(file.name) ?? {
        path: file.name,
        additions: 0,
        deletions: 0,
      };
      const findings = findingCountsByPath?.get(file.name);
      return (
        <FileHeaderRow
          file={file}
          stats={
            <FileChangeCounts
              stats={stats}
              {...(findings === undefined ? {} : { findings })}
            />
          }
        />
      );
    },
    [fileStatsByPath, findingCountsByPath],
  );
  if (syntaxHighlightingStatus === "loading") {
    return (
      <div
        className="flex min-h-48 items-center justify-center gap-2 p-3 text-sm text-muted-foreground"
        role="status"
        aria-label="Loading syntax highlighting"
      >
        <Spinner aria-hidden="true" />
        Loading syntax highlighting…
      </div>
    );
  }
  if (syntaxHighlightingStatus === "unavailable") {
    return (
      <>
        <Alert variant="destructive" className="m-3">
          <AlertTitle>Syntax highlighting unavailable</AlertTitle>
          <AlertDescription>
            Showing plain text. Restart Patchdesk to retry.
          </AlertDescription>
        </Alert>
        <AccessiblePatch
          patch={preferences.fileMode === "all" ? patch : selectedPatch}
          virtualized={false}
          {...(selectedRange === undefined ? {} : { selectedRange })}
          {...(localCommentAuthoring === undefined
            ? {}
            : {
                localCommentAuthoring,
                onAuthorLine: beginAccessibleAuthoring,
              })}
        />
      </>
    );
  }
  const options = {
    theme: diffThemeFor(themePreferences),
    themeType: appearance,
    unsafeCSS: pierreDiffColorsCss,
    disableBackground: !preferences.backgrounds,
    disableLineNumbers: !preferences.lineNumbers,
    diffStyle: preferences.diffStyle,
    overflow: preferences.overflow,
    hunkSeparators: "line-info" as const,
    expandUnchanged: expandUnchanged || expandSelectedRange,
    lineDiffType: DEFAULT_LINE_DIFF_TYPE,
    diffIndicators: "bars" as const,
    lineHoverHighlight: "both" as const,
  };
  const authoringEnabled = localCommentAuthoring?.enabled === true;
  // `disableWorkerPool` stays: these evidence surfaces render outside
  // `DiffWorkbench`, with no pool above them, and show small filtered hunks.
  return selectedFile === undefined ? (
    <PatchDiff
      patch={selectedPatch}
      disableWorkerPool
      className="visual-diff min-h-0 overflow-x-auto font-mono"
      style={DIFF_CODE_METRICS}
      options={{
        ...options,
        ...gutterAuthoringOptions(authoringEnabled, (range) =>
          beginRangeAuthoring(selectedPath ?? "diff", range),
        ),
      }}
      lineAnnotations={selectedAnnotations}
      selectedLines={selectedLines?.range ?? null}
      renderAnnotation={renderAnnotation}
      renderCustomHeader={renderPatchHeader}
    />
  ) : (
    <FileDiff
      fileDiff={selectedFile}
      disableWorkerPool
      className="visual-diff min-h-0 overflow-x-auto font-mono"
      style={DIFF_CODE_METRICS}
      options={{
        ...options,
        ...gutterAuthoringOptions(authoringEnabled, (range) =>
          beginRangeAuthoring(selectedFile.name, range),
        ),
      }}
      lineAnnotations={selectedAnnotations}
      selectedLines={selectedLines?.range ?? null}
      renderAnnotation={renderAnnotation}
      renderCustomHeader={renderPatchHeader}
    />
  );
}

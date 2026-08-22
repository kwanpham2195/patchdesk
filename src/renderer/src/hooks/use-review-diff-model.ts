import { useEffect, useMemo } from "react";
import {
  getFiletypeFromFileName,
  getThemes,
  preloadHighlighter,
  type CodeViewDiffItem,
  type CodeViewLineSelection,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import { reviewContextControl } from "@/review-context-control";
import { reviewDiffItemVersion } from "@/review-diff-item-version";
import { compareTreePaths } from "@/review-diff-order";
import { toDiffLineAnnotation } from "../review-diff-annotations";
import {
  selectPatch,
  useReviewDiffHydration,
  type ReviewDiffSourceSession,
} from "./use-review-diff-hydration";
import {
  useReviewDiffScrollState,
  type ReviewDiffScrollState,
} from "./use-review-diff-scroll-state";
import type { DiffThemePreferences } from "../diff-theme-preferences";
import type {
  ReviewInlineAnnotation,
  SelectedDiffRange,
} from "../components/review-diff-view";
import type { ReviewContextStatus } from "@/review-context-control";

const TREE_ORDER_SORT_LIMIT = 256;

type ReviewDiffHydrationInput = {
  patch: string;
  sourceSession?: ReviewDiffSourceSession;
  selectedPath?: string;
};

export type ReviewDiffModel = {
  readonly contextControl: ReturnType<typeof reviewContextControl>;
  readonly contextStatus: ReviewContextStatus;
  readonly browserSupportsPierre: boolean;
  readonly selectedPatch: string;
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly visibleFiles: ReadonlyArray<FileDiffMetadata>;
  readonly selectedFile: FileDiffMetadata | undefined;
  readonly selectedAnnotations: ReturnType<typeof toDiffLineAnnotation>[];
  readonly items: ReadonlyArray<
    CodeViewDiffItem<ReviewInlineAnnotation | undefined>
  >;
  readonly selectedLines: CodeViewLineSelection | null;
  readonly activePathRef: { current: string | undefined };
  readonly resolveActiveFilePathAt: ReviewDiffScrollState<
    ReviewInlineAnnotation | undefined
  >["resolveActiveFilePathAt"];
  readonly setViewerContainer: ReviewDiffScrollState<
    ReviewInlineAnnotation | undefined
  >["setViewerContainer"];
  readonly handleCodeViewScroll: ReviewDiffScrollState<
    ReviewInlineAnnotation | undefined
  >["handleCodeViewScroll"];
};

/**
 * Composes the sole hydration owner with the settled model consumed by the
 * primary Pierre CodeView. The live hydration map remains available only for
 * context capability checks; rendered files and item versions use the settled
 * map so CodeView is not mutated during a scroll.
 */
export function useReviewDiffModel({
  patch,
  parsedFiles,
  selectedPath,
  selectedRange,
  annotations,
  preferences,
  collapsedPaths,
  expandUnchanged,
  themePreferences,
  sourceSession,
  virtualized,
  viewer,
  onActiveFileChange,
}: {
  readonly patch: string;
  readonly parsedFiles: ReadonlyArray<FileDiffMetadata>;
  readonly selectedPath: string | undefined;
  readonly selectedRange: SelectedDiffRange | undefined;
  readonly annotations: ReadonlyArray<ReviewInlineAnnotation>;
  readonly preferences: Pick<ReviewViewPreferences, "fileMode">;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly expandUnchanged: boolean;
  readonly themePreferences: DiffThemePreferences;
  readonly sourceSession: ReviewDiffSourceSession | undefined;
  readonly virtualized: boolean;
  readonly viewer: RefObject<CodeViewHandle<
    ReviewInlineAnnotation | undefined
  > | null>;
  readonly onActiveFileChange: ((path: string) => void) | undefined;
}): ReviewDiffModel {
  // Walkthrough cards render a filtered hunk with virtualized={false}; full
  // source hydration would pair that partial patch with an entire file.
  const hydrationSourceSession = virtualized ? sourceSession : undefined;
  const hydrationInput: ReviewDiffHydrationInput = { patch };
  if (selectedPath !== undefined) hydrationInput.selectedPath = selectedPath;
  if (hydrationSourceSession !== undefined)
    hydrationInput.sourceSession = hydrationSourceSession;
  const {
    hydratedFiles,
    contextStatus,
    rawFilePatches,
    rawPatchesByPath,
    hydrateFiles,
  } = useReviewDiffHydration(hydrationInput);
  const {
    settledHydratedFiles,
    activePathRef,
    setViewerContainer,
    resolveActiveFilePathAt,
    handleCodeViewScroll,
  } = useReviewDiffScrollState({
    viewer,
    hydratedFiles,
    fileMode: preferences.fileMode,
    itemCount: parsedFiles.length,
    onActiveFileChange,
  });

  const selectedPatch = useMemo(
    () => selectPatch(rawPatchesByPath, rawFilePatches, patch, selectedPath),
    [patch, rawFilePatches, rawPatchesByPath, selectedPath],
  );
  const files = useMemo(() => {
    // Read the settled map, not the live one. A layout mutation during a
    // scroll can blank Pierre's virtualized viewport.
    const hydrated = parsedFiles.map(
      (file) => settledHydratedFiles.get(file.name) ?? file,
    );
    return parsedFiles.length > TREE_ORDER_SORT_LIMIT
      ? hydrated
      : hydrated.sort((left, right) => compareTreePaths(left.name, right.name));
  }, [parsedFiles, settledHydratedFiles]);
  const visibleFiles = useMemo(
    () =>
      preferences.fileMode === "selected" && selectedPath !== undefined
        ? files.filter((file) => file.name === selectedPath)
        : files,
    [files, preferences.fileMode, selectedPath],
  );
  const selectedFile = useMemo(
    () =>
      selectedPath === undefined
        ? undefined
        : files.find((file) => file.name === selectedPath),
    [files, selectedPath],
  );
  const selectedAnnotations = useMemo(
    () =>
      annotations.flatMap((annotation) =>
        selectedPath === undefined || annotation.path === selectedPath
          ? [toDiffLineAnnotation(annotation)]
          : [],
      ),
    [annotations, selectedPath],
  );
  const annotationKey = useMemo(
    () =>
      annotations
        .map((annotation) =>
          [
            annotation.id,
            annotation.path,
            annotation.start,
            annotation.end,
            annotation.side,
            annotation.title,
            annotation.explanation,
            annotation.localComposer?.path ?? "",
            annotation.localComposer?.startLine ?? "",
            annotation.localComposer?.line ?? "",
            // The composer's effective pending state and owner node must bump
            // the controlled item version when its state changes.
            annotation.localComposer?.pendingReview === undefined
              ? ""
              : JSON.stringify([
                  annotation.localComposer.pendingReview.state.state,
                  annotation.localComposer.pendingReview.state.state ===
                  "pending"
                    ? annotation.localComposer.pendingReview.state.nodeId
                    : "",
                  annotation.localComposer.pendingReview.busy,
                ]),
            annotation.pendingConversation === undefined
              ? ""
              : `${annotation.pendingConversation.status}\u0000${annotation.pendingConversation.body}`,
            annotation.pendingReviewWrite === undefined
              ? ""
              : `${annotation.pendingReviewWrite.status}\u0000${annotation.pendingReviewWrite.action}\u0000${annotation.pendingReviewWrite.body}\u0000${annotation.pendingReviewWrite.message ?? ""}`,
            annotation.pendingReviewThread === undefined
              ? ""
              : `${annotation.pendingReviewThread.nodeId}\u0000${annotation.pendingReviewThread.threadId}\u0000${annotation.pendingReviewThread.body}`,
            annotation.conversationThread === undefined
              ? ""
              : JSON.stringify([
                  annotation.conversationThread.state,
                  ...annotation.conversationThread.comments.map(
                    (comment) =>
                      `${comment.id}\u0000${comment.author}\u0000${comment.body}`,
                  ),
                ]),
          ].join("\u0000"),
        )
        .join("\u0001"),
    [annotations],
  );
  const items = useMemo(
    () =>
      visibleFiles.map<CodeViewDiffItem<ReviewInlineAnnotation | undefined>>(
        (file) => ({
          id: file.name,
          type: "diff",
          fileDiff: file,
          annotations: annotations.flatMap((annotation) =>
            annotation.path === file.name
              ? [toDiffLineAnnotation(annotation)]
              : [],
          ),
          collapsed: collapsedPaths.has(file.name),
          version: reviewDiffItemVersion({
            collapsed: collapsedPaths.has(file.name),
            hydrated: settledHydratedFiles.has(file.name),
            annotationKey,
          }),
        }),
      ),
    [
      annotationKey,
      annotations,
      collapsedPaths,
      settledHydratedFiles,
      visibleFiles,
    ],
  );
  const selectedLines = useMemo(
    () =>
      selectedPath === undefined || selectedRange === undefined
        ? null
        : {
            id: selectedPath,
            range: {
              start: selectedRange.start,
              end: selectedRange.end,
              side:
                selectedRange.side === "new"
                  ? ("additions" as const)
                  : ("deletions" as const),
            },
          },
    [selectedPath, selectedRange],
  );

  const browserSupportsPierre =
    globalThis.CSSStyleSheet !== undefined &&
    "replaceSync" in CSSStyleSheet.prototype;
  useEffect(() => {
    if (virtualized || !browserSupportsPierre) return;
    const langs = Array.from(
      new Set(
        parsedFiles.flatMap((file) => {
          const language = getFiletypeFromFileName(file.name);
          return language === undefined || language === "text"
            ? []
            : [language];
        }),
      ),
    );
    if (langs.length === 0) return;
    void preloadHighlighter({
      langs,
      themes: getThemes(themePreferences),
    });
  }, [browserSupportsPierre, parsedFiles, themePreferences, virtualized]);

  const hydrationPathKey = useMemo(
    () => items.map((item) => item.id).join("\u0000"),
    [items],
  );
  const hydrationPaths = useMemo(
    () => (hydrationPathKey === "" ? [] : hydrationPathKey.split("\u0000")),
    [hydrationPathKey],
  );
  useEffect(() => {
    void hydrateFiles(hydrationPaths);
  }, [hydrateFiles, hydrationPaths]);

  const hasExpandableRenderedFile = useMemo(
    () =>
      items.some((item) => {
        if (item.type !== "diff") return false;
        const hydrated = hydratedFiles.get(item.id);
        return hydrated !== undefined && !hydrated.isPartial;
      }),
    [hydratedFiles, items],
  );
  const contextControl = reviewContextControl({
    hasSourceSession:
      hydrationSourceSession?.profileId !== undefined &&
      hydrationSourceSession?.sessionId !== undefined,
    status: contextStatus,
    hasExpandableRenderedFile,
    expanded: expandUnchanged,
  });

  return {
    contextControl,
    contextStatus,
    browserSupportsPierre,
    selectedPatch,
    files,
    visibleFiles,
    selectedFile,
    selectedAnnotations,
    items,
    selectedLines,
    activePathRef,
    resolveActiveFilePathAt,
    setViewerContainer,
    handleCodeViewScroll,
  };
}

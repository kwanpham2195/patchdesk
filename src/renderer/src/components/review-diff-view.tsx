import {
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { CodeView, FileDiff, PatchDiff, type CodeViewHandle } from "@pierre/diffs/react";
import {
  ChevronsUpDown,
  Columns2,
  FileCode2,
  Files,
  MoveHorizontal,
  Rows3,
  WrapText,
} from "lucide-react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import { parseRepoRelativePath } from "../../../domain/ids";
import type { ReviewAnchorFingerprint } from "../../../domain/review-batch";
import { fingerprintPatchAnchor } from "../../../domain/review-anchor";
import type { ResolvedAppearance } from "@/appearance-preferences";
import {
  diffThemeFor,
  loadDiffThemePreferences,
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "@/diff-theme-preferences";
import type { FileChangeStats } from "@/review-diff-data";
import { activeFilePathAtScrollTop } from "@/review-diff-active-file";
import { reviewDiffItemVersion } from "@/review-diff-item-version";
import { compareTreePaths } from "@/review-diff-order";
import {
  reviewContextControl,
} from "@/review-context-control";
import { registerPierreThemeLoaders } from "@/pierre-theme-catalog";
import {
  selectPatch,
  useReviewDiffHydration,
  type ReviewDiffSourceSession,
} from "@/hooks/use-review-diff-hydration";
import { useReviewDiffQaScrollDiagnostics } from "@/hooks/use-review-diff-qa-scroll-diagnostics";
import {
  useProgressiveReviewDiffStream,
  type PierreCodeView,
} from "@/hooks/use-progressive-review-diff-stream";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

registerPierreThemeLoaders();

// Theme colors belong to the selected Pierre/Shiki descriptor. Patchdesk only
// owns the code metrics at this boundary so changing an independently saved
// light or dark theme changes both syntax and surface color as expected.
const DIFF_CODE_METRICS = {
  fontSize: "13px",
  lineHeight: "20px",
  fontFamily: '"Berkeley Mono", "JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as CSSProperties;
const TREE_ORDER_SORT_LIMIT = 256;

export type SelectedDiffRange = {
  readonly start: number;
  readonly end: number;
  readonly side: "new" | "old";
};

export type ReviewInlineAnnotation = {
  readonly id: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly side: "new" | "old";
  readonly severity: string;
  readonly title: string;
  readonly explanation: string;
  readonly localComposer?: {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly onCancel: () => void;
    readonly onSave: (body: string) => Promise<void>;
  };
};

export type LocalCommentLocation = {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
};

export type LocalCommentAuthoring = {
  readonly enabled: boolean;
  readonly canAuthor?: (input: LocalCommentLocation) => boolean;
  /** Reports the exact current diff range before a composer is opened. */
  readonly onSelectionChange?: (input: LocalCommentLocation) => void;
  readonly onSave: (input: {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
    readonly fingerprint?: ReviewAnchorFingerprint;
    readonly body: string;
  }) => Promise<void>;
};


function FileChangeCounts({
  stats,
}: {
  readonly stats: FileChangeStats;
}): React.JSX.Element {
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums"
      data-file-header-change-stats
      data-additions={stats.additions}
      data-deletions={stats.deletions}
      aria-label={`${stats.additions} additions, ${stats.deletions} deletions`}
    >
      <span className="text-emerald-700 dark:text-emerald-400">+{stats.additions}</span>
      <span className="text-rose-700 dark:text-rose-400">-{stats.deletions}</span>
    </span>
  );
}

type ReviewDiffViewProps = {
  readonly patch: string;
  readonly parsedFiles: ReadonlyArray<FileDiffMetadata>;
  readonly fileStatsByPath: ReadonlyMap<string, FileChangeStats>;
  readonly selectedPath?: string | undefined;
  readonly selectedRange?: SelectedDiffRange;
  readonly annotations?: ReadonlyArray<ReviewInlineAnnotation>;
  readonly preferences: ReviewViewPreferences;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly onCollapsedPathsChange: (paths: ReadonlySet<string>) => void;
  readonly onActiveFileChange?: (path: string) => void;
  /** Optional main-process-only source seam used to hydrate omitted hunk context. */
  readonly sourceSession?: ReviewDiffSourceSession;
  readonly virtualized?: boolean;
  /** Local-only composer. Callers omit it for walkthroughs and stale snapshots. */
  readonly localCommentAuthoring?: LocalCommentAuthoring;
};

function ReviewDiffSurface({
  patch,
  parsedFiles,
  fileStatsByPath,
  selectedPath,
  selectedRange,
  annotations = [],
  preferences,
  collapsedPaths,
  onPreferencesChange,
  onCollapsedPathsChange,
  onActiveFileChange,
  sourceSession,
  virtualized = true,
  localCommentAuthoring,
}: ReviewDiffViewProps): React.JSX.Element {
  const [expandUnchanged, setExpandUnchanged] = useState(false);
  const [appearance, setAppearance] = useState<ResolvedAppearance>(() => document.documentElement.dataset.appearance === "light" ? "light" : "dark");
  const [themePreferences, setThemePreferences] = useState<DiffThemePreferences>(() =>
    loadDiffThemePreferences(),
  );
  const viewer = useRef<CodeViewHandle<ReviewInlineAnnotation | undefined>>(null);
  const activePathRef = useRef<string | undefined>(undefined);
  const viewerContainer = useRef<HTMLDivElement>(null);
  const [viewerElement, setViewerElement] = useState<HTMLDivElement | null>(null);
  const [authoringSelection, setAuthoringSelection] = useState<CodeViewLineSelection | null>(null);
  const setViewerContainer = useCallback((node: HTMLDivElement | null): void => {
    viewerContainer.current = node;
    setViewerElement(node);
  }, []);
  // Walkthrough cards render one filtered hunk with virtualized={false}. Full
  // source hydration would pair that partial patch with the entire file and
  // make Pierre calculate impossible trailing context.
  const hydrationSourceSession = virtualized ? sourceSession : undefined;
  const {
    hydratedFiles,
    contextStatus,
    rawFilePatches,
    rawPatchesByPath,
    hydrateFiles,
  } = useReviewDiffHydration({
    patch,
    ...(selectedPath === undefined ? {} : { selectedPath }),
    ...(hydrationSourceSession === undefined ? {} : { sourceSession: hydrationSourceSession }),
  });
  useEffect(() => {
    const onAppearance = (event: Event): void => {
      const value = (event as CustomEvent<ResolvedAppearance>).detail;
      if (value === "light" || value === "dark") setAppearance(value);
    };
    window.addEventListener("patchdesk:appearance", onAppearance);
    return () => window.removeEventListener("patchdesk:appearance", onAppearance);
  }, []);
  useReviewDiffQaScrollDiagnostics(viewerElement, viewer);
  useEffect(() => {
    const onTheme = (event: Event): void => {
      setThemePreferences(
        parseDiffThemePreferences(
          (event as CustomEvent<unknown>).detail,
        ),
      );
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);
    return () => window.removeEventListener("patchdesk:diff-theme", onTheme);
  }, []);
  const selectedPatch = useMemo(
    () => selectPatch(rawPatchesByPath, rawFilePatches, patch, selectedPath),
    [patch, rawFilePatches, rawPatchesByPath, selectedPath],
  );
  const files = useMemo(() => {
    const hydrated = parsedFiles.map(
      (file) => hydratedFiles.get(file.name) ?? file,
    );
    // Large generated diffs already arrive in source/tree order. Avoid a
    // full re-sort whenever one of their files hydrates.
    return parsedFiles.length > TREE_ORDER_SORT_LIMIT
      ? hydrated
      : hydrated.sort((left, right) => compareTreePaths(left.name, right.name));
  }, [hydratedFiles, parsedFiles]);
  const visibleFiles = useMemo(
    () =>
      preferences.fileMode === "selected" && selectedPath !== undefined
        ? files.filter((file) => file.name === selectedPath)
        : files,
    [files, preferences.fileMode, selectedPath],
  );
  const selectedFile = useMemo(
    () => selectedPath === undefined ? undefined : files.find((file) => file.name === selectedPath),
    [files, selectedPath],
  );
  const clearAuthoring = useCallback((): void => {
    setAuthoringSelection(null);
    viewer.current?.clearSelectedLines();
  }, []);
  const beginAccessibleAuthoring = useCallback((path: string, line: number, side: "additions" | "deletions"): void => {
    if (localCommentAuthoring?.enabled !== true) return;
    const location: LocalCommentLocation = {
      path,
      startLine: line,
      line,
      side: side === "additions" ? "new" : "old",
    };
    if (localCommentAuthoring.canAuthor?.(location) === false) return;
    localCommentAuthoring.onSelectionChange?.(location);
    setAuthoringSelection({ id: path, range: { start: line, end: line, side } });
  }, [localCommentAuthoring]);
  const saveAuthoring = useCallback(async (body: string): Promise<void> => {
    if (authoringSelection === null || localCommentAuthoring?.enabled !== true) return;
    const side: "new" | "old" = authoringSelection.range.side === "additions" ? "new" : "old";
    const parsedPath = parseRepoRelativePath(authoringSelection.id);
    const anchor = parsedPath._tag === "ok"
      ? { path: parsedPath.value, startLine: authoringSelection.range.start, line: authoringSelection.range.end, side }
      : undefined;
    const fingerprint = anchor === undefined ? undefined : fingerprintPatchAnchor(patch, anchor);
    await localCommentAuthoring.onSave({
      path: authoringSelection.id,
      startLine: authoringSelection.range.start,
      line: authoringSelection.range.end,
      side,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      body,
    });
    clearAuthoring();
  }, [authoringSelection, clearAuthoring, localCommentAuthoring, patch]);
  const localComposerAnnotation = useMemo<ReviewInlineAnnotation | undefined>(() => {
    if (authoringSelection === null || localCommentAuthoring?.enabled !== true) return undefined;
    return {
      id: `local-comment:${authoringSelection.id}:${authoringSelection.range.start}:${authoringSelection.range.end}:${authoringSelection.range.side}`,
      path: authoringSelection.id,
      start: authoringSelection.range.start,
      end: authoringSelection.range.end,
      side: authoringSelection.range.side === "additions" ? "new" : "old",
      severity: "info",
      title: "Local comment",
      explanation: "",
      localComposer: {
        path: authoringSelection.id,
        startLine: authoringSelection.range.start,
        line: authoringSelection.range.end,
        onCancel: clearAuthoring,
        onSave: saveAuthoring,
      },
    };
  }, [authoringSelection, clearAuthoring, localCommentAuthoring?.enabled, saveAuthoring]);
  const renderedAnnotations = useMemo(
    () => localComposerAnnotation === undefined ? annotations : [...annotations, localComposerAnnotation],
    [annotations, localComposerAnnotation],
  );
  const selectedAnnotations = useMemo(
    () => renderedAnnotations
      .filter((annotation) => selectedPath === undefined || annotation.path === selectedPath)
      .map((annotation): DiffLineAnnotation<ReviewInlineAnnotation | undefined> => ({
        side: annotation.side === "new" ? "additions" : "deletions",
        lineNumber: annotation.start,
        metadata: annotation,
      })),
    [renderedAnnotations, selectedPath],
  );
  const items = useMemo(
    () =>
      visibleFiles.map<CodeViewDiffItem<ReviewInlineAnnotation | undefined>>((file) => ({
        id: file.name,
        type: "diff",
        fileDiff: file,
        annotations: renderedAnnotations
          .filter((annotation) => annotation.path === file.name)
          .map((annotation) => ({
            side: annotation.side === "new" ? "additions" : "deletions",
            lineNumber: annotation.start,
            metadata: annotation,
          })),
        collapsed: collapsedPaths.has(file.name),
        // Pierre deliberately reuses a controlled item with the same ID and
        // version. Hydration swaps the partial raw-patch metadata for exact
        // base/head metadata, so bump its version to let native hunk controls
        // see the replacement.
        version: reviewDiffItemVersion({
          collapsed: collapsedPaths.has(file.name),
          hydrated: hydratedFiles.has(file.name),
        }),
      })),
    [collapsedPaths, hydratedFiles, renderedAnnotations, visibleFiles],
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
  // A finding may land inside a collapsed unchanged hunk. Keep that evidence
  // materialized while it is selected; the user's explicit option still
  // controls whether every other unchanged hunk stays expanded.
  const expandSelectedRange = selectedRange !== undefined;
  const browserSupportsPierre =
    typeof CSSStyleSheet !== "undefined" &&
    "replaceSync" in CSSStyleSheet.prototype;
  const viewerKey = preferences.fileMode;
  const sourceProfileId = hydrationSourceSession?.profileId;
  const sourceSessionId = hydrationSourceSession?.sessionId;
  const {
    loadedCount,
    nextItemIndex,
    appendItemsThrough,
    handleViewerScroll,
  } = useProgressiveReviewDiffStream<ReviewInlineAnnotation | undefined>({
    items,
    fileMode: preferences.fileMode,
    hydrateFiles,
    viewerContainer,
  });

  useEffect(() => {
    activePathRef.current = undefined;
  }, [items, preferences.fileMode]);

  const updateActivePath = useCallback(
    (
      scrollTop: number,
      codeView: PierreCodeView<ReviewInlineAnnotation | undefined>,
    ): void => {
      if (preferences.fileMode !== "all") return;
      const path = activeFilePathAtScrollTop(
        items.slice(0, loadedCount),
        scrollTop,
        (id) => codeView.getTopForItem(id),
      );
      if (path === undefined || path === activePathRef.current) return;
      activePathRef.current = path;
      onActiveFileChange?.(path);
    },
    [items, loadedCount, onActiveFileChange, preferences.fileMode],
  );

  useEffect(() => {
    if (preferences.fileMode !== "all") return;
    const frame = window.requestAnimationFrame(() => {
      const codeView = viewer.current?.getInstance();
      if (codeView === undefined) return;
      updateActivePath(codeView.getScrollTop(), codeView);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadedCount, preferences.fileMode, updateActivePath]);

  const handleCodeViewScroll = useCallback(
    (
      scrollTop: number,
      codeView: PierreCodeView<ReviewInlineAnnotation | undefined>,
    ): void => {
      handleViewerScroll(scrollTop, codeView);
      updateActivePath(scrollTop, codeView);
    },
    [handleViewerScroll, updateActivePath],
  );

  const selectionScrollKey = [
    preferences.diffStyle,
    preferences.fileMode,
    selectedPath ?? "",
    selectedLines?.id ?? "",
    selectedLines?.range.start ?? "",
    selectedLines?.range.end ?? "",
    selectedLines?.range.side ?? "",
  ].join(":");
  const lastSelectionScrollKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (selectedPath === undefined) return;
    const selectionChanged =
      selectionScrollKey !== lastSelectionScrollKey.current;
    if (selectionChanged) lastSelectionScrollKey.current = selectionScrollKey;
    let secondFrame: number | undefined;
    let continuationFrame: number | undefined;
    const scrollToSelection = (): void => {
      const targetIndex = items.findIndex((item) => item.id === selectedPath);
      if (targetIndex === -1) return;
      if (!selectionChanged && viewer.current?.getItem(selectedPath) !== undefined)
        return;
      // DiffWorkbench promotes exceptionally deep direct selections to its
      // explicit selected-file mode. Do not spend a frame materializing a
      // large all-files stream while that controlled preference update is in
      // flight.
      if (preferences.fileMode === "all" && targetIndex > 128) return;
      if (viewer.current?.getItem(selectedPath) === undefined) {
        // Keep direct navigation responsive for large all-files patches. The
        // selected path is committed before this progressive CodeView work,
        // then files are materialized in small animation-frame batches.
        appendItemsThrough(
          Math.min(targetIndex, nextItemIndex.current + 127),
        );
        continuationFrame = requestAnimationFrame(scrollToSelection);
        return;
      }
      if (selectedLines === null) {
        viewer.current?.scrollTo({
          type: "item",
          id: selectedPath,
          align: "start",
        });
      } else {
        viewer.current?.scrollTo({
          type: "range",
          id: selectedLines.id,
          range: selectedLines.range,
          align: "center",
        });
      }
    };
    // CodeView recalculates line metrics after expanding a selected unchanged
    // hunk. Scroll on the following frame so the target range uses those
    // expanded metrics rather than the previous virtual window.
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(scrollToSelection);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
      if (continuationFrame !== undefined) cancelAnimationFrame(continuationFrame);
    };
  }, [
    appendItemsThrough,
    items,
    nextItemIndex,
    preferences.diffStyle,
    preferences.fileMode,
    selectionScrollKey,
    selectedLines,
    selectedPath,
  ]);

  const setAllCollapsed = (collapsed: boolean): void => {
    onCollapsedPathsChange(
      collapsed ? new Set(files.map((file) => file.name)) : new Set(),
    );
  };
  const toggleFile = useCallback(
    (path: string): void => {
      const next = new Set(collapsedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      onCollapsedPathsChange(next);
    },
    [collapsedPaths, onCollapsedPathsChange],
  );
  const codeViewOptions = useMemo(
    () => ({
      theme: diffThemeFor(themePreferences),
      themeType: appearance,
      disableBackground: false,
      diffStyle: preferences.diffStyle,
      overflow: preferences.overflow,
      hunkSeparators: "line-info" as const,
      expandUnchanged: expandUnchanged || expandSelectedRange,
      stickyHeaders: true,
      lineDiffType: "word-alt" as const,
      diffIndicators: "bars" as const,
      enableLineSelection: localCommentAuthoring?.enabled === true,
      enableGutterUtility: localCommentAuthoring?.enabled === true,
    }),
    [appearance, expandSelectedRange, expandUnchanged, localCommentAuthoring?.enabled, preferences.diffStyle, preferences.overflow, themePreferences],
  );
  const hasExpandableRenderedFile = useMemo(
    () =>
      items
        .slice(0, loadedCount)
        .some((item) => {
          if (item.type !== "diff") return false;
          const hydrated = hydratedFiles.get(item.id);
          return hydrated !== undefined && !hydrated.isPartial;
        }),
    [hydratedFiles, items, loadedCount],
  );
  const contextControl = reviewContextControl({
    hasSourceSession:
      sourceProfileId !== undefined && sourceSessionId !== undefined,
    status: contextStatus,
    hasExpandableRenderedFile,
    expanded: expandUnchanged,
  });
  const renderFileChangeCounts = useCallback(
    (path: string) => {
      const stats = fileStatsByPath.get(path) ?? {
        path,
        additions: 0,
        deletions: 0,
      };
      return <FileChangeCounts stats={stats} />;
    },
    [fileStatsByPath],
  );
  const renderCodeViewHeader = useCallback(
    (item: CodeViewItem) => {
      if (item.type !== "diff") return null;
      const path = item.fileDiff.name;
      return (
        <div
          className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm"
          data-review-diff-file-header={path}
        >
          <button
            type="button"
            role="checkbox"
            aria-checked={collapsedPaths.has(path)}
            aria-label={collapsedPaths.has(path) ? `Show file ${path}` : `Mark file ${path} as viewed`}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/60 bg-background text-[10px] leading-none hover:border-primary focus-visible:outline"
            onClick={() => toggleFile(path)}
          >
            {collapsedPaths.has(path) ? "✓" : null}
          </button>
          <FileCode2 className="size-4 shrink-0 text-amber-300" />
          <span className="min-w-0 truncate font-medium" title={path}>
            {path}
          </span>
          {renderFileChangeCounts(path)}
        </div>
      );
    },
    [collapsedPaths, renderFileChangeCounts, toggleFile],
  );
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewInlineAnnotation | undefined>) => {
      const finding = annotation.metadata;
      if (finding === undefined) return null;
      if (finding.localComposer !== undefined) {
        return <InlineCommentComposer {...finding.localComposer} />;
      }
      return (
        <article
          className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden whitespace-normal rounded-md border border-primary/30 bg-primary/5 px-3 py-2 font-sans text-sm text-foreground shadow-sm"
          data-review-inline-finding={finding.id}
          aria-label={`${finding.severity} finding: ${finding.title}`}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-xs font-semibold text-primary">{finding.severity}</span>
            <h3 className="min-w-0 break-words font-medium">{finding.title}</h3>
          </div>
          <p className="mt-1 break-words text-muted-foreground">{finding.explanation}</p>
        </article>
      );
    },
    [],
  );
  const renderPatchHeader = useCallback(
    (file: FileDiffMetadata) => (
      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">
        <FileCode2 className="size-4 shrink-0 text-amber-300" />
        <span className="min-w-0 truncate font-medium" title={file.name}>
          {file.name}
        </span>
        {renderFileChangeCounts(file.name)}
      </div>
    ),
    [renderFileChangeCounts],
  );
  const beginAuthoring = useCallback((selection: CodeViewLineSelection | null): void => {
    if (localCommentAuthoring?.enabled !== true || selection === null) return;
    const range = selection.range;
    if ((range.side !== "additions" && range.side !== "deletions") || (range.endSide !== undefined && range.endSide !== range.side)) return;
    const location: LocalCommentLocation = { path: selection.id, startLine: range.start, line: range.end, side: range.side === "additions" ? "new" : "old" };
    if (localCommentAuthoring.canAuthor?.(location) === false) return;
    localCommentAuthoring.onSelectionChange?.(location);
    setAuthoringSelection(selection);
  }, [localCommentAuthoring]);
  const renderGutterUtility = useCallback((getHoveredLine: () => { readonly lineNumber: number; readonly side: "additions" | "deletions" } | undefined, item: { readonly id: string; readonly type: "diff" | "file" }) => {
    if (localCommentAuthoring?.enabled !== true || item.type !== "diff") return null;
    const hovered = getHoveredLine();
    if (hovered === undefined || localCommentAuthoring.canAuthor?.({ path: item.id, startLine: hovered.lineNumber, line: hovered.lineNumber, side: hovered.side === "additions" ? "new" : "old" }) === false) return null;
    return <button type="button" className="rounded px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Add local comment on ${item.id}`} onClick={() => {
      beginAuthoring({ id: item.id, range: { start: hovered.lineNumber, end: hovered.lineNumber, side: hovered.side } });
    }}>+</button>;
  }, [beginAuthoring, localCommentAuthoring]);

  return (
    <>
      <div
        data-review-diff-toolbar
        className="z-20 flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-1 border-b bg-card/95 px-2 py-1 backdrop-blur"
      >
        <ButtonGroup
          className={`items-center ${virtualized ? "flex" : "hidden"}`}
        >
          <Button
            variant={preferences.fileMode === "all" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={preferences.fileMode === "all"}
            onClick={() => onPreferencesChange({ fileMode: "all" })}
          >
            <Files /> All files
          </Button>
          <Button
            variant={preferences.fileMode === "selected" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={preferences.fileMode === "selected"}
            disabled={selectedPath === undefined}
            onClick={() => onPreferencesChange({ fileMode: "selected" })}
          >
            <FileCode2 /> Selected
          </Button>
        </ButtonGroup>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <ButtonGroup>
            <Button
              variant={preferences.diffStyle === "unified" ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={preferences.diffStyle === "unified"}
              onClick={() => onPreferencesChange({ diffStyle: "unified" })}
            >
              <Rows3 /> Unified
            </Button>
            <Button
              variant={preferences.diffStyle === "split" ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={preferences.diffStyle === "split"}
              onClick={() => onPreferencesChange({ diffStyle: "split" })}
            >
              <Columns2 /> Split
            </Button>
          </ButtonGroup>
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              onPreferencesChange({
                overflow: preferences.overflow === "wrap" ? "scroll" : "wrap",
              })
            }
          >
            {preferences.overflow === "wrap" ? (
              <MoveHorizontal />
            ) : (
              <WrapText />
            )}
            {preferences.overflow === "wrap" ? "Scroll" : "Wrap"}
          </Button>
          <Button
            variant={expandUnchanged ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={expandUnchanged}
            aria-label={contextControl.description}
            title={contextControl.description}
            disabled={contextControl.disabled}
            onClick={() => setExpandUnchanged((current) => !current)}
          >
            {contextStatus === "loading" ? <Spinner /> : <ChevronsUpDown />}
            {contextControl.label}
          </Button>
          <Button
            className={virtualized ? undefined : "hidden"}
            variant="ghost"
            size="xs"
            aria-pressed={collapsedPaths.size === files.length && files.length > 0}
            onClick={() => setAllCollapsed(!(collapsedPaths.size === files.length && files.length > 0))}
          >
            {collapsedPaths.size === files.length && files.length > 0 ? "Show all" : "Mark all viewed"}
          </Button>
        </div>
      </div>
      {!browserSupportsPierre && localComposerAnnotation?.localComposer !== undefined ? (
        <InlineCommentComposer {...localComposerAnnotation.localComposer} />
      ) : null}
      {contextStatus === "loading" ? (
        <p className="sr-only" aria-live="polite">
          Loading unchanged context for {selectedPath}.
        </p>
      ) : contextStatus === "unavailable" ? (
        <p className="sr-only" aria-live="polite">
          Additional unchanged context is unavailable for {selectedPath}.
        </p>
      ) : null}
      {!browserSupportsPierre ? (
        <AccessiblePatch
          patch={preferences.fileMode === "all" ? patch : selectedPatch}
          {...(selectedRange === undefined ? {} : { selectedRange })}
          {...(localCommentAuthoring === undefined ? {} : { localCommentAuthoring, onAuthorLine: beginAccessibleAuthoring })}
        />
      ) : !virtualized ? (
        selectedFile === undefined ? (
          <PatchDiff
            patch={selectedPatch}
            disableWorkerPool
            className="visual-diff max-h-[calc(100vh-12rem)] min-h-0 overflow-auto font-mono"
            style={DIFF_CODE_METRICS}
            options={{
              theme: diffThemeFor(themePreferences),
              themeType: appearance,
              disableBackground: false,
              diffStyle: preferences.diffStyle,
              overflow: preferences.overflow,
              hunkSeparators: "line-info",
              expandUnchanged: expandUnchanged || expandSelectedRange,
              lineDiffType: "word-alt",
              diffIndicators: "bars",
              enableGutterUtility: localCommentAuthoring?.enabled === true,
            }}
            lineAnnotations={selectedAnnotations}
            selectedLines={selectedLines?.range ?? null}
            renderAnnotation={renderAnnotation}
            renderCustomHeader={renderPatchHeader}
            renderGutterUtility={(getHoveredLine) =>
              renderGutterUtility(getHoveredLine, {
                id: selectedPath ?? "diff",
                type: "diff",
              })
            }
          />
        ) : (
          <FileDiff
            fileDiff={selectedFile}
            disableWorkerPool
            className="visual-diff max-h-[calc(100vh-12rem)] min-h-0 overflow-auto font-mono"
            style={DIFF_CODE_METRICS}
            options={{
              theme: diffThemeFor(themePreferences),
              themeType: appearance,
              disableBackground: false,
              diffStyle: preferences.diffStyle,
              overflow: preferences.overflow,
              hunkSeparators: "line-info",
              expandUnchanged: expandUnchanged || expandSelectedRange,
              lineDiffType: "word-alt",
              diffIndicators: "bars",
              enableGutterUtility: localCommentAuthoring?.enabled === true,
            }}
            lineAnnotations={selectedAnnotations}
            selectedLines={selectedLines?.range ?? null}
            renderAnnotation={renderAnnotation}
            renderCustomHeader={renderPatchHeader}
            renderGutterUtility={(getHoveredLine) =>
              renderGutterUtility(getHoveredLine, {
                id: selectedFile.name,
                type: "diff",
              })
            }
          />
        )
      ) : (
        <div className="relative min-h-0 flex-1">
          <span className="hidden" data-review-diff-loaded-file-count={loadedCount} />
          <CodeView<ReviewInlineAnnotation | undefined>
            key={`${viewerKey}-${themePreferences.light}-${themePreferences.dark}-${appearance}`}
            ref={viewer}
            items={items.slice(0, loadedCount)}
            containerRef={setViewerContainer}
            selectedLines={selectedLines}
            className="visual-diff review-diff-viewport size-full min-h-[24rem] overflow-x-hidden overflow-y-auto font-mono"
            style={DIFF_CODE_METRICS}
            options={codeViewOptions}
            renderCustomHeader={renderCodeViewHeader}
            renderAnnotation={renderAnnotation}
            onScroll={handleCodeViewScroll}
            onSelectedLinesChange={beginAuthoring}
            renderGutterUtility={renderGutterUtility}
          />
        </div>
      )}
    </>
  );
}

function InlineCommentComposer({
  path,
  startLine,
  line,
  onCancel,
  onSave,
}: {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly onCancel: () => void;
  readonly onSave: (body: string) => Promise<void>;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (): Promise<void> => {
    if (body.trim().length === 0 || saving) return;
    setSaving(true); setError(undefined);
    try { await onSave(body); }
    catch { setError("Patchdesk could not save this local comment."); }
    finally { setSaving(false); }
  };
  return <section className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 shadow-sm" aria-label="Local comment composer"><p className="text-xs text-muted-foreground">{path}:{startLine}{line === startLine ? "" : `–${line}`} · local only</p><Textarea className="mt-2" autoFocus aria-label="Local comment" value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void save(); } }} placeholder="Write a local inline comment" /><div className="mt-2 flex gap-2"><Button size="sm" onClick={() => void save()} disabled={body.trim().length === 0 || saving}>{saving ? "Saving…" : "Save local comment"}</Button><Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button></div>{error === undefined ? null : <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}<p className="mt-2 text-xs text-muted-foreground">Press ⌘/Ctrl+Enter to save. Escape cancels.</p></section>;
}

const MemoizedReviewDiffSurface = memo(ReviewDiffSurface);

export function ReviewDiffView(props: ReviewDiffViewProps): React.JSX.Element {
  // A navigator click should acknowledge selection before Pierre performs its
  // expensive virtual-file replacement. For extraordinarily large patches we
  // wait briefly for a burst of navigator changes to settle; normal reviews
  // still switch the rendered file synchronously.
  const deferredSelectedPath = useLargeDiffSelection(
    props.selectedPath,
    props.parsedFiles.length > 256,
  );
  return (
    <section
      aria-label="Review diff"
      data-selected-path={props.selectedPath}
      data-diff-style={props.preferences.diffStyle}
      data-file-mode={props.preferences.fileMode}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <MemoizedReviewDiffSurface {...props} selectedPath={deferredSelectedPath} />
    </section>
  );
}

function useLargeDiffSelection(
  selectedPath: string | undefined,
  deferReplacement: boolean,
): string | undefined {
  const [renderedPath, setRenderedPath] = useState(selectedPath);
  useEffect(() => {
    if (!deferReplacement || selectedPath === undefined) {
      setRenderedPath(selectedPath);
      return;
    }
    const timer = window.setTimeout(() => setRenderedPath(selectedPath), 150);
    return () => window.clearTimeout(timer);
  }, [deferReplacement, selectedPath]);
  return renderedPath;
}

type AccessibleLine = {
  readonly content: string;
  readonly kind: "Added" | "Deleted" | "Hunk" | "Context";
  readonly path?: string;
  readonly oldLine?: number;
  readonly newLine?: number;
};

function AccessiblePatch({
  patch,
  selectedRange,
  localCommentAuthoring,
  onAuthorLine,
}: {
  readonly patch: string;
  readonly selectedRange?: SelectedDiffRange;
  readonly localCommentAuthoring?: LocalCommentAuthoring;
  readonly onAuthorLine?: (path: string, line: number, side: "additions" | "deletions") => void;
}): React.JSX.Element {
  const lines = useMemo(() => parseAccessibleLines(patch), [patch]);
  const selectedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    selectedRef.current?.focus({ preventScroll: true });
  }, [patch, selectedRange]);
  return (
    <div
      className="max-h-[calc(100vh-12rem)] min-h-0 overflow-auto p-3 font-mono text-[13px] leading-5"
      style={{
        fontFamily:
          '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
      role="region"
      aria-label="Plain text diff"
      tabIndex={0}
    >
      <ol className="min-w-max space-y-0">
        {lines.map((line, index) => {
          const lineNumber =
            selectedRange?.side === "old" ? line.oldLine : line.newLine;
          const selected =
            selectedRange !== undefined &&
            lineNumber !== undefined &&
            lineNumber >= selectedRange.start &&
            lineNumber <= selectedRange.end;
          const firstSelected = selected && lineNumber === selectedRange?.start;
          return (
            <li
              key={`${index}:${line.content}`}
              ref={firstSelected ? selectedRef : undefined}
              className={`grid grid-cols-[3.5rem_3.5rem_1fr] gap-2 rounded-sm px-1 ${selected ? "bg-primary/20 ring-1 ring-inset ring-primary/50" : ""}`}
              data-selected-line={selected ? "true" : undefined}
              data-line-type={line.kind === "Added" ? "change-addition" : line.kind === "Deleted" ? "change-deletion" : undefined}
              data-line-number={lineNumber}
              data-diff-side={selectedRange?.side}
              tabIndex={firstSelected ? -1 : undefined}
              aria-label={
                selected
                  ? `Selected ${selectedRange.side} line ${lineNumber}`
                  : undefined
              }
            >
              <span className="select-none text-muted-foreground">
                {line.kind}
              </span>
              <span className="select-none text-right text-muted-foreground">
                {line.oldLine === undefined && line.newLine === undefined
                  ? ""
                  : `${line.oldLine ?? ""}${line.oldLine !== undefined && line.newLine !== undefined ? "/" : ""}${line.newLine ?? ""}`}
              </span>
              <code className="whitespace-pre">{line.content || " "}</code>
              {localCommentAuthoring?.enabled === true && line.path !== undefined && (line.kind === "Added" || line.kind === "Deleted") ? (() => {
                const path = line.path;
                const side = line.kind === "Added" ? "additions" as const : "deletions" as const;
                const lineNumber = side === "additions" ? line.newLine : line.oldLine;
                if (lineNumber === undefined || localCommentAuthoring.canAuthor?.({ path, startLine: lineNumber, line: lineNumber, side: side === "additions" ? "new" : "old" }) === false) return null;
                return <button type="button" className="rounded px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Add local comment on ${path}`} onClick={() => onAuthorLine?.(path, lineNumber, side)}>+</button>;
              })() : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function parseAccessibleLines(patch: string): ReadonlyArray<AccessibleLine> {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let path: string | undefined;
  return patch.split("\n").map((content) => {
    const file = /^diff --git a\/(.+) b\/(.+)$/.exec(content);
    if (file !== null) {
      path = file[2];
      oldLine = undefined;
      newLine = undefined;
      return { content, kind: "Context", ...(path === undefined ? {} : { path }) };
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { content, kind: "Hunk", ...(path === undefined ? {} : { path }) };
    }
    if (
      oldLine === undefined ||
      newLine === undefined ||
      content.startsWith("\\ No newline")
    ) {
      return { content, kind: "Context" };
    }
    if (content.startsWith("+") && !content.startsWith("+++")) {
      const line = { content, kind: "Added" as const, ...(path === undefined ? {} : { path }), newLine };
      newLine += 1;
      return line;
    }
    if (content.startsWith("-") && !content.startsWith("---")) {
      const line = { content, kind: "Deleted" as const, ...(path === undefined ? {} : { path }), oldLine };
      oldLine += 1;
      return line;
    }
    const line = { content, kind: "Context" as const, ...(path === undefined ? {} : { path }), oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

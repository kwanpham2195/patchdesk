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
  processFile,
  type CodeViewDiffItem,
  type CodeViewItem,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { CodeView, PatchDiff, type CodeViewHandle } from "@pierre/diffs/react";
import {
  AlignJustify,
  ChevronsUpDown,
  Columns2,
  FileCode2,
  Files,
  Minimize2,
  MoveHorizontal,
  Rows3,
  WrapText,
} from "lucide-react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import type { ResolvedAppearance } from "@/appearance-preferences";
import {
  diffThemeFor,
  loadDiffThemePreferences,
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "@/diff-theme-preferences";
import type { FileChangeStats } from "@/review-diff-data";
import { registerPierreThemeLoaders } from "@/pierre-theme-catalog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Spinner } from "@/components/ui/spinner";
import { requestJson } from "@/api-client";

registerPierreThemeLoaders();

// Theme colors belong to the selected Pierre/Shiki descriptor. Patchdesk only
// owns the code metrics at this boundary so changing an independently saved
// light or dark theme changes both syntax and surface color as expected.
const DIFF_CODE_METRICS = {
  fontSize: "13px",
  lineHeight: "20px",
  fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
} as CSSProperties;

export type SelectedDiffRange = {
  readonly start: number;
  readonly end: number;
  readonly side: "new" | "old";
};

type DiffSourceSession = {
  readonly profileId: string;
  readonly sessionId: string;
};

type DiffSourceResponse =
  | {
      readonly state: "ready";
      readonly oldFile?: { readonly name: string; readonly contents: string };
      readonly newFile?: { readonly name: string; readonly contents: string };
    }
  | { readonly state: "unavailable"; readonly reason: string };

type PierreCodeView = NonNullable<
  ReturnType<CodeViewHandle<undefined>["getInstance"]>
>;

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
  readonly preferences: ReviewViewPreferences;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly onCollapsedPathsChange: (paths: ReadonlySet<string>) => void;
  /** Optional main-process-only source seam used to hydrate omitted hunk context. */
  readonly sourceSession?: DiffSourceSession;
  readonly virtualized?: boolean;
};

function ReviewDiffSurface({
  patch,
  parsedFiles,
  fileStatsByPath,
  selectedPath,
  selectedRange,
  preferences,
  collapsedPaths,
  onPreferencesChange,
  onCollapsedPathsChange,
  sourceSession,
  virtualized = true,
}: ReviewDiffViewProps): React.JSX.Element {
  const [expandUnchanged, setExpandUnchanged] = useState(false);
  const [hydratedFiles, setHydratedFiles] = useState<
    ReadonlyMap<string, FileDiffMetadata>
  >(() => new Map());
  const [contextStatus, setContextStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable"
  >("idle");
  const [loadedCount, setLoadedCount] = useState(1);
  const [appearance, setAppearance] = useState<ResolvedAppearance>(() => document.documentElement.dataset.appearance === "light" ? "light" : "dark");
  const [themePreferences, setThemePreferences] = useState<DiffThemePreferences>(() =>
    loadDiffThemePreferences(),
  );
  const viewer = useRef<CodeViewHandle<undefined>>(null);
  const viewerContainer = useRef<HTMLDivElement>(null);
  const [viewerElement, setViewerElement] = useState<HTMLDivElement | null>(null);
  const pendingAppendedScrollPath = useRef<string | undefined>(undefined);
  const setViewerContainer = useCallback((node: HTMLDivElement | null): void => {
    viewerContainer.current = node;
    setViewerElement(node);
  }, []);
  const nextItemIndex = useRef(1);
  const rawFilePatches = useMemo(() => splitPatch(patch), [patch]);
  const rawPatchesByPath = useMemo(
    () => indexPatchPaths(rawFilePatches),
    [rawFilePatches],
  );
  useEffect(() => {
    const onAppearance = (event: Event): void => {
      const value = (event as CustomEvent<ResolvedAppearance>).detail;
      if (value === "light" || value === "dark") setAppearance(value);
    };
    window.addEventListener("patchdesk:appearance", onAppearance);
    return () => window.removeEventListener("patchdesk:appearance", onAppearance);
  }, []);
  useEffect(() => {
    if (
      viewerElement === null ||
      !window.patchdesk.qaScrollDiagnosticsEnabled
    ) return;

    const capture = (event: WheelEvent): void => {
      const outer = document.querySelector<HTMLElement>("[data-review-scroll-container]");
      const target = event.target instanceof Element ? event.target : undefined;
      const path = event.composedPath()
        .filter((entry): entry is Element => entry instanceof Element)
        .slice(0, 8)
        .map((entry) => entry.tagName.toLowerCase() + (entry.id.length === 0 ? "" : `#${entry.id}`));
      const qaWindow = window as Window & {
        __patchdeskScrollDiagnostic?: Record<string, unknown>;
      };
      qaWindow.__patchdeskScrollDiagnostic = {
        wheelTarget: target?.tagName.toLowerCase(),
        composedPath: path,
        viewer: {
          scrollTop: viewerElement.scrollTop,
          scrollHeight: viewerElement.scrollHeight,
          clientHeight: viewerElement.clientHeight,
          clientWidth: viewerElement.clientWidth,
        },
        outer: outer === null ? undefined : {
          scrollTop: outer.scrollTop,
          scrollHeight: outer.scrollHeight,
          clientHeight: outer.clientHeight,
        },
        codeViewScrollHeight: viewer.current?.getInstance()?.getScrollHeight(),
      };
    };
    viewerElement.addEventListener("wheel", capture, { capture: true, passive: true });
    return () => viewerElement.removeEventListener("wheel", capture, true);
  }, [viewerElement]);
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
  const files = useMemo(
    () =>
      parsedFiles.map((file) => hydratedFiles.get(file.name) ?? file),
    [hydratedFiles, parsedFiles],
  );
  const visibleFiles = useMemo(
    () =>
      preferences.fileMode === "selected" && selectedPath !== undefined
        ? files.filter((file) => file.name === selectedPath)
        : files,
    [files, preferences.fileMode, selectedPath],
  );
  const items = useMemo(
    () =>
      visibleFiles.map<CodeViewDiffItem>((file) => ({
        id: file.name,
        type: "diff",
        fileDiff: file,
        collapsed: collapsedPaths.has(file.name),
        version: collapsedPaths.has(file.name) ? 1 : 0,
      })),
    [collapsedPaths, visibleFiles],
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
  const sourceProfileId = sourceSession?.profileId;
  const sourceSessionId = sourceSession?.sessionId;

  useEffect(() => {
    if (
      !expandUnchanged ||
      selectedPath === undefined ||
      sourceProfileId === undefined ||
      sourceSessionId === undefined
    ) {
      setContextStatus("idle");
      return;
    }
    if (hydratedFiles.has(selectedPath)) {
      setContextStatus("ready");
      return;
    }
    const rawFilePatch = selectPatch(
      rawPatchesByPath,
      rawFilePatches,
      patch,
      selectedPath,
    );
    if (!rawFilePatch.startsWith("diff --git ")) {
      setContextStatus("unavailable");
      return;
    }
    let active = true;
    setContextStatus("loading");
    void requestJson("/v1/reviews/diff-file", {
      method: "POST",
      body: {
        profileId: sourceProfileId,
        sessionId: sourceSessionId,
        path: selectedPath,
      },
    })
      .then((value) => {
        if (!active) return;
        const source = parseDiffSourceResponse(value);
        if (source?.state !== "ready") {
          setContextStatus("unavailable");
          return;
        }
        const hydrated = processFile(rawFilePatch, {
          ...(source.oldFile === undefined ? {} : { oldFile: source.oldFile }),
          ...(source.newFile === undefined ? {} : { newFile: source.newFile }),
        });
        if (hydrated === undefined) {
          setContextStatus("unavailable");
          return;
        }
        setHydratedFiles((current) => {
          const next = new Map(current);
          next.set(selectedPath, hydrated);
          return next;
        });
        setContextStatus("ready");
      })
      .catch(() => {
        if (active) setContextStatus("unavailable");
      });
    return () => {
      active = false;
    };
  }, [
    expandUnchanged,
    hydratedFiles,
    patch,
    rawFilePatches,
    rawPatchesByPath,
    selectedPath,
    sourceProfileId,
    sourceSessionId,
  ]);

  useEffect(() => {
    nextItemIndex.current = 1;
    setLoadedCount(1);
  }, [preferences.fileMode]);

  const appendItemsThrough = useCallback(
    (lastIndex: number): void => {
      const start = nextItemIndex.current;
      const end = Math.min(lastIndex + 1, items.length);
      if (start >= end) return;
      nextItemIndex.current = end;
      setLoadedCount(end);
    },
    [items],
  );

  const appendVisibleBatch = useCallback((followAppendedFile = false): void => {
    const start = nextItemIndex.current;
    if (start >= items.length) return;
    const nextFile = items[start];
    if (followAppendedFile && nextFile !== undefined) {
      pendingAppendedScrollPath.current = nextFile.id;
    }
    appendItemsThrough(start + 4);
  }, [appendItemsThrough, items]);

  useEffect(() => {
    const path = pendingAppendedScrollPath.current;
    if (path === undefined) return;
    pendingAppendedScrollPath.current = undefined;
    // The controlled item list reaches Pierre during its layout effect. Run
    // afterward so a bottom scroll can continue into the appended file.
    const frame = requestAnimationFrame(() => {
      viewer.current?.scrollTo({ type: "item", id: path, align: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [loadedCount]);

  useEffect(() => {
    if (selectedPath === undefined) return;
    let secondFrame: number | undefined;
    let continuationFrame: number | undefined;
    const scrollToSelection = (): void => {
      const targetIndex = items.findIndex((item) => item.id === selectedPath);
      if (targetIndex === -1) return;
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
    preferences.diffStyle,
    preferences.fileMode,
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
    }),
    [appearance, expandSelectedRange, expandUnchanged, preferences.diffStyle, preferences.overflow, themePreferences],
  );
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
        <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">
          <button
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-white/10 focus-visible:outline"
            aria-label={`${collapsedPaths.has(path) ? "Expand" : "Collapse"} file ${path}`}
            onClick={() => toggleFile(path)}
          >
            {collapsedPaths.has(path) ? <AlignJustify /> : <Minimize2 />}
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

  const handleViewerScroll = useCallback(
    (_scrollTop: number, codeView: PierreCodeView): void => {
      const root = viewerContainer.current;
      if (
        root === null ||
        preferences.fileMode !== "all" ||
        _scrollTop + root.clientHeight < codeView.getScrollHeight() - 200
      ) {
        return;
      }
      appendVisibleBatch(true);
    },
    [appendVisibleBatch, preferences.fileMode],
  );

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
            className={virtualized ? undefined : "hidden"}
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
            className={virtualized ? undefined : "hidden"}
            variant={expandUnchanged ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={expandUnchanged}
            disabled={contextStatus === "loading"}
            onClick={() => setExpandUnchanged((current) => !current)}
          >
            {contextStatus === "loading" ? <Spinner /> : <ChevronsUpDown />}
            {contextStatus === "loading"
              ? "Loading context"
              : expandUnchanged
                ? "Context"
                : "Collapsed context"}
          </Button>
          <Button
            className={virtualized ? undefined : "hidden"}
            variant="ghost"
            size="xs"
            aria-pressed={collapsedPaths.size === files.length && files.length > 0}
            onClick={() => setAllCollapsed(!(collapsedPaths.size === files.length && files.length > 0))}
          >
            {collapsedPaths.size === files.length && files.length > 0 ? <ChevronsUpDown /> : <Minimize2 />}
            {collapsedPaths.size === files.length && files.length > 0 ? "Expand files" : "Collapse files"}
          </Button>
        </div>
      </div>
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
        />
      ) : !virtualized ? (
        <PatchDiff
          patch={selectedPatch}
          disableWorkerPool
          className="visual-diff h-[calc(100vh-12rem)] min-h-[32rem] overflow-auto font-mono"
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
          }}
          selectedLines={selectedLines?.range ?? null}
          renderCustomHeader={renderPatchHeader}
        />
      ) : (
        <div className="relative min-h-0 flex-1">
          <CodeView
            key={`${viewerKey}-${themePreferences.light}-${themePreferences.dark}-${appearance}`}
            ref={viewer}
            items={items.slice(0, loadedCount)}
            containerRef={setViewerContainer}
            selectedLines={selectedLines}
            className="visual-diff review-diff-viewport size-full min-h-[24rem] overflow-x-hidden overflow-y-auto font-mono"
            style={DIFF_CODE_METRICS}
            options={codeViewOptions}
            renderCustomHeader={renderCodeViewHeader}
            onScroll={handleViewerScroll}
          />
          {loadedCount < items.length ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center">
              <Button
                variant="secondary"
                size="xs"
                className="pointer-events-auto shadow-lg"
                onClick={() => appendVisibleBatch()}
              >
                Load more files ({items.length - loadedCount} remaining)
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
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
  readonly oldLine?: number;
  readonly newLine?: number;
};

function AccessiblePatch({
  patch,
  selectedRange,
}: {
  readonly patch: string;
  readonly selectedRange?: SelectedDiffRange;
}): React.JSX.Element {
  const lines = useMemo(() => parseAccessibleLines(patch), [patch]);
  const selectedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    selectedRef.current?.focus({ preventScroll: true });
  }, [patch, selectedRange]);
  return (
    <div
      className="h-[calc(100vh-12rem)] overflow-auto p-3 font-mono text-[13px] leading-5"
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
  return patch.split("\n").map((content) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { content, kind: "Hunk" };
    }
    if (
      oldLine === undefined ||
      newLine === undefined ||
      content.startsWith("\\ No newline")
    ) {
      return { content, kind: "Context" };
    }
    if (content.startsWith("+") && !content.startsWith("+++")) {
      const line = { content, kind: "Added" as const, newLine };
      newLine += 1;
      return line;
    }
    if (content.startsWith("-") && !content.startsWith("---")) {
      const line = { content, kind: "Deleted" as const, oldLine };
      oldLine += 1;
      return line;
    }
    const line = { content, kind: "Context" as const, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

function splitPatch(patch: string): ReadonlyArray<string> {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((value) => value.startsWith("diff --git "));
}

function indexPatchPaths(
  patches: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const indexed = new Map<string, string>();
  for (const patch of patches) {
    const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(patch);
    if (header === null) continue;
    const oldPath = header[1];
    const newPath = header[2];
    if (oldPath !== undefined) indexed.set(oldPath, patch);
    if (newPath !== undefined) indexed.set(newPath, patch);
  }
  return indexed;
}

function selectPatch(
  patchesByPath: ReadonlyMap<string, string>,
  files: ReadonlyArray<string>,
  patch: string,
  selectedPath: string | undefined,
): string {
  return (
    (selectedPath === undefined ? undefined : patchesByPath.get(selectedPath)) ??
    files[0] ??
    patch
  );
}

function parseDiffSourceResponse(value: unknown): DiffSourceResponse | undefined {
  if (typeof value !== "object" || value === null || !("state" in value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "unavailable" && typeof candidate.reason === "string") {
    return { state: "unavailable", reason: candidate.reason };
  }
  if (candidate.state !== "ready") return undefined;
  const parseFile = (
    input: unknown,
  ): { readonly name: string; readonly contents: string } | undefined =>
    typeof input === "object" &&
    input !== null &&
    "name" in input &&
    "contents" in input &&
    typeof input.name === "string" &&
    typeof input.contents === "string"
      ? { name: input.name, contents: input.contents }
      : undefined;
  const oldFile = parseFile(candidate.oldFile);
  const newFile = parseFile(candidate.newFile);
  if (oldFile === undefined && newFile === undefined) return undefined;
  return {
    state: "ready",
    ...(oldFile === undefined ? {} : { oldFile }),
    ...(newFile === undefined ? {} : { newFile }),
  };
}

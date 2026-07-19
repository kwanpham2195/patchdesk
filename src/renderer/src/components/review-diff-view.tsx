import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  type CodeViewDiffItem,
  type CodeViewItem,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { CodeView, PatchDiff, type CodeViewHandle } from "@pierre/diffs/react";
import {
  Accessibility,
  AlignJustify,
  ChevronsUpDown,
  Columns2,
  FileCode2,
  Files,
  Minimize2,
  MoveHorizontal,
  Rows3,
  SlidersHorizontal,
  WrapText,
} from "lucide-react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import type { FileChangeStats } from "@/review-diff-data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ButtonGroup } from "@/components/ui/button-group";

const DARK_DIFF_STYLE = {
  "--diffs-dark-bg": "#080d15",
  "--diffs-dark-addition-color": "#63d68b",
  "--diffs-dark-deletion-color": "#fb7185",
  "--diffs-bg-context-override": "#080d15",
  "--diffs-bg-context-gutter-override": "#0c1320",
  "--diffs-bg-addition-override": "#10291f",
  "--diffs-bg-addition-number-override": "#123524",
  "--diffs-bg-deletion-override": "#32181e",
  "--diffs-bg-deletion-number-override": "#422027",
  "--diffs-bg-selection-override": "#17314b",
  "--diffs-bg-selection-number-override": "#1a4265",
  "--diffs-bg-separator-override": "#111927",
  "--diffs-bg-hover-override": "#152032",
  "--diffs-fg-number-override": "#78869a",
  "--diffs-fg-number-addition-override": "#63d68b",
  "--diffs-fg-number-deletion-override": "#fb7185",
  fontSize: "13px",
  lineHeight: "20px",
} as CSSProperties;

export type SelectedDiffRange = {
  readonly start: number;
  readonly end: number;
  readonly side: "new" | "old";
};

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
      <span className="text-emerald-400">+{stats.additions}</span>
      <span className="text-rose-400">-{stats.deletions}</span>
    </span>
  );
}

export function ReviewDiffView({
  patch,
  parsedFiles,
  fileStatsByPath,
  selectedPath,
  selectedRange,
  preferences,
  collapsedPaths,
  onPreferencesChange,
  onCollapsedPathsChange,
  virtualized = true,
}: {
  readonly patch: string;
  readonly parsedFiles: ReadonlyArray<FileDiffMetadata>;
  readonly fileStatsByPath: ReadonlyMap<string, FileChangeStats>;
  readonly selectedPath?: string;
  readonly selectedRange?: SelectedDiffRange;
  readonly preferences: ReviewViewPreferences;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly onCollapsedPathsChange: (paths: ReadonlySet<string>) => void;
  readonly virtualized?: boolean;
}): React.JSX.Element {
  const [accessible, setAccessible] = useState(false);
  const [expandUnchanged, setExpandUnchanged] = useState(false);
  const [loadedCount, setLoadedCount] = useState(1);
  const viewer = useRef<CodeViewHandle<undefined>>(null);
  const viewerContainer = useRef<HTMLDivElement>(null);
  const nextItemIndex = useRef(1);
  const userScrollIntent = useRef(false);
  const rawFilePatches = useMemo(() => splitPatch(patch), [patch]);
  const selectedPatch = useMemo(
    () => selectPatch(rawFilePatches, patch, selectedPath),
    [patch, rawFilePatches, selectedPath],
  );
  const files = parsedFiles;
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
        collapsed: false,
        version: 0,
      })),
    [visibleFiles],
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
  const viewerKey = `${preferences.fileMode}:${preferences.fileMode === "selected" ? (selectedPath ?? "none") : "all"}`;

  useEffect(() => {
    nextItemIndex.current = 1;
    setLoadedCount(1);
  }, [viewerKey]);

  const appendItemsThrough = useCallback(
    (lastIndex: number): void => {
      const start = nextItemIndex.current;
      const end = Math.min(lastIndex + 1, items.length);
      if (start >= end || viewer.current === null) return;
      const batch = items
        .slice(start, end)
        .filter((item) => viewer.current?.getItem(item.id) === undefined)
        .map((item) => ({
          ...item,
          collapsed: collapsedPaths.has(item.id),
        }));
      if (batch.length > 0) viewer.current.addItems(batch);
      nextItemIndex.current = end;
      setLoadedCount(end);
    },
    [collapsedPaths, items],
  );

  const appendVisibleBatch = useCallback((): void => {
    const start = nextItemIndex.current;
    if (start >= items.length) return;
    appendItemsThrough(start + 4);
  }, [appendItemsThrough, items.length]);

  useEffect(() => {
    for (const file of visibleFiles) {
      const item = viewer.current?.getItem(file.name);
      if (item === undefined || item.type !== "diff") continue;
      const collapsed = collapsedPaths.has(file.name);
      if (item.collapsed === collapsed) continue;
      viewer.current?.updateItem({
        ...item,
        collapsed,
        version: (item.version ?? 0) + 1,
      });
    }
  }, [collapsedPaths, visibleFiles]);

  useEffect(() => {
    if (selectedPath === undefined) return;
    const scrollToSelection = (): void => {
      const targetIndex = items.findIndex((item) => item.id === selectedPath);
      if (targetIndex === -1) return;
      if (viewer.current?.getItem(selectedPath) === undefined) {
        appendItemsThrough(targetIndex);
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
      requestAnimationFrame(scrollToSelection);
    });
    return () => cancelAnimationFrame(firstFrame);
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
      theme: "github-dark-high-contrast" as const,
      themeType: "dark" as const,
      disableBackground: false,
      diffStyle: preferences.diffStyle,
      overflow: preferences.overflow,
      hunkSeparators: "line-info" as const,
      expandUnchanged: expandUnchanged || expandSelectedRange,
      stickyHeaders: true,
      lineDiffType: "word-alt" as const,
      diffIndicators: "bars" as const,
    }),
    [expandSelectedRange, expandUnchanged, preferences.diffStyle, preferences.overflow],
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

  useEffect(() => {
    if (!virtualized || preferences.fileMode !== "all") return;
    const root = viewerContainer.current;
    if (root === null) return;
    const noteScrollIntent = (): void => {
      userScrollIntent.current = true;
    };
    root.addEventListener("wheel", noteScrollIntent, { passive: true });
    root.addEventListener("touchmove", noteScrollIntent, { passive: true });
    root.addEventListener("pointerdown", noteScrollIntent);
    root.addEventListener("keydown", noteScrollIntent);
    return () => {
      root.removeEventListener("wheel", noteScrollIntent);
      root.removeEventListener("touchmove", noteScrollIntent);
      root.removeEventListener("pointerdown", noteScrollIntent);
      root.removeEventListener("keydown", noteScrollIntent);
    };
  }, [preferences.fileMode, viewerKey, virtualized]);

  const handleViewerScroll = useCallback(
    (scrollTop: number, codeView: PierreCodeView): void => {
      const root = viewerContainer.current;
      if (
        !userScrollIntent.current ||
        root === null ||
        preferences.fileMode !== "all" ||
        scrollTop + root.clientHeight < codeView.getScrollHeight() - 200
      ) {
        return;
      }
      userScrollIntent.current = false;
      appendVisibleBatch();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Keep a continuous wheel gesture moving into the first appended
          // file. Without this nudge, a large wheel delta stops at the old
          // boundary and leaves the next file below the viewport.
          root.scrollBy({ top: 64, behavior: "instant" });
        });
      });
    },
    [appendVisibleBatch, preferences.fileMode],
  );

  useEffect(() => {
    if (
      !virtualized ||
      preferences.fileMode !== "all" ||
      loadedCount >= items.length
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const root = viewerContainer.current;
      if (root !== null && root.scrollHeight <= root.clientHeight + 1) {
        appendVisibleBatch();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    appendVisibleBatch,
    items.length,
    loadedCount,
    preferences.fileMode,
    viewerKey,
    virtualized,
  ]);

  return (
    <section
      aria-label="Review diff"
      data-selected-path={selectedPath}
      data-diff-style={preferences.diffStyle}
      data-file-mode={preferences.fileMode}
      className="relative flex min-h-0 flex-1 flex-col"
    >
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
            variant="ghost"
            size="xs"
            onClick={() => setAllCollapsed(true)}
          >
            <Minimize2 /> Collapse
          </Button>
          <Button
            className={virtualized ? undefined : "hidden"}
            variant="ghost"
            size="xs"
            onClick={() => setAllCollapsed(false)}
          >
            <ChevronsUpDown /> Expand
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="xs" />}>
              <SlidersHorizontal /> Options
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Diff display</DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={preferences.density === "compact"}
                  onCheckedChange={(checked) =>
                    onPreferencesChange({
                      density: checked === true ? "compact" : "comfortable",
                    })
                  }
                >
                  Compact density
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={expandUnchanged}
                  onCheckedChange={(checked) =>
                    setExpandUnchanged(checked === true)
                  }
                >
                  Show all unchanged lines
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem
                  checked={preferences.overflow === "wrap"}
                  onCheckedChange={(checked) =>
                    onPreferencesChange({
                      overflow: checked === true ? "wrap" : "scroll",
                    })
                  }
                >
                  Wrap long lines
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem
                  checked={accessible}
                  onCheckedChange={(checked) => setAccessible(checked === true)}
                >
                  <Accessibility />
                  Accessible text view
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {accessible || !browserSupportsPierre ? (
        <AccessiblePatch
          patch={preferences.fileMode === "all" ? patch : selectedPatch}
          {...(selectedRange === undefined ? {} : { selectedRange })}
        />
      ) : !virtualized ? (
        <PatchDiff
          patch={selectedPatch}
          disableWorkerPool
          className="visual-diff h-[calc(100vh-12rem)] min-h-[32rem] overflow-auto font-mono"
          style={DARK_DIFF_STYLE}
          options={{
            theme: "github-dark-high-contrast",
            themeType: "dark",
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
            key={viewerKey}
            ref={viewer}
            initialItems={items.slice(0, 1)}
            containerRef={viewerContainer}
            selectedLines={selectedLines}
            className="visual-diff review-diff-viewport size-full min-h-[24rem] overflow-x-hidden overflow-y-auto font-mono"
            style={DARK_DIFF_STYLE}
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
                onClick={appendVisibleBatch}
              >
                Load more files ({items.length - loadedCount} remaining)
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
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

function selectPatch(
  files: ReadonlyArray<string>,
  patch: string,
  selectedPath: string | undefined,
): string {
  return (
    files.find(
      (value) =>
        selectedPath !== undefined && value.includes(` b/${selectedPath}`),
    ) ??
    files[0] ??
    patch
  );
}

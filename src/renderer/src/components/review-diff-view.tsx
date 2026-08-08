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
  getFiletypeFromFileName,
  getThemes,
  preloadHighlighter,
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
import { PullRequestDescriptionPreview } from "./pull-request-description";
import { PatchdeskApiError } from "../api-client";
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
// Pierre derives diff chrome colors from the selected Shiki theme. Some themes
// use saturated terminal red/green values that produce poor contrast in the
// dark line gutters, so walkthrough diffs use a small, GitHub-like semantic
// palette while retaining the selected theme for syntax tokens.
const WALKTHROUGH_DIFF_COLORS_CSS = `
:host {
  --diffs-deletion-color-override: light-dark(#cf222e, #f85149);
  --diffs-addition-color-override: light-dark(#1a7f37, #3fb950);
  --diffs-fg-number-deletion-override: light-dark(#cf222e, #ff7b72);
  --diffs-fg-number-addition-override: light-dark(#1a7f37, #7ee787);
  --diffs-bg-deletion-override: light-dark(#ffebe9, #3d1d1d);
  --diffs-bg-addition-override: light-dark(#dafbe1, #1f3a26);
  --diffs-bg-deletion-emphasis-override: light-dark(rgb(255 129 130 / 0.28), rgb(248 81 73 / 0.22));
  --diffs-bg-addition-emphasis-override: light-dark(rgb(46 160 67 / 0.28), rgb(46 160 67 / 0.22));
}
`;
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
  readonly localComment?: {
    readonly body: string;
  };
  readonly conversationThread?: {
    readonly id: string;
    readonly state: "open" | "resolved" | "outdated" | "unknown";
    readonly complete?: boolean | undefined;
    readonly onSetState?: (
      threadId: string,
      state: "open" | "resolved",
    ) => Promise<void>;
    readonly onReply?: (
      threadId: string,
      body: string,
    ) => Promise<string | void>;
    readonly onEditComment?: (
      commentId: string,
      body: string,
    ) => Promise<void>;
    readonly onDeleteComment?: (
      commentId: string,
    ) => Promise<void>;
    readonly comments: ReadonlyArray<{
      readonly id: string;
      readonly author: string;
      readonly body: string;
      readonly createdAt: string;
      readonly viewerDidAuthor?: boolean | undefined;
    }>;
  };
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
  }) => Promise<{ readonly commentId: string; readonly threadId?: string } | void>;
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

export type ReviewConversationActions = {
  readonly setThreadState?: (
    threadId: string,
    state: "open" | "resolved",
  ) => Promise<void>;
  readonly replyToThread?: (threadId: string, body: string) => Promise<string | void>;
  readonly editComment?: (commentId: string, body: string) => Promise<void>;
  readonly deleteComment?: (commentId: string) => Promise<void>;
};

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
  /** Direct GitHub conversation actions; the surface wraps them to apply published mutations locally. */
  readonly conversationActions?: ReviewConversationActions;
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
  conversationActions,
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
  const [createdThreads, setCreatedThreads] = useState<
    ReadonlyArray<{
      readonly commentId: string;
      readonly threadId?: string | undefined;
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
    }>
  >([]);
  const [editedBodies, setEditedBodies] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [deletedCommentIds, setDeletedCommentIds] = useState<ReadonlySet<string>>(() => new Set());
  const [resolvedThreads, setResolvedThreads] = useState<ReadonlyMap<string, "open" | "resolved">>(() => new Map());
  // Published writes are authoritative (the receipt is GitHub's 200) and the
  // projection only changes on an explicit refresh or reload. Local mutation
  // overrides keep the cards truthful until the projection catches up; each is
  // dropped once the authoritative thread arrives with the same content.
  useEffect(() => {
    const threadIds = new Set<string>();
    const commentIds = new Set<string>();
    const commentBodies = new Map<string, string>();
    const threadStates = new Map<string, string>();
    for (const annotation of annotations) {
      const thread = annotation.conversationThread;
      if (thread === undefined) continue;
      threadIds.add(thread.id);
      threadStates.set(thread.id, thread.state);
      for (const comment of thread.comments) {
        commentIds.add(comment.id);
        commentBodies.set(comment.id, comment.body);
      }
    }
    setCreatedThreads((current) =>
      current.some((entry) => threadIds.has(entry.threadId ?? "") || commentIds.has(entry.commentId))
        ? current.filter((entry) => !threadIds.has(entry.threadId ?? "") && !commentIds.has(entry.commentId))
        : current,
    );
    setEditedBodies((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [commentId, body] of next) {
        if (commentBodies.get(commentId) === body) {
          next.delete(commentId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setDeletedCommentIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const commentId of next) {
        if (!commentIds.has(commentId)) {
          next.delete(commentId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setResolvedThreads((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [threadId, state] of next) {
        if (threadStates.get(threadId) === state) {
          next.delete(threadId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [annotations]);
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
    const receipt = await localCommentAuthoring.onSave({
      path: authoringSelection.id,
      startLine: authoringSelection.range.start,
      line: authoringSelection.range.end,
      side,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      body,
    });
    if (receipt !== undefined && receipt.commentId !== undefined && anchor !== undefined) {
      setCreatedThreads((current) => [
        ...current,
        {
          commentId: receipt.commentId,
          ...(receipt.threadId === undefined ? {} : { threadId: receipt.threadId }),
          path: anchor.path,
          start: anchor.startLine,
          end: anchor.line,
          side: anchor.side,
          body,
        },
      ]);
    }
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
  const optimisticAnnotations = useMemo<ReadonlyArray<ReviewInlineAnnotation>>(
    () =>
      createdThreads.map((entry) => ({
        // The receipt's real thread id keeps this card the same controlled
        // item the authoritative thread will later occupy.
        id: `conversation:${entry.threadId ?? `optimistic:${entry.commentId}`}`,
        path: entry.path,
        start: entry.start,
        end: entry.end,
        side: entry.side,
        severity: "conversation",
        title: "Conversation",
        explanation: "",
        conversationThread: {
          id: entry.threadId ?? `optimistic:${entry.commentId}`,
          state: "open" as const,
          complete: true,
          comments: [
            {
              id: entry.commentId,
              author: "You",
              body: entry.body,
              createdAt: new Date().toISOString(),
              viewerDidAuthor: true,
            },
          ],
        },
      })),
    [createdThreads],
  );
  const renderedAnnotations = useMemo(
    () => localComposerAnnotation === undefined
      ? [...annotations, ...optimisticAnnotations]
      : [...annotations, ...optimisticAnnotations, localComposerAnnotation],
    [annotations, localComposerAnnotation, optimisticAnnotations],
  );
  // Published mutations are applied on top of the projection until an explicit
  // refresh or reload re-baselines it: edited bodies replace comment text,
  // resolved threads flip their state, deleted comments (and emptied threads)
  // disappear, and created entries already present in the projection are not
  // duplicated.
  const displayedAnnotations = useMemo(() => {
    const projectionThreadIds = new Set<string>();
    const projectionCommentIds = new Set<string>();
    for (const annotation of annotations) {
      const thread = annotation.conversationThread;
      if (thread === undefined) continue;
      projectionThreadIds.add(thread.id);
      for (const comment of thread.comments) projectionCommentIds.add(comment.id);
    }
    return renderedAnnotations
      .filter((annotation) => {
        const thread = annotation.conversationThread;
        if (thread === undefined) return true;
        // A created card is superseded by the authoritative thread with the
        // same id; the projection now owns it.
        if (annotations.some((projection) => projection === annotation)) return true;
        if (projectionThreadIds.has(thread.id)) return false;
        if (projectionCommentIds.has(thread.comments[0]?.id ?? "")) return false;
        return true;
      })
      .map((annotation) => {
        const thread = annotation.conversationThread;
        if (thread === undefined) return annotation;
        const state = resolvedThreads.get(thread.id) ?? thread.state;
        const comments = thread.comments
          .filter((comment) => !deletedCommentIds.has(comment.id))
          .map((comment) => {
            const body = editedBodies.get(comment.id);
            return body === undefined ? comment : { ...comment, body };
          });
        if (comments.length === 0) return undefined;
        return { ...annotation, conversationThread: { ...thread, state, comments } };
      })
      .filter((annotation): annotation is ReviewInlineAnnotation => annotation !== undefined);
  }, [annotations, deletedCommentIds, editedBodies, renderedAnnotations, resolvedThreads]);
  const selectedAnnotations = useMemo(
    () => displayedAnnotations
      .filter((annotation) => selectedPath === undefined || annotation.path === selectedPath)
      .map((annotation): DiffLineAnnotation<ReviewInlineAnnotation | undefined> => ({
        side: annotation.side === "new" ? "additions" : "deletions",
        lineNumber: annotation.start,
        metadata: annotation,
      })),
    [displayedAnnotations, selectedPath],
  );
  const annotationKey = useMemo(
    () => displayedAnnotations
      .map((annotation) => [
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
        // Thread cards are controlled items too: resolve state, reconciled
        // comments, and local mutation overrides must bump the version.
        annotation.conversationThread === undefined
          ? ""
          : JSON.stringify([
              annotation.conversationThread.state,
              ...annotation.conversationThread.comments.map(
                (comment) => `${comment.id}\u0000${comment.author}\u0000${comment.body}`,
              ),
            ]),
      ].join("\u0000"))
      .join("\u0001"),
    [displayedAnnotations],
  );
  const items = useMemo(
    () =>
      visibleFiles.map<CodeViewDiffItem<ReviewInlineAnnotation | undefined>>((file) => ({
        id: file.name,
        type: "diff",
        fileDiff: file,
        annotations: displayedAnnotations
          .filter((annotation) => annotation.path === file.name)
          .map((annotation) => ({
            side: annotation.side === "new" ? "additions" : "deletions",
            lineNumber: annotation.start,
            metadata: annotation,
          })),
        collapsed: collapsedPaths.has(file.name),
        // Pierre deliberately reuses a controlled item with the same ID and
        // version. Hydration swaps partial raw-patch metadata for exact
        // base/head metadata, and local annotations change rendered slots, so
        // bump its version to let native hunk controls and annotation portals
        // see the replacement.
        version: reviewDiffItemVersion({
          collapsed: collapsedPaths.has(file.name),
          hydrated: hydratedFiles.has(file.name),
          annotationKey,
        }),
      })),
    [annotationKey, collapsedPaths, hydratedFiles, displayedAnnotations, visibleFiles],
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
  // Non-virtualized (walkthrough) cards tokenize on the main thread after a
  // plain first paint. Preload their file languages and the active themes so
  // the retained reader shows syntax colors on first paint instead of flashing
  // uncolored text while each grammar loads.
  useEffect(() => {
    if (virtualized || !browserSupportsPierre) return;
    const langs = Array.from(
      new Set(
        parsedFiles
          .map((file) => getFiletypeFromFileName(file.name))
          .filter(
            (lang): lang is string =>
              lang !== undefined && lang !== "text",
          ),
      ),
    );
    if (langs.length === 0) return;
    void preloadHighlighter({
      langs,
      themes: getThemes(themePreferences),
    });
  }, [browserSupportsPierre, parsedFiles, themePreferences, virtualized]);
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
      lineHoverHighlight: "both" as const,
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
      if (finding.conversationThread !== undefined) {
        const thread = finding.conversationThread;
        const setState = thread.onSetState ?? conversationActions?.setThreadState;
        const reply = thread.onReply ?? conversationActions?.replyToThread;
        const edit = thread.onEditComment ?? conversationActions?.editComment;
        const remove = thread.onDeleteComment ?? conversationActions?.deleteComment;
        return (
          <ConversationThreadCard
            thread={{
              ...thread,
              ...(setState === undefined
                ? {}
                : {
                    onSetState: async (threadId, state) => {
                      await setState(threadId, state);
                      setResolvedThreads((current) => {
                        const next = new Map(current);
                        next.set(threadId, state);
                        return next;
                      });
                    },
                  }),
              ...(reply === undefined ? {} : { onReply: reply }),
              ...(edit === undefined
                ? {}
                : {
                    onEditComment: async (commentId, body) => {
                      await edit(commentId, body);
                      setEditedBodies((current) => {
                        const next = new Map(current);
                        next.set(commentId, body);
                        return next;
                      });
                    },
                  }),
              ...(remove === undefined
                ? {}
                : {
                    onDeleteComment: async (commentId) => {
                      await remove(commentId);
                      setDeletedCommentIds((current) => {
                        const next = new Set(current);
                        next.add(commentId);
                        return next;
                      });
                      setCreatedThreads((current) =>
                        current.some((entry) => entry.commentId === commentId)
                          ? current.filter((entry) => entry.commentId !== commentId)
                          : current,
                      );
                    },
                  }),
            }}
          />
        );
      }
      if (finding.localComment !== undefined) {
        return (
          <LocalCommentThread
            path={finding.path}
            startLine={finding.start}
            line={finding.end}
            body={finding.localComment.body}
          />
        );
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
    [conversationActions],
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
    const baseTitle = `Add comment on ${item.id}`;
    return <button type="button" className="inline-flex size-5 items-center justify-center rounded border border-border/60 bg-card text-sm font-medium leading-none text-muted-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={baseTitle} title={baseTitle} onPointerEnter={(event) => {
      const hovered = getHoveredLine();
      if (hovered === undefined) return;
      event.currentTarget.dataset.lineNumber = String(hovered.lineNumber);
      event.currentTarget.dataset.lineSide = hovered.side;
      event.currentTarget.title = `${baseTitle} line ${hovered.lineNumber}`;
      event.currentTarget.setAttribute("aria-label", `${baseTitle} line ${hovered.lineNumber}`);
    }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
      const lineNumber = Number(event.currentTarget.dataset.lineNumber);
      const side = event.currentTarget.dataset.lineSide;
      if (!Number.isInteger(lineNumber) || lineNumber < 1 || (side !== "additions" && side !== "deletions")) return;
      const locationSide = side === "additions" ? "new" : "old";
      if (localCommentAuthoring.canAuthor?.({ path: item.id, startLine: lineNumber, line: lineNumber, side: locationSide }) === false) return;
      beginAuthoring({ id: item.id, range: { start: lineNumber, end: lineNumber, side } });
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
          virtualized={virtualized}
          {...(selectedRange === undefined ? {} : { selectedRange })}
          {...(localCommentAuthoring === undefined ? {} : { localCommentAuthoring, onAuthorLine: beginAccessibleAuthoring })}
        />
      ) : !virtualized ? (
        selectedFile === undefined ? (
          <PatchDiff
            patch={selectedPatch}
            disableWorkerPool
            className="visual-diff min-h-0 overflow-x-auto font-mono"
            style={DIFF_CODE_METRICS}
            options={{
              theme: diffThemeFor(themePreferences),
              themeType: appearance,
              unsafeCSS: WALKTHROUGH_DIFF_COLORS_CSS,
              disableBackground: false,
              diffStyle: preferences.diffStyle,
              overflow: preferences.overflow,
              hunkSeparators: "line-info",
              expandUnchanged: expandUnchanged || expandSelectedRange,
              lineDiffType: "word-alt",
              diffIndicators: "bars",
              lineHoverHighlight: "both",
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
            className="visual-diff min-h-0 overflow-x-auto font-mono"
            style={DIFF_CODE_METRICS}
            options={{
              theme: diffThemeFor(themePreferences),
              themeType: appearance,
              unsafeCSS: WALKTHROUGH_DIFF_COLORS_CSS,
              disableBackground: false,
              diffStyle: preferences.diffStyle,
              overflow: preferences.overflow,
              hunkSeparators: "line-info",
              expandUnchanged: expandUnchanged || expandSelectedRange,
              lineDiffType: "word-alt",
              diffIndicators: "bars",
              lineHoverHighlight: "both",
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
            className="visual-diff review-diff-viewport size-full min-h-[24rem] overflow-x-auto overflow-y-auto font-mono"
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

export function ConversationThreadCard({
  thread,
}: {
  readonly thread: NonNullable<ReviewInlineAnnotation["conversationThread"]>;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string>();
  const [editingCommentId, setEditingCommentId] = useState<string>();
  const [editBody, setEditBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [optimisticReplies, setOptimisticReplies] = useState<
    ReadonlyArray<{ readonly id: string; readonly body: string; readonly createdAt: string }>
  >([]);
  // A published reply is authoritative (GitHub returned 200); drop its local
  // row once an explicit refresh or reload brings the authoritative thread.
  useEffect(() => {
    const realCommentIds = new Set(thread.comments.map((comment) => comment.id));
    setOptimisticReplies((current) =>
      current.some((reply) => realCommentIds.has(reply.id))
        ? current.filter((reply) => !realCommentIds.has(reply.id))
        : current,
    );
  }, [thread.comments]);
  const opening = thread.comments[0];
  const latest = thread.comments.at(-1);
  const hiddenReplyCount = Math.max(0, thread.comments.length - (opening === latest ? 1 : 2));
  const middleReplies = expanded && hiddenReplyCount > 0
    ? thread.comments.slice(1, thread.comments.length - (opening === latest ? 0 : 1))
    : [];
  if (opening === undefined) return <p role="status" className="mx-2 my-2 text-sm text-muted-foreground">This conversation has no readable comments.</p>;
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      aria-label={`${thread.state} conversation thread`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{thread.state === "resolved" ? "Resolved" : "Open"}</span>
        {thread.complete === false ? <span>Some replies unavailable</span> : null}
      </div>
      <div className="mt-2">
        <p className="font-semibold">{opening.author}</p>
        {editingCommentId === opening.id ? (
          <div className="mt-1">
            <Textarea aria-label="Edit comment" value={editBody} onChange={(event) => setEditBody(event.target.value)} />
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={async () => {
                if (editBody.trim().length === 0 || editing) return;
                setEditing(true); setError(undefined);
                try { const action = thread.onEditComment; if (action === undefined) return; await action(opening.id, editBody); setEditingCommentId(undefined); }
                catch { setError("Patchdesk could not edit this comment."); }
                finally { setEditing(false); }
              }} disabled={editBody.trim().length === 0 || editing}>{editing ? "Saving…" : "Save"}</Button>
              <Button size="sm" variant="outline" onClick={() => setEditingCommentId(undefined)} disabled={editing}>Cancel</Button>
            </div>
          </div>
        ) : (
          <PullRequestDescriptionPreview markdown={opening.body} />
        )}
        {opening.viewerDidAuthor === true && editingCommentId !== opening.id ? (
          <div className="mt-1 flex gap-3">
            <button type="button" className="text-xs font-medium text-sky-400 hover:underline" onClick={() => { setEditingCommentId(opening.id); setEditBody(opening.body); }}>Edit</button>
            <button type="button" className="text-xs font-medium text-destructive hover:underline" onClick={() => {
              if (!window.confirm("Delete this published comment?")) return;
              const action = thread.onDeleteComment;
              if (action === undefined) return;
              void action(opening.id).catch(() => setError("Patchdesk could not delete this comment."));
            }}>Delete</button>
          </div>
        ) : null}
      </div>
      {middleReplies.length > 0 ? middleReplies.map((comment) => (
        <div key={comment.id} className="mt-4 border-l-2 border-border/70 pl-4">
          <p className="font-semibold">{comment.author}</p>
          <PullRequestDescriptionPreview markdown={comment.body} />
        </div>
      )) : null}
      {latest !== undefined && latest !== opening ? (
        <div className="mt-4 border-l-2 border-border/70 pl-4">
          <p className="font-semibold">{latest.author}</p>
          <PullRequestDescriptionPreview markdown={latest.body} />
        </div>
      ) : null}
      {optimisticReplies.map((reply) => (
        <div key={reply.id} className="mt-4 border-l-2 border-border/70 pl-4">
          <p className="font-semibold">You</p>
          <PullRequestDescriptionPreview markdown={reply.body} />
        </div>
      ))}
      {hiddenReplyCount > 0 ? <button type="button" className="mt-3 text-xs font-medium text-sky-400 hover:underline" onClick={() => setExpanded((current) => !current)}>{expanded ? `Hide ${hiddenReplyCount} replies` : `Show ${hiddenReplyCount} replies`}</button> : null}
      {thread.onSetState === undefined ? null : <Button className="mt-3" size="sm" variant="outline" disabled={pending} onClick={() => {
        setPending(true); setError(undefined);
        const action = thread.onSetState;
        if (action === undefined) return;
        void action(thread.id, thread.state === "resolved" ? "open" : "resolved").catch(() => setError("Patchdesk could not update this thread.")).finally(() => setPending(false));
      }}>{pending ? "Updating…" : thread.state === "resolved" ? "Unresolve" : "Resolve"}</Button>}
      {error === undefined ? null : <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      {thread.onReply === undefined ? null : (
        <div className="mt-4 border-t pt-3">
          <Textarea aria-label="Reply" value={replyBody} onChange={(event) => setReplyBody(event.target.value)} placeholder="Write a reply…" />
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={async () => {
              if (replyBody.trim().length === 0 || replying) return;
              setReplying(true); setError(undefined);
              try {
                const action = thread.onReply;
                if (action === undefined) return;
                const commentId = await action(thread.id, replyBody);
                setReplyBody("");
                if (typeof commentId === "string") {
                  setOptimisticReplies((current) => [
                    ...current,
                    { id: commentId, body: replyBody, createdAt: new Date().toISOString() },
                  ]);
                }
              } catch { setError("Patchdesk could not publish this reply."); }
              finally { setReplying(false); }
            }} disabled={replyBody.trim().length === 0 || replying}>
              {replying ? "Replying…" : "Reply"}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

function LocalCommentThread({
  path,
  startLine,
  line,
  body,
}: {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly body: string;
}): React.JSX.Element {
  const mockActionTitle = "Conversation actions are a UI preview only";
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-local-comment={`${path}:${startLine}:${line}`}
      aria-label={`Saved local comment on ${path}:${startLine}`}
    >
      <div className="flex min-w-0 gap-3">
        <MockCommentAvatar initials="Y" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-semibold">You</span>
            <span className="text-muted-foreground">Just now</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Local draft
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-foreground">{body}</p>

          <div className="mt-4 border-l-2 border-border/70 pl-4">
            <div className="flex min-w-0 gap-3">
              <MockCommentAvatar initials="R" tone="reply" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-semibold">Mock reviewer</span>
                  <span className="text-muted-foreground">Preview</span>
                </div>
                <p className="mt-2 break-words text-foreground">
                  Thanks — threaded replies are UI-only for now.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            <button
              type="button"
              disabled
              title={mockActionTitle}
              data-review-mock-action="reply"
              className="font-medium text-sky-400 transition-colors disabled:cursor-default disabled:opacity-100"
            >
              Add reply…
            </button>
            <button
              type="button"
              disabled
              title={mockActionTitle}
              data-review-mock-action="resolve"
              className="font-medium text-sky-400 transition-colors disabled:cursor-default disabled:opacity-100"
            >
              Resolve
            </button>
            <button
              type="button"
              disabled
              title={mockActionTitle}
              data-review-mock-action="delete"
              className="font-medium text-destructive transition-colors disabled:cursor-default disabled:opacity-100"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function MockCommentAvatar({
  initials,
  tone = "author",
}: {
  readonly initials: string;
  readonly tone?: "author" | "reply";
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${tone === "reply" ? "border-amber-300/30 bg-amber-400/20 text-amber-200" : "border-sky-300/30 bg-sky-400/20 text-sky-200"}`}
    >
      {initials}
    </span>
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
    catch (cause: unknown) {
      if (cause instanceof PatchdeskApiError) {
        console.error("Inline comment failed", { kind: cause.kind, status: cause.status, correlationId: cause.correlationId });
        if (cause.kind === "stale_head") setError("This pull request has changed. Refresh and try again.");
        else if (cause.kind === "github_rejected") setError("GitHub rejected this comment.");
        else if (cause.kind === "revision_conflict") setError("This comment cannot be published against the current diff.");
        else setError(`Patchdesk could not publish this comment (${cause.kind}). Try refreshing.`);
      } else {
        setError(cause instanceof Error ? cause.message : "Patchdesk could not publish this comment.");
      }
    }
    finally { setSaving(false); }
  };
  const cancel = (): void => {
    if (body.trim().length > 0 && !window.confirm("Discard this unsent comment?")) return;
    onCancel();
  };
  return <section className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 shadow-sm" aria-label="Inline comment composer"><p className="text-xs text-muted-foreground">{path}:{startLine}{line === startLine ? "" : `–${line}`} · publishes to GitHub</p><Textarea className="mt-2" autoFocus aria-label="Inline comment" value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void save(); } }} placeholder="Write an inline comment" /><div className="mt-2 flex gap-2"><Button size="sm" onClick={() => void save()} disabled={body.trim().length === 0 || saving}>{saving ? "Commenting…" : "Comment"}</Button><Button size="sm" variant="outline" onClick={cancel} disabled={saving}>Cancel</Button></div>{error === undefined ? null : <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}<p className="mt-2 text-xs text-muted-foreground">Press ⌘/Ctrl+Enter to comment. Escape cancels.</p></section>;
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
  virtualized,
  localCommentAuthoring,
  onAuthorLine,
}: {
  readonly patch: string;
  readonly selectedRange?: SelectedDiffRange;
  readonly virtualized: boolean;
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
      className={virtualized
        ? "max-h-[calc(100vh-12rem)] min-h-0 overflow-auto p-3 font-mono text-[13px] leading-5"
        : "min-h-0 overflow-x-auto p-3 font-mono text-[13px] leading-5"}
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
                return <button type="button" className="inline-flex size-5 items-center justify-center rounded border border-border/60 bg-card text-sm font-medium leading-none text-muted-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Add comment on ${path}`} title={`Add comment on ${path} line ${lineNumber}`} onClick={() => onAuthorLine?.(path, lineNumber, side)}>+</button>;
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

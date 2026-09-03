import {
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type LineDiffTypes,
} from "@pierre/diffs";
import {
  CodeView,
  FileDiff,
  PatchDiff,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import { ChevronsUpDown, FileCode2, Files } from "lucide-react";

import type { ReviewViewPreferences } from "@/review-view-preferences";
import type {
  ReviewContextControl,
  ReviewContextStatus,
} from "@/review-context-control";
import { type GitHubThreadId } from "../../../domain/ids";
import { definedProps } from "../../../domain/defined-props";
import { tokenizeUnifiedPatch } from "../../../domain/unified-patch";
import { FileChangeCounts, FileHeaderRow } from "./review-diff-file-header";
import { renderReviewDiffAnnotation } from "./review-diff-finding-card";
import { ReviewDiffOptionsPopover } from "./review-diff-options-popover";
import type {
  ConversationThreadCardData,
  ReviewConversationActions,
} from "./conversation-thread-card";
import { InlineCommentComposer } from "./review-diff-authoring";
import type { ReviewAnchorFingerprint } from "../../../domain/diff-anchor";
import type { ResolvedAppearance } from "@/appearance-preferences";
import { ReviewDiffNavigationFeedback } from "./review-diff-navigation-feedback";
import {
  diffThemeFor,
  loadDiffThemePreferences,
  parseDiffThemePreferences,
  type DiffThemePreferences,
} from "@/diff-theme-preferences";
import type { FileChangeStats } from "@/review-diff-data";
import type { FileFindingCount } from "@/review-finding-counts";
import { registerPierreThemeLoaders } from "@/pierre-theme-loaders";
import type { ReviewDiffSourceSession } from "@/hooks/use-review-diff-hydration";
import { useReviewCommentNavigation } from "@/hooks/use-review-comment-navigation";
import {
  reviewDiffNavigationResetIdentity,
  useReviewDiffNavigationFeedback,
  type ReviewDiffNavigationFeedbackState,
} from "@/hooks/use-review-diff-navigation-feedback";
import { useReviewFileNavigation } from "@/hooks/use-review-file-navigation";
import { useReviewHunkNavigation } from "@/hooks/use-review-hunk-navigation";
import { useReviewDiffSelectionScroll } from "@/hooks/use-review-diff-scroll-state";
import { useDiffWorkerPoolTheme } from "@/hooks/use-diff-worker-pool-theme";
import {
  useReviewDiffModel,
  type ReviewDiffModel,
} from "@/hooks/use-review-diff-model";
import { useReviewConversationOverlays } from "@/hooks/use-review-conversation-overlays";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

registerPierreThemeLoaders();

// Theme colors belong to the selected Pierre/Shiki descriptor. Patchdesk only
// owns the code metrics at this boundary so changing an independently saved
// light or dark theme changes both syntax and surface color as expected.
// SAFETY: every key below is a valid CSSProperties key with a valid CSS
// string value; the cast only widens the literal's inferred type.
const DIFF_CODE_METRICS = {
  fontSize: "13px",
  lineHeight: "20px",
  // Pierre's shadow-root stylesheet re-sets font-family on code elements, so
  // the stack must be handed over as the `--diffs-font-family` custom
  // property (custom properties cross the shadow boundary). `fontFamily`
  // still covers host-level text outside the shadow root.
  fontFamily: "var(--font-mono)",
  "--diffs-font-family": "var(--font-mono)",
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
// Matches @pierre/diffs' own default (DiffHunksRenderer destructures
// `lineDiffType = "word-alt"`). Named explicitly so the three render call
// sites below share one value instead of three hand-copied literals.
const DEFAULT_LINE_DIFF_TYPE: LineDiffTypes = "word-alt";

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
  /** Local-only create card while the GitHub write is pending or failed; never authoritative remote data. */
  readonly pendingConversation?: {
    readonly localId: string;
    readonly status: "sending" | "failed";
    readonly body: string;
    readonly onDismiss: (localId: string) => void;
  };
  /** Renderer-only card for a pending-review Start/Add write in flight or confirmed failed; no GitHub identity. */
  readonly pendingReviewWrite?: PendingReviewWriteConfig;
  /** Authoritative card for one confirmed pending-review thread, derived only from the pending projection. */
  readonly pendingReviewThread?: {
    readonly threadId: GitHubThreadId;
    readonly body: string;
    readonly nodeId: string;
  };
  readonly conversationThread?: ConversationThreadCardData;
  readonly localComposer?: LocalComposerConfig;
};

type LocalComposerConfig = {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
  readonly onCancel: () => void;
  readonly onSave: (body: string) => Promise<void>;
  readonly pendingReview?: PendingReviewComposerActions;
};
type PendingReviewWriteConfig = {
  readonly localId: string;
  readonly status: "sending" | "failed";
  readonly action: "start" | "add";
  readonly body: string;
  readonly message?: string;
  readonly onDismiss: (localId: string) => void;
};
export type LocalCommentLocation = {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
};

export type PendingReviewComposerActions = {
  readonly state:
    | { readonly state: "none" }
    | { readonly state: "pending"; readonly nodeId: string }
    | { readonly state: "unavailable" | "recovery_required" };
  readonly busy: boolean;
  readonly onStartReview: (
    anchor: LocalCommentLocation,
    body: string,
  ) => Promise<void>;
  readonly onAddReviewComment: (
    nodeId: string,
    anchor: LocalCommentLocation,
    body: string,
  ) => Promise<void>;
};

export type LocalCommentAuthoring = {
  readonly enabled: boolean;
  readonly canAuthor?: (input: LocalCommentLocation) => boolean;
  /** Reports the exact current diff range before a composer is opened. */
  readonly onSelectionChange?: (input: LocalCommentLocation) => void;
  readonly onSave: (input: LocalCommentAuthoringSaveInput) => Promise<{
    readonly commentId: string;
    readonly threadId?: string;
  } | void>;
};

export type LocalCommentAuthoringSaveInput = {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
  readonly fingerprint?: ReviewAnchorFingerprint;
  readonly body: string;
};
// Re-exported for callers (e.g. diff-workbench.tsx) that historically import
// this type from the diff-view module; the type itself now lives with the
// shared conversation thread card.
export type { ReviewConversationActions };

type ReviewDiffViewProps = {
  readonly patch: string;
  readonly parsedFiles: ReadonlyArray<FileDiffMetadata>;
  readonly fileStatsByPath: ReadonlyMap<string, FileChangeStats>;
  /** Mapped Analysis findings per file, shown as a badge in each file header. */
  readonly findingCountsByPath?: ReadonlyMap<string, FileFindingCount>;
  readonly selectedPath?: string | undefined;
  readonly selectedRange?: SelectedDiffRange;
  readonly annotations?: ReadonlyArray<ReviewInlineAnnotation>;
  /** Wires the "Open in Analysis" action on inline finding cards. */
  readonly onOpenFindingInAnalysis?: (findingId: string) => void;
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
  /** GitHub pending-review composer actions; drives the inline action split. */
  readonly pendingReviewComposer?: PendingReviewComposerActions;
  /** Direct GitHub conversation actions; the surface wraps them to apply published mutations locally. */
  readonly conversationActions?: ReviewConversationActions;
};

const EMPTY_ANNOTATIONS: ReadonlyArray<ReviewInlineAnnotation> = [];

function ReviewDiffToolbar({
  virtualized,
  preferences,
  selectedPath,
  onPreferencesChange,
  contextControl,
  contextStatus,
  expandUnchanged,
  onExpandUnchangedChange,
  collapsedPaths,
  files,
  onSetAllCollapsed,
}: {
  readonly virtualized: boolean;
  readonly preferences: Pick<
    ReviewViewPreferences,
    "fileMode" | "diffStyle" | "overflow" | "lineNumbers" | "backgrounds"
  >;
  readonly selectedPath: string | undefined;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly contextControl: ReviewContextControl;
  readonly contextStatus: ReviewContextStatus;
  readonly expandUnchanged: boolean;
  readonly onExpandUnchangedChange: (expanded: boolean) => void;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly onSetAllCollapsed: (collapsed: boolean) => void;
}): React.JSX.Element {
  return (
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
        <ReviewDiffOptionsPopover
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
        />
        <Button
          variant={expandUnchanged ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={expandUnchanged}
          aria-label={contextControl.description}
          title={contextControl.description}
          disabled={contextControl.disabled}
          onClick={() => onExpandUnchangedChange(!expandUnchanged)}
        >
          {contextStatus === "loading" ? <Spinner /> : <ChevronsUpDown />}
          {contextControl.label}
        </Button>
        <Button
          className={virtualized ? undefined : "hidden"}
          variant="ghost"
          size="xs"
          aria-pressed={
            collapsedPaths.size === files.length && files.length > 0
          }
          onClick={() =>
            onSetAllCollapsed(
              !(collapsedPaths.size === files.length && files.length > 0),
            )
          }
        >
          {collapsedPaths.size === files.length && files.length > 0
            ? "Show all"
            : "Mark all viewed"}
        </Button>
      </div>
    </div>
  );
}

function ReviewDiffSurface({
  patch,
  parsedFiles,
  fileStatsByPath,
  findingCountsByPath,
  selectedPath,
  selectedRange,
  annotations = EMPTY_ANNOTATIONS,
  onOpenFindingInAnalysis,
  preferences,
  collapsedPaths,
  onPreferencesChange,
  onCollapsedPathsChange,
  onActiveFileChange,
  sourceSession,
  virtualized = true,
  localCommentAuthoring,
  pendingReviewComposer,
  conversationActions,
}: ReviewDiffViewProps): React.JSX.Element {
  const [expandUnchanged, setExpandUnchanged] = useState(false);
  const [appearance, setAppearance] = useState<ResolvedAppearance>(() =>
    document.documentElement.dataset.appearance === "light" ? "light" : "dark",
  );
  const [themePreferences, setThemePreferences] =
    useState<DiffThemePreferences>(() => loadDiffThemePreferences());
  const viewer =
    useRef<CodeViewHandle<ReviewInlineAnnotation | undefined>>(null);
  useEffect(() => {
    const onAppearance = (event: Event): void => {
      // SAFETY: only `window.dispatchEvent(new CustomEvent("patchdesk:appearance", ...))`
      // ever fires this listener; the `if` below still validates the detail
      // before trusting it as a real ResolvedAppearance.
      const value = (event as CustomEvent<ResolvedAppearance>).detail;
      if (value === "light" || value === "dark") setAppearance(value);
    };
    window.addEventListener("patchdesk:appearance", onAppearance);
    return () =>
      window.removeEventListener("patchdesk:appearance", onAppearance);
  }, []);
  useEffect(() => {
    const onTheme = (event: Event): void => {
      // SAFETY: only a `patchdesk:diff-theme` CustomEvent reaches this
      // listener; its `detail` is still unknown to TS, and
      // `parseDiffThemePreferences` validates it before use.
      setThemePreferences(
        parseDiffThemePreferences((event as CustomEvent<unknown>).detail),
      );
    };
    window.addEventListener("patchdesk:diff-theme", onTheme);
    return () => window.removeEventListener("patchdesk:diff-theme", onTheme);
  }, []);
  useDiffWorkerPoolTheme(themePreferences);
  const {
    displayedAnnotations,
    localComposerAnnotation,
    beginAccessibleAuthoring,
    beginAuthoring,
    decorateConversationThread,
  } = useReviewConversationOverlays({
    patch,
    annotations,
    viewer,
    localCommentAuthoring,
    pendingReviewComposer,
    conversationActions,
  });
  const {
    contextControl,
    contextStatus,
    browserSupportsPierre,
    syntaxHighlightingStatus,
    selectedPatch,
    files,
    selectedFile,
    selectedAnnotations,
    items,
    selectedLines,
    activePathRef,
    resolveActiveFilePathAt,
    setViewerContainer,
    handleCodeViewScroll,
  } = useReviewDiffModel({
    patch,
    parsedFiles,
    selectedPath,
    selectedRange,
    annotations: displayedAnnotations,
    preferences: { fileMode: preferences.fileMode },
    collapsedPaths,
    expandUnchanged,
    themePreferences,
    sourceSession,
    virtualized,
    viewer,
    onActiveFileChange,
  });
  useReviewDiffSelectionScroll({
    viewer,
    items,
    selectedPath,
    selectedLines,
    diffStyle: preferences.diffStyle,
    fileMode: preferences.fileMode,
  });
  // A finding may land inside a collapsed unchanged hunk. Keep that evidence
  // materialized while it is selected; the user's explicit option still
  // controls whether every other unchanged hunk stays expanded.
  const expandSelectedRange = selectedRange !== undefined;

  useEffect(() => {
    activePathRef.current = undefined;
  }, [activePathRef, items, preferences.fileMode]);

  const navigationResetIdentity = reviewDiffNavigationResetIdentity(
    preferences.fileMode,
    items,
  );
  const { navigationStatus, createNavigationOperation } =
    useReviewDiffNavigationFeedback(navigationResetIdentity);

  useReviewFileNavigation({
    viewer,
    activePathRef,
    items,
    fileMode: preferences.fileMode,
    onActiveFileChange,
    createNavigationOperation,
    resolveActiveFilePathAt,
    virtualized,
    browserSupportsPierre,
  });

  useReviewHunkNavigation({
    viewer,
    activePathRef,
    items,
    fileMode: preferences.fileMode,
    onActiveFileChange,
    createNavigationOperation,
    resolveActiveFilePathAt,
    virtualized,
    browserSupportsPierre,
  });

  useReviewCommentNavigation({
    viewer,
    activePathRef,
    items,
    fileMode: preferences.fileMode,
    onActiveFileChange,
    createNavigationOperation,
    virtualized,
    browserSupportsPierre,
  });

  return (
    <ReviewDiffRenderSite
      patch={patch}
      selectedPatch={selectedPatch}
      selectedPath={selectedPath}
      selectedRange={selectedRange}
      preferences={preferences}
      onPreferencesChange={onPreferencesChange}
      contextControl={contextControl}
      themePreferences={themePreferences}
      appearance={appearance}
      expandUnchanged={expandUnchanged}
      expandSelectedRange={expandSelectedRange}
      onExpandUnchangedChange={setExpandUnchanged}
      collapsedPaths={collapsedPaths}
      files={files}
      fileStatsByPath={fileStatsByPath}
      findingCountsByPath={findingCountsByPath}
      onCollapsedPathsChange={onCollapsedPathsChange}
      decorateConversationThread={decorateConversationThread}
      onOpenFindingInAnalysis={onOpenFindingInAnalysis}
      virtualized={virtualized}
      browserSupportsPierre={browserSupportsPierre}
      navigationStatus={navigationStatus}
      syntaxHighlightingStatus={syntaxHighlightingStatus}
      localCommentAuthoring={localCommentAuthoring}
      localComposerAnnotation={localComposerAnnotation}
      contextStatus={contextStatus}
      beginAccessibleAuthoring={beginAccessibleAuthoring}
      selectedFile={selectedFile}
      selectedAnnotations={selectedAnnotations}
      selectedLines={selectedLines}
      viewer={viewer}
      items={items}
      setViewerContainer={setViewerContainer}
      handleCodeViewScroll={handleCodeViewScroll}
      beginAuthoring={beginAuthoring}
    />
  );
}

type ReviewDiffRenderSiteProps = {
  readonly patch: string;
  readonly selectedPatch: string;
  readonly selectedPath: string | undefined;
  readonly selectedRange: SelectedDiffRange | undefined;
  readonly preferences: ReviewViewPreferences;
  readonly onPreferencesChange: (
    update: Partial<ReviewViewPreferences>,
  ) => void;
  readonly contextControl: ReviewContextControl;
  readonly themePreferences: DiffThemePreferences;
  readonly appearance: ResolvedAppearance;
  readonly expandUnchanged: boolean;
  readonly expandSelectedRange: boolean;
  readonly onExpandUnchangedChange: (expanded: boolean) => void;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly fileStatsByPath: ReadonlyMap<string, FileChangeStats>;
  readonly findingCountsByPath:
    | ReadonlyMap<string, FileFindingCount>
    | undefined;
  readonly onCollapsedPathsChange: (paths: ReadonlySet<string>) => void;
  readonly decorateConversationThread: (
    thread: ConversationThreadCardData,
  ) => ConversationThreadCardData;
  readonly onOpenFindingInAnalysis: ((findingId: string) => void) | undefined;
  readonly virtualized: boolean;
  readonly browserSupportsPierre: boolean;
  readonly syntaxHighlightingStatus: "loading" | "ready" | "unavailable";
  readonly navigationStatus: ReviewDiffNavigationFeedbackState["navigationStatus"];
  readonly localCommentAuthoring: LocalCommentAuthoring | undefined;
  readonly localComposerAnnotation: ReviewInlineAnnotation | undefined;
  readonly contextStatus: ReviewContextStatus;
  readonly beginAccessibleAuthoring: (
    path: string,
    line: number,
    side: "additions" | "deletions",
  ) => void;
  readonly selectedFile: FileDiffMetadata | undefined;
  readonly selectedAnnotations: ReviewDiffModel["selectedAnnotations"];
  readonly selectedLines: ReviewDiffModel["selectedLines"];
  readonly viewer: RefObject<CodeViewHandle<
    ReviewInlineAnnotation | undefined
  > | null>;
  readonly items: ReviewDiffModel["items"];
  readonly setViewerContainer: ReviewDiffModel["setViewerContainer"];
  readonly handleCodeViewScroll: ReviewDiffModel["handleCodeViewScroll"];
  readonly beginAuthoring: (selection: CodeViewLineSelection | null) => void;
};

function ReviewDiffRenderSite({
  patch,
  selectedPatch,
  selectedPath,
  selectedRange,
  preferences,
  onPreferencesChange,
  contextControl,
  themePreferences,
  appearance,
  expandUnchanged,
  expandSelectedRange,
  onExpandUnchangedChange,
  collapsedPaths,
  files,
  fileStatsByPath,
  findingCountsByPath,
  onCollapsedPathsChange,
  decorateConversationThread,
  onOpenFindingInAnalysis,
  virtualized,
  browserSupportsPierre,
  navigationStatus,
  syntaxHighlightingStatus,
  localCommentAuthoring,
  localComposerAnnotation,
  contextStatus,
  beginAccessibleAuthoring,
  selectedFile,
  selectedAnnotations,
  selectedLines,
  viewer,
  items,
  setViewerContainer,
  handleCodeViewScroll,
  beginAuthoring,
}: ReviewDiffRenderSiteProps): React.JSX.Element {
  const codeViewOptions = useMemo(
    () => ({
      theme: diffThemeFor(themePreferences),
      themeType: appearance,
      disableBackground: !preferences.backgrounds,
      disableLineNumbers: !preferences.lineNumbers,
      diffStyle: preferences.diffStyle,
      overflow: preferences.overflow,
      hunkSeparators: "line-info" as const,
      expandUnchanged: expandUnchanged || expandSelectedRange,
      stickyHeaders: true,
      lineDiffType: DEFAULT_LINE_DIFF_TYPE,
      diffIndicators: "bars" as const,
      lineHoverHighlight: "both" as const,
      enableLineSelection: localCommentAuthoring?.enabled === true,
      enableGutterUtility: localCommentAuthoring?.enabled === true,
    }),
    [
      appearance,
      expandSelectedRange,
      expandUnchanged,
      localCommentAuthoring?.enabled,
      preferences.backgrounds,
      preferences.diffStyle,
      preferences.lineNumbers,
      preferences.overflow,
      themePreferences,
    ],
  );
  const codeViewKey = preferences.fileMode;
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
  const renderFileChangeCounts = useCallback(
    (path: string) => {
      const stats = fileStatsByPath.get(path) ?? {
        path,
        additions: 0,
        deletions: 0,
      };
      const findings = findingCountsByPath?.get(path);
      return (
        <FileChangeCounts
          stats={stats}
          {...(findings === undefined ? {} : { findings })}
        />
      );
    },
    [fileStatsByPath, findingCountsByPath],
  );
  const renderCodeViewHeader = useCallback(
    (item: CodeViewItem) => {
      if (item.type !== "diff") return null;
      const path = item.fileDiff.name;
      return (
        <FileHeaderRow
          file={item.fileDiff}
          stats={renderFileChangeCounts(path)}
          toggle={{
            collapsed: collapsedPaths.has(path),
            onToggle: () => toggleFile(path),
          }}
        />
      );
    },
    [collapsedPaths, renderFileChangeCounts, toggleFile],
  );
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewInlineAnnotation | undefined>) =>
      renderReviewDiffAnnotation(
        annotation,
        decorateConversationThread,
        onOpenFindingInAnalysis,
      ),
    [decorateConversationThread, onOpenFindingInAnalysis],
  );
  const renderGutterUtility = useCallback(
    (
      getHoveredLine: () =>
        | {
            readonly lineNumber: number;
            readonly side: "additions" | "deletions";
          }
        | undefined,
      item: { readonly id: string; readonly type: "diff" | "file" },
    ) =>
      renderReviewDiffGutterUtility(
        getHoveredLine,
        item,
        localCommentAuthoring,
        beginAuthoring,
      ),
    [beginAuthoring, localCommentAuthoring],
  );

  return (
    <>
      <ReviewDiffToolbar
        virtualized={virtualized}
        preferences={preferences}
        selectedPath={selectedPath}
        onPreferencesChange={onPreferencesChange}
        contextControl={contextControl}
        contextStatus={contextStatus}
        expandUnchanged={expandUnchanged}
        onExpandUnchangedChange={onExpandUnchangedChange}
        collapsedPaths={collapsedPaths}
        files={files}
        onSetAllCollapsed={setAllCollapsed}
      />
      {!browserSupportsPierre &&
      localComposerAnnotation?.localComposer !== undefined ? (
        <InlineCommentComposer {...localComposerAnnotation.localComposer} />
      ) : null}
      <ReviewDiffNavigationFeedback status={navigationStatus} />
      {!browserSupportsPierre ? (
        <AccessiblePatch
          patch={preferences.fileMode === "all" ? patch : selectedPatch}
          virtualized={virtualized}
          {...(selectedRange === undefined ? {} : { selectedRange })}
          {...(localCommentAuthoring === undefined
            ? {}
            : {
                localCommentAuthoring,
                onAuthorLine: beginAccessibleAuthoring,
              })}
        />
      ) : !virtualized ? (
        <NonVirtualizedReviewDiff
          patch={patch}
          selectedPatch={selectedPatch}
          selectedPath={selectedPath}
          selectedRange={selectedRange}
          preferences={preferences}
          syntaxHighlightingStatus={syntaxHighlightingStatus}
          localCommentAuthoring={localCommentAuthoring}
          beginAccessibleAuthoring={beginAccessibleAuthoring}
          selectedFile={selectedFile}
          themePreferences={themePreferences}
          appearance={appearance}
          expandUnchanged={expandUnchanged}
          expandSelectedRange={expandSelectedRange}
          selectedAnnotations={selectedAnnotations}
          selectedLines={selectedLines}
          fileStatsByPath={fileStatsByPath}
          findingCountsByPath={findingCountsByPath}
          decorateConversationThread={decorateConversationThread}
          onOpenFindingInAnalysis={onOpenFindingInAnalysis}
          beginAuthoring={beginAuthoring}
        />
      ) : (
        <div className="relative min-h-0 flex-1">
          <CodeView<ReviewInlineAnnotation | undefined>
            key={codeViewKey}
            ref={viewer}
            items={items}
            containerRef={setViewerContainer}
            selectedLines={selectedLines}
            className="visual-diff review-diff-viewport size-full min-h-[24rem] overflow-x-auto overflow-y-auto font-mono outline-none [contain:strict] [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-ring"
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
  | "onOpenFindingInAnalysis"
  | "beginAuthoring"
>;

function NonVirtualizedReviewDiff({
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
  onOpenFindingInAnalysis,
  beginAuthoring,
}: NonVirtualizedReviewDiffProps): React.JSX.Element {
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewInlineAnnotation | undefined>) =>
      renderReviewDiffAnnotation(
        annotation,
        decorateConversationThread,
        onOpenFindingInAnalysis,
      ),
    [decorateConversationThread, onOpenFindingInAnalysis],
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
  const renderGutterUtility = useCallback(
    (
      getHoveredLine: () =>
        | {
            readonly lineNumber: number;
            readonly side: "additions" | "deletions";
          }
        | undefined,
      item: { readonly id: string; readonly type: "diff" | "file" },
    ) =>
      renderReviewDiffGutterUtility(
        getHoveredLine,
        item,
        localCommentAuthoring,
        beginAuthoring,
      ),
    [beginAuthoring, localCommentAuthoring],
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
          <AlertTitle>Syntax highlighting is unavailable.</AlertTitle>
          <AlertDescription>
            Restart Patchdesk and try again. The code is shown as plain text.
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
    unsafeCSS: WALKTHROUGH_DIFF_COLORS_CSS,
    disableBackground: !preferences.backgrounds,
    disableLineNumbers: !preferences.lineNumbers,
    diffStyle: preferences.diffStyle,
    overflow: preferences.overflow,
    hunkSeparators: "line-info" as const,
    expandUnchanged: expandUnchanged || expandSelectedRange,
    lineDiffType: DEFAULT_LINE_DIFF_TYPE,
    diffIndicators: "bars" as const,
    lineHoverHighlight: "both" as const,
    enableGutterUtility: localCommentAuthoring?.enabled === true,
  };
  // `disableWorkerPool` on both renderers below predates the review diff's own
  // (removed) opt-out and stays: these are the walkthrough, brief and analysis
  // evidence surfaces, which render outside `DiffWorkbench` and so have no
  // pool above them anyway. Highlighting on the main thread is what a filtered
  // hunk of a few dozen lines wants.
  return selectedFile === undefined ? (
    <PatchDiff
      patch={selectedPatch}
      disableWorkerPool
      className="visual-diff min-h-0 overflow-x-auto font-mono"
      style={DIFF_CODE_METRICS}
      options={options}
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
      options={options}
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
  );
}

function renderReviewDiffGutterUtility(
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

/**
 * Local-only card for an inline create while the GitHub write is pending or
 * failed. It has no thread or comment id, offers no GitHub actions, and a
 * failed card only dismisses with bounded copy: a timeout may have created
 * the comment, so a direct retry could duplicate it.
 */

const MemoizedReviewDiffSurface = memo(ReviewDiffSurface);

const REVIEW_DIFF_REGION_NAME = "Review diff";

/** Every mounted region's "recompute my name" callback, so one region
 * mounting or unmounting can prompt every other mounted region to re-check
 * its own position instead of only ever checking its own once at mount. */
const reviewDiffRegionListeners = new Set<() => void>();

function notifyReviewDiffRegions(): void {
  for (const listener of reviewDiffRegionListeners) listener();
}

/**
 * Almost every page mounts exactly one `<section aria-label="Review diff">`,
 * so the plain name below is what nearly all callers and tests see. The
 * walkthrough is the one place two can mount at once: it takes over the
 * workbench visually but doesn't unmount it, so the workbench's own region
 * and the walkthrough's cited-hunk region both sit in the document at the
 * same time, and axe's landmark-unique rule correctly rejects same-role
 * regions that share a name. Threading a "there might be a sibling" flag
 * through the workbench, the walkthrough, and this component for that one
 * case isn't worth it: instead, every region tracks its live position in
 * the rendered document, and every region re-checks that position whenever
 * any region (including itself) mounts or unmounts -- not only at its own
 * mount, since the region that collides might not be the one that changed.
 * The first "Review diff" region in document order keeps the plain name;
 * any later one earns a name built from its selected path (falling back to
 * its rank if the path is unknown), so no two regions ever collide.
 */
function useReviewDiffRegionName(selectedPath: string | undefined) {
  const ref = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(REVIEW_DIFF_REGION_NAME);
  useLayoutEffect(() => {
    const recompute = (): void => {
      const element = ref.current;
      if (element === null) return;
      const regions = document.querySelectorAll<HTMLElement>(
        `section[aria-label^="${REVIEW_DIFF_REGION_NAME}"]`,
      );
      const rank = Array.from(regions).indexOf(element) + 1;
      setName(
        rank <= 1
          ? REVIEW_DIFF_REGION_NAME
          : selectedPath === undefined
            ? `${REVIEW_DIFF_REGION_NAME} ${rank}`
            : `${REVIEW_DIFF_REGION_NAME} ${rank}: ${selectedPath}`,
      );
    };
    reviewDiffRegionListeners.add(recompute);
    notifyReviewDiffRegions();
    return () => {
      reviewDiffRegionListeners.delete(recompute);
      notifyReviewDiffRegions();
    };
  }, [selectedPath]);
  return { ref, name };
}

export function ReviewDiffView(props: ReviewDiffViewProps): React.JSX.Element {
  // A navigator click should acknowledge selection before Pierre performs its
  // expensive virtual-file replacement. For extraordinarily large patches we
  // wait briefly for a burst of navigator changes to settle; normal reviews
  // still switch the rendered file synchronously.
  const deferredSelectedPath = useLargeDiffSelection(
    props.selectedPath,
    props.parsedFiles.length > 256,
  );
  const { ref: regionRef, name: regionName } = useReviewDiffRegionName(
    props.selectedPath,
  );
  return (
    <section
      ref={regionRef}
      aria-label={regionName}
      data-selected-path={props.selectedPath}
      data-diff-style={props.preferences.diffStyle}
      data-file-mode={props.preferences.fileMode}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <MemoizedReviewDiffSurface
        {...props}
        selectedPath={deferredSelectedPath}
      />
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
  /** Stable source-line identity within one parsed patch. */
  readonly key: string;
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
  readonly onAuthorLine?: (
    path: string,
    line: number,
    side: "additions" | "deletions",
  ) => void;
}): React.JSX.Element {
  const lines = useMemo(() => parseAccessibleLines(patch), [patch]);
  const selectedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    selectedRef.current?.focus({ preventScroll: true });
  }, [patch, selectedRange]);
  return (
    <div
      className={
        virtualized
          ? "max-h-[calc(100vh-12rem)] min-h-0 overflow-auto p-3 font-mono text-[13px] leading-5"
          : "min-h-0 overflow-x-auto p-3 font-mono text-[13px] leading-5"
      }
      role="region"
      aria-label="Plain text diff"
      tabIndex={0}
    >
      <ol className="min-w-max space-y-0">
        {lines.map((line) => {
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
              key={line.key}
              ref={firstSelected ? selectedRef : undefined}
              className={`grid grid-cols-[3.5rem_3.5rem_1fr] gap-2 rounded-sm px-1 ${selected ? "bg-primary/20 ring-1 ring-inset ring-primary/50" : ""}`}
              data-selected-line={selected ? "true" : undefined}
              data-line-type={
                line.kind === "Added"
                  ? "change-addition"
                  : line.kind === "Deleted"
                    ? "change-deletion"
                    : undefined
              }
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
              {localCommentAuthoring?.enabled === true &&
              line.path !== undefined &&
              (line.kind === "Added" || line.kind === "Deleted")
                ? (() => {
                    const path = line.path;
                    const side =
                      line.kind === "Added"
                        ? ("additions" as const)
                        : ("deletions" as const);
                    const lineNumber =
                      side === "additions" ? line.newLine : line.oldLine;
                    if (
                      lineNumber === undefined ||
                      localCommentAuthoring.canAuthor?.({
                        path,
                        startLine: lineNumber,
                        line: lineNumber,
                        side: side === "additions" ? "new" : "old",
                      }) === false
                    )
                      return null;
                    return (
                      <button
                        type="button"
                        className="inline-flex size-5 items-center justify-center rounded border border-border/60 bg-card text-sm font-medium leading-none text-muted-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Add comment on ${path}`}
                        title={`Add comment on ${path} line ${lineNumber}`}
                        onClick={() => onAuthorLine?.(path, lineNumber, side)}
                      >
                        +
                      </button>
                    );
                  })()
                : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function parseAccessibleLines(patch: string): ReadonlyArray<AccessibleLine> {
  let path: string | undefined;
  return tokenizeUnifiedPatch(patch).map((token) => {
    const base = { key: `source-line-${token.index}`, content: token.raw };
    if (token.kind === "file_header") {
      path = token.newPath;
      return { ...base, kind: "Context" as const, ...definedProps({ path }) };
    }
    const withPath = { ...base, ...definedProps({ path }) };
    if (token.kind === "hunk_header")
      return { ...withPath, kind: "Hunk" as const };
    if (token.kind !== "body" || token.marker === "no_newline")
      return { ...withPath, kind: "Context" as const };
    if (token.marker === "added")
      return {
        ...withPath,
        kind: "Added" as const,
        ...definedProps({ newLine: token.newLine }),
      };
    if (token.marker === "removed")
      return {
        ...withPath,
        kind: "Deleted" as const,
        ...definedProps({ oldLine: token.oldLine }),
      };
    return {
      ...withPath,
      kind: "Context" as const,
      ...definedProps({ oldLine: token.oldLine, newLine: token.newLine }),
    };
  });
}

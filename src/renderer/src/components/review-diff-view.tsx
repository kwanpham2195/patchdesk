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
import {
  CodeView,
  FileDiff,
  PatchDiff,
  type CodeViewHandle,
} from "@pierre/diffs/react";
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
import {
  parseGitHubThreadId,
  parseRepoRelativePath,
  type GitHubThreadId,
} from "../../../domain/ids";
import { toDiffLineAnnotation } from "../review-diff-annotations";
import { PullRequestDescriptionPreview } from "./pull-request-description";
import { PatchdeskApiError } from "../api-client";
import {
  ConversationThreadCard,
  type ConversationThreadCardData,
  type ReviewConversationActions,
} from "./conversation-thread-card";
import {
  fingerprintPatchAnchor,
  type ReviewAnchorFingerprint,
} from "../../../domain/diff-anchor";
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
import { reviewContextControl } from "@/review-context-control";
import { registerPierreThemeLoaders } from "@/pierre-theme-loaders";
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
// SAFETY: every key below is a valid CSSProperties key with a valid CSS
// string value; the cast only widens the literal's inferred type.
const DIFF_CODE_METRICS = {
  fontSize: "13px",
  lineHeight: "20px",
  fontFamily:
    '"Berkeley Mono", "JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
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

/** Mutable draft of `useReviewDiffHydration`'s input, built in statements so
 * each optional field is added only when it has a value. */
type ReviewDiffHydrationInput = {
  patch: string;
  sourceSession?: ReviewDiffSourceSession;
  selectedPath?: string;
};

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

export type LocalComposerConfig = {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
  readonly onCancel: () => void;
  readonly onSave: (body: string) => Promise<void>;
  readonly pendingReview?: PendingReviewComposerActions;
};
/** Mutable draft of `LocalComposerConfig`, built in statements so the
 * optional `pendingReview` is added only when it has a value. */
type MutableLocalComposerConfig = {
  -readonly [K in keyof LocalComposerConfig]: LocalComposerConfig[K];
};
/** Mutable draft of `ConversationThreadCardData`, built in statements so
 * each optional callback is added only when its action is wired. */
type MutableConversationThreadCardData = {
  -readonly [K in keyof ConversationThreadCardData]: ConversationThreadCardData[K];
};

export type PendingReviewWriteConfig = {
  readonly localId: string;
  readonly status: "sending" | "failed";
  readonly action: "start" | "add";
  readonly body: string;
  readonly message?: string;
  readonly onDismiss: (localId: string) => void;
};
/** Mutable draft of `PendingReviewWriteConfig`, built in statements so the
 * optional `message` is added only when the status is `"failed"`. */
type MutablePendingReviewWriteConfig = {
  -readonly [K in keyof PendingReviewWriteConfig]: PendingReviewWriteConfig[K];
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
  readonly onSave: (
    input: LocalCommentAuthoringSaveInput,
  ) => Promise<
    { readonly commentId: string; readonly threadId?: string } | void
  >;
};

export type LocalCommentAuthoringSaveInput = {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
  readonly fingerprint?: ReviewAnchorFingerprint;
  readonly body: string;
};
/** Mutable draft of `LocalCommentAuthoringSaveInput`, built in statements so
 * the optional `fingerprint` is added only when it has a value. */
type MutableLocalCommentAuthoringSaveInput = {
  -readonly [K in keyof LocalCommentAuthoringSaveInput]: LocalCommentAuthoringSaveInput[K];
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
      <span className="text-emerald-700 dark:text-emerald-400">
        +{stats.additions}
      </span>
      <span className="text-rose-700 dark:text-rose-400">
        -{stats.deletions}
      </span>
    </span>
  );
}

// Re-exported for callers (e.g. diff-workbench.tsx) that historically import
// this type from the diff-view module; the type itself now lives with the
// shared conversation thread card.
export type { ReviewConversationActions };

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
  /** GitHub pending-review composer actions; drives the inline action split. */
  readonly pendingReviewComposer?: PendingReviewComposerActions;
  /** Direct GitHub conversation actions; the surface wraps them to apply published mutations locally. */
  readonly conversationActions?: ReviewConversationActions;
};

const EMPTY_ANNOTATIONS: ReadonlyArray<ReviewInlineAnnotation> = [];

// Pre-existing giant component (over 1800 lines before this change, and this
// change actually shrinks the file by ~350 lines via the ConversationThreadCard
// extraction; `react-doctor --scope changed --base main` reports zero new
// issues here). Splitting it is the renderer god-file refactor the project's
// own plans explicitly defer to dedicated, separately-scoped work, not a fix
// this small feature change should take on.
// react-doctor-disable-next-line react-doctor/no-giant-component -- see comment above
function ReviewDiffSurface({
  patch,
  parsedFiles,
  fileStatsByPath,
  selectedPath,
  selectedRange,
  annotations = EMPTY_ANNOTATIONS,
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
  const activePathRef = useRef<string | undefined>(undefined);
  const viewerContainer = useRef<HTMLDivElement>(null);
  const [viewerElement, setViewerElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [authoringSelection, setAuthoringSelection] =
    useState<CodeViewLineSelection | null>(null);
  /** Local-only create overlays; `published` carries the real GitHub comment id, `sending`/`failed` carry none. */
  type CreatedThreadOverlay =
    | {
        readonly _tag: "sending";
        readonly localId: string;
        readonly path: string;
        readonly start: number;
        readonly end: number;
        readonly side: "new" | "old";
        readonly body: string;
      }
    | {
        readonly _tag: "failed";
        readonly localId: string;
        readonly path: string;
        readonly start: number;
        readonly end: number;
        readonly side: "new" | "old";
        readonly body: string;
      }
    | {
        readonly _tag: "published";
        readonly localId: string;
        readonly path: string;
        readonly start: number;
        readonly end: number;
        readonly side: "new" | "old";
        readonly body: string;
        readonly commentId: string;
        readonly threadId?: GitHubThreadId;
      };
  // Renderer-only feedback while a pending-review Start/Add command is in
  // flight or confirmed failed. Never a GitHub identity: a sending card only
  // shows progress, a failed card reports the bounded error, and neither
  // offers a retry nor becomes an editable Review draft.
  type PendingReviewWriteOverlay =
    | {
        readonly _tag: "sending";
        readonly localId: string;
        readonly action: "start" | "add";
        readonly path: string;
        readonly start: number;
        readonly end: number;
        readonly side: "new" | "old";
        readonly body: string;
      }
    | {
        readonly _tag: "failed";
        readonly localId: string;
        readonly action: "start" | "add";
        readonly path: string;
        readonly start: number;
        readonly end: number;
        readonly side: "new" | "old";
        readonly body: string;
        readonly message: string;
      };
  const [createdThreads, setCreatedThreads] = useState<
    ReadonlyArray<CreatedThreadOverlay>
  >([]);
  const [pendingWriteOverlays, setPendingWriteOverlays] = useState<
    ReadonlyArray<PendingReviewWriteOverlay>
  >([]);
  const localIdCounter = useRef(0);
  const [editedBodies, setEditedBodies] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [deletedCommentIds, setDeletedCommentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [resolvedThreads, setResolvedThreads] = useState<
    ReadonlyMap<string, "open" | "resolved">
  >(() => new Map());
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
      if (thread.target._tag === "thread") {
        threadIds.add(thread.target.id);
        threadStates.set(thread.target.id, thread.state);
      }
      for (const comment of thread.comments) {
        commentIds.add(comment.id);
        commentBodies.set(comment.id, comment.body);
      }
    }
    setCreatedThreads((current) => {
      const reconciled = current.filter((entry) => {
        // A published overlay is superseded once the projection owns its real
        // comment id; sending/failed overlays have no GitHub identity and stay.
        return entry._tag !== "published" || !commentIds.has(entry.commentId);
      });
      return reconciled.length === current.length ? current : reconciled;
    });
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
  const setViewerContainer = useCallback(
    (node: HTMLDivElement | null): void => {
      viewerContainer.current = node;
      setViewerElement(node);
    },
    [],
  );
  // Walkthrough cards render one filtered hunk with virtualized={false}. Full
  // source hydration would pair that partial patch with the entire file and
  // make Pierre calculate impossible trailing context.
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
  useReviewDiffQaScrollDiagnostics(viewerElement, viewer);
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
    () =>
      selectedPath === undefined
        ? undefined
        : files.find((file) => file.name === selectedPath),
    [files, selectedPath],
  );
  const clearAuthoring = useCallback((): void => {
    setAuthoringSelection(null);
    viewer.current?.clearSelectedLines();
  }, []);
  const beginAccessibleAuthoring = useCallback(
    (path: string, line: number, side: "additions" | "deletions"): void => {
      if (localCommentAuthoring?.enabled !== true) return;
      const location: LocalCommentLocation = {
        path,
        startLine: line,
        line,
        side: side === "additions" ? "new" : "old",
      };
      if (localCommentAuthoring.canAuthor?.(location) === false) return;
      localCommentAuthoring.onSelectionChange?.(location);
      setAuthoringSelection({
        id: path,
        range: { start: line, end: line, side },
      });
    },
    [localCommentAuthoring],
  );
  const saveAuthoring = useCallback(
    async (body: string): Promise<void> => {
      if (
        authoringSelection === null ||
        localCommentAuthoring?.enabled !== true
      )
        return;
      const side: "new" | "old" =
        authoringSelection.range.side === "additions" ? "new" : "old";
      const parsedPath = parseRepoRelativePath(authoringSelection.id);
      const anchor =
        parsedPath._tag === "ok"
          ? {
              path: parsedPath.value,
              startLine: authoringSelection.range.start,
              line: authoringSelection.range.end,
              side,
            }
          : undefined;
      if (anchor === undefined) return;
      const fingerprint = fingerprintPatchAnchor(patch, anchor);
      // A temporary local id never reaches a write command: the card is visible
      // immediately as pending, then reconciled from a real receipt or the next
      // represented snapshot. It is never a GitHub thread id.
      const localId = `local-${Date.now().toString(36)}-${localIdCounter.current}`;
      localIdCounter.current += 1;
      setCreatedThreads((current) => [
        ...current,
        {
          _tag: "sending",
          localId,
          path: anchor.path,
          start: anchor.startLine,
          end: anchor.line,
          side: anchor.side,
          body,
        },
      ]);
      clearAuthoring();
      try {
        const saveInput: MutableLocalCommentAuthoringSaveInput = {
          path: authoringSelection.id,
          startLine: anchor.startLine,
          line: anchor.line,
          side,
          body,
        };
        if (fingerprint !== undefined) saveInput.fingerprint = fingerprint;
        const receipt = await localCommentAuthoring.onSave(saveInput);
        // A read-back that failed or found no match must not fabricate a
        // thread id: an unparseable or absent `receipt.threadId` leaves the
        // card `comment_only`-equivalent (no `threadId` on the overlay),
        // never a guessed identity.
        const parsedThreadId =
          receipt?.threadId === undefined
            ? undefined
            : parseGitHubThreadId(receipt.threadId);
        const publishedBase = {
          _tag: "published" as const,
          localId,
          path: anchor.path,
          start: anchor.startLine,
          end: anchor.line,
          side: anchor.side,
          body,
        };
        const nextEntry: CreatedThreadOverlay =
          receipt !== undefined && receipt.commentId !== undefined
            ? parsedThreadId?._tag === "ok"
              ? {
                  ...publishedBase,
                  commentId: receipt.commentId,
                  threadId: parsedThreadId.value,
                }
              : { ...publishedBase, commentId: receipt.commentId }
            : {
                _tag: "failed" as const,
                localId,
                path: anchor.path,
                start: anchor.startLine,
                end: anchor.line,
                side: anchor.side,
                body,
              };
        setCreatedThreads((current) =>
          current.map((entry) =>
            entry.localId === localId ? nextEntry : entry,
          ),
        );
      } catch {
        // A timeout or transport failure may have created the comment; the card
        // must not offer a retry that could duplicate it. Refresh re-baselines.
        setCreatedThreads((current) =>
          current.map((entry) =>
            entry.localId === localId
              ? {
                  _tag: "failed" as const,
                  localId: entry.localId,
                  path: entry.path,
                  start: entry.start,
                  end: entry.end,
                  side: entry.side,
                  body: entry.body,
                }
              : entry,
          ),
        );
      }
    },
    [authoringSelection, clearAuthoring, localCommentAuthoring, patch],
  );
  const submitPendingWrite = useCallback(
    async (
      action: "start" | "add",
      anchor: LocalCommentLocation,
      body: string,
      run: (anchor: LocalCommentLocation, body: string) => Promise<void>,
    ): Promise<void> => {
      const localId = `pending-write-${Date.now().toString(36)}-${localIdCounter.current}`;
      localIdCounter.current += 1;
      setPendingWriteOverlays((current) => [
        ...current,
        {
          _tag: "sending",
          localId,
          action,
          path: anchor.path,
          start: anchor.startLine,
          end: anchor.line,
          side: anchor.side,
          body,
        },
      ]);
      // The composer closes immediately on submit, before the remote command
      // resolves; only the transient card represents the write now. onCancel is
      // not used because it may prompt about discarding text.
      clearAuthoring();
      try {
        await run(anchor, body);
        // The flow applied the confirmed pending projection on success; the
        // authoritative pending card replaces this transient at the same anchor.
        setPendingWriteOverlays((current) =>
          current.filter((entry) => entry.localId !== localId),
        );
      } catch (cause) {
        // An unknown outcome must not leave a card that claims anything was
        // written: the unavailable/recovery state and Check GitHub again own
        // reconciliation. A confirmed rejection keeps bounded failed feedback.
        if (
          cause instanceof PatchdeskApiError &&
          cause.kind === "outcome_unknown"
        ) {
          setPendingWriteOverlays((current) =>
            current.filter((entry) => entry.localId !== localId),
          );
          return;
        }
        setPendingWriteOverlays((current) =>
          current.map((entry) =>
            entry.localId === localId
              ? {
                  ...entry,
                  _tag: "failed" as const,
                  message: composerErrorMessage(cause),
                }
              : entry,
          ),
        );
      }
    },
    [clearAuthoring],
  );
  const localComposerAnnotation = useMemo<
    ReviewInlineAnnotation | undefined
  >(() => {
    if (authoringSelection === null || localCommentAuthoring?.enabled !== true)
      return undefined;
    // The pending actions are wrapped so a Start/Add submit gets the direct
    // comment lifecycle: a transient renderer-only card and an unconditional
    // composer close, both before the remote command is awaited.
    const wrappedPendingReview: PendingReviewComposerActions | undefined =
      pendingReviewComposer === undefined
        ? undefined
        : {
            ...pendingReviewComposer,
            onStartReview: (anchor, body) =>
              submitPendingWrite(
                "start",
                anchor,
                body,
                pendingReviewComposer.onStartReview,
              ),
            onAddReviewComment: (nodeId, anchor, body) =>
              submitPendingWrite("add", anchor, body, (a, b) =>
                pendingReviewComposer.onAddReviewComment(nodeId, a, b),
              ),
          };
    return {
      id: `local-comment:${authoringSelection.id}:${authoringSelection.range.start}:${authoringSelection.range.end}:${authoringSelection.range.side}`,
      path: authoringSelection.id,
      start: authoringSelection.range.start,
      end: authoringSelection.range.end,
      side: authoringSelection.range.side === "additions" ? "new" : "old",
      severity: "info",
      title: "Local comment",
      explanation: "",
      localComposer: (() => {
        const composer: MutableLocalComposerConfig = {
          path: authoringSelection.id,
          startLine: authoringSelection.range.start,
          line: authoringSelection.range.end,
          side: authoringSelection.range.side === "additions" ? "new" : "old",
          onCancel: clearAuthoring,
          onSave: saveAuthoring,
        };
        if (wrappedPendingReview !== undefined)
          composer.pendingReview = wrappedPendingReview;
        return composer;
      })(),
    };
  }, [
    authoringSelection,
    clearAuthoring,
    localCommentAuthoring?.enabled,
    saveAuthoring,
    pendingReviewComposer,
    submitPendingWrite,
  ]);
  const optimisticAnnotations = useMemo<ReadonlyArray<ReviewInlineAnnotation>>(
    () => [
      ...createdThreads.map((entry: CreatedThreadOverlay) => {
        // A sending/failed card has no GitHub identity at all: no thread id and
        // no comment id, so no write command can ever target it. A published
        // card uses its real comment id as the controlled item key; the
        // authoritative thread replaces it after an explicit refresh.
        if (entry._tag !== "published") {
          return {
            id: `conversation:pending:${entry.localId}`,
            path: entry.path,
            start: entry.start,
            end: entry.end,
            side: entry.side,
            severity: "conversation",
            title: "Conversation",
            explanation: "",
            pendingConversation: {
              localId: entry.localId,
              status: entry._tag,
              body: entry.body,
              onDismiss: (localId: string) =>
                setCreatedThreads((current) =>
                  current.filter((candidate) => candidate.localId !== localId),
                ),
            },
          };
        }
        const conversationThread: MutableConversationThreadCardData = {
          // A bounded, retried read-back inside `createInlineComment` may
          // already have confirmed the published thread this comment landed
          // in (see `confirmPublishedCommentThread`), upgrading Reply/Resolve
          // in the same round trip; when it could not confirm one, the card
          // stays comment-only and Edit/Delete remain reachable through the
          // real viewer-authored comment id (never a synthetic thread id).
          target:
            entry.threadId === undefined
              ? { _tag: "comment_only" as const, commentId: entry.commentId }
              : { _tag: "thread" as const, id: entry.threadId },
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
        };
        if (conversationActions?.editComment !== undefined)
          conversationThread.onEditComment = conversationActions.editComment;
        if (conversationActions?.deleteComment !== undefined)
          conversationThread.onDeleteComment = conversationActions.deleteComment;
        return {
          id: `conversation:${entry.commentId}`,
          path: entry.path,
          start: entry.start,
          end: entry.end,
          side: entry.side,
          severity: "conversation",
          title: "Conversation",
          explanation: "",
          conversationThread,
        };
      }),
      ...pendingWriteOverlays.map((entry: PendingReviewWriteOverlay) => {
        const pendingReviewWrite: MutablePendingReviewWriteConfig = {
          localId: entry.localId,
          status: entry._tag,
          action: entry.action,
          body: entry.body,
          onDismiss: (localId: string) =>
            setPendingWriteOverlays((current) =>
              current.filter((candidate) => candidate.localId !== localId),
            ),
        };
        if (entry._tag === "failed") pendingReviewWrite.message = entry.message;
        return {
          id: `pending-write:${entry.localId}`,
          path: entry.path,
          start: entry.start,
          end: entry.end,
          side: entry.side,
          severity: "conversation",
          title: "Pending review write",
          explanation: "",
          pendingReviewWrite,
        };
      }),
    ],
    [conversationActions, createdThreads, pendingWriteOverlays],
  );
  const renderedAnnotations = useMemo(
    () =>
      localComposerAnnotation === undefined
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
      if (thread.target._tag === "thread")
        projectionThreadIds.add(thread.target.id);
      for (const comment of thread.comments)
        projectionCommentIds.add(comment.id);
    }
    const displayed: Array<ReviewInlineAnnotation> = [];
    for (const annotation of renderedAnnotations) {
      const thread = annotation.conversationThread;
      if (thread === undefined) {
        displayed.push(annotation);
        continue;
      }
      // A created card is superseded by the authoritative thread with the
      // same thread or comment id; the projection now owns it.
      if (annotations.some((projection) => projection === annotation)) {
        displayed.push(annotation);
        continue;
      }
      const projectionTargetThreadId =
        thread.target._tag === "thread" ? thread.target.id : undefined;
      if (
        projectionTargetThreadId !== undefined &&
        projectionThreadIds.has(projectionTargetThreadId)
      )
        continue;
      if (projectionCommentIds.has(thread.comments[0]?.id ?? "")) continue;
      const targetThreadId =
        thread.target._tag === "thread" ? thread.target.id : undefined;
      const state =
        targetThreadId === undefined
          ? thread.state
          : (resolvedThreads.get(targetThreadId) ?? thread.state);
      const comments = thread.comments.flatMap((comment) => {
        if (deletedCommentIds.has(comment.id)) return [];
        const body = editedBodies.get(comment.id);
        return [body === undefined ? comment : { ...comment, body }];
      });
      if (comments.length === 0) continue;
      displayed.push({
        ...annotation,
        conversationThread: { ...thread, state, comments },
      });
    }
    return displayed;
  }, [
    annotations,
    deletedCommentIds,
    editedBodies,
    renderedAnnotations,
    resolvedThreads,
  ]);
  const selectedAnnotations = useMemo(
    () =>
      displayedAnnotations.flatMap((annotation) =>
        selectedPath === undefined || annotation.path === selectedPath
          ? [toDiffLineAnnotation(annotation)]
          : [],
      ),
    [displayedAnnotations, selectedPath],
  );
  const annotationKey = useMemo(
    () =>
      displayedAnnotations
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
            // The composer's effective pending state and owner node must bump the
            // controlled item version so a stale portal re-renders when none
            // becomes pending, the owner review changes, or a command goes busy.
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
            // Pending create cards are controlled items: their status and body must
            // bump the version so the replacement slot re-renders.
            annotation.pendingConversation === undefined
              ? ""
              : `${annotation.pendingConversation.status}\u0000${annotation.pendingConversation.body}`,
            // Pending-review write cards are controlled items too: status, action,
            // body, and the bounded failure message all bump the version.
            annotation.pendingReviewWrite === undefined
              ? ""
              : `${annotation.pendingReviewWrite.status}\u0000${annotation.pendingReviewWrite.action}\u0000${annotation.pendingReviewWrite.body}\u0000${annotation.pendingReviewWrite.message ?? ""}`,
            // Confirmed pending threads are controlled items: the owner node,
            // thread id, and body must bump the version when the projection moves.
            annotation.pendingReviewThread === undefined
              ? ""
              : `${annotation.pendingReviewThread.nodeId}\u0000${annotation.pendingReviewThread.threadId}\u0000${annotation.pendingReviewThread.body}`,
            // Thread cards are controlled items too: resolve state, reconciled
            // comments, and local mutation overrides must bump the version.
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
    [displayedAnnotations],
  );
  const items = useMemo(
    () =>
      visibleFiles.map<CodeViewDiffItem<ReviewInlineAnnotation | undefined>>(
        (file) => ({
          id: file.name,
          type: "diff",
          fileDiff: file,
          annotations: displayedAnnotations.flatMap((annotation) =>
            annotation.path === file.name
              ? [toDiffLineAnnotation(annotation)]
              : [],
          ),
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
        }),
      ),
    [
      annotationKey,
      collapsedPaths,
      hydratedFiles,
      displayedAnnotations,
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
  // A finding may land inside a collapsed unchanged hunk. Keep that evidence
  // materialized while it is selected; the user's explicit option still
  // controls whether every other unchanged hunk stays expanded.
  const expandSelectedRange = selectedRange !== undefined;
  const browserSupportsPierre =
    globalThis.CSSStyleSheet !== undefined &&
    "replaceSync" in CSSStyleSheet.prototype;
  // Non-virtualized (walkthrough) cards tokenize on the main thread after a
  // plain first paint. Preload their file languages and the active themes so
  // the retained reader shows syntax colors on first paint instead of flashing
  // uncolored text while each grammar loads.
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
  const viewerKey = preferences.fileMode;
  const sourceProfileId = hydrationSourceSession?.profileId;
  const sourceSessionId = hydrationSourceSession?.sessionId;
  const { loadedCount, nextItemIndex, appendItemsThrough, handleViewerScroll } =
    useProgressiveReviewDiffStream<ReviewInlineAnnotation | undefined>({
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
      if (
        !selectionChanged &&
        viewer.current?.getItem(selectedPath) !== undefined
      )
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
        appendItemsThrough(Math.min(targetIndex, nextItemIndex.current + 127));
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
      if (continuationFrame !== undefined)
        cancelAnimationFrame(continuationFrame);
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
    [
      appearance,
      expandSelectedRange,
      expandUnchanged,
      localCommentAuthoring?.enabled,
      preferences.diffStyle,
      preferences.overflow,
      themePreferences,
    ],
  );
  const hasExpandableRenderedFile = useMemo(
    () =>
      items.slice(0, loadedCount).some((item) => {
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
            aria-label={
              collapsedPaths.has(path)
                ? `Show file ${path}`
                : `Mark file ${path} as viewed`
            }
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
      if (finding.pendingConversation !== undefined) {
        return <PendingConversationCard {...finding.pendingConversation} />;
      }
      if (finding.pendingReviewWrite !== undefined) {
        return <PendingReviewWriteCard {...finding.pendingReviewWrite} />;
      }
      if (finding.pendingReviewThread !== undefined) {
        return <PendingReviewThreadCard {...finding.pendingReviewThread} />;
      }
      if (finding.conversationThread !== undefined) {
        const thread = finding.conversationThread;
        // Global Reply and state callbacks only ever attach to a canonical
        // GitHub thread target; a comment-only card cannot inherit them.
        const hasThreadTarget = thread.target._tag === "thread";
        const setState = hasThreadTarget
          ? (thread.onSetState ?? conversationActions?.setThreadState)
          : undefined;
        const reply = hasThreadTarget
          ? (thread.onReply ?? conversationActions?.replyToThread)
          : undefined;
        const edit = thread.onEditComment ?? conversationActions?.editComment;
        const remove =
          thread.onDeleteComment ?? conversationActions?.deleteComment;
        const cardThread: MutableConversationThreadCardData = { ...thread };
        if (setState !== undefined) {
          cardThread.onSetState = async (threadId, state) => {
            await setState(threadId, state);
            setResolvedThreads((current) => {
              const next = new Map(current);
              next.set(threadId, state);
              return next;
            });
          };
        }
        if (reply !== undefined) cardThread.onReply = reply;
        if (edit !== undefined) {
          cardThread.onEditComment = async (commentId, body) => {
            await edit(commentId, body);
            setEditedBodies((current) => {
              const next = new Map(current);
              next.set(commentId, body);
              return next;
            });
          };
        }
        if (remove !== undefined) {
          cardThread.onDeleteComment = async (commentId) => {
            await remove(commentId);
            setDeletedCommentIds((current) => {
              const next = new Set(current);
              next.add(commentId);
              return next;
            });
            setCreatedThreads((current) =>
              current.some(
                (entry) =>
                  entry._tag === "published" && entry.commentId === commentId,
              )
                ? current.filter(
                    (entry) =>
                      entry._tag !== "published" ||
                      entry.commentId !== commentId,
                  )
                : current,
            );
          };
        }
        return <ConversationThreadCard thread={cardThread} />;
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
            <span className="text-xs font-semibold text-primary">
              {finding.severity}
            </span>
            <h3 className="min-w-0 break-words font-medium">{finding.title}</h3>
          </div>
          <p className="mt-1 break-words text-muted-foreground">
            {finding.explanation}
          </p>
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
  const beginAuthoring = useCallback(
    (selection: CodeViewLineSelection | null): void => {
      if (localCommentAuthoring?.enabled !== true || selection === null) return;
      const range = selection.range;
      if (
        (range.side !== "additions" && range.side !== "deletions") ||
        (range.endSide !== undefined && range.endSide !== range.side)
      )
        return;
      const location: LocalCommentLocation = {
        path: selection.id,
        startLine: range.start,
        line: range.end,
        side: range.side === "additions" ? "new" : "old",
      };
      if (localCommentAuthoring.canAuthor?.(location) === false) return;
      localCommentAuthoring.onSelectionChange?.(location);
      setAuthoringSelection(selection);
    },
    [localCommentAuthoring],
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
    ) => {
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
    },
    [beginAuthoring, localCommentAuthoring],
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
            variant={
              preferences.fileMode === "selected" ? "secondary" : "ghost"
            }
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
              variant={
                preferences.diffStyle === "unified" ? "secondary" : "ghost"
              }
              size="xs"
              aria-pressed={preferences.diffStyle === "unified"}
              onClick={() => onPreferencesChange({ diffStyle: "unified" })}
            >
              <Rows3 /> Unified
            </Button>
            <Button
              variant={
                preferences.diffStyle === "split" ? "secondary" : "ghost"
              }
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
            aria-pressed={
              collapsedPaths.size === files.length && files.length > 0
            }
            onClick={() =>
              setAllCollapsed(
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
      {!browserSupportsPierre &&
      localComposerAnnotation?.localComposer !== undefined ? (
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
          {...(localCommentAuthoring === undefined
            ? {}
            : {
                localCommentAuthoring,
                onAuthorLine: beginAccessibleAuthoring,
              })}
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
          <span
            className="hidden"
            data-review-diff-loaded-file-count={loadedCount}
          />
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

/**
 * Local-only card for an inline create while the GitHub write is pending or
 * failed. It has no thread or comment id, offers no GitHub actions, and a
 * failed card only dismisses with bounded copy: a timeout may have created
 * the comment, so a direct retry could duplicate it.
 */
function PendingConversationCard({
  localId,
  status,
  body,
  onDismiss,
}: NonNullable<
  ReviewInlineAnnotation["pendingConversation"]
>): React.JSX.Element {
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-pending-conversation={localId}
      aria-label={`${status === "sending" ? "Publishing" : "Comment failed"} conversation`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {status === "sending" ? "Publishing…" : "Not published"}
        </span>
        {status === "sending" ? <span>Waiting for GitHub</span> : null}
      </div>
      <div className="mt-2">
        <p className="font-semibold">You</p>
        <PullRequestDescriptionPreview markdown={body} />
      </div>
      {status === "failed" ? (
        <div className="mt-2">
          <p role="alert" className="text-sm text-destructive">
            Patchdesk could not publish this comment. Refresh GitHub state
            before composing it again.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => onDismiss(localId)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Renderer-only card for a pending-review Start/Add write while the remote
 * command is in flight or confirmed failed. It has no GitHub identity, offers
 * no retry (a timeout may have created the thread), and never becomes an
 * editable Review draft: Refresh or Check GitHub again reconcile it.
 */
function PendingReviewWriteCard({
  localId,
  status,
  action,
  body,
  message,
  onDismiss,
}: NonNullable<
  ReviewInlineAnnotation["pendingReviewWrite"]
>): React.JSX.Element {
  const label =
    action === "start" ? "Starting review…" : "Adding to pending review…";
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-pending-write={localId}
      aria-label={`${status === "sending" ? label : "Pending review write failed"}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {status === "sending" ? label : "Pending review write failed"}
        </span>
        {status === "sending" ? <span>Waiting for GitHub</span> : null}
      </div>
      <div className="mt-2">
        <p className="font-semibold">You</p>
        <PullRequestDescriptionPreview markdown={body} />
      </div>
      {status === "failed" ? (
        <div className="mt-2">
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => onDismiss(localId)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Authoritative inline card for one comment of the viewer's pending review,
 * derived only from the confirmed pending projection. Explicitly not
 * published: no Reply/Resolve/Unresolve/edit/delete controls, and no
 * assumption that other reviewers can see it.
 */
function PendingReviewThreadCard({
  threadId,
  body,
}: NonNullable<
  ReviewInlineAnnotation["pendingReviewThread"]
>): React.JSX.Element {
  return (
    <article
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
      data-review-pending-thread={threadId}
      aria-label="Pending review comment"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 font-medium text-amber-200">
          Pending review
        </span>
        <span className="text-muted-foreground">Not yet submitted</span>
      </div>
      <div className="mt-2">
        <p className="font-semibold">You</p>
        <PullRequestDescriptionPreview markdown={body} />
      </div>
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
          <p className="mt-2 whitespace-pre-wrap break-words text-foreground">
            {body}
          </p>

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

/** Bounded copy for a failed inline write; shared by the composer and the transient pending-write card. */
function composerErrorMessage(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (cause.kind === "stale_head")
      return "This pull request has changed. Refresh and try again.";
    if (cause.kind === "github_rejected" || cause.kind === "rejected")
      return "GitHub rejected this comment.";
    if (cause.kind === "revision_conflict")
      return "This comment cannot be published against the current diff.";
    if (cause.kind === "outcome_unknown")
      return "GitHub could not confirm this write. Check GitHub again before trying again.";
    if (
      cause.kind === "no_pending_review" ||
      cause.kind === "pending_review_locked"
    )
      return "The pending review changed. Refresh to see its current state.";
    return `Patchdesk could not publish this comment (${cause.kind}). Try refreshing.`;
  }
  return cause instanceof Error
    ? cause.message
    : "Patchdesk could not publish this comment.";
}

function InlineCommentComposer({
  path,
  startLine,
  line,
  side,
  onCancel,
  onSave,
  pendingReview,
}: {
  readonly path: string;
  readonly startLine: number;
  readonly line: number;
  readonly side: "new" | "old";
  readonly onCancel: () => void;
  readonly onSave: (body: string) => Promise<void>;
  readonly pendingReview?: PendingReviewComposerActions;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pendingState = pendingReview?.state.state;
  const writeDisabled =
    pendingState === "unavailable" || pendingState === "recovery_required";
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (body.trim().length === 0 || saving || pendingReview?.busy === true)
      return;
    setSaving(true);
    setError(undefined);
    try {
      await action();
    } catch (cause: unknown) {
      if (cause instanceof PatchdeskApiError) {
        console.error("Inline review comment failed", {
          kind: cause.kind,
          status: cause.status,
          correlationId: cause.correlationId,
        });
      }
      setError(composerErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  const anchor = { path, startLine, line, side };
  const startOrAdd = (): Promise<void> => {
    if (pendingReview === undefined) return onSave(body);
    const state = pendingReview.state;
    if (state.state === "pending")
      return pendingReview.onAddReviewComment(state.nodeId, anchor, body);
    return pendingReview.onStartReview(anchor, body);
  };
  const cancel = (): void => {
    if (
      body.trim().length > 0 &&
      !window.confirm("Discard this unsent comment?")
    )
      return;
    onCancel();
  };
  const busy = saving || pendingReview?.busy === true;
  return (
    <section
      className="mx-2 my-2 box-border w-[calc(100%-1rem)] min-w-0 max-w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-md border bg-card p-3 shadow-sm"
      aria-label="Inline comment composer"
    >
      <p className="text-xs text-muted-foreground">
        {path}:{startLine}
        {line === startLine ? "" : `–${line}`} ·{" "}
        {pendingState === "pending"
          ? "joins your pending review on GitHub"
          : pendingState === "none"
            ? "publishes to GitHub"
            : "GitHub write is paused"}
      </p>
      <Textarea
        className="mt-2"
        autoFocus
        aria-label="Inline comment"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            !writeDisabled
          ) {
            event.preventDefault();
            void run(startOrAdd);
          }
        }}
        placeholder="Write an inline comment"
        disabled={writeDisabled}
      />
      <div className="mt-2 flex gap-2">
        {pendingReview === undefined ? (
          <Button
            size="sm"
            onClick={() => void run(() => onSave(body))}
            disabled={body.trim().length === 0 || busy}
          >
            Comment
          </Button>
        ) : writeDisabled ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Pending review state is unavailable. Check GitHub again or refresh
            before commenting.
          </p>
        ) : pendingState === "pending" ? (
          <Button
            size="sm"
            onClick={() => void run(startOrAdd)}
            disabled={body.trim().length === 0 || busy}
          >
            Add review comment
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              onClick={() => void run(startOrAdd)}
              disabled={body.trim().length === 0 || busy}
            >
              Start a review
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run(() => onSave(body))}
              disabled={body.trim().length === 0 || busy}
            >
              Comment now
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onClick={cancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Press ⌘/Ctrl+Enter to comment. Escape cancels.
      </p>
    </section>
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
      style={{
        fontFamily:
          '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
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
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let path: string | undefined;
  return patch.split("\n").map((content, sourceLine) => {
    const key = `source-line-${sourceLine}`;
    const file = /^diff --git a\/(.+) b\/(.+)$/.exec(content);
    if (file !== null) {
      path = file[2];
      oldLine = undefined;
      newLine = undefined;
      const contextLine = { key, content, kind: "Context" as const };
      return path === undefined ? contextLine : { ...contextLine, path };
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      const hunkLine = { key, content, kind: "Hunk" as const };
      return path === undefined ? hunkLine : { ...hunkLine, path };
    }
    if (
      oldLine === undefined ||
      newLine === undefined ||
      content.startsWith("\\ No newline")
    ) {
      return { key, content, kind: "Context" };
    }
    if (content.startsWith("+") && !content.startsWith("+++")) {
      const line = { key, content, kind: "Added" as const, newLine };
      newLine += 1;
      return path === undefined ? line : { ...line, path };
    }
    if (content.startsWith("-") && !content.startsWith("---")) {
      const line = { key, content, kind: "Deleted" as const, oldLine };
      oldLine += 1;
      return path === undefined ? line : { ...line, path };
    }
    const line = { key, content, kind: "Context" as const, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return path === undefined ? line : { ...line, path };
  });
}

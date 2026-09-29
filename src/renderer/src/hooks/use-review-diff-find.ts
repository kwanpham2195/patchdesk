import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { materializeAndScrollTo } from "../review-diff-materialize-and-scroll";
import {
  adjacentFindMatch,
  findDiffMatches,
  findNavigationStatus,
  type DiffFindMatch,
} from "../review-diff-find";
import { markDiffFindMatch } from "../review-diff-find-mark";
import {
  focusInsideOverlay,
  type ReviewNavDirection,
} from "../review-diff-keyboard-nav";
import type { ReviewDiffNavigationOperation } from "./use-review-diff-navigation-feedback";
import { useKeyboardJump } from "./use-keyboard-jump";
import { useLatestCommitted } from "./use-latest-committed";

/**
 * The window event the native Edit menu's Find item raises in the renderer;
 * the Diff's find bar is the only screen that answers it.
 */
export const FIND_IN_DIFF_REQUEST = "patchdesk:find-in-diff";

/** What the find bar draws and the actions it calls. */
export type ReviewDiffFindControl = {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly total: number;
  /** The landed match's 1-based position; undefined before the first step. */
  readonly position: number | undefined;
  readonly onStep: (direction: ReviewNavDirection) => void;
  readonly onClose: () => void;
};

type FindItem = {
  readonly id: string;
  readonly collapsed?: boolean;
};

type PendingFindJump = {
  readonly match: DiffFindMatch;
  readonly index: number;
  readonly total: number;
  readonly wrapped: boolean;
  readonly direction: ReviewNavDirection;
};

function matchKey(match: DiffFindMatch): string {
  return `${match.path}\u0000${match.lineType}\u0000${match.lineNumber}`;
}

/**
 * Owns ⌘F on the Diff: the find bar's state, the step from match to match,
 * and the mark on the landed line.
 *
 * A step first makes its match's file drawable: in Selected it selects that
 * file, and a Viewed file loses its mark so it expands. The scroll waits until
 * `items` shows the file drawn and expanded, then reports its outcome through
 * the shared navigation feedback once the line has materialized.
 */
export function useReviewDiffFind<T>({
  viewer,
  activePathRef,
  files,
  items,
  collapsedPaths,
  onCollapsedPathsChange,
  onActiveFileChange,
  onSelectedPathChange,
  createNavigationOperation,
  virtualized,
  browserSupportsPierre,
  markdownPreviewActive,
}: {
  readonly viewer: RefObject<CodeViewHandle<T> | null>;
  readonly activePathRef: { current: string | undefined };
  /** Every file the Scope picker shows, in the order the Diff draws them. */
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly items: ReadonlyArray<FindItem>;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly onCollapsedPathsChange: (paths: ReadonlySet<string>) => void;
  readonly onActiveFileChange: ((path: string) => void) | undefined;
  /** Absent where the diff cannot change its selected file, which turns find off. */
  readonly onSelectedPathChange: ((path: string) => void) | undefined;
  readonly createNavigationOperation: () => ReviewDiffNavigationOperation;
  readonly virtualized: boolean;
  readonly browserSupportsPierre: boolean;
  /** The preview pane replaces CodeView, so there is no diff to search. */
  readonly markdownPreviewActive: boolean;
}): ReviewDiffFindControl | undefined {
  const enabled =
    virtualized &&
    browserSupportsPierre &&
    !markdownPreviewActive &&
    onSelectedPathChange !== undefined;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [landed, setLanded] = useState<DiffFindMatch>();
  const [focusRequest, setFocusRequest] = useState(0);
  const [jumpRequest, setJumpRequest] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const pending = useRef<PendingFindJump | undefined>(undefined);
  // The match the last step asked for, until its scroll lands. A second Enter
  // steps from here; `landed` still names the previous match until then.
  const requestedIndex = useRef<number | undefined>(undefined);
  const matches = useMemo(
    () => (open ? findDiffMatches(files, query) : []),
    [files, open, query],
  );
  const landedKey = landed === undefined ? undefined : matchKey(landed);
  const landedIndex =
    landedKey === undefined
      ? -1
      : matches.findIndex((match) => matchKey(match) === landedKey);
  const latest = useLatestCommitted({
    open,
    matches,
    landedIndex,
    items,
    collapsedPaths,
    onCollapsedPathsChange,
    onActiveFileChange,
    onSelectedPathChange,
    createNavigationOperation,
  });

  const openFind = useCallback((): void => {
    if (focusInsideOverlay()) return;
    if (!latest.current.open) opener.current = document.activeElement;
    setOpen(true);
    setFocusRequest((request) => request + 1);
  }, [latest]);

  const runner = useKeyboardJump(enabled, (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
      return;
    if (event.key.toLowerCase() !== "f" || event.isComposing) return;
    event.preventDefault();
    openFind();
  });

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener(FIND_IN_DIFF_REQUEST, openFind);
    return () => window.removeEventListener(FIND_IN_DIFF_REQUEST, openFind);
  }, [enabled, openFind]);

  useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  useEffect(() => {
    const jump = pending.current;
    const jumpRunner = runner.current;
    if (jump === undefined || jumpRunner === undefined) return;
    const { path } = jump.match;
    const item = items.find((candidate) => candidate.id === path);
    if (item === undefined || item.collapsed === true) return;
    pending.current = undefined;
    // Created only now: expanding or selecting the file resets the feedback generation.
    const operation = latest.current.createNavigationOperation();
    jumpRunner.start((isStale) => {
      const stale = (): boolean => isStale() || operation.isStale();
      return materializeAndScrollTo({
        viewer,
        itemId: path,
        isStale: stale,
        target: {
          type: "line",
          id: path,
          lineNumber: jump.match.lineNumber,
          side: jump.match.side,
          align: "center",
        },
        onScrolled: () => {
          if (stale()) return;
          activePathRef.current = path;
          latest.current.onActiveFileChange?.(path);
          requestedIndex.current = undefined;
          setLanded(jump.match);
          operation.report(
            findNavigationStatus(
              jump.match,
              jump.index,
              jump.total,
              jump.wrapped,
              jump.direction,
            ),
          );
        },
      });
    });
  }, [activePathRef, items, jumpRequest, latest, runner, viewer]);

  // A Scope change can drop the landed line from the matches; its mark goes with it.
  const markedMatch = landedIndex === -1 ? undefined : landed;
  useEffect(() => {
    const codeView = viewer.current?.getInstance();
    if (markedMatch === undefined || codeView === undefined) return;
    return markDiffFindMatch(codeView, markedMatch);
  }, [items, markedMatch, viewer]);

  if (!enabled || !open) return undefined;
  const cancelJump = (): void => {
    pending.current = undefined;
    requestedIndex.current = undefined;
    runner.current?.start(() => () => undefined);
  };
  return {
    inputRef,
    query,
    onQueryChange: (next) => {
      cancelJump();
      setLanded(undefined);
      setQuery(next);
    },
    total: matches.length,
    position: landedIndex === -1 ? undefined : landedIndex + 1,
    onStep: (direction) => {
      const current = latest.current;
      const target = adjacentFindMatch(
        current.matches.length,
        requestedIndex.current ??
          (current.landedIndex === -1 ? undefined : current.landedIndex),
        direction,
      );
      const match =
        target === undefined ? undefined : current.matches[target.index];
      if (target === undefined || match === undefined) return;
      cancelJump();
      requestedIndex.current = target.index;
      pending.current = {
        match,
        index: target.index,
        total: current.matches.length,
        wrapped: target.wrapped,
        direction,
      };
      if (!current.items.some((item) => item.id === match.path))
        current.onSelectedPathChange?.(match.path);
      if (current.collapsedPaths.has(match.path)) {
        const next = new Set(current.collapsedPaths);
        next.delete(match.path);
        current.onCollapsedPathsChange(next);
      }
      setJumpRequest((request) => request + 1);
    },
    onClose: () => {
      cancelJump();
      setLanded(undefined);
      setOpen(false);
      const previous = opener.current;
      opener.current = null;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    },
  };
}

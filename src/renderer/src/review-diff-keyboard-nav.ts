/**
 * Shared guard and navigation geometry for printable-key bindings on the Diff
 * surface. Cmd/Ctrl+K and Cmd/Ctrl+, are modifier-gated; `,`, `.`, `[`, `]`,
 * `{`, and `}` must ignore typing, modifiers, IME composition, and overlays.
 * Comment navigation also uses this guard and stops at either end like file
 * and hunk navigation.
 */

import { threadNeedsReply } from "../../domain/github-context";

/** True when `target` is a place the user is actively typing: a native
 * text-entry control, or any element inside a `contenteditable` region.
 * `HTMLElement.isContentEditable` already reflects an editable ancestor, so
 * no manual `closest` walk is needed for that case. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

/**
 * True when focus is inside an open overlay. Base UI uses dialog for Dialog
 * and Popover, alertdialog for AlertDialog, menu for Menu, and listbox for
 * Select and Combobox. Its menu typeahead swallows printable keys, but
 * modifier chords such as ⌘1–⌘3 and ⌘F still reach the window.
 */
export function focusInsideOverlay(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active.closest(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    ) !== null
  );
}

/**
 * True when a single-key review-navigation binding must be ignored outright:
 * the keystroke targets a text-entry surface, a modifier is held (this is
 * what keeps e.g. Cmd+, working untouched), IME composition owns the
 * keystroke, or an overlay currently holds focus. Every printable-character
 * binding in the review diff surface must consult this before acting, and
 * must never call `preventDefault()` when it returns true.
 */
export function shouldIgnoreReviewNavKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  // 229 is the IME composition sentinel keyCode; some browsers still report
  // it for the keystroke that ends composition, after `isComposing` has
  // already flipped back to false.
  // oxlint-disable-next-line no-deprecated -- keyCode is the only signal
  // some browsers still give for the composition-ending keystroke.
  if (event.isComposing || event.keyCode === 229) return true;
  // A window listener sees a shadow-root field (the Browse tree's search) retargeted to its host.
  if (isTypingTarget(event.composedPath()[0] ?? event.target)) return true;
  if (focusInsideOverlay()) return true;
  return false;
}

export type ReviewNavDirection = "previous" | "next";

/**
 * One completed or boundary-limited review-diff keyboard-navigation outcome.
 * The renderer consumes its fields directly for both visible copy and stable
 * data attributes; it never infers meaning by parsing a message string.
 */
export type ReviewDiffNavigationStatus =
  | {
      readonly kind: "file" | "hunk";
      readonly state: "first" | "last";
      readonly total: number;
      readonly message: string;
    }
  | {
      readonly kind: "comment" | "finding";
      readonly state: "first" | "last" | "empty";
      readonly total: number;
      readonly message: string;
    }
  | {
      readonly kind: "unviewed";
      readonly state: "empty";
      readonly total: 0;
      readonly message: string;
    }
  | {
      readonly kind:
        | "file"
        | "hunk"
        | "comment"
        | "finding"
        | "unviewed"
        | "viewed";
      readonly state: "unavailable";
      readonly message: string;
    }
  | {
      readonly kind: "unviewed";
      readonly state: "target" | "wrapped";
      readonly position: number;
      readonly total: number;
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly kind: "file";
      readonly state: "target";
      readonly position: number;
      readonly total: number;
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly kind: "hunk" | "comment" | "finding";
      readonly state: "target";
      readonly position: number;
      readonly total: number;
      readonly path: string;
      readonly line: number;
      readonly message: string;
    }
  | {
      readonly kind: "find";
      readonly state: "target" | "wrapped";
      readonly position: number;
      readonly total: number;
      readonly path: string;
      readonly line: number;
      readonly message: string;
    };

/** Builds the structured outcome for one file-navigation keypress. */
export function fileNavigationStatus(
  order: ReadonlyArray<string>,
  target: string | undefined,
  direction: ReviewNavDirection,
): ReviewDiffNavigationStatus {
  if (target === undefined)
    return {
      kind: "file",
      state: direction === "next" ? "last" : "first",
      total: order.length,
      message:
        direction === "next"
          ? "Already at the last file."
          : "Already at the first file.",
    };
  const position = order.indexOf(target) + 1;
  return {
    kind: "file",
    state: "target",
    position,
    total: order.length,
    path: target,
    message: `File ${position} of ${order.length}: ${target}.`,
  };
}

/** Builds the structured outcome for one hunk-navigation keypress. */
export function hunkNavigationStatus(
  order: ReadonlyArray<HunkAnchor>,
  target: HunkAnchor | undefined,
  direction: ReviewNavDirection,
): ReviewDiffNavigationStatus {
  if (target === undefined)
    return {
      kind: "hunk",
      state: direction === "next" ? "last" : "first",
      total: order.length,
      message:
        direction === "next"
          ? "Already at the last hunk."
          : "Already at the first hunk.",
    };
  const position =
    order.findIndex(
      (anchor) =>
        anchor.filePath === target.filePath &&
        anchor.lineNumber === target.lineNumber &&
        anchor.side === target.side,
    ) + 1;
  return {
    kind: "hunk",
    state: "target",
    position,
    total: order.length,
    path: target.filePath,
    line: target.lineNumber,
    message: `Hunk ${position} of ${order.length}: ${target.filePath} line ${target.lineNumber}.`,
  };
}

/** Builds the structured outcome for one unresolved-comment keypress. */
export function commentNavigationStatus(
  order: ReadonlyArray<CommentAnchor>,
  target: CommentAnchor | undefined,
  direction: ReviewNavDirection,
): ReviewDiffNavigationStatus {
  if (order.length === 0)
    return {
      kind: "comment",
      state: "empty",
      total: 0,
      message: "No unresolved comments.",
    };
  if (target === undefined) {
    const state = direction === "next" ? "last" : "first";
    const count =
      order.length === 1
        ? "1 unresolved comment"
        : `${order.length} unresolved comments`;
    return {
      kind: "comment",
      state,
      total: order.length,
      message: `Already at the ${state} unresolved comment. ${count} total.`,
    };
  }
  const position = order.findIndex((anchor) => anchor.id === target.id) + 1;
  return {
    kind: "comment",
    state: "target",
    position,
    total: order.length,
    path: target.filePath,
    line: target.lineNumber,
    message: `Comment ${position} of ${order.length} unresolved.`,
  };
}

/**
 * The file adjacent to `current` in `order`, one step in `direction`, or
 * `undefined` at either end -- navigation stops rather than wrapping. A
 * `current` missing from `order` (nothing has resolved an active file yet)
 * is treated as sitting just before the first file, so "next" lands on
 * `order[0]` and "previous" reports the start boundary.
 */
export function adjacentFilePath(
  order: ReadonlyArray<string>,
  current: string | undefined,
  direction: ReviewNavDirection,
): string | undefined {
  if (order.length === 0) return undefined;
  const currentIndex = current === undefined ? -1 : order.indexOf(current);
  const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= order.length) return undefined;
  return order[nextIndex];
}

/**
 * The next or previous file in `order` that is not in `viewed`, searching
 * from `current` and wrapping past either end. `wrapped` is true when the
 * search passed an end; `undefined` means every file is viewed.
 */
export function adjacentUnviewedFilePath(
  order: ReadonlyArray<string>,
  viewed: ReadonlySet<string>,
  current: string | undefined,
  direction: ReviewNavDirection,
): { readonly path: string; readonly wrapped: boolean } | undefined {
  const unviewed = order.filter((path) => !viewed.has(path));
  const wrappedPath = direction === "next" ? unviewed[0] : unviewed.at(-1);
  if (wrappedPath === undefined) return undefined;
  const currentIndex = current === undefined ? -1 : order.indexOf(current);
  const ahead =
    direction === "next"
      ? order.slice(currentIndex + 1)
      : order.slice(0, Math.max(currentIndex, 0)).reverse();
  const path = ahead.find((candidate) => !viewed.has(candidate));
  if (path !== undefined) return { path, wrapped: false };
  return { path: wrappedPath, wrapped: true };
}

/** Builds the structured outcome for one unviewed-file keypress. */
export function unviewedFileNavigationStatus(
  order: ReadonlyArray<string>,
  viewed: ReadonlySet<string>,
  target: { readonly path: string; readonly wrapped: boolean } | undefined,
  direction: ReviewNavDirection,
): ReviewDiffNavigationStatus {
  if (target === undefined)
    return {
      kind: "unviewed",
      state: "empty",
      total: 0,
      message: "Every file is viewed.",
    };
  const unviewed = order.filter((path) => !viewed.has(path));
  const position = unviewed.indexOf(target.path) + 1;
  const landed = `Unviewed file ${position} of ${unviewed.length}: ${target.path}.`;
  return {
    kind: "unviewed",
    state: target.wrapped ? "wrapped" : "target",
    position,
    total: unviewed.length,
    path: target.path,
    message: target.wrapped
      ? `Wrapped to the ${direction === "next" ? "first" : "last"} unviewed file. ${landed}`
      : landed,
  };
}

/** Which column a hunk's scroll anchor line lives in -- mirrors
 * `@pierre/diffs`' `SelectionSide` without importing it, keeping this module
 * free of a Pierre dependency. */
type ReviewHunkSide = "additions" | "deletions";

/**
 * Identifies one hunk's jump target: the file it belongs to and the line
 * (in that side's numbering) `[`/`]` scroll to. Compared structurally by
 * `adjacentHunkAnchor`, not by reference -- callers rebuild the order fresh
 * on every keypress (the diff's hunks don't change shape between presses,
 * but the array instance does), so reference equality would never match.
 */
export type HunkAnchor = {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly side: ReviewHunkSide;
};

/**
 * The hunk anchor adjacent to `current` in `order`, one step in `direction`,
 * across file boundaries when `current` sits at the first or last hunk of
 * its file -- `order` is already flattened across every file in document
 * order, so crossing a boundary is just stepping past that file's last (or
 * before its first) hunk. Returns `undefined` at either end of `order`:
 * navigation stops rather than wrapping, same as `adjacentFilePath`. A
 * `current` missing from `order` (nothing has resolved a starting hunk yet)
 * is treated as sitting just before the first hunk, so "next" lands on
 * `order[0]` and "previous" reports the start boundary.
 */
export function adjacentHunkAnchor(
  order: ReadonlyArray<HunkAnchor>,
  current: HunkAnchor | undefined,
  direction: ReviewNavDirection,
): HunkAnchor | undefined {
  if (order.length === 0) return undefined;
  const currentIndex =
    current === undefined
      ? -1
      : order.findIndex(
          (anchor) =>
            anchor.filePath === current.filePath &&
            anchor.lineNumber === current.lineNumber &&
            anchor.side === current.side,
        );
  const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= order.length) return undefined;
  return order[nextIndex];
}

/**
 * Identifies one unresolved comment thread's jump target: the file and line
 * (in that side's numbering) `{`/`}` scroll to, plus the thread's own
 * annotation id (`conversation:${threadId}`, stable across re-renders --
 * see `review-workbench.tsx`) so `adjacentCommentAnchor` and the DOM lookup
 * that focuses the landed thread's card both key on an identity that never
 * collides, unlike `HunkAnchor`'s file+line+side structural key which two
 * distinct threads anchored to the same line could share.
 */
export type CommentAnchor = {
  readonly id: string;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly side: ReviewHunkSide;
};

/**
 * The unresolved-comment anchor adjacent to `current` in `order`, one step
 * in `direction` -- `order` is already built in document order (file order,
 * then line order within each file; see the `{`/`}` listener in
 * `ReviewDiffSurface`), so this is the same flatten-and-step shape as
 * `adjacentHunkAnchor`, matching by `id` instead of by file+line+side (see
 * `CommentAnchor`'s doc comment for why). Returns `undefined` at either end
 * of `order`: navigation stops rather than wrapping. A `current` missing
 * from `order` -- nothing has jumped yet this session, or the thread it
 * named was resolved or filtered out since -- is treated as sitting just
 * before the first comment, so "next" lands on `order[0]` and "previous"
 * reports the start boundary.
 */
export function adjacentCommentAnchor(
  order: ReadonlyArray<CommentAnchor>,
  current: CommentAnchor | undefined,
  direction: ReviewNavDirection,
): CommentAnchor | undefined {
  return adjacentAnchorById(order, current, direction);
}

function adjacentAnchorById<Anchor extends { readonly id: string }>(
  order: ReadonlyArray<Anchor>,
  current: Anchor | undefined,
  direction: ReviewNavDirection,
): Anchor | undefined {
  if (order.length === 0) return undefined;
  const currentIndex =
    current === undefined
      ? -1
      : order.findIndex((anchor) => anchor.id === current.id);
  const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= order.length) return undefined;
  return order[nextIndex];
}

/**
 * Builds the `{`/`}` announcement for no unresolved comments, a landed
 * comment with its N-of-M position, or a boundary with the total count. The
 * count tells the reviewer whether more comments remain. This pure function
 * keeps those cases testable without a mounted diff.
 */
export function commentNavAnnouncement(
  order: ReadonlyArray<CommentAnchor>,
  target: CommentAnchor | undefined,
  direction: ReviewNavDirection,
): string {
  return commentNavigationStatus(order, target, direction).message;
}

/**
 * Minimal duck-typed shape `buildCommentOrder` reads from one rendered file
 * item -- just enough of Pierre's `CodeViewDiffItem`/`DiffLineAnnotation` to
 * build the `{`/`}` order without this module depending on `@pierre/diffs`
 * types. `metadata` mirrors the parts of `ReviewInlineAnnotation` this needs:
 * its own stable id, its first line `start` (Pierre's `lineNumber` is the
 * annotation's last line), and (when the annotation is a comment thread, not
 * a finding or a pending write) that thread's state and comments.
 */
export type CommentOrderItem = {
  readonly id: string;
  readonly annotations?: ReadonlyArray<{
    readonly lineNumber: number;
    readonly side: ReviewHunkSide;
    readonly metadata?:
      | {
          readonly id: string;
          readonly start: number;
          readonly conversationThread?: Parameters<typeof threadNeedsReply>[0];
        }
      | undefined;
  }>;
};

/**
 * Builds the `{`/`}` navigation order from `items` (already in document file
 * order -- the same order `[`/`]`'s hunk-flattening relies on): every
 * unresolved comment thread's anchor, threads that need the viewer's reply
 * first, then file order and first line within each group -- the order
 * `projectConversationThreadRows` gives the Threads navigator. Excludes any
 * annotation that isn't a comment thread (a finding, a pending write, a
 * local composer draft, ...) and any `"resolved"` thread, because the point
 * of this binding is "have I dealt with everything". A thread whose location
 * never mapped into any visible file never appears in any item's
 * `annotations`, so it is already excluded.
 */
export function buildCommentOrder(
  items: ReadonlyArray<CommentOrderItem>,
): CommentAnchor[] {
  const documentOrder = items.flatMap((item) =>
    (item.annotations ?? [])
      .flatMap((entry) =>
        entry.metadata?.conversationThread === undefined ||
        entry.metadata.conversationThread.state === "resolved"
          ? []
          : [
              {
                anchor: {
                  id: entry.metadata.id,
                  filePath: item.id,
                  lineNumber: entry.lineNumber,
                  side: entry.side,
                },
                start: entry.metadata.start,
                needsReply: threadNeedsReply(entry.metadata.conversationThread),
              },
            ],
      )
      .sort(
        (a, b) =>
          a.start - b.start || a.anchor.lineNumber - b.anchor.lineNumber,
      ),
  );
  return [
    ...documentOrder.filter((entry) => entry.needsReply),
    ...documentOrder.filter((entry) => !entry.needsReply),
  ].map((entry) => entry.anchor);
}

// Bounds the post-scroll focus poll below: a target that never renders a
// card (a defect in its own right) gives up honestly instead of polling
// forever.
const MAX_COMMENT_FOCUS_ATTEMPTS = 30;

/** Finds the `ConversationThreadCard` root rendered for `anchorId`, matching
 * on `data-review-comment-thread` by attribute value comparison rather than
 * interpolating `anchorId` into a CSS selector string -- the id is a raw
 * GitHub thread id and must never need escaping to be looked up safely. */
export function findCommentThreadCard(
  anchorId: string,
): HTMLElement | undefined {
  const cards = document.querySelectorAll<HTMLElement>(
    "[data-review-comment-thread]",
  );
  for (const card of cards) {
    if (card.dataset.reviewCommentThread === anchorId) return card;
  }
  return undefined;
}

/**
 * Focuses the thread card after navigation. CodeView may mount its annotation
 * portal a frame after scrolling, and `focus()` may be a no-op before layout
 * makes the card focusable, so poll for at most `MAX_COMMENT_FOCUS_ATTEMPTS`
 * frames and verify `document.activeElement`. Check `isStale` before every
 * attempt so a later keypress or unmount cannot steal focus.
 */
export function focusCommentThreadCard(
  anchorId: string,
  isStale: () => boolean,
): void {
  focusNavigationCard(() => findCommentThreadCard(anchorId), isStale, 0);
}

function focusNavigationCard(
  findCard: () => HTMLElement | undefined,
  isStale: () => boolean,
  attempt: number,
): void {
  if (isStale()) return;
  const card = findCard();
  if (card !== undefined) {
    card.focus();
    if (document.activeElement === card) return;
  }
  if (attempt >= MAX_COMMENT_FOCUS_ATTEMPTS) return;
  window.requestAnimationFrame(() =>
    focusNavigationCard(findCard, isStale, attempt + 1),
  );
}

/**
 * One Analysis Finding card's `(`/`)` jump target. `id` is the Finding id
 * the card carries in `data-review-inline-finding`.
 */
export type FindingAnchor = {
  readonly id: string;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly side: ReviewHunkSide;
};

/** The parts of one rendered file item `buildFindingOrder` reads. */
export type FindingOrderItem = {
  readonly id: string;
  readonly annotations?: ReadonlyArray<{
    readonly lineNumber: number;
    readonly side: ReviewHunkSide;
    readonly metadata?:
      | {
          readonly id: string;
          readonly start: number;
          readonly analysisFinding?: true;
        }
      | undefined;
  }>;
};

/**
 * The `(`/`)` order: every Analysis Finding card in `items` (already in
 * document file order), then by first line within each file. Comment
 * threads, notes, and pending writes are not Findings.
 */
export function buildFindingOrder(
  items: ReadonlyArray<FindingOrderItem>,
): FindingAnchor[] {
  return items.flatMap((item) =>
    (item.annotations ?? [])
      .flatMap((entry) =>
        entry.metadata?.analysisFinding === true
          ? [
              {
                start: entry.metadata.start,
                anchor: {
                  id: entry.metadata.id,
                  filePath: item.id,
                  lineNumber: entry.lineNumber,
                  side: entry.side,
                },
              },
            ]
          : [],
      )
      .sort(
        (a, b) =>
          a.start - b.start || a.anchor.lineNumber - b.anchor.lineNumber,
      )
      .map((entry) => entry.anchor),
  );
}

/** The Finding next to `current` in `order`; stops at either end, and a missing `current` sits before the first. */
export function adjacentFindingAnchor(
  order: ReadonlyArray<FindingAnchor>,
  current: FindingAnchor | undefined,
  direction: ReviewNavDirection,
): FindingAnchor | undefined {
  return adjacentAnchorById(order, current, direction);
}

/** Builds the structured outcome for one Finding-navigation step. */
export function findingNavigationStatus(
  order: ReadonlyArray<FindingAnchor>,
  target: FindingAnchor | undefined,
  direction: ReviewNavDirection,
): ReviewDiffNavigationStatus {
  if (order.length === 0)
    return {
      kind: "finding",
      state: "empty",
      total: 0,
      message: "No Findings in this diff.",
    };
  if (target === undefined) {
    const state = direction === "next" ? "last" : "first";
    const count = order.length === 1 ? "1 Finding" : `${order.length} Findings`;
    return {
      kind: "finding",
      state,
      total: order.length,
      message: `Already at the ${state} Finding. ${count} total.`,
    };
  }
  const position = order.findIndex((anchor) => anchor.id === target.id) + 1;
  return {
    kind: "finding",
    state: "target",
    position,
    total: order.length,
    path: target.filePath,
    line: target.lineNumber,
    message: `Finding ${position} of ${order.length}: ${target.filePath} line ${target.lineNumber}.`,
  };
}

/** Moves focus onto the Finding card for `findingId` once CodeView mounts it; see `focusCommentThreadCard`. */
export function focusFindingCard(
  findingId: string,
  isStale: () => boolean,
): void {
  focusNavigationCard(
    () => {
      for (const card of document.querySelectorAll<HTMLElement>(
        "[data-review-inline-finding]",
      )) {
        if (card.dataset.reviewInlineFinding === findingId) return card;
      }
      return undefined;
    },
    isStale,
    0,
  );
}

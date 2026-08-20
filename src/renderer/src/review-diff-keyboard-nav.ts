/**
 * Centralized single-key navigation guard and jump geometry for the review
 * diff surface. patchdesk has no other single-key global bindings today
 * (only Cmd/Ctrl+K and Cmd/Ctrl+,, both modifier-gated); printable keys like
 * `,`/`.`/`[`/`]`/`{`/`}` need this discipline built once, centrally, rather
 * than re-derived per binding. `{`/`}` (comments, see `adjacentCommentAnchor`
 * below) reuses `shouldIgnoreReviewNavKey` and the same "stop, don't wrap"
 * boundary semantics `adjacentFilePath`/`adjacentHunkAnchor` establish here.
 */

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

/** True when the focused element sits inside an open dialog, alertdialog, or
 * popover. Base UI (this app's primitive layer) renders `role="dialog"` for
 * both its Dialog and Popover popups and `role="alertdialog"` for
 * AlertDialog, so these two selectors cover all three surfaces the guard
 * names without a component-specific check. */
function focusInsideOverlay(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active.closest('[role="dialog"], [role="alertdialog"]') !== null
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
  if (isTypingTarget(event.target)) return true;
  if (focusInsideOverlay()) return true;
  return false;
}

export type ReviewNavDirection = "previous" | "next";

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
  const nextIndex =
    direction === "next" ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= order.length) return undefined;
  return order[nextIndex];
}

/** Which column a hunk's scroll anchor line lives in -- mirrors
 * `@pierre/diffs`' `SelectionSide` without importing it, keeping this module
 * free of a Pierre dependency. */
export type ReviewHunkSide = "additions" | "deletions";

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
  const nextIndex =
    direction === "next" ? currentIndex + 1 : currentIndex - 1;
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
  if (order.length === 0) return undefined;
  const currentIndex =
    current === undefined
      ? -1
      : order.findIndex((anchor) => anchor.id === current.id);
  const nextIndex =
    direction === "next" ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= order.length) return undefined;
  return order[nextIndex];
}

/**
 * The aria-live text a `{`/`}` press announces, covering all three outcomes
 * a press can produce: the diff has no unresolved comments at all, the press
 * landed on one (with a "N of M" position counter -- the point of the
 * counter is answering "am I done yet", not just "where am I"), or the press
 * hit a boundary (which also carries the total, so the boundary reads as a
 * definite ending rather than the silence a bare "already at the last
 * comment" would leave). Pure and DOM-independent so the zero-comment and
 * counter-text cases are unit-testable without a live diff surface.
 */
export function commentNavAnnouncement(
  order: ReadonlyArray<CommentAnchor>,
  target: CommentAnchor | undefined,
  direction: ReviewNavDirection,
): string {
  if (order.length === 0) return "No unresolved comments.";
  if (target === undefined) {
    const boundary = direction === "next" ? "last" : "first";
    const count =
      order.length === 1
        ? "1 unresolved comment"
        : `${order.length} unresolved comments`;
    return `Already at the ${boundary} unresolved comment. ${count} total.`;
  }
  const index = order.findIndex((anchor) => anchor.id === target.id);
  return `Comment ${index + 1} of ${order.length} unresolved.`;
}

/**
 * Minimal duck-typed shape `buildCommentOrder` reads from one rendered file
 * item -- just enough of Pierre's `CodeViewDiffItem`/`DiffLineAnnotation` to
 * build the `{`/`}` order without this module depending on `@pierre/diffs`
 * types. `metadata` mirrors the parts of `ReviewInlineAnnotation` this needs:
 * its own stable id, and (when the annotation is a comment thread, not a
 * finding or a pending write) that thread's resolution state.
 */
export type CommentOrderItem = {
  readonly id: string;
  readonly annotations?: ReadonlyArray<{
    readonly lineNumber: number;
    readonly side: ReviewHunkSide;
    readonly metadata?:
      | {
          readonly id: string;
          readonly conversationThread?: { readonly state: string };
        }
      | undefined;
  }>;
};

/**
 * Builds the `{`/`}` navigation order from `items` (already in document file
 * order -- the same order `[`/`]`'s hunk-flattening relies on): every
 * unresolved comment thread's anchor, file order then line order within each
 * file. Excludes any annotation that isn't a comment thread at all (a
 * finding, a pending write, a local composer draft, ...) and any thread
 * whose `state` is `"resolved"` -- a resolved thread is finished work, not a
 * target, because the point of this binding is "have I dealt with
 * everything". A thread whose location never mapped into any visible file
 * never appears in any item's `annotations` in the first place, so it is
 * already excluded here without any special-case handling.
 */
export function buildCommentOrder(
  items: ReadonlyArray<CommentOrderItem>,
): CommentAnchor[] {
  return items.flatMap((item) => {
    const unresolved = (item.annotations ?? []).filter(
      (entry) =>
        entry.metadata?.conversationThread !== undefined &&
        entry.metadata.conversationThread.state !== "resolved",
    );
    return unresolved
      .slice()
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .flatMap((entry) =>
        entry.metadata === undefined
          ? []
          : [
              {
                id: entry.metadata.id,
                filePath: item.id,
                lineNumber: entry.lineNumber,
                side: entry.side,
              },
            ],
      );
  });
}

// Bounds the post-scroll focus poll below: a target that never renders a
// card (a defect in its own right) gives up honestly instead of polling
// forever, the same discipline `materializeAndScrollTo` uses for its own
// materialize retries.
export const MAX_COMMENT_FOCUS_ATTEMPTS = 30;

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
 * Moves focus onto the `ConversationThreadCard` for `anchorId` once it
 * exists in the DOM. `{`/`}` navigation calls this right after its scroll
 * resolves, but CodeView can still mount the annotation's portal a frame
 * later (it materializes the portal once the target item's own DOM node is
 * in place), so this polls a bounded number of frames rather than assuming
 * the card is already there. A found card can also still reject `focus()`
 * as a no-op -- the portal can mount mid-layout, a frame before it is
 * actually focusable -- so this verifies against `document.activeElement`
 * and keeps polling rather than trusting a silent, ineffective call.
 * `isStale` is checked before every attempt, including the first, so a
 * superseding press or an unmounted listener stops the poll rather than
 * stealing focus from whatever the user is doing by the time a late frame
 * runs.
 */
export function focusCommentThreadCard(
  anchorId: string,
  isStale: () => boolean,
  attempt = 0,
): void {
  if (isStale()) return;
  const card = findCommentThreadCard(anchorId);
  if (card !== undefined) {
    card.focus();
    if (document.activeElement === card) return;
  }
  if (attempt >= MAX_COMMENT_FOCUS_ATTEMPTS) return;
  window.requestAnimationFrame(() =>
    focusCommentThreadCard(anchorId, isStale, attempt + 1),
  );
}

/**
 * Centralized single-key navigation guard and jump geometry for the review
 * diff surface. patchdesk has no other single-key global bindings today
 * (only Cmd/Ctrl+K and Cmd/Ctrl+,, both modifier-gated); printable keys like
 * `,`/`.`/`[`/`]` need this discipline built once, centrally, rather than
 * re-derived per binding. `{`/`}` (comments) is a later slice; it should
 * reuse `shouldIgnoreReviewNavKey` and the same "stop, don't wrap" boundary
 * semantics `adjacentFilePath`/`adjacentHunkAnchor` establish here.
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

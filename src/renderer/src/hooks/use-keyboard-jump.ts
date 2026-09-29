import { useEffect, useRef } from "react";

import { useLatestCommitted } from "./use-latest-committed";

/** Starts one scroll jump, superseding whatever jump is still in flight. */
export type KeyboardJump = {
  /**
   * Runs `startJump` as the newest jump and keeps the canceller it returns.
   *
   * `isStale()` turns true as soon as a later jump starts, or the listener is
   * torn down. Hand it to `materializeAndScrollTo`, and to anything that
   * outlives the scroll itself, such as a bounded post-scroll poll.
   */
  readonly start: (startJump: (isStale: () => boolean) => () => void) => void;
};

/**
 * Owns the window `keydown` listener, the jump token, and the cancel handle
 * behind the review diff's file, hunk, and comment jumps. ADR 0034 keeps
 * those jumps as product behaviour for a sighted keyboard user, not as an
 * accessibility lane.
 *
 * The listener exists only while `enabled`. Tearing it down — a mode change,
 * or the surface unmounting — removes the listener, cancels the jump in
 * flight, and marks it stale, so no frame or poll a jump scheduled can run
 * against a surface that is gone.
 *
 * `onKeyDown` is read from a latest-committed ref rather than from the
 * effect's dependencies, so an unrelated re-render never removes the listener
 * and never cancels a jump already in flight.
 *
 * The returned ref holds the same runner while the listener exists, so a
 * command outside the keyboard (the ⌘K palette) supersedes and is superseded
 * by key presses alike.
 */
export function useKeyboardJump(
  enabled: boolean,
  onKeyDown: (event: KeyboardEvent, jump: KeyboardJump) => void,
): { readonly current: KeyboardJump | undefined } {
  const latestOnKeyDown = useLatestCommitted(onKeyDown);
  const jump = useRef<{ token: number; cancel: (() => void) | undefined }>({
    token: 0,
    cancel: undefined,
  });
  const activeRunner = useRef<KeyboardJump | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let tornDown = false;
    const runner: KeyboardJump = {
      start: (startJump) => {
        jump.current.cancel?.();
        const token = jump.current.token + 1;
        jump.current.token = token;
        jump.current.cancel = startJump(
          () => tornDown || jump.current.token !== token,
        );
      },
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      latestOnKeyDown.current(event, runner);
    };
    activeRunner.current = runner;
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      tornDown = true;
      activeRunner.current = undefined;
      window.removeEventListener("keydown", handleKeyDown);
      jump.current.cancel?.();
      jump.current.cancel = undefined;
    };
  }, [enabled, latestOnKeyDown]);
  return activeRunner;
}

import { useEffect } from "react";
import { useWorkerPool } from "@pierre/diffs/react";

import {
  diffThemeFor,
  type DiffThemePreferences,
} from "@/diff-theme-preferences";

/**
 * Keeps the shared syntax-highlighting worker pool on the user's diff theme.
 *
 * A pool-backed `CodeView` colours its tokens from
 * `WorkerPoolManager.renderOptions.theme`, not from the `options.theme` prop
 * it is rendered with, so changing the preference alone leaves the diff on
 * whatever theme the pool was constructed with. `setRenderOptions` re-resolves
 * the theme on this thread, posts it to every worker, drops the pool's cached
 * ASTs, and notifies each mounted renderer, which clears its render cache and
 * repaints in place -- so no `CodeView` remount is needed or wanted.
 */
export function useDiffWorkerPoolTheme(theme: DiffThemePreferences): void {
  const pool = useWorkerPool();
  const { light, dark } = diffThemeFor(theme);
  useEffect(() => {
    // Rejects only when a theme name fails to resolve; the pool keeps the
    // previous theme, so the diff stays readable and the review surface does
    // not crash on an unhandled rejection.
    pool
      ?.setRenderOptions({ theme: { light, dark } })
      .catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        console.error(`Diff worker pool theme change failed: ${reason}`);
      });
  }, [dark, light, pool]);
}

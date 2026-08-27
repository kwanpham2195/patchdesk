import { useEffect } from "react";

import type { DesktopMenuAction } from "../../../main/ipc-contract";

/**
 * Runs the native desktop menu's actions inside the renderer.
 *
 * The handler table is a `Record<DesktopMenuAction, () => void>` rather than
 * an if/else chain: adding a menu action to `DesktopMenuAction` becomes a type
 * error here instead of a menu item that silently does nothing.
 *
 * `refresh` may return a promise — `refreshDashboard` in `app.tsx` does — so
 * the awaiting is done here and callers can pass their existing `useCallback`
 * identity straight in, which keeps the IPC subscription from being torn down
 * and rebuilt on every render.
 */
export function useDesktopMenuActions(
  enabled: boolean,
  openSettings: () => void,
  refresh: () => Promise<void> | void,
): void {
  useEffect(() => {
    if (!enabled || window.patchdesk?.onMenuAction === undefined) return;
    const handlers = {
      openSettings,
      refresh: () => void refresh(),
    } satisfies Record<DesktopMenuAction, () => void>;
    return window.patchdesk.onMenuAction((action) => handlers[action]());
  }, [enabled, openSettings, refresh]);
}

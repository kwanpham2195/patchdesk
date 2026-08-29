import { useEffect } from "react";
import type { SettingsSection } from "../flows/settings-flow";
import type { NavigationState } from "./use-app-navigation";
import { useDesktopMenuActions } from "./use-desktop-menu-actions";

/**
 * Everything the renderer says to, and hears from, the desktop shell: the
 * navigation state the main process needs before it may close a window, and
 * the native menu's own two actions.
 *
 * Both are one-way bridges over the same IPC channel, and both are off in
 * fixture mode, where there is no main process to talk to.
 */
export function useDesktopMenuBridge({
  fixtureMode,
  navigationState,
  openSettings,
  refreshDashboard,
}: {
  readonly fixtureMode: boolean;
  readonly navigationState: NavigationState;
  readonly openSettings: (
    opener?: HTMLElement,
    section?: SettingsSection,
  ) => void;
  readonly refreshDashboard: () => Promise<void>;
}): void {
  useEffect(() => {
    if (fixtureMode || window.patchdesk?.request === undefined) return;
    void window.patchdesk
      .request({ operation: "setNavigationState", state: navigationState })
      .catch(() => undefined);
  }, [fixtureMode, navigationState]);
  useDesktopMenuActions(!fixtureMode, openSettings, refreshDashboard);
}

import { useEffect, useState } from "react";

/**
 * True while the window is in native macOS full screen.
 *
 * An Electron renderer cannot observe this on its own — `(display-mode:
 * fullscreen)` stays false there — so the state arrives over the desktop
 * bridge (`onWindowFullScreen` in `src/main/ipc-contract.ts`). It matters to
 * the header: macOS hides the traffic lights in full screen, and the inset
 * that keeps the brand clear of them becomes dead space.
 *
 * The initial value is the one preload read synchronously as this renderer
 * loaded, so reloading inside full screen is right on the first frame instead
 * of flashing the inset. Outside Electron — the Playwright and RTL fixtures —
 * the bridge member is absent and the hook stays false.
 */
export function useWindowFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(
    () => window.patchdesk?.windowFullScreenAtLoad ?? false,
  );
  useEffect(() => {
    if (window.patchdesk?.onWindowFullScreen === undefined) return;
    return window.patchdesk.onWindowFullScreen(setFullScreen);
  }, []);
  return fullScreen;
}

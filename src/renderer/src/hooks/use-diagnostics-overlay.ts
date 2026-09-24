import { useCallback, useState } from "react";
import type { NavigationState } from "./use-app-navigation";

/** The Diagnostics overlay: whether it is open and the element focus returns to when it closes. */
export type DiagnosticsOverlay = {
  readonly diagnosticsOpen: boolean;
  readonly diagnosticsOpener: HTMLElement | undefined;
  readonly openDiagnostics: (opener?: HTMLElement) => void;
  readonly closeDiagnostics: () => void;
};

/** Opens like Settings: refused while navigation is blocked by a draft or a pending GitHub write. */
export function useDiagnosticsOverlay(
  navigationState: NavigationState,
): DiagnosticsOverlay {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsOpener, setDiagnosticsOpener] = useState<HTMLElement>();
  const openDiagnostics = useCallback(
    (opener?: HTMLElement): void => {
      if (navigationState !== "clear") return;
      // The native menu passes no opener; focus then returns to whatever held it.
      const focused =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : undefined;
      setDiagnosticsOpener(
        opener ??
          focused ??
          document.querySelector<HTMLElement>("#main-content") ??
          undefined,
      );
      setDiagnosticsOpen(true);
    },
    [navigationState],
  );
  const closeDiagnostics = useCallback((): void => {
    setDiagnosticsOpen(false);
    setDiagnosticsOpener(undefined);
  }, []);
  return {
    diagnosticsOpen,
    diagnosticsOpener,
    openDiagnostics,
    closeDiagnostics,
  };
}

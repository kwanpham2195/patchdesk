import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./app";
import {
  applyAppearance,
  currentAppearancePreference,
} from "./appearance-preferences";
import { RendererRecovery } from "./components/renderer-recovery";
import { appLog, installRendererLogging } from "./lib/logger";

installRendererLogging();

// The main process read the stored appearance from config.json before this
// window existed and preload handed it over synchronously, so the first
// render already paints the chosen theme. The value comes from the appearance
// module, which holds that same bridge value on a real document load but keeps
// the current one when only this module is re-executed, as Vite does on a hot
// update: reading the bridge here would repaint the boot theme over it.
applyAppearance(currentAppearancePreference());

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Patchdesk renderer root is missing");
}

/** Whether the boundary has swapped the tree for the recovery screen. */
type RendererErrorBoundaryState = { readonly failed: boolean };

class RendererErrorBoundary extends Component<
  { readonly children: ReactNode },
  RendererErrorBoundaryState
> {
  override state: RendererErrorBoundaryState = { failed: false };
  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // React's types promise an `Error` here, but it forwards whatever the
    // render actually threw, so keep the runtime check the message relies on.
    appLog.error("react-boundary", "Renderer crashed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack: info.componentStack ?? undefined,
    });
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <RendererRecovery onReload={() => window.location.reload()} />;
  }
}

createRoot(rootElement).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </StrictMode>,
);

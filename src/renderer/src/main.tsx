import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./app";
import { RendererRecovery } from "./components/renderer-recovery";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Patchdesk renderer root is missing");
}

class RendererErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { readonly failed: true } { return { failed: true }; }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <RendererRecovery onReload={() => window.location.reload()} />;
  }
}

createRoot(rootElement).render(
  <StrictMode>
    <RendererErrorBoundary><App /></RendererErrorBoundary>
  </StrictMode>,
);

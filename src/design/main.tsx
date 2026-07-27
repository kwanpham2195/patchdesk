import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "../renderer/src/styles.css";
import { RendererRecovery } from "../renderer/src/components/renderer-recovery";
import { installDesignBridge } from "./mock-bridge";
import { DesignApp } from "./design-app";
import { fixtureHashForScenario, scenarioFromLocation } from "./scenarios";

const scenario = scenarioFromLocation();
installDesignBridge(scenario?.id);
const fixtureHash = fixtureHashForScenario(scenario?.id);
if (fixtureHash !== undefined) window.location.hash = fixtureHash;
if (scenario?.id === "settings-default") window.localStorage.setItem("patchdesk.destination", "settings");
else if (scenario !== undefined && scenario.group === "Review workbench") window.localStorage.setItem("patchdesk.destination", "workbench:design-session");
else window.localStorage.setItem("patchdesk.destination", "dashboard");

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Patchdesk Design root is missing");

class RendererErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { readonly failed: true } { return { failed: true }; }
  override render(): ReactNode { return this.state.failed ? <RendererRecovery onReload={() => window.location.reload()} /> : this.props.children; }
}

createRoot(rootElement).render(<StrictMode><RendererErrorBoundary><DesignApp /></RendererErrorBoundary></StrictMode>);

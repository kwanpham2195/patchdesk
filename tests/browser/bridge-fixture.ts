import type { Page } from "playwright/test";
import type { PatchdeskDesktopApi } from "../../src/main/ipc-contract";

/**
 * How the stub answers `request`: by proxying the loopback API a spec started,
 * or with the empty payloads a renderer-only spec needs to reach the dashboard.
 */
export type TestDesktopBridgeRequests =
  | {
      readonly kind: "localApi";
      readonly baseUrl: string;
      readonly capability: string;
    }
  | { readonly kind: "static" };

/**
 * Browser-only stand-in for Electron's credential-hiding IPC bridge.
 *
 * The object is typed as `PatchdeskDesktopApi`, so a member added to the
 * contract is a compile error here rather than a renderer crash mid-spec: the
 * renderer's `window.patchdesk?.setWindowAppearance(...)` guards a missing
 * bridge, not a bridge missing that method.
 *
 * Both request shapes are branches of this one definition because Playwright
 * serializes the `addInitScript` callback and evaluates it in page scope,
 * where an imported helper is out of scope and only JSON-serializable
 * arguments cross the boundary -- so a second stub could not share this one's
 * window-method surface.
 */
export async function installTestDesktopBridge(
  page: Page,
  requests: TestDesktopBridgeRequests,
): Promise<void> {
  await page.addInitScript((config: TestDesktopBridgeRequests) => {
    const bridge: PatchdeskDesktopApi = {
      async request(input) {
        if (config.kind === "static") {
          const profiles =
            !("operation" in input) && input.path === "/v1/profiles";
          return {
            ok: true,
            status: 200,
            body: profiles ? [] : {},
            correlationId: "keys",
          };
        }
        if ("operation" in input)
          return {
            ok: true,
            status: 200,
            body: {},
            correlationId: "browser-test",
          };
        // Built in separate statements, not via `definedProps`: this callback
        // is serialized and evaluated inside the page, where an imported
        // helper is not in scope.
        const requestInit: RequestInit = {
          method: input.method ?? "GET",
          headers: {
            "Content-Type": "application/json",
            "X-Patchdesk-Capability": config.capability,
          },
        };
        if (input.body !== undefined)
          requestInit.body = JSON.stringify(input.body);
        const response = await fetch(
          new URL(input.path.slice(1), config.baseUrl),
          requestInit,
        );
        return {
          ok: response.ok,
          status: response.status,
          body: await response.json(),
          correlationId: "browser-test",
        };
      },
      // A browser tab has no shell to hand the URL to, so the stub reports the
      // hand-off the real bridge reports on success and opens nothing.
      async openExternalHttps() {
        return true;
      },
      onMenuAction() {
        return () => undefined;
      },
      // A browser page is never in a macOS window, so the header keeps the
      // traffic-light inset it has when the app is not full screen.
      onWindowFullScreen() {
        return () => undefined;
      },
      windowFullScreenAtLoad: false,
      // The renderer's own default, so installing the stub never repaints the
      // page in an appearance no spec asked for.
      appearanceAtLoad: "system",
      setWindowAppearance() {
        return undefined;
      },
      qaScrollDiagnosticsEnabled: false,
    };
    Object.defineProperty(window, "patchdesk", { value: bridge });
  }, requests);
}

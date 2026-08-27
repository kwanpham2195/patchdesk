import type { Page } from "playwright/test";

/** Browser-only stand-in for Electron's credential-hiding IPC bridge. */
export async function installTestDesktopBridge(
  page: Page,
  baseUrl: string,
  capability: string,
): Promise<void> {
  await page.addInitScript(
    ({ url, cap }) => {
      Object.defineProperty(window, "patchdesk", {
        value: {
          async request(input: {
            readonly path?: string;
            readonly method?: string;
            readonly body?: unknown;
            readonly operation?: string;
          }) {
            if (input.operation !== undefined)
              return {
                ok: true,
                status: 200,
                body: {},
                correlationId: "browser-test",
              };
            if (input.path === undefined)
              return {
                ok: false,
                status: 400,
                body: { error: "invalid_input" },
                correlationId: "browser-test",
              };
            // Built in separate statements, not via `definedProps`: this
            // callback is serialized by Playwright's `addInitScript` and
            // evaluated inside the page, where an imported helper is not in
            // scope.
            const requestInit: RequestInit = {
              method: input.method ?? "GET",
              headers: {
                "Content-Type": "application/json",
                "X-Patchdesk-Capability": cap,
              },
            };
            if (input.body !== undefined)
              requestInit.body = JSON.stringify(input.body);
            const response = await fetch(
              new URL(input.path.slice(1), url),
              requestInit,
            );
            return {
              ok: response.ok,
              status: response.status,
              body: await response.json(),
              correlationId: "browser-test",
            };
          },
          onMenuAction() {
            return () => undefined;
          },
        },
      });
    },
    { url: baseUrl, cap: capability },
  );
}

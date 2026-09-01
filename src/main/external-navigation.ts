import type { WebContents } from "electron";

/** A DOM-style event this module only ever cancels. */
type PreventableEvent = {
  readonly preventDefault: () => void;
};

/** The slice of `Electron.Session` this module hardens against remote content. */
type HardenedSession = {
  readonly webRequest: {
    onHeadersReceived(
      listener: (
        details: {
          readonly responseHeaders?: Record<string, string | string[]>;
        },
        callback: (response: {
          readonly responseHeaders?: Record<string, string | string[]>;
        }) => void,
      ) => void,
    ): void;
  };
  setPermissionCheckHandler(
    handler: (
      webContents: WebContents | null,
      permission: string,
      requestingOrigin: string,
    ) => boolean,
  ): void;
  setPermissionRequestHandler(
    handler: (
      requestingWebContents: WebContents | null,
      permission: string,
      callback: (granted: boolean) => void,
      details: { readonly requestingUrl?: string },
    ) => void,
  ): void;
  on(event: "will-download", listener: (event: PreventableEvent) => void): void;
};

/** The slice of `Electron.WebContents` this module hardens against remote content. */
export type GuardedWebContents = {
  readonly session: HardenedSession;
  setWindowOpenHandler(
    handler: (details: { readonly url: string }) => {
      readonly action: "deny";
    },
  ): void;
  on(
    event: "will-navigate",
    listener: (event: PreventableEvent, url: string) => void,
  ): void;
  on(event: "will-redirect", listener: (event: PreventableEvent) => void): void;
};

const hardenedSessions = new WeakSet<HardenedSession>();

/** Opens a URL in the operating system only after Patchdesk validates it. Its resolved value is never read by a caller. */
export type ExternalUrlOpener = (url: string) => Promise<void>;

/** Exact HTTPS hosts that product links are allowed to open outside Patchdesk. */
export function normalizeExternalHosts(
  hosts: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set(
    hosts.flatMap((host) => {
      const normalized = host.trim().toLowerCase().replace(/\.$/, "");
      return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)
        ? [normalized]
        : [];
    }),
  );
}

/** Rejects non-HTTPS, credential-bearing, custom-port, and non-allowlisted URLs. */
export function isAllowedExternalUrl(
  rawUrl: string,
  allowedHosts: ReadonlySet<string>,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return (
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    (url.port.length === 0 || url.port === "443") &&
    allowedHosts.has(hostname)
  );
}

/** Opens one validated URL and reports whether an external open was attempted. */
export async function openAllowedExternalUrl(
  rawUrl: string,
  allowedHosts: ReadonlySet<string>,
  openExternal: ExternalUrlOpener,
): Promise<boolean> {
  if (!isAllowedExternalUrl(rawUrl, allowedHosts)) return false;
  await openExternal(rawUrl);
  return true;
}

/** Origin of a URL, or `undefined` when the URL is missing or unparseable. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  return new URL(url).origin;
}

/**
 * The only permission this app's session ever grants: `clipboard-sanitized-write`,
 * the permission Chromium requires for `navigator.clipboard.writeText()`.
 * It is safe to allow because it is write-only (there is no matching read
 * back through it), it only ever carries plain text the renderer already
 * held, and Chromium only reaches it from a user-initiated action such as a
 * click on a "Copy as diff" button — never from a script running
 * unattended. Restricting it to the app's own renderer origin keeps it from
 * ever reaching content this session would otherwise deny by default.
 * `clipboard-read` and every other permission stay denied.
 */
function isAllowedClipboardWrite(
  permission: string,
  requestingOrigin: string | undefined,
  ownOrigin: string,
): boolean {
  return (
    permission === "clipboard-sanitized-write" &&
    requestingOrigin !== undefined &&
    requestingOrigin === ownOrigin
  );
}

/** Keeps all remote content outside the privileged Patchdesk renderer. */
export function installWebContentsSecurity(
  webContents: GuardedWebContents,
  allowedHosts: ReadonlySet<string>,
  openExternal: ExternalUrlOpener,
  packaged = true,
  ownOrigin = "null",
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl(url, allowedHosts, openExternal).catch(
      () => undefined,
    );
    return { action: "deny" };
  });

  webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    void openAllowedExternalUrl(url, allowedHosts, openExternal).catch(
      () => undefined,
    );
  });
  webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });

  const electronSession = webContents.session;
  if (hardenedSessions.has(electronSession)) return;
  hardenedSessions.add(electronSession);
  electronSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      isAllowedClipboardWrite(permission, requestingOrigin, ownOrigin),
  );
  electronSession.setPermissionRequestHandler(
    (_requestingWebContents, permission, callback, details) => {
      callback(
        isAllowedClipboardWrite(
          permission,
          originOf(details.requestingUrl),
          ownOrigin,
        ),
      );
    },
  );
  electronSession.on("will-download", (event) => {
    event.preventDefault();
  });
  electronSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy(packaged)],
      },
    });
  });
}

export function contentSecurityPolicy(packaged: boolean): string {
  const developmentConnect = packaged
    ? ""
    : " http://localhost:5173 ws://localhost:5173";
  // 'wasm-unsafe-eval' is required by the diff worker pool's WASM syntax
  // highlighter. It permits WebAssembly compilation only, never JavaScript
  // eval, so it does not widen the script surface.
  const scriptSource = packaged
    ? "script-src 'self' 'wasm-unsafe-eval'"
    : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    scriptSource,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${developmentConnect}`,
    "font-src 'self' data:",
  ].join("; ");
}

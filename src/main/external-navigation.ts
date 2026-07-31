import type { Session, WebContents } from "electron";

const hardenedSessions = new WeakSet<Session>();

/** Opens a URL in the operating system only after Patchdesk validates it. */
export type ExternalUrlOpener = (url: string) => Promise<unknown>;

/** Exact HTTPS hosts that product links are allowed to open outside Patchdesk. */
export function normalizeExternalHosts(
  hosts: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set(
    hosts
      .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
      .filter((host) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)),
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

/** Keeps all remote content outside the privileged Patchdesk renderer. */
export function installWebContentsSecurity(
  webContents: WebContents,
  allowedHosts: ReadonlySet<string>,
  openExternal: ExternalUrlOpener,
  packaged = true,
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
  electronSession.setPermissionCheckHandler(() => false);
  electronSession.setPermissionRequestHandler(
    (_requestingWebContents, _permission, callback) => callback(false),
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
  const developmentConnect = packaged ? "" : " http://localhost:5173 ws://localhost:5173";
  const scriptSource = packaged
    ? "script-src 'self'"
    : "script-src 'self' 'unsafe-inline'";
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

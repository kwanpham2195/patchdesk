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
